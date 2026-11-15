import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../lib/store.js';
import { Automation } from '../lib/automation.js';
import { proxyLaunchOptions } from '../lib/proxy.js';

test('proxy configuration rejects malformed settings and expands fresh sessions', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browserauto-proxy-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await proxyLaunchOptions(root, {}), {});
  await writeFile(path.join(root, 'proxy.json'), JSON.stringify({ server: 'http://localhost:1234', username: 'user-{{session}}', password: 'secret' }));
  const a = await proxyLaunchOptions(root, {}), b = await proxyLaunchOptions(root, {});
  assert.notEqual(a.proxy.username, b.proxy.username);
  assert.equal(a.proxy.password, 'secret');
  await assert.rejects(proxyLaunchOptions(root, { BROWSERAUTO_PROXY_SERVER: 'http://user:secret@localhost:1234' }), /without embedded credentials/);
  await writeFile(path.join(root, 'proxy.json'), '{broken');
  await assert.rejects(proxyLaunchOptions(root, {}), /valid JSON/);
});

test('recording and each run use authenticated proxy sessions; unavailable proxy fails the run', { timeout: 45000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browserauto-proxy-'));
  const sessions = new Set();
  let exitIP = '1.1.1.1', changeAfterCheck = false, checks = 0;
  const proxy = createServer((req, res) => {
    const auth = req.headers['proxy-authorization'];
    if (!auth) { res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="test"' }); res.end(); return; }
    const credentials = Buffer.from(auth.slice(6), 'base64').toString();
    if (!/^test-[a-f0-9]{32}:test-password$/.test(credentials)) { res.writeHead(403); res.end(); return; }
    if (req.url === 'http://proxy-check.invalid/ip') {
      checks++;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(changeAfterCheck && checks > 1 ? '1.0.0.1' : exitIP);
      return;
    }
    if (req.url === 'http://proxy-check.invalid/') sessions.add(credentials);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><p id="result">Through the proxy</p>');
  });
  proxy.on('connect', (_req, socket) => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const store = new Store(root);
  await store.init('http://127.0.0.1:4310');
  const automation = new Automation(store, { headlessRecorder: true, proxyCheckOptions: { url: 'http://proxy-check.invalid/ip', getDirectIP: async () => '9.9.9.9' } });
  t.after(async () => { await automation.shutdown(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); await rm(root, { recursive: true, force: true }); });
  await writeFile(path.join(root, 'proxy.json'), JSON.stringify({ server: `http://127.0.0.1:${proxy.address().port}`, username: 'test-{{session}}', password: 'test-password' }));
  const workflow = { id: randomUUID(), startUrl: 'http://proxy-check.invalid/', steps: [{ type: 'assert', enabled: true, selector: '#result', value: 'Through the proxy', timeout: 2000 }] };
  await automation.startRecording(workflow);
  assert.equal(await automation.recorder.page.locator('#result').innerText(), 'Through the proxy');
  await automation.stopRecording(false);
  for (let i = 0; i < 2; i++) {
    const run = { id: randomUUID(), logs: [], screenshots: [], currentStep: 0 };
    await automation.execute({ run, workflow, settings: { headless: true } }, { canceled: false });
    assert.equal(run.status, 'passed', run.error);
    assert.equal(run.proxy.status, 'verified');
    assert.equal(run.proxy.exitIP, '1.1.1.1');
    assert.deepEqual(run.proxy.checks.map(check => check.phase), ['start', 'end']);
    assert.ok(!JSON.stringify(run).includes('test-password'));
  }
  assert.equal(sessions.size, 3);
  exitIP = '9.9.9.9';
  const leaking = { id: randomUUID(), logs: [], screenshots: [], currentStep: 0 };
  await automation.execute({ run: leaking, workflow, settings: { headless: true } }, { canceled: false });
  assert.equal(leaking.status, 'failed');
  assert.equal(leaking.proxy.status, 'failed');
  assert.equal(leaking.currentStep, 0);
  assert.match(leaking.error, /matches the direct IP/);
  exitIP = '1.1.1.1'; changeAfterCheck = true; checks = 0;
  const changed = { id: randomUUID(), logs: [], screenshots: [], currentStep: 0 };
  await automation.execute({ run: changed, workflow, settings: { headless: true } }, { canceled: false });
  assert.equal(changed.status, 'failed');
  assert.equal(changed.proxy.status, 'failed');
  assert.equal(changed.currentStep, 1);
  assert.match(changed.error, /changed from the expected/);
  // A proxy that refuses connections must not silently fall back to direct access.
  await writeFile(path.join(root, 'proxy.json'), JSON.stringify({ server: 'http://127.0.0.1:1' }));
  const run = { id: randomUUID(), logs: [], screenshots: [], currentStep: 0 };
  await automation.execute({ run, workflow, settings: { headless: true } }, { canceled: false });
  assert.equal(run.status, 'failed');
  assert.equal(run.proxy.status, 'failed');
  assert.match(run.error, /Could not verify the browser exit IP/);
});
