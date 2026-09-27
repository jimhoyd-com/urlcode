// Standalone reproducer for #708: V8 aborts with
//   Check failed: jit_page_->allocations_.erase(addr) == 1
//   v8::internal::ThreadIsolation::UnregisterJitAllocationForTesting
// seen on Windows / Node 24 while URLCode's sandbox tests terminate and respawn
// worker threads that run WebAssembly.
//
// This file depends on nothing from URLCode. It only needs Node, and, for the
// optional `quickjs` workload, the `quickjs-emscripten` package. It keeps a
// number of worker_threads in flight; each one compiles and runs WebAssembly
// under top-level await and is terminated at a random point (while compiling,
// while running hot code that is tiering up, or not at all), then replaced.
//
// Usage: node scripts/repro/wasm-worker-churn.mjs [--iterations N] [--concurrency C]
//          [--workloads synthetic,wasm-file,quickjs] [--unique-modules] [--seed S]
//          [--wasm-file PATH] [--no-exit-live] [--quiet]
// Exit code 0 means no crash in this run; a V8 fatal error aborts the process.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- synthetic WASM
// A module of `functions` hot loops plus an exported `run(n)` that calls them all.
// Calling `run` repeatedly makes V8 lazily compile with Liftoff, then tier the
// functions up with TurboFan on background threads: the JIT allocation churn the
// crash names. Identical bytes across workers share V8's process-wide native
// module cache; `salt` makes each worker's bytes unique instead.
function uleb(value) { const out = []; do { let byte = value & 0x7f; value >>>= 7; if (value) byte |= 0x80; out.push(byte); } while (value); return out; }
function sleb(value) {
  const out = [];
  for (;;) {
    const byte = value & 0x7f; value >>= 7;
    if ((value === 0 && !(byte & 0x40)) || (value === -1 && (byte & 0x40))) { out.push(byte); return out; }
    out.push(byte | 0x80);
  }
}
const section = (id, bytes) => [id, ...uleb(bytes.length), ...bytes];
const vec = items => [...uleb(items.length), ...items.flat()];
function syntheticModule({ functions = 160, unroll = 12, salt = 0 } = {}) {
  const I32 = 0x7f;
  const types = section(1, vec([[0x60, 1, I32, 1, I32]]));
  const funcs = section(3, vec(Array.from({ length: functions + 1 }, () => [0])));
  const exportsSection = section(7, vec([[...uleb(3), ...Buffer.from('run'), 0x00, ...uleb(functions)]]));
  const bodies = [];
  for (let f = 0; f < functions; f++) {
    const step = [];
    for (let u = 0; u < unroll; u++) {
      // acc = ((acc * k) + n) ^ c
      step.push(0x20, 1, 0x41, ...sleb((f * 131 + u * 7 + 3) | 1), 0x6c, 0x20, 0, 0x6a, 0x41, ...sleb((salt + f * 17 + u) & 0x3fffffff), 0x73, 0x21, 1);
    }
    const code = [
      0x02, 0x40, 0x03, 0x40, // block, loop
      0x20, 0, 0x45, 0x0d, 1, // if (n == 0) break
      ...step,
      0x20, 0, 0x41, 1, 0x6b, 0x21, 0, // n = n - 1
      0x0c, 0, 0x0b, 0x0b, // continue; end loop; end block
      0x20, 1, 0x0b, // return acc
    ];
    const body = [1, 1, I32, ...code];
    bodies.push([...uleb(body.length), ...body]);
  }
  const run = [0x41, 0];
  for (let f = 0; f < functions; f++) run.push(0x20, 0, 0x10, ...uleb(f), 0x73);
  run.push(0x0b);
  const runBody = [0, ...run];
  bodies.push([...uleb(runBody.length), ...runBody]);
  const code = section(10, vec(bodies));
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...types, ...funcs, ...exportsSection, ...code]);
}

// Stub every import so an arbitrary module (the QuickJS .wasm here) can be instantiated without its JS glue.
function stubImports(module) {
  const imports = {};
  for (const { module: name, name: field, kind } of WebAssembly.Module.imports(module)) {
    imports[name] ??= {};
    if (kind === 'function') imports[name][field] = () => 0;
    else if (kind === 'memory') imports[name][field] = new WebAssembly.Memory({ initial: 256, maximum: 32768 });
    else if (kind === 'table') imports[name][field] = new WebAssembly.Table({ initial: 4096, element: 'anyfunc' });
    else if (kind === 'global') imports[name][field] = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
  }
  return imports;
}

