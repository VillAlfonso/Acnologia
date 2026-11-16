export function installGeneratorUI({ getWorkflow, setWorkflow, save, api, openDialog, esc, handle }) {
  const kinds = { name: 'Full name', first_name: 'First name', last_name: 'Last name', email: 'Email address', username: 'Username', password: 'Password', text: 'Text + random suffix', number: 'Random 6-digit number', fixed: 'Fixed value', reference: 'Reuse earlier variable' };
  async function open(draft) {
    const fields = draft.generator.fields;
    const body = `<div class="generator-editor"><p>Fields are listed in the order first typed. Each run generates a new set; reused variables stay identical throughout the run.</p><label class="check-row"><input type="checkbox" name="generatorEnabled" ${draft.generator.enabled ? 'checked' : ''}>Generate fresh values automatically for each run</label><div class="generator-fields">${fields.map((field, index) => `<fieldset class="generator-field" data-index="${index}"><legend>${index + 1}. ${esc(field.label || field.key)} · {{${esc(field.key)}}}</legend><label class="form-field">Generate<select name="kind_${index}">${Object.entries(kinds).map(([key, label]) => `<option value="${key}" ${field.kind === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="form-field" data-setting="value">Domain, text prefix, or fixed value<input name="value_${index}" value="${esc(field.value)}"></label><label class="form-field" data-setting="length">Password length<input name="length_${index}" type="number" min="8" max="128" value="${field.length || 16}"></label><label class="form-field" data-setting="source">Reuse variable<select name="source_${index}"><option value="">Choose…</option>${fields.slice(0, index).map(previous => `<option value="${esc(previous.key)}" ${previous.key === field.source ? 'selected' : ''}>{{${esc(previous.key)}}}</option>`).join('')}</select></label></fieldset>`).join('') || '<p>No typed fields yet. Record a form, or add Fill text steps first.</p>'}</div><p class="muted">Email generation creates address text, not a mailbox. Default: example.test. Use a fixed value for an existing inbox. Generated values are saved locally with each run; passwords are hidden in Run history until revealed.</p><button type="button" id="generator-preview" class="button secondary">Preview new values</button> <button type="button" id="generator-detect" class="button secondary">Detect added fields</button><pre id="generator-preview-output" class="capture-html" hidden></pre></div>`;
    const read = form => ({ enabled: form.has('generatorEnabled'), fields: fields.map((field, index) => ({ ...field, kind: form.get(`kind_${index}`), value: form.get(`value_${index}`), source: form.get(`source_${index}`), length: Number(form.get(`length_${index}`)) })) });
    openDialog('Variables & generator', body, 'Save generator', async form => {
      const generator = read(form);
      // Validate and save together so Cancel never changes the recording.
      const saved = await api('/workflows', { ...draft, generator });
      await setWorkflow(saved);
    });
    const editor = document.querySelector('.generator-editor');
    const sync = () => {
      for (const row of editor.querySelectorAll('.generator-field')) {
        const kind = row.querySelector('select').value;
        row.querySelector('[data-setting="value"]').hidden = !['email', 'text', 'fixed'].includes(kind);
        row.querySelector('[data-setting="length"]').hidden = kind !== 'password';
        row.querySelector('[data-setting="source"]').hidden = kind !== 'reference';
      }
    };
    editor.addEventListener('change', sync); sync();
    document.querySelector('#generator-preview').onclick = handle(async () => {
      const result = await api('/generator/preview', { ...read(new FormData(document.querySelector('#dialog-form'))), enabled: true });
      const output = document.querySelector('#generator-preview-output');
      output.hidden = false; output.textContent = JSON.stringify(result.values, null, 2);
    });
    document.querySelector('#generator-detect').onclick = handle(async () => {
      const next = await api('/generator/detect', { ...draft, generator: read(new FormData(document.querySelector('#dialog-form'))) });
      await open(next);
    });
  }
  document.querySelector('#generator-button').onclick = handle(async () => {
    await save();
    const current = getWorkflow();
    const draft = current.generator ? structuredClone(current) : await api('/generator/detect', current);
    await open(draft);
  });
}

export function renderGeneratedValues(run, container, esc, revealed = false) {
  if (!run.generatedValues || !Object.keys(run.generatedValues).length) return;
  const section = document.createElement('section');
  section.className = 'generated-values';
  const secret = key => run.secretKeys?.includes(key) || /password|secret|token/i.test(key);
  section.innerHTML = `<h3>Values used in this run</h3><p class="muted">Saved input values. A passed workflow alone does not confirm an account was created.</p><dl>${Object.entries(run.generatedValues).map(([key, value]) => `<dt>{{${esc(key)}}}</dt><dd>${secret(key) && !revealed ? '••••••••' : esc(value)}</dd>`).join('')}</dl><button class="button secondary" type="button" data-reveal-generated>${revealed ? 'Hide passwords' : 'Reveal passwords'}</button> <button class="button secondary" type="button" data-export-generated>Export values…</button>`;
  section.querySelector('[data-export-generated]').onclick = () => {
    const blob = new Blob([JSON.stringify({ name: run.name || run.workflowName, workflow: run.workflowName, status: run.status, values: run.generatedValues }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `run-${run.id}-values.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  container.append(section);
}
