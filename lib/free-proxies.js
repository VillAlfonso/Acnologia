import { request } from 'playwright';
import { isIP } from 'node:net';
import { randomInt } from 'node:crypto';
import { readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

const sources = [
  'https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/http.txt',
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text',
];
const checkUrl = 'https://api.ipify.org';
const pools = new Map();

function publicIPv4(ip) {
  if (isIP(ip) !== 4) return false;
  const [a, b, c] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}

export function parseProxyList(text) {
  const servers = new Set();
  for (const line of text.slice(0, 2000000).split(/\s+/)) {
    const match = /^(?:http:\/\/)?(\d+\.\d+\.\d+\.\d+):(\d{1,5})\/?$/.exec(line);
    if (match && publicIPv4(match[1]) && Number(match[2]) > 0 && Number(match[2]) <= 65535) servers.add(`http://${match[1]}:${Number(match[2])}`);
  }
  return [...servers];
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Proxy list unavailable');
  return response.text();
}

async function probe(server, timeout = 5000) {
  const context = await request.newContext({ ...(server ? { proxy: { server } } : {}), timeout });
  try {
    const response = await context.get(checkUrl);
    const ip = (await response.text()).trim();
    if (!response.ok() || !isIP(ip)) throw new Error('Invalid IP check response');
    return ip;
  } finally { await context.dispose(); }
}

export async function checkTarget(server, targetURL, timeout = 5000) {
  const target = new URL(targetURL);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Unsupported target URL');
  // Local practice pages cannot be reached by a remote public proxy.
  if (['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) return 0;
  const started = performance.now();
  const context = await request.newContext({ proxy: { server }, timeout });
  try {
    const response = await context.get(target.href);
    if (!response.ok()) throw new Error(`Starting page returned HTTP ${response.status()}`);
    const html = (await response.text()).slice(0, 1000000);
    const finalURL = new URL(response.url());
    const resources = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)]
      .map(match => { try { return new URL(match[1].replaceAll('&amp;', '&'), finalURL); } catch { return null; } })
      .filter(url => url && url.origin === finalURL.origin).slice(0, 2);
    await Promise.all(resources.map(async url => {
      const remaining = timeout - (performance.now() - started);
      if (remaining <= 0) throw new Error('Page speed check timed out');
      const resource = await context.get(url.href, { timeout: remaining });
      if (!resource.ok()) throw new Error(`Page script returned HTTP ${resource.status()}`);
    }));
    return performance.now() - started;
  } finally { await context.dispose(); }
}

export class FreeProxyPool {
  constructor(root, dependencies = {}) {
    this.historyPath = path.join(root, 'proxy-used-ips.txt');
    this.download = dependencies.download || download;
    this.probe = dependencies.probe || probe;
    this.checkTarget = dependencies.checkTarget || checkTarget;
    this.rejected = new Map();
    this.servers = []; this.expires = 0; this.used = new Set();
    this.ready = readFile(this.historyPath, 'utf8').then(text => {
      for (const ip of text.split(/\s+/)) if (isIP(ip)) this.used.add(ip);
    }).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  async refresh() {
    if (!this.loading) this.loading = (async () => {
      const results = await Promise.allSettled(sources.map(source => this.download(source)));
      this.servers = [...new Set(results.flatMap(result => result.status === 'fulfilled' ? parseProxyList(result.value) : []))];
      for (let i = this.servers.length - 1; i > 0; i--) {
        const j = randomInt(i + 1); [this.servers[i], this.servers[j]] = [this.servers[j], this.servers[i]];
      }
      this.expires = Date.now() + 15 * 60 * 1000;
    })().finally(() => { this.loading = null; });
    await this.loading;
  }
  async select({ onProgress = () => {}, onSelected = () => {}, isCanceled = () => false, targetURL, maxLatencyMs = 2000, maxPageLoadMs = 6000 } = {}) {
    await this.ready;
    const checkpoint = () => { if (isCanceled()) throw new Error('Run canceled'); };
    checkpoint();
    onProgress('Finding a working public proxy with a fresh exit IP');
    if (!this.servers.length || Date.now() >= this.expires) await this.refresh();
    checkpoint();
    if (!this.servers.length) throw new Error('Public proxy lists are unavailable or contain no supported HTTP proxies. No direct connection was started.');
    // Never accept a proxy that reports the same address as a direct connection.
    let directIP;
    try { directIP = await this.probe(); }
    catch { throw new Error('Could not check the direct IP before proxy selection. Check connectivity and retry. No browser was launched.'); }
    const deadline = Date.now() + 45000;
    let checked = 0;
    for (let attempt = 0; attempt < 6 && this.servers.length && Date.now() < deadline; attempt++) {
      checkpoint();
      this.servers = this.servers.filter(server => (this.rejected.get(server) || 0) <= Date.now());
      const batch = this.servers.splice(0, 4);
      const results = await Promise.allSettled(batch.map(async server => {
        try {
          let ip, latencyMs = 0;
          for (let sample = 0; sample < 2; sample++) {
            checkpoint();
            const timeout = Math.min(maxLatencyMs, deadline - Date.now());
            if (timeout <= 0) throw new Error('Selection time limit reached');
            const started = performance.now();
            const nextIP = await this.probe(server, timeout);
            const duration = performance.now() - started;
            if (duration > maxLatencyMs) throw new Error('Slow IP check');
            if (!isIP(nextIP) || nextIP === directIP || this.used.has(nextIP)) throw new Error('Exit IP unavailable or already used');
            if (ip && ip !== nextIP) throw new Error('Exit IP changed during checks');
            ip = nextIP; latencyMs = Math.max(latencyMs, duration);
          }
          checkpoint();
          const remaining = Math.min(maxPageLoadMs, deadline - Date.now());
          if (remaining <= 0) throw new Error('Selection time limit reached');
          const pageMs = targetURL ? await this.checkTarget(server, targetURL, remaining) : 0;
          if (pageMs > maxPageLoadMs || Date.now() > deadline) throw new Error('Slow starting page');
          onProgress(`Candidate passed: IP check ${Math.round(latencyMs)} ms${targetURL ? `, page/scripts ${Math.round(pageMs)} ms` : ''}`);
          return { server, ip, latencyMs, pageMs };
        } catch (error) {
          this.rejected.set(server, Date.now() + 10 * 60 * 1000);
          onProgress('Skipped slow, unstable, or unreachable proxy');
          throw error;
        }
      }));
      checked += batch.length;
      checkpoint();
      const candidates = results.filter(result => result.status === 'fulfilled').map(result => result.value).sort((a, b) => a.pageMs + a.latencyMs - b.pageMs - b.latencyMs);
      for (const { server, ip, latencyMs, pageMs } of candidates) {
        if (!isIP(ip) || ip === directIP || this.used.has(ip)) continue;
        // Reserve before awaiting disk I/O so concurrent runs cannot claim the same IP.
        this.used.add(ip);
        await appendFile(this.historyPath, `${ip}\n`);
        onProgress(`Public proxy verified; exit IP ${ip}; IP check ${Math.round(latencyMs)} ms, page/scripts ${Math.round(pageMs)} ms`);
        onSelected({ expectedIP: ip, baselineIP: directIP });
        return { proxy: { server } };
      }
      onProgress(`Checked ${checked} public proxies; trying more`);
    }
    throw new Error('No working public proxy with an unused exit IP was found in this batch. Retry to check more proxies. No direct connection was started.');
  }
}

export function freeProxyOptions(root, options) {
  const key = path.resolve(root);
  if (!pools.has(key)) pools.set(key, new FreeProxyPool(key));
  return pools.get(key).select(options);
}