// ---------------------------------------------------------------- worker side
if (!isMainThread) {
  const { workload, bytes, wasmFile, compile, runs } = workerData;
  const port = parentPort;
  const hotFor = async fn => {
    // `runs` < 0 means run until terminated. Yield between batches so the
    // worker also sees terminate at a safe point, not only inside wasm.
    for (let i = 0; runs < 0 || i < runs; i++) {
      fn();
      if (i === 2) port.postMessage('hot');
      if (i % 4 === 3) await new Promise(resolve => setImmediate(resolve));
    }
  };
  // Everything below runs under top-level await, like URLCode's function-worker.ts.
  if (workload === 'quickjs') {
    const { getQuickJS } = await import('quickjs-emscripten');
    const engine = await getQuickJS();
    port.postMessage('compiled');
    await hotFor(() => {
      const runtime = engine.newRuntime();
      runtime.setMemoryLimit(32 * 1024 * 1024);
      const vm = runtime.newContext();
      const result = vm.evalCode('let a = 0; for (let i = 0; i < 20000; i++) a = (a * 31 + i) | 0; a');
      if (result.error) result.error.dispose(); else result.value.dispose();
      vm.dispose(); runtime.dispose();
    });
  } else {
    const source = workload === 'wasm-file' ? await readFile(wasmFile) : bytes;
    const module = compile === 'sync' ? new WebAssembly.Module(source) : await WebAssembly.compile(source);
    port.postMessage('compiled');
    if (workload === 'wasm-file') {
      new WebAssembly.Instance(module, stubImports(module));
      // The QuickJS exports need their JS glue to run; recompile instead so the module churns.
      await hotFor(() => { new WebAssembly.Module(source); });
    } else {
      const { exports } = await WebAssembly.instantiate(module, {});
      await hotFor(() => exports.run(2000));
    }
  }
  port.postMessage('done');
} else {
  await main();
}

// ---------------------------------------------------------------- main side
function options(argv) {
  const opts = { iterations: 500, concurrency: 8, workloads: 'synthetic,wasm-file,quickjs', uniqueModules: false, seed: Date.now() % 1e9, wasmFile: '', exitLive: true, quiet: false, stuckMs: 60000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], next = () => { const value = argv[++i]; if (value === undefined) throw new Error(`${arg} needs a value`); return value; };
    if (arg === '--iterations') opts.iterations = Number(next());
    else if (arg === '--concurrency') opts.concurrency = Number(next());
    else if (arg === '--workloads') opts.workloads = next();
    else if (arg === '--unique-modules') opts.uniqueModules = true;
    else if (arg === '--seed') opts.seed = Number(next());
    else if (arg === '--wasm-file') opts.wasmFile = next();
    else if (arg === '--no-exit-live') opts.exitLive = false;
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '--help') { console.log('See the header of this file and scripts/repro/README.md.'); process.exit(0); }
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!Number.isInteger(opts.iterations) || opts.iterations < 1) throw new Error('--iterations must be a positive integer');
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) throw new Error('--concurrency must be a positive integer');
  return opts;
}

// Seeded so a run can be repeated with --seed.
function prng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function resolveQuickJS() {
  try {
    const require = createRequire(import.meta.url);
    const packageDir = dirname(require.resolve('@jitl/quickjs-wasmfile-release-sync/package.json'));
    return { wasm: join(packageDir, 'dist', 'emscripten-module.wasm'), engine: true };
  } catch { return { wasm: '', engine: false }; }
}

