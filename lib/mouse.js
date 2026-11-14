export function scalePoint(point, viewport) {
  return { x: Math.min(viewport.width - 1, Math.max(0, point.x * viewport.width)), y: Math.min(viewport.height - 1, Math.max(0, point.y * viewport.height)) };
}
export async function replayMousePath(page, points, checkpoint = async () => {}) {
  for (const point of points || []) {
    await checkpoint();
    if (point.dt) await new Promise(resolve => setTimeout(resolve, point.dt));
    await checkpoint();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const position = scalePoint(point, viewport);
    await page.mouse.move(position.x, position.y);
  }
}
export async function clickRecordedElement(locator, position, options = {}) {
  if (!position) return locator.click(options);
  await locator.scrollIntoViewIfNeeded(options);
  const dimensions = await locator.evaluate(el => ({ width: el.clientWidth, height: el.clientHeight }));
  await locator.click({ ...options, position: {
    x: Math.max(0, Math.min(dimensions.width - 1, position.x * dimensions.width)),
    y: Math.max(0, Math.min(dimensions.height - 1, position.y * dimensions.height)),
  } });
}
export function showReplayCursor() {
  const install = () => {
    const marker = document.createElement('div');
    marker.dataset.browserautoOverlay = 'cursor';
    marker.setAttribute('aria-hidden', 'true');
    marker.style.cssText = 'position:fixed;width:12px;height:12px;border:2px solid #d52525;border-radius:50%;background:#ffdddd66;pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%);display:none';
    document.documentElement.append(marker);
    document.addEventListener('mousemove', event => { marker.style.display = 'block'; marker.style.left = `${event.clientX}px`; marker.style.top = `${event.clientY}px`; }, true);
    document.addEventListener('mousedown', () => marker.style.background = '#d52525', true);
    document.addEventListener('mouseup', () => marker.style.background = '#ffdddd66', true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true }); else install();
}
