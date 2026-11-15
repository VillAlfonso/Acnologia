import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FreeProxyPool, parseProxyList } from '../lib/free-proxies.js';

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
