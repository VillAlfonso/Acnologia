// Browser-side input adapter. This function is serialized into the recorded page.
// Keep it self-contained: dependencies are supplied through the emit callback.
export function installFormInputs(emit) {
  const lastValues = new WeakMap();
  const captureText = event => {
    const el = event.target;
    if (!(el instanceof Element) || !el.matches('input,textarea,[contenteditable="true"],[contenteditable=""]') || ['checkbox', 'radio', 'file', 'submit', 'button', 'hidden', 'reset', 'range', 'color'].includes(el.type)) return;
    const value = el.isContentEditable ? el.textContent : el.value;
    if (lastValues.has(el) && lastValues.get(el) === value) return;
    lastValues.set(el, value);
    const hint = [el.getAttribute('aria-label'), el.labels?.[0]?.textContent, el.name, el.id, el.autocomplete, el.getAttribute('placeholder')].filter(Boolean).join(' ').slice(0, 200);
    // Only field metadata leaves the page; never send the typed value.
    emit('fill', el, '', { field: { hint, type: el.type || 'text', empty: !value } });
  };
  document.addEventListener('input', captureText, true);
  document.addEventListener('change', captureText, true);
  document.addEventListener('focusout', captureText, true);
  document.addEventListener('keydown', event => {
    if (['Enter', 'Tab'].includes(event.key) && event.target.matches('input,textarea,[contenteditable]')) emit('press', event.target, event.key);
  }, true);
}
