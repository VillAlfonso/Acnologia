import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FreeProxyPool, parseProxyList, checkTarget } from '../lib/free-proxies.js';
import { createServer } from 'node:http';
import { connect } from 'node:net';

test('public lists accept only public IPv4 HTTP endpoints', () => {
  assert.deepEqual(parseProxyList('http://8.8.8.8:8080\n8.8.8.8:8080\nsocks5://1.1.1.1:1080\n127.0.0.1:80\n10.1.1.1:80\n169.254.169.254:80\n192.168.1.1:80\n100.64.0.1:80\n8.8.4.4:99999\nhttp://user:pass@1.1.1.1:80'), ['http://8.8.8.8:8080']);
});

test('public proxy selection skips failures, direct and reused IPs, and persists reservations', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browserauto-free-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const servers = ['http://8.8.8.1:80', 'http://8.8.8.2:80', 'http://8.8.8.3:80', 'http://8.8.8.4:80'];
  const dependencies = {
    download: async () => servers.join('\n'),
    probe: async server => {
      if (!server || server === servers[0]) return '9.9.9.9';
      if (server === servers[1]) throw new Error('offline');
      return server === servers[2] ? '1.1.1.1' : '1.0.0.1';
    },
  };
  const pool = new FreeProxyPool(root, dependencies);
  const first = await pool.select();
  const second = await pool.select();
  assert.notEqual(first.proxy.server, second.proxy.server);
  const restarted = new FreeProxyPool(root, dependencies);
  await assert.rejects(restarted.select(), /unused exit IP/);
  await assert.rejects(pool.select({ isCanceled: () => true }), /canceled/);
});

test('concurrent selections cannot reserve the same exit IP', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browserauto-free-concurrent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pool = new FreeProxyPool(root, {
    download: async () => Array.from({ length: 8 }, (_, i) => `8.8.8.${i + 1}:80`).join('\n'),
    probe: async server => server ? '1.1.1.1' : '9.9.9.9',
  });
  const results = await Promise.allSettled([pool.select(), pool.select()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
});

test('unavailable feeds fail closed', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browserauto-free-offline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pool = new FreeProxyPool(root, { download: async () => { throw new Error('offline'); }, probe: async () => { throw new Error('Must not probe'); } });
  await assert.rejects(pool.select(), /lists are unavailable/);
});

test('selection skips slow pages, failed sites, and changing IPs; chooses fastest healthy candidate', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browserauto-speed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const servers = Array.from({ length: 4 }, (_, i) => `http://8.8.8.${i + 1}:80`);
  const messages = [];
  const pool = new FreeProxyPool(root, {
    download: async () => servers.join('\n'),
    probe: async server => server ? `1.1.1.${servers.indexOf(server) + 1}` : '9.9.9.9',
    checkTarget: async (server, url) => {
      assert.equal(url, 'https://example.test/start');
      if (server === servers[0]) return 9000;
      if (server === servers[1]) throw Error('Script unavailable');
      return server === servers[2] ? 100 : 1000;
    },
  });
  const selected = await pool.select({ targetURL: 'https://example.test/start', maxPageLoadMs: 6000, onProgress: text => messages.push(text) });
  assert.equal(selected.proxy.server, servers[2]);
  assert.equal(messages.filter(text => text.startsWith('Skipped')).length, 2);
  assert.ok(pool.rejected.has(servers[0]));
  const changing = new FreeProxyPool(root, { download: async () => '8.8.4.4:80', probe: async server => !server ? '9.9.9.9' : (++calls === 1 ? '2.2.2.2' : '3.3.3.3') });
  let calls = 0;
  await assert.rejects(changing.select(), /No working public proxy/);
});

test('slow IP probes are rejected before target access', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browserauto-latency-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pool = new FreeProxyPool(root, {
    download: async () => '8.8.4.4:80',
    probe: async server => { if (!server) return '9.9.9.9'; await new Promise(resolve => setTimeout(resolve, 30)); return '1.1.1.1'; },
    checkTarget: async () => { assert.fail('Slow proxies must not reach the site check'); },
  });
  await assert.rejects(pool.select({ maxLatencyMs: 10, targetURL: 'https://example.test/' }), /No working public proxy/);
});

test('target check uses proxy for HTML and scripts and rejects script failures', async t => {
  const requests = [];
  let broken = false;
  const origin = createServer((req, res) => {
    requests.push(req.url);
    if (req.url.endsWith('.js')) { res.writeHead(broken ? 503 : 200); res.end('void 0'); }
    else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<script src="/main.js"></script><script src="https://other.invalid/ignored.js"></script>'); }
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  const proxy = createServer();
  const tunnels = new Set();
  proxy.on('connect', (req, client, head) => {
    assert.equal(req.url, 'speed-check.invalid:80');
    const upstream = connect(origin.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    for (const socket of [client, upstream]) { tunnels.add(socket); socket.on('close', () => tunnels.delete(socket)); socket.on('error', () => { client.destroy(); upstream.destroy(); }); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of tunnels) socket.destroy(); origin.closeAllConnections(); await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => origin.close(resolve))]); });
  const server = `http://127.0.0.1:${proxy.address().port}`;
  assert.ok(await checkTarget(server, 'http://speed-check.invalid/', 2000) >= 0);
  assert.deepEqual(requests, ['/', '/main.js']);
  broken = true;
  await assert.rejects(checkTarget(server, 'http://speed-check.invalid/', 2000), /script returned HTTP 503/);
});
