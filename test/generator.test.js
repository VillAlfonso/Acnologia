import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createApp } from '../server.js';
import { parameterizeWorkflow, generateValues } from '../lib/generator.js';
import { workflowSchema, generatorSchema } from '../lib/schema.js';
import { formAnswers } from '../lib/form-answers.js';

test('legacy fields become ordered variables; confirmation reuses password and schema rejects invalid references', () => {
  const converted = workflowSchema.parse(parameterizeWorkflow({ name: 'Old recording', startUrl: 'https://example.test', steps: ['Name', 'Email', 'Password', 'Confirm password'].map((label, i) => ({ id: String(i), type: 'fill', label, selector: `#field-${i}`, value: 'old-value' })) }));
  assert.deepEqual(converted.generator.fields.map(f => f.key), ['name', 'email', 'password', 'confirm_password']);
  const first = generateValues(converted.generator), second = generateValues(converted.generator);
  assert.equal(first.generated.password, first.generated.confirm_password);
  assert.notEqual(first.generated.password, second.generated.password);
  assert.notEqual(first.generated.email, second.generated.email);
  assert.match(first.generated.password, /[A-Z]/); assert.match(first.generated.password, /[a-z]/); assert.match(first.generated.password, /[0-9]/); assert.match(first.generated.password, /[!@#$%&*]/);
  assert.deepEqual(first.secretKeys, ['password', 'confirm_password']);
  assert.throws(() => generatorSchema.parse({ fields: [{ key: 'confirm_password', kind: 'reference', source: 'missing' }] }));
  assert.throws(() => generatorSchema.parse({ fields: [{ key: '__proto__', kind: 'text' }] }));
  assert.deepEqual(generateValues({ enabled: false, fields: [] }, { name: 'Fixed' }).variables, { name: 'Fixed' });
  const captured = { ...converted, generator: undefined, steps: converted.steps.map(step => ({ ...step, field: { hint: step.label, type: 'text', empty: false } })) };
  const prepared = formAnswers.prepareWorkflow(captured);
  assert.equal(prepared.generator.enabled, true);
  assert.equal(captured.generator, undefined, 'Preparing a run must not mutate its recording');
  const disabled = { ...converted, generator: { ...converted.generator, enabled: false } };
  assert.equal(formAnswers.prepareWorkflow(disabled).generator.enabled, false);
});

test('record, edit generator, replay fresh values, and reveal saved output', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browserauto-generator-'));
  const base = 'http://127.0.0.1:4312';
  const { app, store, automation } = await createApp({ dataDir: root, baseUrl: base, headlessRecorder: true });
  app.get('/signup-fixture', (_req, res) => res.type('html').send(`<!doctype html><form onsubmit="event.preventDefault();document.querySelector('#result').textContent = document.querySelector('#password').value === document.querySelector('#confirm-password').value ? 'Matched' : 'Mismatch'">
    <label>Name<input id="name" name="name" required></label><label>Email<input id="email" type="email" required></label>
    <label>Password<input id="password" type="password" minlength="8" required></label><label>Confirm password<input id="confirm-password" type="password" required></label>
    <button id="submit">Submit</button></form><p id="result"></p><div id="notes" contenteditable="true" aria-label="Notes"></div>`));
  const server = await new Promise(resolve => { const listener = app.listen(4312, '127.0.0.1', () => resolve(listener)); });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await automation.shutdown(); while (automation.active.size) await new Promise(resolve => setTimeout(resolve, 20)); await store.queue; await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const state = await (await fetch(`${base}/api/state`)).json();
  const post = async (url, data) => { const r = await fetch(`${base}/api${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrowserAuto-Token': state.token }, body: JSON.stringify(data) }); const result = await r.json(); assert.equal(r.status, 200, JSON.stringify(result)); return result; };
  const until = async fn => { for (let i = 0; i < 200; i++) { const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error('Timed out'); };
  const workflow = await post('/workflows', { name: 'Generated form', startUrl: `${base}/signup-fixture` });
  await post('/record/start', { workflowId: workflow.id });
  const page = automation.recorder.page;
  await page.locator('#name').pressSequentially('Private Recorded Name');
  await page.locator('#email').fill('private-recorded@example.test');
  await page.locator('#password').fill('private-recorded-password');
  await page.locator('#confirm-password').fill('private-recorded-password');
  await page.locator('#submit').click();
  await page.locator('#notes').fill('Private notes');
  await until(() => automation.recorder.steps.filter(s => s.type === 'fill').length === 5);
  assert.ok(!JSON.stringify(automation.recorderState()).includes('private-recorded'));
  assert.ok(!JSON.stringify(automation.recorderState()).includes('Private Recorded Name'));
  assert.ok(!JSON.stringify(automation.recorderState()).includes('Private notes'));
  await post('/record/stop', { save: true });
  let saved = store.state.workflows.find(w => w.id === workflow.id);
  assert.deepEqual(saved.generator.fields.map(f => f.key), ['name', 'email', 'password', 'confirm_password', 'text']);
  saved.steps.push({ id: randomUUID(), type: 'assert', selector: '#result', value: 'Matched', enabled: true, timeout: 2000 });
  saved = await post('/workflows', saved);
  const ui = await browser.newPage();
  await ui.goto(base);
  await ui.getByRole('button', { name: 'Generated form', exact: true }).click();
  await ui.locator('#generator-button').click();
  await ui.locator('#generator-preview').click();
  await ui.locator('#generator-preview-output:not([hidden])').waitFor();
  const preview = JSON.parse(await ui.locator('#generator-preview-output').innerText());
  assert.equal(preview.password, preview.confirm_password);
  await mkdir('test-results', { recursive: true });
  await ui.screenshot({ path: 'test-results/generator-editor.png', fullPage: true });
  await ui.locator('[name="length_2"]').fill('24');
  await ui.locator('#dialog-submit').click();
  await ui.locator('#dialog:not([open])').waitFor({ state: 'attached' });
  const results = [];
  for (let i = 0; i < 2; i++) {
    const [queued] = await post('/runs', { workflowId: workflow.id, headless: true });
    const run = await until(() => { const r = store.state.runs.find(r => r.id === queued.id); return ['passed', 'failed'].includes(r.status) && r; });
    assert.equal(run.status, 'passed', run.error);
    assert.equal(run.generatedValues.password.length, 24);
    assert.equal(run.generatedValues.confirm_password, run.generatedValues.password);
    assert.ok(!JSON.stringify(run.logs).includes(run.generatedValues.password));
    results.push(run);
  }
  assert.notEqual(results[0].generatedValues.email, results[1].generatedValues.email);
  await ui.locator('[data-view="runs"]').click();
  await ui.locator(`[data-run="${results[1].id}"]`).click();
  await ui.locator('.generated-values').waitFor();
  await ui.screenshot({ path: 'test-results/generated-run.png', fullPage: true });
  assert.ok(!(await ui.locator('.generated-values').innerText()).includes(results[1].generatedValues.password));
  await ui.locator('[data-reveal-generated]').click();
  assert.ok((await ui.locator('.generated-values').innerText()).includes(results[1].generatedValues.password));
  await store.queue;
  const persisted = JSON.parse(await readFile(path.join(root, 'store.json'), 'utf8'));
  assert.equal(persisted.runs.find(r => r.id === results[1].id).generatedValues.password, results[1].generatedValues.password);
  // Existing recordings work directly on Run without manually configuring a generator.
  const legacy = structuredClone(store.state.workflows.find(w => w.id === workflow.id));
  delete legacy.generator;
  await post('/workflows', legacy);
  const [queued] = await post('/runs', { workflowId: workflow.id, headless: true });
  const upgraded = await until(() => { const r = store.state.runs.find(r => r.id === queued.id); return ['passed', 'failed'].includes(r.status) && r; });
  assert.equal(upgraded.status, 'passed', upgraded.error);
  assert.equal(upgraded.generatedValues.password, upgraded.generatedValues.confirm_password);
  assert.notEqual(upgraded.generatedValues.password, results[1].generatedValues.password);
});
