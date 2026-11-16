import http from 'node:http';
import net from 'node:net';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
async function defaultAdb() {
  const file = process.env.BROWSERAUTO_ADB_PATH || 'C:/BrowserAuto/tools/platform-tools/adb.exe';
  try { await access(file); return file; } catch { return 'adb'; }
}
export async function mobileDevices(adbPath) {
  let stdout;
  try { ({ stdout } = await exec(adbPath || await defaultAdb(), ['devices'], { windowsHide: true, timeout: 10000 })); }
  catch { throw new Error('ADB not found. Install Android Platform Tools and select adb.exe in Mobile setup.'); }
  return stdout.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(parts => parts.length === 2 && !parts[0].startsWith('*')).map(([serial, status]) => ({ serial, status }));
}
export async function cycleAirplane(config, { onProgress = () => {}, isCanceled = () => false } = {}, dependencies = {}) {
  const run = dependencies.exec || exec;
  const wait = dependencies.wait || delay;
  if (!config.serial || !/^[a-zA-Z0-9._:-]+$/.test(config.serial)) throw new Error('Choose an authorized Android phone in Mobile setup.');
  const command = async action => {
    try {
      const { stdout, stderr } = await run(config.adbPath || 'adb', ['-s', config.serial, 'shell', 'cmd', 'connectivity', 'airplane-mode', ...(action ? [action] : [])], { windowsHide: true, timeout: 15000 });
      if (/error|exception|denied|unknown/i.test(stdout + stderr)) throw new Error('unsupported');
      return stdout.trim();
    } catch { throw new Error('The phone refused airplane-mode control. Check USB debugging authorization and device support.'); }
  };
  if (isCanceled()) throw new Error('Mobile rotation canceled.');
  if (await command() !== 'disabled') throw new Error('Turn airplane mode off on the phone before starting.');
  onProgress('Cycling phone airplane mode; mobile connectivity will briefly disconnect');
  try {
    await command('enable');
    if (await command() !== 'enabled') throw new Error('The phone did not enable airplane mode.');
    await wait(5000);
  } finally {
    // Always attempt to restore connectivity, even after a failed command or cancellation.
    await command('disable');
    if (await command() !== 'disabled') throw new Error('Could not confirm airplane mode is off. Turn it off manually on the phone.');
  }
  if (isCanceled()) throw new Error('Mobile rotation canceled.');
  onProgress('Airplane mode is off; waiting for USB tethering to reconnect');
}

