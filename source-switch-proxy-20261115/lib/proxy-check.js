import { request } from 'playwright';
import { isIP } from 'node:net';

const ipURL = 'https://api.ipify.org';
async function directIP() {
  const context = await request.newContext({ timeout: 10000 });
  try {
    const response = await context.get(ipURL);
    const ip = (await response.text()).trim();
    if (!response.ok() || !isIP(ip)) throw new Error('Invalid direct IP response');
    return ip;
  } finally { await context.dispose(); }
}

// Use an actual tab in the run's browser, isolated from profile cookies.
export async function verifyBrowserProxy(browser, { expectedIP, baselineIP, allowDirectMatch = false, url = ipURL, getDirectIP = directIP, page: existingPage } = {}) {
  let context;
  try {
    const baseline = allowDirectMatch ? null : baselineIP || await getDirectIP();
    if (!allowDirectMatch && !isIP(baseline)) throw new Error('Invalid direct IP');
    if (!existingPage) context = await browser.newContext();
    const page = existingPage || await context.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    const exitIP = (await page.locator('body').innerText({ timeout: 3000 })).trim();
    if (!response?.ok() || !isIP(exitIP)) throw new Error('IP check returned an invalid response');
    if (!allowDirectMatch && exitIP === baseline) throw new Error('Browser exit IP matches the direct IP');
    if (expectedIP && exitIP !== expectedIP) throw new Error('Browser exit IP changed from the expected proxy IP');
    return { exitIP, checkedAt: new Date().toISOString() };
  } catch (error) {
    // Keep browser diagnostics/URLs and any credentials out of persisted errors.
    const reason = /^(Browser exit IP|IP check returned)/.test(error.message) ? error.message : 'Could not verify the browser exit IP';
    throw new Error(`Proxy check failed: ${reason}.`);
  } finally { await context?.close().catch(() => {}); }
}
