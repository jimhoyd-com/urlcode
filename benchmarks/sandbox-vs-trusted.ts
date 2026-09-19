// Sandboxed (`sandbox: true`) vs trusted (`sandbox` absent) function dispatch,
// same handler source, same request shape, only the route's `sandbox` field
// differing. Methodology follows benchmarks/routing.ts: a private in-process
// server, a keep-alive HTTP agent, a warmup phase excluded from every
// statistic, then a fixed-size measured burst driven at a chosen concurrency.
// See docs/CAPACITY.md for how these numbers are used and docs/LOAD-TESTING.md
// for what a benchmark run does and does not prove.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import http from 'node:http';
import { startServer } from '../src/server.ts';
import type { Server } from '../src/server.ts';

// Both routes run this exact handler; only their `sandbox` field differs.
// The 20 ms guest timer stands in for a modest I/O-bound call (an upstream
// fetch, a small computation with a yield) long enough that overlapping
// in-flight calls actually contend for a worker slot (sandboxed) or an
// admission slot (trusted) at the concurrency levels below — an
// instant-return handler would never make either ceiling visible.
const handlerSource = `export default () => new Promise(resolve => setTimeout(() => resolve(Response.json({ ok: true })), 20));`;

const concurrencyLevels = [1, 2, 8, 32, 128];
const requestsPerLevel = 2000;
const warmupPerLevel = 20;

function hit(port: number, path: string, agent: http.Agent): Promise<{ ms: number; status: number }> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const req = http.get({ host: '127.0.0.1', port, path, agent, timeout: 10000 }, res => {
      res.resume();
      res.on('error', reject);
      res.on('end', () => resolve({ ms: performance.now() - started, status: res.statusCode ?? 0 }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Timeout')));
  });
}

async function runLevel(port: number, path: string, concurrency: number) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  try {
    for (let i = 0; i < warmupPerLevel; i++) { try { await hit(port, path, agent); } catch { /* warmup only */ } }
    const times: number[] = [];
    const statuses: Record<string, number> = {};
    let transportErrors = 0;
    let next = 0;
    const began = performance.now();
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next < requestsPerLevel) {
        next++;
        try {
          const { ms, status } = await hit(port, path, agent);
          statuses[status] = (statuses[status] ?? 0) + 1;
          if (status === 200) times.push(ms);
        } catch { transportErrors++; }
      }
    }));
    const elapsedMs = performance.now() - began;
    times.sort((a, b) => a - b);
    const shed = (statuses['503'] ?? 0) + (statuses['504'] ?? 0);
    return {
      concurrency, requests: requestsPerLevel, elapsedMs: Math.round(elapsedMs),
      successful: times.length, shedResponses: shed, transportErrors, statuses,
      requestsPerSecond: Math.round(times.length / elapsedMs * 1000),
      p50Ms: times.length ? Math.round((times[Math.floor(times.length * 0.5)] ?? 0) * 100) / 100 : null,
      p95Ms: times.length ? Math.round((times[Math.floor(times.length * 0.95)] ?? 0) * 100) / 100 : null,
      p99Ms: times.length ? Math.round((times[Math.floor(times.length * 0.99)] ?? 0) * 100) / 100 : null,
    };
  } finally { agent.destroy(); }
}

const root = await mkdtemp(join(tmpdir(), 'urlcode-sandbox-vs-trusted-'));
let app: Server | undefined;
try {
  await writeFile(join(root, 'f.mjs'), handlerSource);
  await writeFile(join(root, 'urlcode.yaml'), [
    'version: "1"',
    'routes:',
    '  /sandboxed:',
    '    sandbox: true',
    '    function:',
    '      source: f.mjs',
    '  /trusted:',
    '    function:',
    '      source: f.mjs',
    '',
  ].join('\n'));
  // Defaults on purpose: 2 sandbox workers, 64 max-in-flight admission — the
  // same numbers docs/CAPACITY.md documents, so this run measures exactly the
  // ceilings that document describes rather than a tuned-up comparison.
  app = await startServer({ project: root, port: 0, log: () => {} });
  const port = app.address.port;

  const sandboxed = [];
  const trusted = [];
  for (const concurrency of concurrencyLevels) sandboxed.push(await runLevel(port, '/sandboxed', concurrency));
  for (const concurrency of concurrencyLevels) trusted.push(await runLevel(port, '/trusted', concurrency));

  console.log(JSON.stringify({
    node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, cpuCount: cpus().length,
    systemMemoryGiB: Math.round(totalmem() / 2 ** 30), date: new Date().toISOString(),
    handler: '20ms guest timer, same source for both routes',
    serverOptions: { workers: 2, maxInFlightRequests: 64, timeoutMs: 5000 },
    requestsPerLevel, warmupPerLevel, concurrencyLevels,
    sandboxed, trusted,
  }, null, 2));
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
