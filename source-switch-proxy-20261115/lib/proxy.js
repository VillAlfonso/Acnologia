import { openMobile } from './mobile.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { freeProxyOptions } from './free-proxies.js';

// Read for every launch so settings changes apply to the next browser instance.
// Credentials stay out of workflows, API state, and run history.
export async function proxyLaunchOptions(dataDir, env = process.env, options = {}) {
  try {
    const connection = JSON.parse(await readFile(path.join(dataDir, 'connection-mode.json'), 'utf8'));
    if (connection.mode === 'mobile') return openMobile(dataDir, options);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let config = {};
  try { config = JSON.parse(await readFile(path.join(dataDir, 'proxy.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot read proxy.json. Check that it contains valid JSON.');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('proxy.json must contain a settings object.');
  const mode = env.BROWSERAUTO_PROXY_MODE ?? config.mode;
  if (mode !== undefined && !['free', 'custom', 'direct'].includes(mode)) throw new Error('Proxy mode must be free, custom, or direct.');
  if (mode === 'direct') return {};
  if (mode === 'free') {
    const maxLatencyMs = config.maxLatencyMs ?? 2000;
    const maxPageLoadMs = config.maxPageLoadMs ?? 6000;
    if (!Number.isInteger(maxLatencyMs) || maxLatencyMs < 250 || maxLatencyMs > 10000 || !Number.isInteger(maxPageLoadMs) || maxPageLoadMs < 1000 || maxPageLoadMs > 15000) throw new Error('Proxy speed limits must be integers: maxLatencyMs 250–10000, maxPageLoadMs 1000–15000.');
    return freeProxyOptions(dataDir, { ...options, maxLatencyMs, maxPageLoadMs });
  }
  const server = env.BROWSERAUTO_PROXY_SERVER ?? config.server;
  const username = env.BROWSERAUTO_PROXY_USERNAME ?? config.username;
  const password = env.BROWSERAUTO_PROXY_PASSWORD ?? config.password;
  if (!server && username === undefined && password === undefined && mode !== 'custom') return {};
  let url;
  try { url = new URL(server); } catch { throw new Error('Proxy server must be an http:// or https:// URL with a port.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use an HTTP(S) proxy server URL without embedded credentials, a path, or query parameters.');
  }
  if ((username !== undefined && typeof username !== 'string') || (password !== undefined && typeof password !== 'string')) throw new Error('Proxy username and password must be strings.');
  const session = randomUUID().replaceAll('-', '');
  const expand = value => value?.replaceAll('{{session}}', session);
  return { proxy: { server: url.origin, ...(username !== undefined ? { username: expand(username) } : {}), ...(password !== undefined ? { password: expand(password) } : {}) } };
}