export async function mobileAdapters() {
  const script = "@(Get-NetIPConfiguration | Where-Object { $_.NetAdapter.Status -eq 'Up' -and $_.IPv4Address -and $_.IPv4DefaultGateway } | ForEach-Object { [pscustomobject]@{ id=$_.NetAdapter.InterfaceGuid.ToString(); name=$_.InterfaceAlias; description=$_.InterfaceDescription; address=$_.IPv4Address[0].IPAddress } }) | ConvertTo-Json -Compress";
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 });
  const parsed = stdout.trim() ? JSON.parse(stdout) : [];
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(item => /USB|RNDIS|Remote NDIS|Android/i.test(item.description));
}
export async function readMobile(root) {
  try { return JSON.parse(await readFile(path.join(root, 'mobile.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { adbPath: await defaultAdb() }; throw new Error('Cannot read Mobile setup settings.'); }
}
export async function saveMobile(root, input) {
  if (typeof input.adbPath !== 'string' || input.adbPath.length > 500 || !/^[a-zA-Z0-9._:-]{1,200}$/.test(input.serial || '') || !/^[a-f0-9{}-]{36,38}$/i.test(input.adapterId || '')) throw new Error('Select adb.exe, an authorized phone, and its USB tethering adapter.');
  await writeFile(path.join(root, 'mobile.json'), JSON.stringify({ adbPath: input.adbPath, serial: input.serial, adapterId: input.adapterId }, null, 2));
}
// A loopback-only forward proxy binds every outgoing socket to the selected USB IPv4.
// No request is retried on another adapter when the phone disconnects.
export async function createMobileRelay(initialAddress) {
  let address = initialAddress, blocked = false;
  const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); return socket; };
  const server = http.createServer((req, res) => {
    if (blocked) { res.writeHead(503); res.end(); return; }
    let url;
    try { url = new URL(req.url); if (url.protocol !== 'http:' || url.username || url.password) throw new Error(); }
    catch { res.writeHead(400); res.end(); return; }
    const headers = { ...req.headers, host: url.host }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
    const upstream = http.request(url, { method: req.method, headers, localAddress: address, family: 4, agent: false, timeout: 15000 }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on('socket', track); upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('aborted', () => upstream.destroy()); req.pipe(upstream);
  });
  server.on('connection', track);
  server.on('connect', (req, client, head) => {
    if (blocked) { client.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return; }
    let target;
    try { target = new URL('http://' + req.url); if (!target.hostname || target.username || target.password || target.pathname !== '/') throw new Error(); }
    catch { client.destroy(); return; }
    const upstream = track(net.createConnection({ host: target.hostname, port: Number(target.port || 443), localAddress: address, family: 4 }));
    upstream.setTimeout(15000, () => upstream.destroy());
    upstream.on('connect', () => { upstream.setTimeout(0); client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    server: `http://127.0.0.1:${server.address().port}`,
    block() { blocked = true; for (const socket of sockets) socket.destroy(); },
    resume(nextAddress) { address = nextAddress; blocked = false; },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}
export function mobileExitIP(address) {
  return new Promise((resolve, reject) => {
    const request = https.get('https://api.ipify.org', { localAddress: address, family: 4, agent: false, timeout: 8000 }, response => {
      let text = ''; response.on('data', chunk => { text += chunk; if (text.length > 100) request.destroy(); });
      response.on('end', () => response.statusCode === 200 && net.isIP(text.trim()) ? resolve(text.trim()) : reject(new Error('Invalid mobile IP response')));
    });
    request.on('timeout', () => request.destroy(new Error('Mobile connection timed out'))); request.on('error', reject);
  });
}
let inUse = false;
export async function openMobile(root, options = {}, dependencies = {}) {
  const getDevices = dependencies.devices || mobileDevices;
  const getAdapters = dependencies.adapters || mobileAdapters;
  const getIP = dependencies.exitIP || mobileExitIP;
  const cycle = dependencies.cycle || cycleAirplane;
  const makeRelay = dependencies.relay || createMobileRelay;
  const run = dependencies.exec || exec;
  const wait = dependencies.wait || delay;
  const now = dependencies.now || Date.now;
  if (inUse) throw new Error('The phone is already in use. Stop capture or close its run browser before starting another mobile session.');
  inUse = true;
  let relay, released = false;
  const release = async () => { if (released) return; released = true; try { await relay?.close(); } finally { inUse = false; } };
  try {
    const config = await readMobile(root);
    const devices = await getDevices(config.adbPath);
    if (!devices.some(d => d.serial === config.serial && d.status === 'device')) throw new Error('Connect and authorize the selected phone over USB.');
    const adapter = (await getAdapters()).find(a => a.id === config.adapterId);
    if (!adapter) throw new Error('Enable USB tethering and select the phone adapter in Mobile setup.');
    const { stdout } = await run(config.adbPath || 'adb', ['-s', config.serial, 'shell', 'settings', 'get', 'global', 'wifi_on'], { windowsHide: true, timeout: 10000 });
    if (stdout.trim() !== '0') throw new Error('Turn phone Wi-Fi off so tethering uses mobile data.');
    let exitIP = await getIP(adapter.address);
    relay = await makeRelay(adapter.address);
    const rotate = async () => {
      if (released) throw new Error('Mobile session is closed.');
      const before = exitIP;
      relay.block();
      try {
        await cycle(config, options);
        const deadline = now() + 60000;
        while (now() < deadline) {
          if (options.isCanceled?.() || released) throw new Error('Mobile rotation canceled.');
          try {
            const current = (await getAdapters()).find(a => a.id === config.adapterId);
            if (current) {
              const next = await getIP(current.address);
              if (next !== before) { exitIP = next; relay.resume(current.address); options.onProgress?.('Mobile exit IP changed to ' + next); return next; }
            }
          } catch {}
          await wait(2000);
        }
        throw new Error('No new mobile IP confirmed. The carrier may have reused the IP, or USB tethering needs re-enabling. Mobile browser traffic remains paused; retry Change mobile IP.');
      } catch (error) { throw error; }
    };
    await rotate();
    options.onSelected?.({ expectedIP: exitIP, allowDirectMatch: true });
    const result = { proxy: { server: relay.server } };
    Object.defineProperty(result, 'mobile', { value: { rotate, release, pause: () => relay.block(), get exitIP() { return exitIP; } } });
    return result;
  } catch (error) { await release(); throw error; }
}
export function attachMobile(browser, proxyOptions) {
  if (proxyOptions?.mobile) browser.once('disconnected', () => { proxyOptions.mobile.release().catch(() => {}); });
}
