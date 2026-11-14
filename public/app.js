const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icons = { navigate: '↗', click: '↖', fill: 'T', select: '≡', check: '✓', press: '↵', wait: '◷', assert: '✓', screenshot: '▧', move: '⌖' };
const labels = { navigate: 'Navigate', click: 'Click', fill: 'Fill text', select: 'Select option', check: 'Check / uncheck', press: 'Press key', wait: 'Wait', assert: 'Assert text', screenshot: 'Screenshot', move: 'Mouse movement' };
let state = { workflows: [], profiles: [], runs: [] }, current, selectedStep, view = 'builder', dirty = false, jsonDirty = false, selectedRun, toastTimer, dialogHandler;
let browsers = [], captureSignature = '';
let urlCaptureTimer, startingUrlCapture = false;
function cancelUrlCapture() { clearTimeout(urlCaptureTimer); urlCaptureTimer = undefined; }
function validStartUrl(value) {
  try {
    const text = value.trim();
    if (!text || /\s/.test(text)) return null;
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!['http:', 'https:'].includes(url.protocol) || (!url.hostname.includes('.') && url.hostname !== 'localhost' && url.hostname !== '[::1]')) return null;
    return url.href;
  } catch { return null; }
}
async function startCaptureFromUrl(workflowId, typedValue) {
  cancelUrlCapture();
  if (startingUrlCapture || state.recorder || !current || current.id !== workflowId || $('#start-url').value !== typedValue) return;
  const url = validStartUrl(typedValue); if (!url) return;
  startingUrlCapture = true; renderRecorder();
  try {
    current.startUrl = url; dirty = true;
    await saveWorkflow();
    const profile = state.profiles[0] || await api('/profiles', { name: 'Capture profile', variables: {} });
    await api('/record/start', { workflowId, profileId: profile.id, browserId: $('#browser-select').value });
    $('#visual-tab').click(); await refresh(); toast('Recording started — use the opened browser');
  } catch (error) { toast(`Could not start recording: ${error.message}`, true); }
  finally { startingUrlCapture = false; renderRecorder(); }
}
const activeCapture = () => state.recorder && state.recorder.workflowId === current?.id;
const displayedSteps = () => activeCapture() ? state.recorder.steps : current?.steps || [];
async function refreshBrowsers() {
  const response = await fetch('/api/browsers'); if (!response.ok) throw new Error('Unable to detect browsers');
  browsers = await response.json();
  const preference = localStorage.getItem('browserauto-browser');
  const selected = browsers.find(b => b.id === preference && b.available)?.id || ['brave', 'opera', 'opera-gx', 'chrome', 'edge', 'chromium'].find(id => browsers.some(b => b.id === id && b.available));
  $('#browser-select').innerHTML = browsers.map(b => `<option value="${b.id}" ${!b.available ? 'disabled' : ''}>${esc(b.name)}${b.available ? '' : ' — not installed'}</option>`).join('');
  if (selected) $('#browser-select').value = selected;
}
async function api(url, body, method = 'POST') {
  const response = await fetch(`/api${url}`, { method, headers: { 'Content-Type': 'application/json', 'X-BrowserAuto-Token': state.token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Request failed'); return data;
}
function toast(message, error = false) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').className = error ? 'error' : ''; $('#toast').hidden = false; toastTimer = setTimeout(() => $('#toast').hidden = true, 6000); }
function handle(fn) { return async (...args) => { try { await fn(...args); } catch (error) { toast(error.message, true); } }; }
function markDirty() { dirty = true; $('#save-status').textContent = 'Unsaved changes'; }
async function refresh() {
  const response = await fetch('/api/state'); if (!response.ok) throw new Error('Unable to connect to the local engine.'); state = await response.json();
  renderSidebar(); renderRecorder();
  if (view === 'runs') renderRuns();
}
function switchView(next) {
  view = next;
  $$('.view').forEach(el => el.hidden = el.id !== `${view}-view`);
  $$('#nav button').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  $('#page-label').textContent = { builder: 'Capture builder', profiles: 'Profiles', runs: 'Run history' }[view];
  if (view === 'profiles') renderProfiles(); if (view === 'runs') renderRuns();
}
function renderSidebar() {
  $('#workflow-list').innerHTML = state.workflows.map(w => `<button class="workflow-item ${current?.id === w.id ? 'selected' : ''}" data-workflow="${w.id}"><i></i><span>${esc(w.name)}</span></button>`).join('') || '<div class="empty-state">Create your first workflow.</div>';
  $('#profile-count').textContent = state.profiles.length; $('#run-count').textContent = state.runs.length;
}
function chooseWorkflow(id) {
  if (startingUrlCapture) return;
  cancelUrlCapture();
  if ((dirty || jsonDirty) && !confirm('Discard unsaved changes to this workflow?')) return;
  current = structuredClone(state.workflows.find(w => w.id === id)); dirty = false; jsonDirty = false; selectedStep = current?.steps[0]?.id;
  $('#visual-tab').click();
  switchView('builder'); renderBuilder(); renderSidebar();
}
function renderBuilder() {
  $('#workflow-name').value = current?.name || ''; $('#start-url').value = current?.startUrl || '';
  $('#open-page').href = current?.startUrl || '#';
  $('#save-status').textContent = dirty ? 'Unsaved changes' : 'All changes saved locally';
  for (const id of ['run-button', 'save-button', 'export-button', 'record-button', 'add-step']) $(`#${id}`).disabled = !current;
  renderSteps(); renderInspector();
  renderRecorder();
}
function renderSteps() {
  const steps = displayedSteps();
  $('#step-count').textContent = `${steps.length} steps`; $('#canvas-footer-count').textContent = `${steps.filter(s => s.enabled).length} enabled steps`;
  $('#steps').innerHTML = steps.map((s, i) => `<div class="step ${s.id === selectedStep ? 'active' : ''} ${!s.enabled ? 'disabled' : ''}" tabindex="0" role="button" data-step="${esc(s.id)}" aria-label="Edit ${esc(s.label || labels[s.type])}"><span class="step-number">${String(i + 1).padStart(2, '0')}</span><span class="step-icon ${esc(s.type)}">${icons[s.type]}</span><div class="step-text"><strong>${esc(s.label || labels[s.type])}</strong><small>${esc(s.selector || s.value || 'Save a full-page snapshot')}</small></div><span class="step-type">${esc(s.type)}</span><span class="step-chevron">›</span></div>`).join('') || '<div class="empty-state"><strong>Your next routine starts here</strong>Record a task in the browser, or add your first step below.</div>';
}
function renderInspector() {
  const s = displayedSteps().find(s => s.id === selectedStep);
  if (!s) { $('#step-inspector').innerHTML = '<h3>Step settings</h3><p class="muted">Select a step to edit its action, locator, or value.</p>'; return; }
  const needsSelector = ['click', 'fill', 'select', 'check', 'press', 'assert'].includes(s.type);
  const needsValue = !['click', 'screenshot', 'move'].includes(s.type);
  const hints = { navigate: 'An http or https URL', fill: 'Text or a variable, like {{email}}', select: 'The option label or value', check: 'true to check, false to uncheck', press: 'For example: Enter, Tab, Control+A', wait: 'Duration in milliseconds (0–120000)', assert: 'Text the element must contain' };
  $('#step-inspector').innerHTML = `<h3>Action properties <span>STEP ${displayedSteps().indexOf(s) + 1}</span></h3><label class="form-field">Step name<input data-field="label" value="${esc(s.label)}" maxlength="200"></label><label class="form-field">Action<select data-field="type">${Object.entries(labels).map(([value, label]) => `<option value="${value}" ${s.type === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>${needsSelector ? `<label class="form-field">Element selector<input data-field="selector" value="${esc(s.selector)}" placeholder="#email or text=Continue"><small>CSS or a Playwright selector. Must match one element.</small></label><button id="test-selector" class="button secondary">Test selector</button><div id="calibration-result" class="calibration-result"></div>` : ''}${needsValue ? `<label class="form-field">${s.type === 'wait' ? 'Duration' : 'Value'}<textarea data-field="value" rows="2">${esc(s.value)}</textarea><small>${esc(hints[s.type])}</small></label>` : ''}<label class="form-field">Timeout (ms)<input data-field="timeout" type="number" min="100" max="120000" value="${s.timeout}"></label><div class="step-controls"><label><input data-field="enabled" type="checkbox" ${s.enabled ? 'checked' : ''}> Enabled</label><button class="icon-button" data-step-action="up" title="Move step up">↑</button><button class="icon-button" data-step-action="down" title="Move step down">↓</button><button class="icon-button danger" data-step-action="delete" title="Delete step">×</button></div><div class="capture-details"><h4>Captured element HTML</h4>${s.capture ? `<dl class="capture-meta"><dt>Element</dt><dd>&lt;${esc(s.capture.tag)}&gt;</dd><dt>Page</dt><dd>${esc(s.capture.pageUrl)}</dd><dt>Captured</dt><dd>${esc(new Date(s.capture.timestamp).toLocaleTimeString())}</dd></dl><pre id="capture-html" class="capture-html">${esc(s.capture.html)}</pre><button id="copy-html" class="button secondary">Copy HTML</button>` : '<p class="muted">No HTML captured. Record an action in the browser to inspect its element here.</p>'}</div>`;
  if (s.mousePath?.length) {
    const last = s.mousePath.at(-1);
    $('#step-inspector').insertAdjacentHTML('beforeend', `<div class="capture-details"><h4>Recorded cursor path · ${s.mousePath.length} points</h4><svg class="cursor-map" viewBox="0 0 300 120" aria-label="Recorded cursor trail"><polyline points="${s.mousePath.map(p => `${p.x * 300},${p.y * 120}`).join(' ')}" fill="none" stroke="#0067b8" stroke-width="1.5"/><circle cx="${last.x * 300}" cy="${last.y * 120}" r="3" fill="#c22"/></svg><p class="muted">Viewport: ${last.width} × ${last.height}. Replay scales the path to the current browser size.</p></div>`);
  }
  if (s.clickPosition) $('#step-inspector').insertAdjacentHTML('beforeend', `<p class="muted">Click position within element: ${(s.clickPosition.x * 100).toFixed(1)}% across, ${(s.clickPosition.y * 100).toFixed(1)}% down. The selector finds the button at replay time.</p>`);
  if (activeCapture()) $$('[data-field], [data-step-action]', $('#step-inspector')).forEach(el => el.disabled = true);
}
function renderRecorder() {
  const r = state.recorder;
  const points = (activeCapture() ? r.steps : current?.steps || []).filter(s => s.type === 'move').flatMap(s => s.mousePath || []);
  const lastPoint = points.at(-1);
  $('#cursor-status').textContent = lastPoint ? `${points.length} points · x ${Math.round(lastPoint.x * lastPoint.width)}, y ${Math.round(lastPoint.y * lastPoint.height)} · viewport ${lastPoint.width} × ${lastPoint.height}` : 'Cursor tracking enabled · move the mouse in the recording page';
  $('#recording-controls').hidden = !r; $('#record-button').hidden = !!r;
  $('#recorder-status').textContent = r ? r.status === 'recording' ? 'Live' : r.status : 'Ready';
  $('#browser-select').disabled = !!r || startingUrlCapture;
  $('#record-button').disabled = !current || startingUrlCapture;
  $('#record-pause').textContent = r?.status === 'paused' ? 'Resume' : 'Pause';
  $('#record-pause').disabled = !['recording', 'paused'].includes(r?.status);
  $('#recording-info').textContent = r ? `${r.browserId} · ${r.steps.length} actions captured${r.error ? ` · ${r.error}` : ` · ${r.url || 'Opening browser…'}`}` : startingUrlCapture ? 'Opening browser and starting recording…' : 'Enter a Start URL to begin recording automatically after 1 second. Press Enter to start immediately. Uses the first profile.';
  $('#capture-mode').textContent = activeCapture() ? 'Live capture — stop to edit' : 'Editor';
  for (const id of ['save-button', 'add-step', 'apply-json', 'workflow-name', 'start-url']) $(`#${id}`).disabled = !current || !!activeCapture() || startingUrlCapture;
  $('#run-button').disabled = !current || !!activeCapture();
  $('#json-tab').disabled = !!activeCapture();
  const signature = activeCapture() ? JSON.stringify([r.status, r.steps.length, r.steps.at(-1)]) : '';
  if (signature !== captureSignature) {
    captureSignature = signature;
    if (!displayedSteps().some(s => s.id === selectedStep)) selectedStep = activeCapture() ? r.steps.at(-1)?.id : current?.steps[0]?.id;
    renderSteps(); renderInspector();
  }
}
async function saveWorkflow() {
  if (!current) throw new Error('Create a workflow first.');
  const value = jsonDirty ? { ...JSON.parse($('#json-editor').value), id: current.id } : current;
  current = await api('/workflows', value); dirty = false; jsonDirty = false; await refresh(); renderBuilder(); return current;
}
function openDialog(title, body, submit, handler) {
  $('#dialog-title').textContent = title; $('#dialog-body').innerHTML = body; $('#dialog-submit').textContent = submit;
  $('#dialog-submit').hidden = !handler; $('#dialog-cancel').textContent = handler ? 'Cancel' : 'Close'; dialogHandler = handler;
  $('#dialog').showModal();
}
function field(label, name, value = '', options = '') { return `<label class="form-field">${label}<input name="${name}" value="${esc(value)}" ${options}></label>`; }
function newWorkflow() {
  openDialog('Create a workflow', `<p class="muted">Give your workflow a name and choose where it begins.</p>${field('Workflow name', 'name', '', 'required maxlength="100" placeholder="e.g. Weekly report"')}${field('Starting URL', 'startUrl', `${location.origin}/practice`, 'required type="url"')}`, 'Create workflow', async form => {
    if (dirty) await saveWorkflow();
    const w = await api('/workflows', { name: form.get('name'), startUrl: form.get('startUrl'), steps: [] }); await refresh(); chooseWorkflow(w.id);
  });
}
function editProfile(id) {
  const p = state.profiles.find(p => p.id === id);
  openDialog(p ? 'Edit profile' : 'Create a profile', `${field('Profile name', 'name', p?.name, 'required maxlength="100"')}<label class="form-field">Variables (JSON)<textarea name="variables" rows="8" spellcheck="false" required>${esc(JSON.stringify(p?.variables || { name: '', email: '' }, null, 2))}</textarea><small>String values only. Use {{variable_name}} in your workflow. Variables and saved sessions are stored on this computer.</small></label>`, p ? 'Save profile' : 'Create profile', async form => {
    await api('/profiles', { ...(p ? { id: p.id } : {}), name: form.get('name'), variables: JSON.parse(form.get('variables')) }); await refresh(); renderProfiles(); toast('Profile saved');
  });
}
function renderProfiles() {
  $('#profiles-grid').innerHTML = state.profiles.map(p => `<article class="profile-card"><div class="profile-card-top"><span class="avatar">${esc(p.name.slice(0, 2).toUpperCase())}</span><div><h3>${esc(p.name)}</h3><small>${p.hasSession ? '● Saved browser session' : '○ Fresh browser session'}</small></div></div><div class="variable-list">${Object.entries(p.variables).map(([key, value]) => `<div class="variable-row"><code>${esc(key)}</code><span>${/password|secret|token/i.test(key) ? '••••••••' : esc(value)}</span></div>`).join('') || '<p class="muted">No variables yet</p>'}</div><div class="profile-actions"><button class="button secondary" data-edit-profile="${p.id}">Edit profile</button><button class="button ghost danger" data-delete-profile="${p.id}">Delete</button></div></article>`).join('') || '<div class="empty-state"><strong>Make your workflow personal</strong>Add a profile with variables to start running.</div>';
}
async function runDialog() {
  if (!current) throw new Error('Create or select a workflow first.');
  if (dirty) await saveWorkflow();
  if (!state.profiles.length) { editProfile(); return; }
  openDialog('Run workflow', `<p class="muted">Run <strong>${esc(current.name)}</strong> in a separate browser session for each selected profile.</p><div class="form-field">Profiles</div>${state.profiles.map((p, i) => `<label class="check-row"><input type="checkbox" name="profiles" value="${p.id}" ${i === 0 ? 'checked' : ''}>${esc(p.name)}<small>${p.hasSession ? 'Saved session' : 'Fresh session'}</small></label>`).join('')}${field('Concurrent browsers (1–8)', 'concurrency', '3', 'type="number" min="1" max="8" required')}<label class="check-row"><input name="headless" type="checkbox" checked>Run browsers in the background</label><p class="muted">Pause takes effect between steps. Cancel closes the browser immediately.</p>`, '▶ Start run', async form => {
    const runs = await api('/runs', { workflowId: current.id, profileIds: form.getAll('profiles'), concurrency: Number(form.get('concurrency')), headless: form.has('headless'), browserId: $('#browser-select').value, replayMouse: form.has('replayMouse'), showCursor: form.has('showCursor'), viewportWidth: Number(form.get('viewportWidth')), viewportHeight: Number(form.get('viewportHeight')) });
    selectedRun = runs[0].id; await refresh(); switchView('runs'); toast(`${runs.length} run${runs.length === 1 ? '' : 's'} queued`);
  });
  $('#dialog-body').insertAdjacentHTML('beforeend', `<label class="check-row"><input name="replayMouse" type="checkbox" checked>Replay recorded mouse movement</label><label class="check-row"><input name="showCursor" type="checkbox" checked>Show red cursor marker during playback</label><div class="viewport-fields">${field('Background viewport width', 'viewportWidth', '1360', 'type="number" min="320" max="3840" required')}${field('Height', 'viewportHeight', '900', 'type="number" min="240" max="2160" required')}</div><p class="muted">Visible browsers follow their window size. Clicks follow the HTML element even if the layout changes. A hidden or replaced button may require a different selector.</p>`);
}
function renderRuns() {
  const counts = [state.runs.length, state.runs.filter(r => ['running', 'queued', 'paused'].includes(r.status)).length, state.runs.filter(r => r.status === 'passed').length, state.runs.filter(r => ['failed', 'interrupted'].includes(r.status)).length];
  $('#run-stats').innerHTML = ['Total runs', 'In progress', 'Successful', 'Needs attention'].map((label, i) => `<div class="stat"><small>${label}</small><strong>${counts[i]}</strong></div>`).join('');
  if (!selectedRun) selectedRun = state.runs[0]?.id;
  $('#runs-list').innerHTML = state.runs.map(r => `<button class="run-row ${selectedRun === r.id ? 'selected' : ''}" data-run="${r.id}"><div><strong>${esc(r.workflowName)}</strong><span class="status ${r.status}">${r.status}</span></div><small>${esc(r.profileName)} · ${new Date(r.createdAt).toLocaleString()}</small></button>`).join('') || '<div class="empty-state"><strong>No runs yet</strong>Your workflow’s next chapter starts with Run.</div>';
  const r = state.runs.find(r => r.id === selectedRun);
  if (!r) { $('#run-detail').innerHTML = ''; return; }
  const active = ['running', 'queued', 'paused'].includes(r.status);
  $('#run-detail').innerHTML = `<div class="run-detail-card"><h2>${esc(r.workflowName)}</h2><div class="muted">${esc(r.profileName)} · <span class="status ${r.status}">${r.status}</span></div>${active ? `<div class="run-actions">${r.status !== 'queued' ? `<button class="button secondary" data-control="${r.status === 'paused' ? 'resume' : 'pause'}">${r.status === 'paused' ? '▶ Resume' : 'Ⅱ Pause'}</button>` : ''}<button class="button secondary danger" data-control="cancel">■ Cancel run</button></div>` : ''}<div class="progress-track"><div style="width:${r.totalSteps ? r.currentStep / r.totalSteps * 100 : 0}%"></div></div><div class="muted">${r.currentStep} / ${r.totalSteps} steps reached${r.finishedAt && r.startedAt ? ` · ${((new Date(r.finishedAt) - new Date(r.startedAt)) / 1000).toFixed(1)}s elapsed` : ''}</div>${r.error ? `<p class="error-block">${esc(r.error)}</p>` : ''}<div class="logs">${r.logs.map(l => `<div class="log ${l.level}"><time>${new Date(l.time).toLocaleTimeString()}</time>${esc(l.message)}</div>`).join('') || '<span class="muted">Waiting for an available browser…</span>'}</div>${r.screenshots.length ? `<div class="shots">${r.screenshots.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noreferrer"><img src="${esc(s.url)}" alt="${esc(s.label)}"><small>${esc(s.label)} ↗</small></a>`).join('')}</div>` : ''}</div>`;
}
$('#nav').addEventListener('click', e => { const target = e.target.closest('[data-view]'); if (target) switchView(target.dataset.view); });
$('#workflow-list').addEventListener('click', e => { const target = e.target.closest('[data-workflow]'); if (target) chooseWorkflow(target.dataset.workflow); });
$('#new-sidebar').onclick = newWorkflow;
$('#workflow-name').oninput = e => { if (current) { current.name = e.target.value; markDirty(); } };
$('#start-url').oninput = e => {
  cancelUrlCapture();
  if (!current) return;
  const value = e.target.value;
  current.startUrl = value; $('#open-page').href = validStartUrl(value) || '#'; markDirty();
  if (validStartUrl(value) && !state.recorder) {
    const workflowId = current.id;
    urlCaptureTimer = setTimeout(() => startCaptureFromUrl(workflowId, value), 1000);
  }
};
$('#start-url').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); startCaptureFromUrl(current?.id, e.target.value); } };
$('#steps').addEventListener('click', e => { const target = e.target.closest('[data-step]'); if (target) { selectedStep = target.dataset.step; renderSteps(); renderInspector(); } });
$('#steps').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.click(); } });
$('#step-inspector').addEventListener('input', e => {
  if (activeCapture()) return;
  const field = e.target.dataset.field; if (!field) return;
  const step = current.steps.find(s => s.id === selectedStep);
  step[field] = field === 'enabled' ? e.target.checked : field === 'timeout' ? Number(e.target.value) : e.target.value; markDirty(); renderSteps();
  if (field === 'type') { if (field && step.type === 'wait') step.value = '1000'; if (step.type === 'check') step.value = 'true'; renderInspector(); }
});
$('#step-inspector').addEventListener('click', handle(async e => {
  if (e.target.id === 'copy-html') { await navigator.clipboard.writeText(displayedSteps().find(s => s.id === selectedStep).capture.html); toast('Element HTML copied'); return; }
  if (e.target.id === 'test-selector') {
    const step = displayedSteps().find(s => s.id === selectedStep); const result = await api('/calibrate', { selector: step.selector });
    $('#calibration-result').textContent = `${result.count} match${result.count !== 1 ? 'es' : ''} · ${result.count === 1 && result.visible ? 'Ready to use' : 'Choose a unique, visible element'}`; return;
  }
  if (activeCapture()) return;
  const action = e.target.closest('[data-step-action]')?.dataset.stepAction; if (!action) return;
  const index = current.steps.findIndex(s => s.id === selectedStep);
  if (action === 'delete') { current.steps.splice(index, 1); selectedStep = current.steps[Math.min(index, current.steps.length - 1)]?.id; }
  else { const next = index + (action === 'up' ? -1 : 1); if (next < 0 || next >= current.steps.length) return; [current.steps[index], current.steps[next]] = [current.steps[next], current.steps[index]]; }
  markDirty(); renderSteps(); renderInspector();
}));
$('#add-step').onclick = () => {
  const step = { id: crypto.randomUUID(), type: 'click', label: 'Click an element', selector: '', value: '', enabled: true, timeout: 15000 };
  current.steps.push(step); selectedStep = step.id; markDirty(); renderSteps(); renderInspector();
};
$('#save-button').onclick = handle(async () => { await saveWorkflow(); toast('Workflow saved locally'); });
$('#run-button').onclick = handle(runDialog); $('#runs-new').onclick = handle(runDialog);
$('#record-button').onclick = handle(async () => {
  cancelUrlCapture();
  if (dirty) await saveWorkflow();
  if (!state.profiles.length) { editProfile(); return; }
  const browserId = $('#browser-select').value;
  openDialog('Start browser capture', `<p class="muted">Open <strong>${esc(browsers.find(b => b.id === browserId)?.name || browserId)}</strong> at your starting URL. Click and type normally; actions and element HTML appear live in the builder. F12 is optional.</p><label class="form-field">Browser profile<select name="profileId">${state.profiles.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label><p class="muted">Uses a separate browser window with this app’s saved session. Stop & save replaces this workflow’s actions. Recording covers the main tab and main frame.</p>`, 'Start capture', async form => {
    await api('/record/start', { workflowId: current.id, profileId: form.get('profileId'), browserId }); $('#visual-tab').click(); await refresh(); toast('Capture started');
  });
});
$('#record-save').onclick = handle(async () => {
  const id = state.recorder.workflowId; await api('/record/stop', { save: true }); dirty = false; await refresh(); chooseWorkflow(id); toast('Recording saved. Review the steps before running.');
});
$('#record-discard').onclick = handle(async () => { await api('/record/stop', { save: false }); await refresh(); toast('Recording discarded'); });
$('#record-pause').onclick = handle(async () => { if (!state.recorder) return; await api('/record/pause', { paused: state.recorder.status !== 'paused' }); await refresh(); });
$('#refresh-browsers').onclick = handle(async () => { await refreshBrowsers(); toast('Browser list refreshed'); });
$('#browser-select').onchange = e => localStorage.setItem('browserauto-browser', e.target.value);
$('#new-profile').onclick = () => editProfile();
$('#profiles-grid').addEventListener('click', handle(async e => {
  const edit = e.target.closest('[data-edit-profile]'); if (edit) editProfile(edit.dataset.editProfile);
  const remove = e.target.closest('[data-delete-profile]');
  if (remove && confirm('Delete this profile and its saved browser session?')) { await api(`/profiles/${remove.dataset.deleteProfile}`, undefined, 'DELETE'); await refresh(); renderProfiles(); }
}));
$('#runs-list').addEventListener('click', e => { const row = e.target.closest('[data-run]'); if (row) { selectedRun = row.dataset.run; renderRuns(); } });
$('#run-detail').addEventListener('click', handle(async e => { const action = e.target.closest('[data-control]')?.dataset.control; if (action) { await api(`/runs/${selectedRun}/control`, { action }); await refresh(); } }));
$('#dialog-close').onclick = $('#dialog-cancel').onclick = () => $('#dialog').close();
$('#dialog-form').onsubmit = async e => {
  e.preventDefault(); if (!dialogHandler) return;
  $('#dialog-submit').disabled = true; $('.dialog-error', $('#dialog-body'))?.remove();
  try { await dialogHandler(new FormData(e.target)); $('#dialog').close(); }
  catch (error) { const el = document.createElement('p'); el.className = 'dialog-error'; el.textContent = error.message; $('#dialog-body').append(el); }
  finally { $('#dialog-submit').disabled = false; }
};
$('#json-tab').onclick = () => { if (!jsonDirty) $('#json-editor').value = JSON.stringify(current, null, 2); $('#json-panel').hidden = false; $('#visual-panel').hidden = true; $('#json-tab').classList.add('selected'); $('#visual-tab').classList.remove('selected'); };
$('#json-editor').oninput = () => { jsonDirty = true; markDirty(); };
$('#visual-tab').onclick = () => { if (jsonDirty && !confirm('Discard unapplied JSON edits?')) return; jsonDirty = false; $('#json-panel').hidden = true; $('#visual-panel').hidden = false; $('#visual-tab').classList.add('selected'); $('#json-tab').classList.remove('selected'); };
$('#apply-json').onclick = handle(async () => {
  const data = JSON.parse($('#json-editor').value); const saved = await api('/workflows', { ...data, id: current.id });
  current = saved; dirty = false; jsonDirty = false; selectedStep = current.steps[0]?.id; await refresh(); renderBuilder(); $('#visual-tab').click(); toast('JSON applied and saved');
});
$('#export-button').onclick = handle(async () => {
  if (dirty) await saveWorkflow();
  const blob = new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = `${current.name.replace(/[^a-z0-9_-]/gi, '-').slice(0, 80)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('#import-button').onclick = () => $('#import-file').click();
$('#import-file').onchange = handle(async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    if (file.size > 12000000) throw new Error('Workflow JSON must be smaller than 12 MB.');
    if (dirty) await saveWorkflow();
    const data = JSON.parse(await file.text()); delete data.id;
    const imported = await api('/workflows', data); await refresh(); chooseWorkflow(imported.id); toast('Workflow imported');
  } finally { e.target.value = ''; }
});
$('#guide-button').onclick = () => openDialog('A little setup. A lot less repetition.', '<ol class="help-list"><li><strong>Try the example.</strong> “Welcome aboard” fills the included practice page. Select Run workflow to see it work.</li><li><strong>Create a workflow.</strong> Use the + beside Your workflows and choose a starting URL.</li><li><strong>Record your actions.</strong> Open the recorder, use its browser, and stop & save here. Review every captured step.</li><li><strong>Calibrate selectors.</strong> Select a step and test its selector while the recording browser is open.</li><li><strong>Add profiles.</strong> Store variables like name and email. Reference them with {{name}} in a step.</li><li><strong>Run and inspect.</strong> Select profiles, set concurrency, and follow the logs. Add screenshot steps to capture results.</li></ol><p class="muted">The app uses standard Playwright browsers. Saved sessions contain cookies and should be treated as private. Recording covers the main tab and main frame.</p>', '', null);
$('#workflow-options').onclick = () => {
  if (!current) return;
  openDialog('Workflow options', `<p class="muted">${esc(current.name)}</p><button type="button" id="duplicate-workflow" class="button secondary">Duplicate workflow</button> <button type="button" id="delete-workflow" class="button secondary danger">Delete workflow</button>`, '', null);
  $('#duplicate-workflow').onclick = handle(async () => { if (dirty) await saveWorkflow(); const copy = { ...current, name: `${current.name.slice(0, 90)} copy` }; delete copy.id; const saved = await api('/workflows', copy); $('#dialog').close(); await refresh(); chooseWorkflow(saved.id); });
  $('#delete-workflow').onclick = handle(async () => { if (!confirm(`Delete “${current.name}”? Run history will be kept.`)) return; await api(`/workflows/${current.id}`, undefined, 'DELETE'); $('#dialog').close(); dirty = false; jsonDirty = false; await refresh(); chooseWorkflow(state.workflows[0]?.id); });
};
window.addEventListener('beforeunload', e => { if (dirty || jsonDirty) { e.preventDefault(); e.returnValue = ''; } });
window.browserAutoDesktop?.onCommand(command => {
  const buttons = { new: 'new-sidebar', save: 'save-button', import: 'import-button', export: 'export-button', record: 'record-button', pause: 'record-pause', stop: 'record-save', help: 'guide-button' };
  if (['builder', 'profiles', 'runs'].includes(command)) switchView(command);
  else if (buttons[command]) { const button = $(`#${buttons[command]}`); if (!button.disabled && !button.hidden && !button.closest('[hidden]')) button.click(); }
});
await handle(async () => { await Promise.all([refresh(), refreshBrowsers()]); if (state.workflows[0]) chooseWorkflow(state.recorder?.workflowId || state.workflows[0].id); else renderBuilder(); window.browserAutoDesktop?.ready(); })();
let polling = false;
setInterval(async () => { if (polling) return; polling = true; try { await refresh(); $('.local-status').innerHTML = '<i></i>Local engine connected'; } catch { $('.local-status').textContent = 'Local engine disconnected'; } finally { polling = false; } }, 1500);
