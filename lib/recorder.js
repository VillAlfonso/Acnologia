// Runs inside the recorded page. Password text is never sent to the application.
export function installRecorder() {
  if (window.__browserAutoInstalled) return;
  window.__browserAutoInstalled = true;
  const clamp = value => Math.max(0, Math.min(1, value));
  let lastMoveAt = 0;
  const selectorFor = el => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    for (const attr of ['data-testid', 'name', 'aria-label']) {
      const value = el.getAttribute(attr);
      if (value) {
        const selector = `${el.tagName.toLowerCase()}[${attr}=${JSON.stringify(value)}]`;
        if (document.querySelectorAll(selector).length === 1) return selector;
      }
    }
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      let part = el.tagName.toLowerCase();
      const siblings = el.parentElement ? [...el.parentElement.children].filter(s => s.tagName === el.tagName) : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(el) + 1})`;
      parts.unshift(part); el = el.parentElement;
    }
    return parts.join(' > ');
  };
  const send = (type, el, value = '', extra = {}) => {
    if (window !== window.top) return;
    const label = (el.getAttribute('aria-label') || el.labels?.[0]?.textContent || el.textContent || el.name || el.tagName).trim().slice(0, 100);
    // Store inspection evidence as text, never execute captured markup in the app.
    const clone = el.cloneNode(true);
    for (const node of [clone, ...clone.querySelectorAll('*')]) {
      for (const attr of [...node.attributes]) if (/^on|password|secret|token|nonce/i.test(attr.name)) node.removeAttribute(attr.name);
      if (node.matches('input[type="password"],input[type="hidden"]')) { node.removeAttribute('value'); node.value = ''; }
      if (node.matches('script,iframe,object,embed')) node.remove();
    }
    const capture = {
      html: clone.outerHTML.slice(0, 12000), tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().slice(0, 500), pageUrl: location.href.slice(0, 4000),
      pageTitle: document.title.slice(0, 300), timestamp: new Date().toISOString(),
      attributes: Object.fromEntries([...clone.attributes].slice(0, 30).map(a => [a.name.slice(0, 100), a.value.slice(0, 1000)])),
    };
    window.__recordAction({ type, selector: selectorFor(el), value, label: `${type[0].toUpperCase() + type.slice(1)} ${label}`, capture, ...extra }).catch(() => {});
  };
  document.addEventListener('mousemove', event => {
    if (window !== window.top || event.buttons || !(event.target instanceof Element)) return;
    const now = performance.now();
    if (lastMoveAt && now - lastMoveAt < 50) return;
    const dt = lastMoveAt ? Math.min(250, now - lastMoveAt) : 0; lastMoveAt = now;
    const point = { x: clamp(event.clientX / innerWidth), y: clamp(event.clientY / innerHeight), dt, width: innerWidth, height: innerHeight };
    const hoverTarget = event.target.closest('button,a,input,textarea,select,[role="button"],[role="menuitem"],[tabindex]');
    window.__recordAction({ type: 'move', selector: hoverTarget ? selectorFor(hoverTarget) : '', value: '', label: 'Mouse movement', mousePath: [point] }).catch(() => {});
  }, true);
  document.addEventListener('click', event => {
    const el = event.target.closest('button,a,input,[role="button"],summary') || event.target;
    if (el.closest('[data-browserauto-overlay]') || /^(TEXTAREA|SELECT|OPTION|LABEL)$/.test(el.tagName)) return;
    if (el.tagName === 'INPUT' && !['submit', 'button', 'reset', 'image'].includes(el.type)) return;
    const box = el.getBoundingClientRect();
    const clickPosition = box.width && box.height ? { x: clamp((event.clientX - box.left) / box.width), y: clamp((event.clientY - box.top) / box.height) } : undefined;
    send('click', el, '', { clickPosition });
  }, true);
  document.addEventListener('input', event => {
    const el = event.target;
    if (!el.matches('input,textarea') || ['checkbox', 'radio', 'file', 'submit', 'button'].includes(el.type)) return;
    send('fill', el, el.type === 'password' ? '{{password}}' : el.value);
  }, true);
  document.addEventListener('change', event => {
    const el = event.target;
    if (el.tagName === 'SELECT') send('select', el, el.value);
    else if (['checkbox', 'radio'].includes(el.type)) send('check', el, String(el.checked));
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target.matches('input,textarea')) send('press', event.target, 'Enter');
  }, true);
}
