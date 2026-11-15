import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';

const { values } = parseArgs({ options: { browser: { type: 'string', default: 'chrome' }, url: { type: 'string' }, name: { type: 'string', default: 'Browser capture' }, server: { type: 'string', default: 'http://127.0.0.1:4310' }, help: { type: 'boolean' } } });
if (values.help || !values.url) {
  console.log('Usage: npm run record -- --browser brave --url https://example.com [--server http://127.0.0.1:4310]');
  console.log('Start the command-line backend first with: npm run backend');
  process.exit(values.help ? 0 : 1);
}
const base = new URL(values.server);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.protocol !== 'http:') throw new Error('The backend must be a local HTTP address.');
try {
  let state = await (await fetch(`${base.origin}/api/state`)).json();
  const post = async (endpoint, body) => {
    const response = await fetch(`${base.origin}/api${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrowserAuto-Token': state.token }, body: JSON.stringify(body) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
  };
  const available = await (await fetch(`${base.origin}/api/browsers`)).json();
  if (!available.find(b => b.id === values.browser)?.available) throw new Error(`${values.browser} is unavailable. Available: ${available.filter(b => b.available).map(b => b.id).join(', ')}`);
  if (state.recorder) throw new Error('A recording is already active. Stop it first.');
  const workflow = await post('/workflows', { name: values.name, startUrl: values.url, steps: [] });
  await post('/record/start', { workflowId: workflow.id, browserId: values.browser });
  console.log(`Capturing ${values.browser}. Click and type in its window. Workflow: ${workflow.id}`);
  console.log('Commands: Enter / save = stop and save; pause; resume; discard.');
  let last = 0, busy = false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const timer = setInterval(async () => {
    try {
      state = await (await fetch(`${base.origin}/api/state`)).json();
      for (const step of state.recorder?.steps.slice(last) || []) console.log(`${++last}. ${step.type} ${step.selector}`);
      if (!state.recorder) { clearInterval(timer); rl.close(); }
    } catch (error) { console.error(error.message); clearInterval(timer); rl.close(); }
  }, 750);
  rl.on('line', async line => {
    if (busy) return; busy = true;
    try {
      const command = line.trim().toLowerCase();
      if (['pause', 'resume'].includes(command)) { await post('/record/pause', { paused: command === 'pause' }); console.log(command); }
      else if (['', 'save', 'discard'].includes(command)) { const result = await post('/record/stop', { save: command !== 'discard' }); console.log(`${result.saved ? 'Saved' : 'Discarded'} ${result.count} actions.`); clearInterval(timer); rl.close(); }
      else console.log('Use save, pause, resume, or discard.');
    } catch (error) { console.error(error.message); } finally { busy = false; }
  });
} catch (error) { console.error(error.cause?.code === 'ECONNREFUSED' ? 'Backend unavailable. Run npm run backend first, or pass --server with the desktop backend address from its log.' : error.message); process.exitCode = 1; }
