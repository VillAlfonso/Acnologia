import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FreeProxyPool, proxySources } from '../lib/free-proxies.js';

const targetURL = process.argv[2];
if (!targetURL || !/^https?:\/\//.test(targetURL)) throw new Error('Usage: node scripts/check-proxies.js https://example.com/');
const root = await mkdtemp(path.join(os.tmpdir(), 'browserauto-proxy-benchmark-'));
const report = { startedAt: new Date().toISOString(), targetURL, maxLatencyMs: 2000, maxPageLoadMs: 6000, maxCandidatesPerSource: 24, sources: [] };
await mkdir('test-results', { recursive: true });
const filename = path.resolve('test-results', `proxy-benchmark-${Date.now()}.json`);
try {
  for (const source of proxySources) {
    const pool = new FreeProxyPool(root, { sources: [source] });
    const candidates = [];
    const entry = { name: source.name, candidates };
    console.log(`Testing ${source.name}...`);
    try {
      const result = await pool.select({ targetURL, maxLatencyMs: 2000, maxPageLoadMs: 6000, onCandidate: candidate => candidates.push(candidate) });
      entry.selected = result.proxy.server;
    } catch (error) { entry.error = error.message; }
    entry.list = pool.sourceReports[0];
    entry.passed = candidates.filter(candidate => candidate.status === 'passed').length;
    report.sources.push(entry);
    await writeFile(filename, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ source: source.name, loaded: entry.list?.count || 0, tested: candidates.length, passed: entry.passed, timings: candidates.filter(candidate => candidate.status === 'passed').map(candidate => ({ ipMs: Math.round(candidate.latencyMs), pageMs: Math.round(candidate.pageMs) })), ...(candidates.length ? {} : { error: entry.error }) }));
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(filename, JSON.stringify(report, null, 2));
  console.log(`Report: ${filename}`);
} finally { await rm(root, { recursive: true, force: true }); }
// All probes, report writes, and cleanup have completed; close any idle network handles.
process.exit(0);
