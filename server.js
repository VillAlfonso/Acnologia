import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { rm, access } from 'node:fs/promises';
import { z } from 'zod';
import { createServer } from 'node:http';
import { Store } from './lib/store.js';
import { Automation } from './lib/automation.js';
import { workflowSchema, profileSchema } from './lib/schema.js';
import { browserIds, discoverBrowsers } from './lib/browsers.js';

const root = path.dirname(fileURLToPath(import.meta.url));
export async function createApp({ dataDir = path.join(root, 'data'), baseUrl = 'http://127.0.0.1:4310', headlessRecorder = false } = {}) {
  const app = express();
  const store = new Store(dataDir); await store.init(baseUrl);
  const automation = new Automation(store, { headlessRecorder });
  const token = randomBytes(32).toString('hex');
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(req.hostname)) return res.status(403).json({ error: 'Local access only.' });
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(express.json({ limit: '12mb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.headers.origin && req.headers.origin !== baseUrl) return res.status(403).json({ error: 'Cross-origin access denied.' });
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-browserauto-token'] !== token) return res.status(403).json({ error: 'Reload the app to renew the local session.' });
    next();
  });
  const workflow = id => { const value = store.state.workflows.find(w => w.id === id); if (!value) throw new Error('Workflow not found.'); return value; };
  const profile = id => { const value = store.state.profiles.find(p => p.id === id); if (!value) throw new Error('Profile not found.'); return value; };
  app.get('/api/browsers', async (req, res) => res.json(await discoverBrowsers()));
  app.get('/api/state', async (req, res) => {
    const profiles = await Promise.all(store.state.profiles.map(async p => { let hasSession = false; try { await access(store.sessionPath(p.id)); hasSession = true; } catch {} return { ...p, hasSession }; }));
    res.json({ token, workflows: store.state.workflows, profiles, runs: store.state.runs, recorder: automation.recorderState() });
  });
  app.post('/api/workflows', async (req, res) => {
    const value = workflowSchema.parse(req.body);
    if (value.id && automation.recorder?.workflowId === value.id) throw new Error('Stop recording before editing this workflow.');
    const item = { ...value, id: value.id || randomUUID(), updatedAt: new Date().toISOString() };
    const index = store.state.workflows.findIndex(w => w.id === item.id);
    if (index < 0) store.state.workflows.push(item); else store.state.workflows[index] = item;
    await store.save(); res.json(item);
  });
  app.delete('/api/workflows/:id', async (req, res) => {
    workflow(req.params.id);
    if (automation.recorder?.workflowId === req.params.id) throw new Error('Stop recording before deleting this workflow.');
    store.state.workflows = store.state.workflows.filter(w => w.id !== req.params.id); await store.save(); res.json({ ok: true });
  });
  app.post('/api/profiles', async (req, res) => {
    const value = profileSchema.parse(req.body); const item = { ...value, id: value.id || randomUUID() };
    const index = store.state.profiles.findIndex(p => p.id === item.id);
    if (index < 0) store.state.profiles.push(item); else store.state.profiles[index] = item;
    await store.save(); res.json(item);
  });
  app.delete('/api/profiles/:id', async (req, res) => {
    profile(req.params.id);
    if (automation.recorder?.profileId === req.params.id || store.state.runs.some(r => r.profileId === req.params.id && ['running', 'queued', 'paused'].includes(r.status))) throw new Error('Stop this profile’s active sessions first.');
    await rm(store.sessionPath(req.params.id), { force: true });
    store.state.profiles = store.state.profiles.filter(p => p.id !== req.params.id); await store.save(); res.json({ ok: true });
  });
  app.post('/api/record/start', async (req, res) => { const data = z.object({ workflowId: z.string().uuid(), profileId: z.string().uuid(), browserId: z.enum(browserIds).default('chromium') }).parse(req.body); profile(data.profileId); res.json(await automation.startRecording(workflow(data.workflowId), data.profileId, data.browserId)); });
  app.post('/api/record/pause', (req, res) => res.json(automation.pauseRecording(z.object({ paused: z.boolean() }).parse(req.body).paused)));
  app.post('/api/record/stop', async (req, res) => { res.json(await automation.stopRecording(z.object({ save: z.boolean() }).parse(req.body).save)); });
  app.post('/api/calibrate', async (req, res) => { const data = z.object({ selector: z.string().min(1).max(2000), pageId: z.number().int().min(0).max(100).optional() }).parse(req.body); res.json(await automation.calibrate(data.selector, data.pageId)); });
  app.post('/api/runs', async (req, res) => {
    const data = z.object({ workflowId: z.string().uuid(), profileIds: z.array(z.string().uuid()).min(1).max(10), concurrency: z.number().int().min(1).max(8).default(3), headless: z.boolean().default(true), browserId: z.enum(browserIds).default('chromium'), replayMouse: z.boolean().default(true), showCursor: z.boolean().default(true), viewportWidth: z.number().int().min(320).max(3840).default(1360), viewportHeight: z.number().int().min(240).max(2160).default(900) }).parse(req.body);
    const selected = [...new Set(data.profileIds)].map(profile);
    const w = workflow(data.workflowId); if (!w.steps.some(s => s.enabled)) throw new Error('Add at least one enabled step before running.');
    res.json(automation.enqueue(w, selected, data));
  });
  app.post('/api/runs/:id/control', (req, res) => { res.json(automation.control(req.params.id, z.object({ action: z.enum(['pause', 'resume', 'cancel']) }).parse(req.body).action)); });
  app.use('/screenshots', express.static(path.join(dataDir, 'screenshots')));
  app.use(express.static(path.join(root, 'public'), { extensions: ['html'] }));
  app.use((error, req, res, next) => {
    const message = error instanceof z.ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : error.message;
    res.status(400).json({ error: message });
  });
  return { app, store, automation };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.PORT || 4310), '127.0.0.1', resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const { app, automation, store } = await createApp({ baseUrl, ...(process.env.BROWSERAUTO_DATA_DIR ? { dataDir: process.env.BROWSERAUTO_DATA_DIR } : {}) });
  server.on('request', app);
  console.log(`BrowserAuto backend ready at ${baseUrl}`);
  process.send?.({ type: 'ready', baseUrl });
  let shuttingDown = false;
  const shutdown = async () => { if (shuttingDown) return; shuttingDown = true; await automation.shutdown(); while (automation.active.size) await new Promise(r => setTimeout(r, 50)); await store.queue; server.close(); process.exit(0); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
  process.on('message', message => { if (message?.type === 'shutdown') shutdown(); });
  if (process.connected) process.on('disconnect', shutdown);
}
