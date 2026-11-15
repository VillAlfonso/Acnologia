import { chromium } from './playwright.js';
import { proxyLaunchOptions } from './proxy.js';
import { verifyBrowserProxy } from './proxy-check.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { interpolate, httpUrl, stepSchema } from './schema.js';
import { recorderScript } from './recorder.js';
import { browserLaunchOptions } from './browsers.js';
import { replayMousePath, showReplayCursor, clickRecordedElement } from './mouse.js';
import { formAnswers } from './form-answers.js';
import { safePageURL } from './monitor.js';

export class Automation {
  constructor(store, options = {}) { this.store = store; this.monitor = options.monitor || { event() {} }; this.keptBrowsers = new Map(); this.headlessRecorder = options.headlessRecorder ?? false; this.proxyCheckOptions = options.proxyCheckOptions || {}; this.formAnswers = options.formAnswers || formAnswers; this.recorder = null; this.active = new Map(); this.jobs = []; this.limit = 3; this.closing = false; }
  recorderState() {
    const r = this.recorder;
    return r ? { workflowId: r.workflowId, browserId: r.browserId, status: r.status, steps: r.steps, url: r.page?.url(), tabCount: r.pages.filter(page => !page.isClosed()).length, error: r.error } : null;
  }
  async startRecording(workflow, browserId = 'chromium') {
    if (this.recorder) throw new Error('Stop the current recording first.');
    const r = { workflowId: workflow.id, browserId, status: 'starting', steps: [], fields: [], bindings: new Map(), pages: [], browser: null };
    this.recorder = r;
    this.monitor.event('capture', `Opening ${browserId} for ${workflow.name}`);
    try {
      r.browser = await chromium.launch({ ...await browserLaunchOptions(browserId), ...await proxyLaunchOptions(this.store.root, process.env, { onProgress: message => this.monitor.event('capture', message), isCanceled: () => this.closing }), headless: this.headlessRecorder });
      r.context = await r.browser.newContext({ viewport: this.headlessRecorder ? { width: 1360, height: 900 } : null });
      const registerPage = page => {
        if (!r.pages.includes(page)) {
          r.pages.push(page);
          this.watchPage(page, message => this.monitor.event('capture', message));
          this.monitor.event('capture', `Tab ${r.pages.length} opened`);
          page.on('close', () => { if (r.page === page) r.page = r.pages.findLast(candidate => !candidate.isClosed()); });
        }
        r.page = page;
        return r.pages.indexOf(page);
      };
      r.context.on('page', registerPage);
      await r.context.exposeBinding('__recordAction', ({ page, frame }, action) => {
        if (r.status !== 'recording' || frame !== page.mainFrame()) return;
        const pageId = registerPage(page);
        if (!['click', 'fill', 'select', 'check', 'press', 'move'].includes(action.type) || typeof action.selector !== 'string' || typeof action.value !== 'string') return;
        const parsed = stepSchema.safeParse({ ...action, pageId, selector: action.selector.slice(0, 2000), value: action.value.slice(0, 10000), label: String(action.label).slice(0, 200), id: randomUUID(), enabled: true, timeout: 15000 });
        if (!parsed.success) return;
        const step = parsed.data;
        this.formAnswers.recordField(step, r.fields, r.bindings);
        if (step.type !== 'move') this.monitor.event('capture', `${step.type} captured on tab ${pageId + 1}${step.type === 'fill' ? ' (variable)' : ''}`);
        const last = r.steps.at(-1);
        if (step.type === 'move' && last?.type === 'move' && last.pageId === pageId && last.mousePath.length + step.mousePath.length <= 400) r.steps[r.steps.length - 1] = { ...step, id: last.id, mousePath: [...last.mousePath, ...step.mousePath] };
        else if (step.type === 'fill' && last?.type === 'fill' && last.pageId === pageId && last.selector === step.selector) r.steps[r.steps.length - 1] = { ...step, id: last.id };
        else if (r.steps.length < 500) r.steps.push(step);
      });
      await r.context.addInitScript(recorderScript());
      r.page = await r.context.newPage();
      r.browser.on('disconnected', () => { if (['recording', 'paused'].includes(r.status)) { r.status = 'closed'; r.error = 'Browser closed. Save the captured steps or discard this recording.'; } });
      await r.page.goto(workflow.startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      r.status = 'recording';
      this.monitor.event('capture', 'Recording active');
      return this.recorderState();
    } catch (error) {
      this.monitor.event('capture', error.message, 'error');
      if (!this.closing && !this.headlessRecorder && r.browser?.isConnected() && r.page && !r.page.isClosed()) {
        r.status = 'recording';
        r.error = 'Could not load the start URL. Browser kept open so you can inspect or retry. ' + error.message;
        return this.recorderState();
      }
      await r.browser?.close(); this.recorder = null; throw error;
    }
  }
  async stopRecording(save) {
    const r = this.recorder;
    if (!r || r.status === 'starting') throw new Error('No recording is ready to stop.');
    r.status = 'stopping';
    try {
      if (save) {
        const workflow = this.store.state.workflows.find(w => w.id === r.workflowId);
        if (!workflow) throw new Error('Workflow no longer exists.');
        workflow.steps = r.steps; workflow.generator = { enabled: true, fields: r.fields }; workflow.updatedAt = new Date().toISOString();
        await this.store.save();
      }
      this.monitor.event('capture', `${save ? 'Saved' : 'Discarded'} ${r.steps.length} actions`);
      return { saved: save, count: r.steps.length };
    } finally { await r.browser?.close(); this.recorder = null; }
  }
  pauseRecording(paused) {
    const r = this.recorder;
    if (!r || !['recording', 'paused'].includes(r.status)) throw new Error('No active recording.');
    r.status = paused ? 'paused' : 'recording'; this.monitor.event('capture', r.status); return this.recorderState();
  }
  async calibrate(selector, pageId) {
    if (!['recording', 'paused'].includes(this.recorder?.status)) throw new Error('Open a recording browser to inspect a selector.');
    const page = pageId === undefined ? this.recorder.page : this.recorder.pages[pageId];
    if (!page || page.isClosed()) throw new Error('The selected recording tab is closed or unavailable.');
    const locator = page.locator(selector);
    const count = await locator.count();
    return { count, visible: count === 1 ? await locator.isVisible() : false, text: count === 1 ? (await locator.textContent({ timeout: 2000 }) || '').slice(0, 200) : '' };
  }
  watchPage(page, log) {
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) log('Page: ' + safePageURL(frame.url())); });
    page.on('requestfailed', request => log('Request failed: ' + request.resourceType() + ' ' + safePageURL(request.url())));
    page.on('response', response => { if (response.status() >= 400) log('HTTP ' + response.status() + ': ' + safePageURL(response.url())); });
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) log('Page console ' + message.type() + ' (content omitted)'); });
    page.on('pageerror', () => log('JavaScript error in page (content omitted)'));
    page.on('close', () => log('Tab closed'));
    page.on('crash', () => log('Tab crashed'));
  }
  enqueue(workflow, settings) {
    const count = settings.runCount || 1;
    if (this.jobs.length + this.active.size + count > 30) throw new Error('The queue holds at most 30 runs.');
    this.limit = settings.concurrency;
    const runs = Array.from({ length: count }, (_, index) => {
      const name = settings.name?.trim() || workflow.name;
      const run = { id: randomUUID(), workflowId: workflow.id, workflowName: workflow.name, name: count > 1 ? name + ' ' + (index + 1) : name, status: 'queued', createdAt: new Date().toISOString(), currentStep: 0, totalSteps: workflow.steps.filter(s => s.enabled).length, logs: [], screenshots: [] };
      this.store.state.runs.unshift(run);
      this.jobs.push({ run, workflow: structuredClone(workflow), settings });
      this.monitor.event(run.id.slice(0, 8), 'Queued: ' + run.name);
      return run;
    });
    this.store.save(); this.pump(); return runs;
  }
  pump() {
    while (!this.closing && this.active.size < this.limit && this.jobs.length) {
      const job = this.jobs.shift();
      const control = { canceled: false, paused: false, browser: null };
      this.active.set(job.run.id, control);
      this.execute(job, control).catch(error => { job.run.status = 'failed'; job.run.error = error.message; }).finally(async () => {
        this.active.delete(job.run.id); await this.store.save(); this.pump();
      });
    }
  }
  control(id, action) {
    const run = this.store.state.runs.find(r => r.id === id);
    if (!run) throw new Error('Run not found.');
    this.monitor.event(id.slice(0, 8), 'Control: ' + action);
    if (action === 'close-browser') { this.keptBrowsers.get(id)?.close().catch(() => {}); return run; }
    const control = this.active.get(id);
    if (action === 'cancel') {
      if (control) { control.canceled = true; control.browser?.close().catch(() => {}); }
      else if (run.status === 'queued') { this.jobs = this.jobs.filter(j => j.run.id !== id); run.status = 'canceled'; run.finishedAt = new Date().toISOString(); this.store.save(); }
    } else if (control && !control.canceled) { control.paused = action === 'pause'; run.status = control.paused ? 'paused' : 'running'; }
    return run;
  }
  async execute({ run, workflow, settings }, control) {
    let context, page, outcome;
    let selectedProxy = {};
    let variables = {}, secretKeys = [];
    const redact = text => Object.entries(variables).filter(([key, value]) => (/password|secret|token/i.test(key) || secretKeys.includes(key)) && value).reduce((msg, [, value]) => msg.replaceAll(value, '[redacted]'), String(text));
    const log = (message, level = 'info') => { const safe = redact(message); run.logs.push({ time: new Date().toISOString(), message: safe, level }); this.monitor.event(run.id.slice(0, 8), safe, level); };
    const checkProxy = async phase => {
      if (run.proxy?.status === 'direct') return;
      run.proxy.status = 'checking';
      log(`Checking proxy in the run browser (${phase})`);
      const result = await verifyBrowserProxy(control.browser, { ...this.proxyCheckOptions, ...selectedProxy, ...(phase === 'start' ? { page } : {}), expectedIP: run.proxy.exitIP || selectedProxy.expectedIP });
      Object.assign(run.proxy, result, { status: 'verified', phase });
      run.proxy.checks.push({ ...result, phase });
      log(`Proxy verified (${phase}): ${result.exitIP}`, 'success');
    };
    const checkpoint = async () => {
      while (control.paused && !control.canceled) await new Promise(resolve => setTimeout(resolve, 100));
      if (control.canceled) throw new Error('Run canceled');
    };
    const screenshot = async label => {
      const filename = `${run.id}-${run.screenshots.length + 1}.png`;
      await page.screenshot({ path: path.join(this.store.root, 'screenshots', filename), fullPage: true, timeout: 5000 });
      run.screenshots.push({ label, url: `/screenshots/${filename}` });
      log(`Screenshot saved: ${label}`);
    };
    try {
      run.status = 'running'; run.startedAt = new Date().toISOString();
      workflow = this.formAnswers.prepareWorkflow(workflow);
      const generated = this.formAnswers.generateForRun(workflow.generator, {});
      variables = generated.variables; secretKeys = generated.secretKeys;
      if (workflow.generator?.enabled) {
        run.generatedValues = generated.generated;
        run.secretKeys = secretKeys;
        log(`Generated ${Object.keys(generated.generated).length} variables for this run`);
        await this.store.save();
      }
      // Validate all answers before opening the browser.
      for (const step of workflow.steps.filter(s => s.enabled)) { interpolate(step.value, variables); interpolate(step.selector, variables); }
      run.proxy = { status: 'selecting', checks: [] };
      const proxyOptions = await proxyLaunchOptions(this.store.root, process.env, { onProgress: message => log(message), onSelected: value => { selectedProxy = value; }, isCanceled: () => control.canceled || this.closing });
      run.proxy.status = proxyOptions.proxy ? 'checking' : 'direct';
      await checkpoint();
      // Do not persist proxy credentials or include them in log messages.
      log(proxyOptions.proxy ? 'Proxy configured for this browser session' : 'Direct connection configured');
      log(`Launching ${settings.browserId || 'chromium'} (${settings.headless ? 'background' : 'visible'})`);
      control.browser = await chromium.launch({ ...await browserLaunchOptions(settings.browserId), ...proxyOptions, headless: settings.headless });
      await checkpoint();
      const viewport = settings.headless ? { width: settings.viewportWidth || 1360, height: settings.viewportHeight || 900 } : null;
      context = await control.browser.newContext({ viewport });
      const pages = [];
      context.on('page', opened => { if (!pages.includes(opened)) pages.push(opened); this.watchPage(opened, log); log('Tab ' + pages.length + ' opened'); });
      if (settings.showCursor !== false) await context.addInitScript(showReplayCursor);
      page = await context.newPage();
      page.setDefaultTimeout(15000);
      log('Browser session opened');
      await checkProxy('start');
      await checkpoint();
      await page.goto(httpUrl.parse(workflow.startUrl), { waitUntil: 'domcontentloaded', timeout: 30000 });
      for (const step of workflow.steps.filter(s => s.enabled)) {
        await checkpoint();
        run.currentStep++;
        const tabId = step.pageId ?? 0;
        const tabDeadline = Date.now() + step.timeout;
        while (!pages[tabId]) {
          await checkpoint();
          if (Date.now() >= tabDeadline) throw new Error(`Tab ${tabId + 1} did not open. Check that the preceding action opens this tab.`);
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        page = pages[tabId];
        if (page.isClosed()) throw new Error(`Tab ${tabId + 1} was closed before this action.`);
        if (!settings.headless) await page.bringToFront();
        const value = interpolate(step.value, variables);
        const selector = interpolate(step.selector, variables);
        const locator = selector ? page.locator(selector) : null;
        const options = { timeout: step.timeout };
        log(`Step ${run.currentStep} · Tab ${tabId + 1}: ${step.label || step.type}`);
        const stepStarted = Date.now();
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
        log(`Step ${run.currentStep} completed in ${Date.now() - stepStarted} ms`);
      }
      await checkpoint();
      await checkProxy('end');
      await checkpoint();
      outcome = 'passed'; log('Workflow completed successfully', 'success');
    } catch (error) {
      if (['checking', 'selecting'].includes(run.proxy?.status)) {
        run.proxy.status = control.canceled ? 'canceled' : 'failed';
        run.proxy.error = redact(error.message);
      }
      outcome = control.canceled ? 'canceled' : 'failed';
      run.error = redact(error.message); log(run.error, 'error');
      if (!control.canceled && page && !page.isClosed()) await screenshot('Failure snapshot').catch(() => {});
    } finally {
      if (!settings.headless && settings.keepBrowserOpen !== false && !control.canceled && !this.closing && control.browser?.isConnected()) {
        const browser = control.browser;
        this.keptBrowsers.set(run.id, browser); run.browserOpen = true;
        browser.once('disconnected', () => { this.keptBrowsers.delete(run.id); run.browserOpen = false; this.monitor.event(run.id.slice(0, 8), 'Browser closed'); this.store.save(); });
        log('Browser kept open for inspection. Close it manually or use Close browser in Run history.');
      } else await control.browser?.close().catch(() => {});
      run.finishedAt = new Date().toISOString();
      run.status = control.canceled ? 'canceled' : outcome;
      this.monitor.event(run.id.slice(0, 8), 'Run finished: ' + run.status);
    }
  }
  async shutdown() {
    this.closing = true;
    this.monitor.event('app', 'Shutting down browsers');
    await Promise.all([...this.keptBrowsers.values()].map(browser => browser.close().catch(() => {})));
    if (this.recorder) await this.recorder.browser?.close();
    for (const [id] of this.active) this.control(id, 'cancel');
    await Promise.all([...this.active.values()].map(c => c.browser?.close().catch(() => {})));
  }
}
