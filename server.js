import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { createServer } from 'node:http';
import { Store } from './lib/store.js';
import { Automation } from './lib/automation.js';
import { workflowSchema, generatorSchema } from './lib/schema.js';
import { formAnswers } from './lib/form-answers.js';
import { Monitor } from './lib/monitor.js';
import { browserIds, discoverBrowsers } from './lib/browsers.js';

const root = path.dirname(fileURLToPath(import.meta.url));
export async function createApp({ dataDir = path.join(root, 'data'), baseUrl = 'http://127.0.0.1:4310', headlessRecorder = false } = {}) {
  const app = express();
  const store = new Store(dataDir); await store.init(baseUrl);
  const monitor = new Monitor(dataDir);
  monitor.event('app', 'Backend starting');
  const automation = new Automation(store, { headlessRecorder, monitor });
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
    if (req.method !== 'GET') monitor.event('api', `${req.method} ${req.path}`);
    res.set('Cache-Control', 'no-store');
    if (req.headers.origin && req.headers.origin !== baseUrl) return res.status(403).json({ error: 'Cross-origin access denied.' });
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-browserauto-token'] !== token) return res.status(403).json({ error: 'Reload the app to renew the local session.' });
    next();
  });
  const workflow = id => { const value = store.state.workflows.find(w => w.id === id); if (!value) throw new Error('Workflow not found.'); return value; };
  app.get('/api/browsers', async (req, res) => res.json(await discoverBrowsers()));
  app.post('/api/generator/detect', (req, res) => res.json(workflowSchema.parse(formAnswers.detectFields(workflowSchema.parse(req.body)))));
  app.post('/api/generator/preview', (req, res) => {
    const generator = generatorSchema.parse(req.body);
    const result = formAnswers.generateForRun({ ...generator, fields: generator.fields.map(field => field.kind === 'profile' ? { ...field, kind: 'fixed', value: '(from selected profile)' } : field) });
    res.json({ values: result.generated, secretKeys: result.secretKeys });
  });
  app.get('/api/state', async (req, res) => {
    res.json({ token, workflows: store.state.workflows, runs: store.state.runs, recorder: automation.recorderState() });
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
  app.post('/api/record/start', async (req, res) => { const data = z.object({ workflowId: z.string().uuid(), browserId: z.enum(browserIds).default('chromium') }).parse(req.body); res.json(await automation.startRecording(workflow(data.workflowId), data.browserId)); });
  app.post('/api/record/pause', (req, res) => res.json(automation.pauseRecording(z.object({ paused: z.boolean() }).parse(req.body).paused)));
  app.post('/api/record/stop', async (req, res) => { res.json(await automation.stopRecording(z.object({ save: z.boolean() }).parse(req.body).save)); });
  app.post('/api/calibrate', async (req, res) => { const data = z.object({ selector: z.string().min(1).max(2000), pageId: z.number().int().min(0).max(100).optional() }).parse(req.body); res.json(await automation.calibrate(data.selector, data.pageId)); });
  app.post('/api/runs', async (req, res) => {
    const data = z.object({ name: z.string().trim().max(100).default(''), workflowId: z.string().uuid(), runCount: z.number().int().min(1).max(10).default(1), keepBrowserOpen: z.boolean().default(true), concurrency: z.number().int().min(1).max(8).default(3), headless: z.boolean().default(true), browserId: z.enum(browserIds).default('chromium'), replayMouse: z.boolean().default(true), showCursor: z.boolean().default(true), viewportWidth: z.number().int().min(320).max(3840).default(1360), viewportHeight: z.number().int().min(240).max(2160).default(900) }).parse(req.body);
    const w = workflow(data.workflowId); if (!w.steps.some(s => s.enabled)) throw new Error('Add at least one enabled step before running.');
    res.json(automation.enqueue(w, data));
  });
  app.post('/api/runs/:id/control', (req, res) => { res.json(automation.control(req.params.id, z.object({ action: z.enum(['pause', 'resume', 'cancel', 'close-browser']) }).parse(req.body).action)); });
  app.post('/api/runs/:id/rename', async (req, res) => {
    const { name } = z.object({ name: z.string().trim().max(100) }).parse(req.body);
    const run = store.state.runs.find(run => run.id === req.params.id);
    if (!run) throw new Error('Run not found.');
    run.name = name || run.workflowName;
    await store.save();
    res.json(run);
  });
  app.use('/screenshots', express.static(path.join(dataDir, 'screenshots')));
  app.use(express.static(path.join(root, 'public'), { extensions: ['html'] }));
  app.use((error, req, res, next) => {
    const message = error instanceof z.ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : error.message;
    monitor.event('api', `${req.method} ${req.path}: ${message}`, 'error');
    res.status(400).json({ error: message });
  });
  return { app, store, automation, monitor };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.PORT || 4310), '127.0.0.1', resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const { app, automation, store, monitor } = await createApp({ baseUrl, ...(process.env.BROWSERAUTO_DATA_DIR ? { dataDir: process.env.BROWSERAUTO_DATA_DIR } : {}) });
  server.on('request', app);
  monitor.event('app', `Backend ready at ${baseUrl}`);
  console.log(`BrowserAuto backend ready at ${baseUrl}`);
  process.send?.({ type: 'ready', baseUrl });
  let shuttingDown = false;
  const shutdown = async () => { if (shuttingDown) return; shuttingDown = true; await automation.shutdown(); while (automation.active.size) await new Promise(r => setTimeout(r, 50)); await store.queue; monitor.event('app', 'Backend stopped'); await monitor.queue; server.close(); process.exit(0); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
  process.on('message', message => { if (message?.type === 'shutdown') shutdown(); });
  if (process.connected) process.on('disconnect', shutdown);
}
