// URLCode-specific reproducer for #708: drives the real sandbox worker pool
// (packages/core/src/functions.ts `SandboxPool`, the engine behind
// `sandbox: true` routes and `FunctionPool`) through the deadline-terminate /
// respawn / close churn that test/sandbox.test.ts's "repeated guest deadlines"
// test performs, in a loop. It changes nothing in the pool; it only calls it.
//
// Usage: node --conditions=development scripts/repro/function-pool-churn.ts
//          [--iterations N] [--pools P] [--workers W] [--deadlines D] [--timeout-ms T]
//          [--pattern test|churn] [--quiet]
//   --pattern test   mirror the test: D back-to-back slow requests (504 or 503), then wait for recovery and close.
//   --pattern churn  wait for a free ready slot before each slow request, so every one ends in a deadline
//                    terminate, and close the pool while respawns may still be starting.
// Exit code 0 means no crash in this run; a V8 fatal error aborts the process.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxPool } from '../../packages/core/src/functions.ts';
import type { FunctionContext } from '../../packages/core/src/functions.ts';

interface Options { iterations: number; pools: number; workers: number; deadlines: number; timeoutMs: number; pattern: 'test' | 'churn'; quiet: boolean }
function options(argv: string[]): Options {
  const opts: Options = { iterations: 20, pools: 1, workers: 2, deadlines: 8, timeoutMs: 100, pattern: 'test', quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => { const value = argv[++i]; if (value === undefined) throw new Error(`${arg} needs a value`); return value; };
    const int = (): number => { const value = Number(next()); if (!Number.isInteger(value) || value < 1) throw new Error(`${arg} must be a positive integer`); return value; };
    if (arg === '--iterations') opts.iterations = int();
    else if (arg === '--pools') opts.pools = int();
    else if (arg === '--workers') opts.workers = int();
    else if (arg === '--deadlines') opts.deadlines = int();
    else if (arg === '--timeout-ms') opts.timeoutMs = int();
    else if (arg === '--pattern') { const value = next(); if (value !== 'test' && value !== 'churn') throw new Error('--pattern is test or churn'); opts.pattern = value; }
    else if (arg === '--quiet') opts.quiet = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  return opts;
}

const opts = options(process.argv.slice(2));
const log = (message: string): void => { if (!opts.quiet) console.log(message); };
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const request = { url: 'http://localhost/', method: 'GET', headers: [] };
const context: FunctionContext = { inputs: { path: {}, query: {}, header: {} }, env: {}, secrets: {}, requestId: 'repro' };
const counts: Record<string, number> = { deadline: 0, unavailable: 0, otherError: 0, recovered: 0, restartingEvents: 0 };

// The same two guest modules as the test: one that spins past any deadline, one that answers at once.
const root = await mkdtemp(join(tmpdir(), 'urlcode-708-'));
await writeFile(join(root, 'slow.mjs'), `export default () => { const end = Date.now() + 60000; while (Date.now() < end) {} return new Response('never'); };`);
await writeFile(join(root, 'fast.mjs'), `export default () => new Response('fast');`);
const slow = { source: join(root, 'slow.mjs'), export: 'default' }, fast = { source: join(root, 'fast.mjs'), export: 'default' };

async function invoke(pool: SandboxPool, entry: typeof slow): Promise<number> {
  try { return (await pool.execute({ entry }, request, context, undefined)).status; }
  catch (error) { return (error as { status?: number }).status ?? 0; }
}
async function until(check: () => boolean | Promise<boolean>, ms = 30000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await check()) return true; await sleep(5); }
  return false;
}
const tally = (status: number): void => { counts[status === 504 ? 'deadline' : status === 503 ? 'unavailable' : 'otherError']!++; };

async function iteration(): Promise<void> {
  const pool = await new SandboxPool([slow, fast], { root, workers: opts.workers, timeoutMs: opts.timeoutMs,
    log: event => { if (event['status'] === 'restarting') counts['restartingEvents']!++; } }).start();
  try {
    for (let d = 0; d < opts.deadlines; d++) {
      if (opts.pattern === 'churn') await until(() => pool.slots.some(slot => slot?.ready && !slot.pending));
      tally(await invoke(pool, slow));
    }
    if (opts.pattern === 'test') {
      // Recovery, as the test asserts it: a fast answer, then every slot ready again.
      if (await until(async () => await invoke(pool, fast) === 200) && await until(() => pool.healthy)) counts['recovered']!++;
    }
  } finally { await pool.close(); }
}

log(JSON.stringify({ reproducer: 'function-pool-churn', node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, ...opts }));
const started = performance.now();
try {
  let next = 0;
  await Promise.all(Array.from({ length: opts.pools }, async () => {
    while (next < opts.iterations) {
      const index = ++next;
      const t = performance.now();
      await iteration();
      log(`iteration ${index}/${opts.iterations} ${Math.round(performance.now() - t)}ms`);
    }
  }));
} finally { await rm(root, { recursive: true, force: true }); }
console.log(JSON.stringify({ result: 'no-crash', iterations: opts.iterations, elapsedMs: Math.round(performance.now() - started), counts }));
