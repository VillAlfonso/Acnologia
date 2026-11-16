import { request } from 'playwright';
import { isIP } from 'node:net';
import { randomInt } from 'node:crypto';
import { readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

export const proxySources = [
  { name: 'IPLocate', url: 'https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/http.txt' },
  { name: 'ProxyScrape', url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text' },
  { name: 'Monosans', url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt' },
  { name: 'Proxifly', url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt' },
  { name: 'Geonode', url: 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=http', format: 'geonode' },
  { name: 'MADEVAL', url: 'https://raw.githubusercontent.com/MADEVAL/free-proxy-list/main/http.txt' },
  { name: 'TheSpeedX', url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt' },
  { name: 'OpenProxyList', url: 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt' },
  { name: 'Vakhov', url: 'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt' },
  { name: 'Jetkai', url: 'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt' },
  { name: 'Dahono', url: 'https://raw.githubusercontent.com/Dahono-com/free-proxy-list/main/proxies/http.txt' },
  { name: 'Proxmint', url: 'https://raw.githubusercontent.com/proxmint/free-proxy-list/main/proxies/http.txt' },
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
  for (const line of text.slice(0, 8000000).split(/\s+/)) {
    const match = /^(?:http:\/\/)?(\d+\.\d+\.\d+\.\d+):(\d{1,5})\/?$/.exec(line);
    if (match && publicIPv4(match[1]) && Number(match[2]) > 0 && Number(match[2]) <= 65535) servers.add(`http://${match[1]}:${Number(match[2])}`);
  }
  return [...servers];
}

export function parseSource(source, text) {
  if (source.format !== 'geonode') return parseProxyList(text);
  const json = JSON.parse(text);
  if (!Array.isArray(json.data)) throw new Error('Invalid Geonode response');
  return parseProxyList(json.data.filter(row => Array.isArray(row.protocols) && row.protocols.includes('http')).map(row => `${row.ip}:${row.port}`).join('\n'));
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
    this.sources = dependencies.sources || proxySources;
    this.sourceReports = [];
    this.serverSources = new Map();
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
      const results = await Promise.allSettled(this.sources.map(async source => parseSource(source, await this.download(source.url))));
      this.serverSources.clear();
      this.sourceReports = results.map((result, index) => ({ name: this.sources[index].name, status: result.status === 'fulfilled' ? 'loaded' : 'unavailable', count: result.status === 'fulfilled' ? result.value.length : 0 }));
      const lists = results.map((result, index) => {
        const list = result.status === 'fulfilled' ? result.value : [];
        for (const server of list) {
          if (!this.serverSources.has(server)) this.serverSources.set(server, []);
          this.serverSources.get(server).push(this.sources[index].name);
        }
        for (let i = list.length - 1; i > 0; i--) { const j = randomInt(i + 1); [list[i], list[j]] = [list[j], list[i]]; }
        return list;
      });
      // Round-robin feeds so a very large list cannot crowd out smaller sources.
      const unique = new Set();
      const offset = randomInt(Math.max(1, lists.length));
      const length = Math.max(0, ...lists.map(list => list.length));
      for (let row = 0; row < length; row++) {
        for (let column = 0; column < lists.length; column++) {
          const server = lists[(column + offset) % lists.length][row];
          if (server) unique.add(server);
        }
      }
      this.servers = [...unique];
      this.expires = Date.now() + 15 * 60 * 1000;
    })().finally(() => { this.loading = null; });
    await this.loading;
  }
  async select({ onProgress = () => {}, onSelected = () => {}, onCandidate = () => {}, isCanceled = () => false, targetURL, maxLatencyMs = 2000, maxPageLoadMs = 6000 } = {}) {
    await this.ready;
    const checkpoint = () => { if (isCanceled()) throw new Error('Run canceled'); };
    checkpoint();
    onProgress('Finding a working public proxy with a fresh exit IP');
    if (!this.servers.length || Date.now() >= this.expires) await this.refresh();
    for (const source of this.sourceReports) onProgress(`${source.name}: ${source.status === 'loaded' ? source.count + ' HTTP candidates loaded' : 'list unavailable; continuing with other sources'}`);
    checkpoint();
    if (!this.servers.length) throw new Error('Public proxy lists are unavailable or contain no supported HTTP proxies. No direct connection was started.');
    // Never accept a proxy that reports the same address as a direct connection.
    let directIP;
    try { directIP = await this.probe(); }
    catch { throw new Error('Could not check the direct IP before proxy selection. Check connectivity and retry. No browser was launched.'); }
    const deadline = Date.now() + 45000;
    let checked = 0;
    for (let attempt = 0; attempt < 12 && this.servers.length && Date.now() < deadline; attempt++) {
      checkpoint();
      this.servers = this.servers.filter(server => (this.rejected.get(server) || 0) <= Date.now());
      const batch = this.servers.splice(0, 8);
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
          onProgress(`Candidate passed (${(this.serverSources.get(server) || []).join(', ')}): IP check ${Math.round(latencyMs)} ms${targetURL ? `, page/scripts ${Math.round(pageMs)} ms` : ''}`);
          onCandidate({ server, sources: this.serverSources.get(server) || [], status: 'passed', ip, latencyMs, pageMs });
          return { server, ip, latencyMs, pageMs };
        } catch (error) {
          this.rejected.set(server, Date.now() + 10 * 60 * 1000);
          onProgress('Skipped slow, unstable, or unreachable proxy');
          onCandidate({ server, sources: this.serverSources.get(server) || [], status: 'failed', error: error.message.split('\n')[0] });
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