async function main() {
  const opts = options(process.argv.slice(2));
  const random = prng(opts.seed);
  const quickjs = resolveQuickJS();
  const wasmFile = opts.wasmFile || quickjs.wasm;
  let workloads = opts.workloads.split(',').map(s => s.trim()).filter(Boolean);
  const skipped = [];
  if (workloads.includes('wasm-file') && !wasmFile) { skipped.push('wasm-file'); workloads = workloads.filter(w => w !== 'wasm-file'); }
  if (workloads.includes('quickjs') && !quickjs.engine) { skipped.push('quickjs'); workloads = workloads.filter(w => w !== 'quickjs'); }
  for (const w of workloads) if (!['synthetic', 'wasm-file', 'quickjs'].includes(w)) throw new Error(`Unknown workload ${w}`);
  if (!workloads.length) throw new Error('No runnable workload');
  const shared = syntheticModule();
  const log = message => { if (!opts.quiet) console.log(message); };
  log(JSON.stringify({ reproducer: 'wasm-worker-churn', node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, ...opts, workloads, skipped, wasmFile: workloads.includes('wasm-file') ? wasmFile : undefined, file: fileURLToPath(import.meta.url) }));

  const counts = { spawned: 0, errors: 0 };
  const byWorkload = Object.fromEntries(workloads.map(w => [w, 0]));
  const started = performance.now();

  function spawn(index, forced) {
    const workload = workloads[Math.floor(random() * workloads.length)];
    const plan = forced ?? (random() < 0.4 ? 'startup' : random() < 0.8 ? 'hot' : 'natural');
    const delay = Math.floor(random() * (plan === 'startup' ? 40 : 150));
    const data = { workload, wasmFile, compile: random() < 0.5 ? 'async' : 'sync', runs: plan === 'natural' ? 6 : -1,
      bytes: workload === 'synthetic' ? (opts.uniqueModules ? syntheticModule({ salt: index + 1 }) : shared) : undefined };
    // Same shape as URLCode's sandbox pool: empty env, no execArgv, piped stdio, resource limits.
    const worker = new Worker(fileURLToPath(import.meta.url), { workerData: data, env: {}, execArgv: [], stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 } });
    worker.stdout.resume(); worker.stderr.resume();
    counts.spawned++; byWorkload[workload]++;
    return new Promise(resolve => {
      // `phase` is the last progress message the worker posted when terminate() was called.
      let settled = false, phase = 'loading', outcome = plan === 'natural' ? 'natural' : 'exitedEarly';
      const finish = () => { if (settled) return; settled = true; clearTimeout(stuck); counts[outcome] = (counts[outcome] || 0) + 1; resolve(worker); };
      const stuck = setTimeout(() => { outcome = 'stuck'; void worker.terminate(); finish(); }, opts.stuckMs);
      const terminate = () => setTimeout(() => { outcome = `terminatedWhile_${phase}`; void worker.terminate(); }, delay);
      if (plan === 'startup') terminate();
      worker.on('message', message => { phase = message; if (message === 'hot' && plan === 'hot') terminate(); });
      worker.on('error', () => { counts.errors++; });
      worker.on('exit', finish);
    });
  }

  let next = 0, completed = 0, lastReport = 0;
  const lane = async () => {
    while (next < opts.iterations) {
      const index = next++;
      await spawn(index);
      completed++;
      const percent = Math.floor(completed * 10 / opts.iterations);
      if (percent > lastReport) { lastReport = percent; log(`progress ${completed}/${opts.iterations} ${Math.round(performance.now() - started)}ms`); }
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency }, lane));

  const summary = { result: 'no-crash', iterations: opts.iterations, elapsedMs: Math.round(performance.now() - started), counts, byWorkload };
  if (!opts.exitLive) { console.log(JSON.stringify(summary)); return; }
  // Final phase: exit the process while workers are still running hot WebAssembly, as a test
  // file's process does when it ends with workers alive. Node tears those isolates down at exit.
  const live = Array.from({ length: opts.concurrency }, (_, i) => new Promise(resolve => {
    const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { workload: 'synthetic', bytes: shared, compile: 'async', runs: -1 }, env: {}, execArgv: [], stdout: true, stderr: true });
    worker.stdout.resume(); worker.stderr.resume();
    worker.on('message', message => { if (message === 'hot') resolve(i); });
    worker.on('error', () => resolve(i)); worker.on('exit', () => resolve(i));
  }));
  await Promise.race([Promise.all(live), new Promise(resolve => setTimeout(resolve, 10000))]);
  summary.elapsedMs = Math.round(performance.now() - started);
  summary.exitedWithLiveWorkers = opts.concurrency;
  console.log(JSON.stringify(summary));
  process.exit(0);
}
