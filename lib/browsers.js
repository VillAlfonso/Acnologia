import { stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';

export const browserIds = ['chromium', 'brave', 'opera', 'opera-gx', 'chrome', 'edge'];
const names = { chromium: 'Chromium (bundled)', brave: 'Brave', opera: 'Opera', 'opera-gx': 'Opera GX', chrome: 'Google Chrome', edge: 'Microsoft Edge' };
async function exists(file) { try { return (await stat(file)).isFile(); } catch { return false; } }
export async function discoverBrowsers() {
  const local = process.env.LOCALAPPDATA || '', program = process.env.ProgramFiles || '', x86 = process.env['ProgramFiles(x86)'] || '';
  const candidates = Object.fromEntries(browserIds.map(id => [id, []]));
  candidates.chromium.push(chromium.executablePath());
  for (const id of browserIds.filter(id => id !== 'chromium')) {
    const override = process.env[`BROWSERAUTO_${id.replace('-', '_').toUpperCase()}_PATH`];
    if (override) candidates[id].push(override);
  }
  if (process.platform === 'win32') {
    for (const base of [local, program, x86].filter(Boolean)) {
      candidates.brave.push(path.join(base, 'BraveSoftware/Brave-Browser/Application/brave.exe'));
      candidates.chrome.push(path.join(base, 'Google/Chrome/Application/chrome.exe'));
      candidates.edge.push(path.join(base, 'Microsoft/Edge/Application/msedge.exe'));
    }
    for (const [id, folder] of [['opera', 'Opera'], ['opera-gx', 'Opera GX']]) {
      for (const base of [local && path.join(local, 'Programs', folder), program && path.join(program, folder), x86 && path.join(x86, folder)].filter(Boolean)) {
        // Opera installs its actual browser binary in a versioned directory.
        const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
        for (const entry of entries.filter(e => e.isDirectory() && /^\d/.test(e.name)).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))) candidates[id].push(path.join(base, entry.name, 'opera.exe'));
        candidates[id].push(path.join(base, 'opera.exe'));
      }
    }
  } else if (process.platform === 'darwin') {
    for (const base of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      for (const [id, app, binary] of [['brave', 'Brave Browser', 'Brave Browser'], ['opera', 'Opera', 'Opera'], ['opera-gx', 'Opera GX', 'Opera GX'], ['chrome', 'Google Chrome', 'Google Chrome'], ['edge', 'Microsoft Edge', 'Microsoft Edge']]) candidates[id].push(path.join(base, `${app}.app/Contents/MacOS/${binary}`));
    }
  } else {
    for (const base of ['/usr/bin', '/usr/local/bin', '/snap/bin']) {
      for (const [id, binary] of [['brave', 'brave-browser'], ['opera', 'opera'], ['chrome', 'google-chrome'], ['edge', 'microsoft-edge']]) candidates[id].push(path.join(base, binary));
    }
  }
  return Promise.all(browserIds.map(async id => {
    let executablePath;
    for (const file of candidates[id]) if (await exists(file)) { executablePath = file; break; }
    return { id, name: names[id], available: !!executablePath, ...(executablePath ? { executablePath } : {}) };
  }));
}
export async function browserLaunchOptions(id = 'chromium') {
  const browser = (await discoverBrowsers()).find(b => b.id === id);
  if (!browser?.available) throw new Error(`${browser?.name || id} is not installed or could not be found. Install it, or set BROWSERAUTO_${id.replace('-', '_').toUpperCase()}_PATH to its browser executable.`);
  return id === 'chromium' ? {} : { executablePath: browser.executablePath };
}
