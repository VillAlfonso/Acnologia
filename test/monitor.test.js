import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.js';

test('visible failure stays open, recording navigation failure stays open, and monitor records redacted events', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browserauto-monitor-'));
  const { app, store, automation, monitor } = await createApp({ dataDir: root });
  app.get('/fixture', (_req, res) => res.send('<input id="password" type="password">'));
  app.get('/broken', req => req.socket.destroy());
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await automation.shutdown(); await store.queue; await monitor.queue; await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const workflow = { id: randomUUID(), name: 'Monitor check', startUrl: `${base}/fixture`, generator: { enabled: true, fields: [{ key: 'password', kind: 'password', length: 16 }] }, steps: [
    { type: 'fill', enabled: true, selector: '#password', value: '{{password}}', timeout: 1000 },
    { type: 'click', enabled: true, selector: '#missing', value: '', timeout: 100 },
  ] };
  const run = { id: randomUUID(), logs: [], screenshots: [], currentStep: 0 };
  store.state.runs.push(run);
  await automation.execute({ run, workflow, settings: { headless: false, keepBrowserOpen: true } }, { canceled: false });
  assert.equal(run.status, 'failed');
  assert.equal(run.browserOpen, true);
  assert.equal(automation.keptBrowsers.get(run.id).isConnected(), true);
  const closed = new Promise(resolve => automation.keptBrowsers.get(run.id).once('disconnected', resolve));
  automation.control(run.id, 'close-browser');
  await closed;
  assert.equal(run.browserOpen, false);
  await automation.startRecording({ ...workflow, startUrl: `${base}/broken` });
  assert.equal(automation.recorder.status, 'recording');
  assert.equal(automation.recorder.browser.isConnected(), true);
  assert.match(automation.recorder.error, /kept open/);
  await automation.stopRecording(false);
  await monitor.queue;
  const log = await readFile(monitor.file, 'utf8');
  assert.match(log, /Step 1 completed/);
  assert.match(log, /Run finished: failed/);
  assert.match(log, /\[capture\]/);
  assert.ok(!log.includes(run.generatedValues.password));
  const response = await (await fetch(`${base}/api/state`)).json();
  assert.equal('profiles' in response, false);
  assert.equal((await fetch(`${base}/api/profiles`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrowserAuto-Token': response.token }, body: '{}' })).status, 404);
});
