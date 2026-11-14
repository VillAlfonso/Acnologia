import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { interpolate, httpUrl, stepSchema } from './schema.js';
import { installRecorder } from './recorder.js';
import { browserLaunchOptions } from './browsers.js';
import { replayMousePath, showReplayCursor, clickRecordedElement } from './mouse.js';

export class Automation {
  constructor(store, options = {}) { this.store = store; this.headlessRecorder = options.headlessRecorder ?? false; this.recorder = null; this.active = new Map(); this.jobs = []; this.limit = 3; this.closing = false; }
  async context(browser, profileId, viewport = { width: 1360, height: 900 }) {
    const storageState = this.store.sessionPath(profileId);
    try { await access(storageState); return await browser.newContext({ storageState, viewport }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return browser.newContext({ viewport }); }
  }
  recorderState() {
    const r = this.recorder;
    return r ? { workflowId: r.workflowId, profileId: r.profileId, browserId: r.browserId, status: r.status, steps: r.steps, url: r.page?.url(), error: r.error } : null;
  }
  async startRecording(workflow, profileId, browserId = 'chromium') {
    if (this.recorder) throw new Error('Stop the current recording first.');
    if ([...this.active.values()].some(c => c.profileId === profileId) || this.jobs.some(j => j.profile.id === profileId)) throw new Error('Wait for this profile’s runs to finish before recording.');
    const r = { workflowId: workflow.id, profileId, browserId, status: 'starting', steps: [], browser: null };
    this.recorder = r;
    try {
      r.browser = await chromium.launch({ ...await browserLaunchOptions(browserId), headless: this.headlessRecorder });
      r.context = await this.context(r.browser, profileId, this.headlessRecorder ? { width: 1360, height: 900 } : null);
      await r.context.exposeBinding('__recordAction', ({ page, frame }, action) => {
        if (r.status !== 'recording' || page !== r.page || frame !== page.mainFrame()) return;
        if (!['click', 'fill', 'select', 'check', 'press', 'move'].includes(action.type) || typeof action.selector !== 'string' || typeof action.value !== 'string') return;
        const parsed = stepSchema.safeParse({ ...action, selector: action.selector.slice(0, 2000), value: action.value.slice(0, 10000), label: String(action.label).slice(0, 200), id: randomUUID(), enabled: true, timeout: 15000 });
        if (!parsed.success) return;
        const step = parsed.data;
        const last = r.steps.at(-1);
        if (step.type === 'move' && last?.type === 'move' && last.mousePath.length + step.mousePath.length <= 400) r.steps[r.steps.length - 1] = { ...step, id: last.id, mousePath: [...last.mousePath, ...step.mousePath] };
        else if (step.type === 'fill' && last?.type === 'fill' && last.selector === step.selector) r.steps[r.steps.length - 1] = { ...step, id: last.id };
        else if (r.steps.length < 500) r.steps.push(step);
      });
      await r.context.addInitScript(installRecorder);
      r.page = await r.context.newPage();
      r.browser.on('disconnected', () => { if (['recording', 'paused'].includes(r.status)) { r.status = 'closed'; r.error = 'Browser closed. Save the captured steps or discard this recording.'; } });
      await r.page.goto(workflow.startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      r.status = 'recording';
      return this.recorderState();
    } catch (error) { await r.browser?.close(); this.recorder = null; throw error; }
  }
  async stopRecording(save) {
    const r = this.recorder;
    if (!r || r.status === 'starting') throw new Error('No recording is ready to stop.');
    r.status = 'stopping';
    try {
      if (save) {
        const workflow = this.store.state.workflows.find(w => w.id === r.workflowId);
        if (!workflow) throw new Error('Workflow no longer exists.');
        workflow.steps = r.steps; workflow.updatedAt = new Date().toISOString();
        if (r.browser?.isConnected()) await r.context.storageState({ path: this.store.sessionPath(r.profileId), indexedDB: true });
        await this.store.save();
      }
      return { saved: save, count: r.steps.length };
    } finally { await r.browser?.close(); this.recorder = null; }
  }
  pauseRecording(paused) {
    const r = this.recorder;
    if (!r || !['recording', 'paused'].includes(r.status)) throw new Error('No active recording.');
    r.status = paused ? 'paused' : 'recording'; return this.recorderState();
  }
  async calibrate(selector) {
    if (!['recording', 'paused'].includes(this.recorder?.status)) throw new Error('Open a recording browser to inspect a selector.');
    const locator = this.recorder.page.locator(selector);
    const count = await locator.count();
    return { count, visible: count === 1 ? await locator.isVisible() : false, text: count === 1 ? (await locator.textContent({ timeout: 2000 }) || '').slice(0, 200) : '' };
  }
  enqueue(workflow, profiles, settings) {
    if (profiles.some(p => p.id === this.recorder?.profileId)) throw new Error('Stop recording with this profile before running it.');
    if (this.jobs.length + this.active.size + profiles.length > 30) throw new Error('The queue holds at most 30 runs.');
    this.limit = settings.concurrency;
    const runs = profiles.map(profile => {
      const run = { id: randomUUID(), workflowId: workflow.id, workflowName: workflow.name, profileId: profile.id, profileName: profile.name, status: 'queued', createdAt: new Date().toISOString(), currentStep: 0, totalSteps: workflow.steps.filter(s => s.enabled).length, logs: [], screenshots: [] };
      this.store.state.runs.unshift(run);
      this.jobs.push({ run, workflow: structuredClone(workflow), profile: structuredClone(profile), settings });
      return run;
    });
    this.store.save(); this.pump(); return runs;
  }
  pump() {
    while (!this.closing && this.active.size < this.limit && this.jobs.length) {
      const index = this.jobs.findIndex(job => ![...this.active.values()].some(c => c.profileId === job.profile.id));
      if (index === -1) break;
      const [job] = this.jobs.splice(index, 1);
      const control = { canceled: false, paused: false, browser: null, profileId: job.profile.id };
      this.active.set(job.run.id, control);
      this.execute(job, control).catch(error => { job.run.status = 'failed'; job.run.error = error.message; }).finally(async () => {
        this.active.delete(job.run.id); await this.store.save(); this.pump();
      });
    }
  }
  control(id, action) {
    const run = this.store.state.runs.find(r => r.id === id);
    if (!run) throw new Error('Run not found.');
    const control = this.active.get(id);
    if (action === 'cancel') {
      if (control) { control.canceled = true; control.browser?.close().catch(() => {}); }
      else if (run.status === 'queued') { this.jobs = this.jobs.filter(j => j.run.id !== id); run.status = 'canceled'; run.finishedAt = new Date().toISOString(); this.store.save(); }
    } else if (control && !control.canceled) { control.paused = action === 'pause'; run.status = control.paused ? 'paused' : 'running'; }
    return run;
  }
  async execute({ run, workflow, profile, settings }, control) {
    let context, page, outcome;
    const redact = text => Object.entries(profile.variables).filter(([key, value]) => /password|secret|token/i.test(key) && value).reduce((msg, [, value]) => msg.replaceAll(value, '[redacted]'), String(text));
    const log = (message, level = 'info') => run.logs.push({ time: new Date().toISOString(), message: redact(message), level });
    const checkpoint = async () => {
      while (control.paused && !control.canceled) await new Promise(resolve => setTimeout(resolve, 100));
      if (control.canceled) throw new Error('Run canceled');
    };
    const screenshot = async label => {
      const filename = `${run.id}-${run.screenshots.length + 1}.png`;
      await page.screenshot({ path: path.join(this.store.root, 'screenshots', filename), fullPage: true, timeout: 5000 });
      run.screenshots.push({ label, url: `/screenshots/${filename}` });
    };
    try {
      run.status = 'running'; run.startedAt = new Date().toISOString();
      // Fail before navigating when a profile is missing a required variable.
      for (const step of workflow.steps.filter(s => s.enabled)) { interpolate(step.value, profile.variables); interpolate(step.selector, profile.variables); }
      control.browser = await chromium.launch({ ...await browserLaunchOptions(settings.browserId), headless: settings.headless });
      await checkpoint();
      context = await this.context(control.browser, profile.id, settings.headless ? { width: settings.viewportWidth || 1360, height: settings.viewportHeight || 900 } : null);
      if (settings.showCursor !== false) await context.addInitScript(showReplayCursor);
      page = await context.newPage();
      page.setDefaultTimeout(15000);
      log('Browser session opened');
      await page.goto(httpUrl.parse(workflow.startUrl), { waitUntil: 'domcontentloaded', timeout: 30000 });
      for (const step of workflow.steps.filter(s => s.enabled)) {
        await checkpoint();
        run.currentStep++;
        const value = interpolate(step.value, profile.variables);
        const selector = interpolate(step.selector, profile.variables);
        const locator = selector ? page.locator(selector) : null;
        const options = { timeout: step.timeout };
        log(`Step ${run.currentStep}: ${step.label || step.type}`);
        switch (step.type) {
          case 'move':
            if (settings.replayMouse !== false) {
              await replayMousePath(page, step.mousePath, checkpoint);
              // Re-anchor the final hover when a responsive layout moves the target.
              if (locator && await locator.count() === 1 && await locator.isVisible()) await locator.hover(options);
            }
            break;
          case 'navigate': await page.goto(httpUrl.parse(value), { waitUntil: 'domcontentloaded', timeout: step.timeout }); break;
          case 'click': await clickRecordedElement(locator, step.clickPosition, options); break;
          case 'fill': await locator.fill(value, options); break;
          case 'select': await locator.selectOption({ label: value }, options).catch(() => locator.selectOption(value, options)); break;
          case 'check': await locator.setChecked(value !== 'false', options); break;
          case 'press': await locator.press(value, options); break;
          case 'wait': {
            let remaining = Number(value);
            while (remaining > 0) { await checkpoint(); const duration = Math.min(remaining, 100); await new Promise(resolve => setTimeout(resolve, duration)); remaining -= duration; }
            break;
          }
          case 'assert': {
            await locator.waitFor({ state: 'visible', timeout: step.timeout });
            const deadline = Date.now() + step.timeout;
            while (!(await locator.innerText(options)).includes(value)) {
              await checkpoint();
              if (Date.now() >= deadline) throw new Error('Expected text was not found in the selected element.');
              await new Promise(resolve => setTimeout(resolve, 100));
            }
            break;
          }
          case 'screenshot': await screenshot(step.label || 'Screenshot'); break;
        }
      }
      await checkpoint();
      await context.storageState({ path: this.store.sessionPath(profile.id), indexedDB: true });
      outcome = 'passed'; log('Workflow completed successfully', 'success');
    } catch (error) {
      outcome = control.canceled ? 'canceled' : 'failed';
      run.error = redact(error.message); log(run.error, 'error');
      if (!control.canceled && page && !page.isClosed()) await screenshot('Failure snapshot').catch(() => {});
    } finally {
      await control.browser?.close().catch(() => {});
      run.finishedAt = new Date().toISOString();
      run.status = control.canceled ? 'canceled' : outcome;
    }
  }
  async shutdown() {
    this.closing = true;
    if (this.recorder) await this.recorder.browser?.close();
    for (const [id] of this.active) this.control(id, 'cancel');
    await Promise.all([...this.active.values()].map(c => c.browser?.close().catch(() => {})));
  }
}
