import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(root) { this.root = root; this.state = { workflows: [], runs: [] }; this.queue = Promise.resolve(); }
  async init(baseUrl) {
    await mkdir(path.join(this.root, 'screenshots'), { recursive: true });
    try { this.state = JSON.parse(await readFile(path.join(this.root, 'store.json'), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state.workflows.push({ id: randomUUID(), name: 'Welcome aboard', description: 'A ready-to-run example. Fill out the practice form with generated answers and verify the result.', startUrl: `${baseUrl}/practice`, updatedAt: new Date().toISOString(), steps: [
        { type: 'fill', label: 'Enter full name', selector: '#full-name', value: '{{name}}' },
        { type: 'fill', label: 'Enter email address', selector: '#email', value: '{{email}}' },
        { type: 'select', label: 'Choose a team', selector: '#team', value: '{{team}}' },
        { type: 'check', label: 'Accept the invitation', selector: '#consent', value: 'true' },
        { type: 'click', label: 'Submit demo form', selector: '#submit', value: '' },
        { type: 'assert', label: 'Verify welcome message', selector: '#result', value: 'Welcome, {{name}}' },
        { type: 'screenshot', label: 'Capture the result', selector: '', value: '' },
      ].map(step => ({ id: randomUUID(), enabled: true, timeout: 15000, ...step })), generator: { enabled: true, fields: [
        { key: 'name', label: 'Name', kind: 'name' }, { key: 'email', label: 'Email', kind: 'email', value: 'example.test' }, { key: 'team', label: 'Team', kind: 'fixed', value: 'Engineering' },
      ] } });
    }
    // The desktop backend gets a free loopback port on each launch.
    const previousBase = this.state.localBaseUrl || 'http://127.0.0.1:4310';
    for (const workflow of this.state.workflows) {
      if (!workflow.generator && workflow.name === 'Welcome aboard' && workflow.steps.some(step => step.value === '{{team}}')) workflow.generator = { enabled: true, fields: [
        { key: 'name', label: 'Name', kind: 'name' }, { key: 'email', label: 'Email', kind: 'email', value: 'example.test' }, { key: 'team', label: 'Team', kind: 'fixed', value: 'Engineering' },
      ] };
      if (workflow.startUrl === `${previousBase}/practice`) workflow.startUrl = `${baseUrl}/practice`;
      for (const step of workflow.steps) if (step.type === 'navigate' && step.value === `${previousBase}/practice`) step.value = `${baseUrl}/practice`;
    }
    this.state.localBaseUrl = baseUrl;
    for (const run of this.state.runs) if (['queued', 'running', 'paused'].includes(run.status)) { run.status = 'interrupted'; run.error = 'Application restarted before this run completed.'; }
    for (const run of this.state.runs) run.browserOpen = false;
    await this.save();
  }
  save() {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.queue = this.queue.catch(() => {}).then(async () => {
      const temp = path.join(this.root, 'store.tmp');
      await writeFile(temp, snapshot); await rename(temp, path.join(this.root, 'store.json'));
    });
    return this.queue;
  }
}
