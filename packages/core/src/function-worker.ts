import { parentPort, workerData } from 'node:worker_threads';
import { posix } from 'node:path';
import { newQuickJSWASMModule, newVariant, RELEASE_SYNC, type QuickJSHandle } from 'quickjs-emscripten';
import { guestBootstrap } from './guest-api.ts';
import type { FunctionWorkerData, FunctionWorkerMessage, FunctionWorkerRequest } from './functions.ts';
import type { GuestResponsePayload } from './guest-api.ts';

if (!parentPort) throw new Error('Function worker requires a parent');
const port = parentPort;
const data = workerData as FunctionWorkerData; // trust boundary: set by FunctionPool.spawn
const post = (message: FunctionWorkerMessage): void => port.postMessage(message);
// The guest heap bound is this WebAssembly memory's maximum, not QuickJS's own
// setMemoryLimit: the packaged build has no malloc_usable_size, so QuickJS
// counts only a small overhead per allocation and would let the guest grow the
// memory to Emscripten's 2 GiB ceiling (#1092). The memory leaves the engine's
// static data, stack and runtime/context baseline on top of the 32 MiB guest
// heap, so a guest within 32 MiB never meets the cap.
//
// The memory is created at its maximum and never grows (#1096). A grow detaches
// the ArrayBuffer behind every view the host already holds, and
// quickjs-emscripten 0.32.0's executePendingJobs reads its out-pointer through
// such a view: after a job grew the memory it read `undefined` as the job's
// context, created a new context for it and never freed it, so disposing the
// runtime aborted on that leaked context and a successful response answered
// 502. Untouched pages are not resident, so the fixed size costs address space,
// not RSS.
const guestHeapBytes = 32 * 1024 * 1024;
const wasmPage = 65536;
const pages = (guestHeapBytes + 12 * 1024 * 1024) / wasmPage;
const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
// A refused grow means an allocation may have failed inside the engine. The
// invocation then fails and the worker is retired, because WebAssembly memory
// never shrinks and an engine that ran out is not trusted to serve again. An
// engine that aborted while freeing a runtime is retired for the same reason.
let exhausted = false;
const grow = memory.grow.bind(memory);
memory.grow = (delta: number): number => { try { return grow(delta); } catch (error) { exhausted = true; throw error; } };
const engine = await newQuickJSWASMModule(newVariant(RELEASE_SYNC, { wasmMemory: memory }));
async function evaluate(entry: string | undefined, name: string | undefined, payload?: string, timeoutMs = 5000, chain: FunctionWorkerRequest['chain'] = []): Promise<{ output: string; body: Buffer } | undefined> {
  // New heap/module state for every invocation, including validation. No Node
  // objects/functions are injected. Only strings and JSON cross the boundary.
  const allowed = new Set<string>();
  function allow(name: string) { if (allowed.has(name)) return; allowed.add(name); for (const dep of data.dependencies[name] || []) allow(dep); }
  if (entry) allow(entry);
  for (const item of chain) if (item.source !== undefined) allow(item.source);
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + timeoutMs;
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  runtime.setModuleLoader(moduleName => {
    const source = data.sources[moduleName];
    if (!allowed.has(moduleName) || source === undefined) throw new Error('Module denied');
    return source;
  }, (base, requested) => {
    const resolved = requested.startsWith('./') || requested.startsWith('../') ? posix.resolve(posix.dirname(base),requested) : requested;
    if (!allowed.has(resolved)) throw new Error('Module denied');
    return resolved;
  });
  const vm = runtime.newContext();
  function run(code: string, filename = 'bootstrap.js', type: 'global' | 'module' = 'global') {
    const result = vm.evalCode(code,filename,{type});
    if (result.error) { result.error.dispose(); throw new Error('Guest evaluation failed'); }
    result.value.dispose();
  }
  function string(name: string): string {
    const handle: QuickJSHandle = vm.getProp(vm.global,name);
    try { return vm.getString(handle); } finally { handle.dispose(); }
  }
  // The body is read in slices, so handing it over needs one slice's UTF-8
  // copy in the guest heap rather than a copy of the whole body. getString
  // answers '' when the engine cannot allocate a copy, so the slices must add
  // up to the body's length in the engine: a body the heap cannot hand over
  // fails, it never arrives short.
  function body(): Buffer {
    const units = number('__bodyLength');
    const chunk = vm.getProp(vm.global,'__bodyChunk');
    const chunks: Buffer[] = [];
    let start = 0;
    try {
      while (start < units) {
        const offset = vm.newNumber(start);
        let result;
        try { result = vm.callFunction(chunk,vm.undefined,offset); } finally { offset.dispose(); }
        if (result.error) { result.error.dispose(); throw new Error('Guest body unreadable'); }
        let text: string;
        try { text = vm.getString(result.value); } finally { result.value.dispose(); }
        if (text === '') break;
        chunks.push(Buffer.from(text,'utf8')); start += text.length;
      }
    } finally { chunk.dispose(); }
    if (start !== units) throw new Error('Guest body unreadable');
    return Buffer.concat(chunks);
  }
  function number(name: string): number {
    const handle: QuickJSHandle = vm.getProp(vm.global,name);
    try { return vm.getNumber(handle); } finally { handle.dispose(); }
  }
  try {
    run(guestBootstrap);
    if (payload !== undefined) {
      const value = vm.newString(payload); vm.setProp(vm.global,'__payload',value); value.dispose();
      run("Object.defineProperty(globalThis,'__payload',{writable:false,enumerable:false,configurable:false})");
    }
    if (chain.length) {
      const imports = chain.map((item,i) => `import * as mw${i} from ${JSON.stringify(item.source)};`).join('\n');
      const functions = chain.map((item,i) => `mw${i}[${JSON.stringify(item.name)}]`).join(',');
      run(`${imports}
        ${entry ? `import * as entry from ${JSON.stringify(entry)};` : ''}
        globalThis.__invokePipeline([${functions}], ${entry ? `entry[${JSON.stringify(name)}]` : 'null'}, globalThis.__payload);`,
      '/__urlcode_entry.mjs','module');
    } else {
      run(`import * as entry from ${JSON.stringify(entry)};
        if (typeof entry[${JSON.stringify(name)}] !== 'function') throw new Error('Invalid export');
        ${payload === undefined ? 'globalThis.__ready();' : `globalThis.__invoke(entry[${JSON.stringify(name)}], globalThis.__payload);`}`,
      '/__urlcode_entry.mjs','module');
    }
    while (string('__state') === 'pending') {
      if (Date.now() >= deadline) throw new Error('Guest deadline exceeded');
      const jobs = runtime.executePendingJobs(100);
      if (jobs.error) { jobs.error.dispose(); throw new Error('Guest promise failed'); }
      run('globalThis.__pump()');
      if (string('__state') === 'pending') await new Promise(resolve => setTimeout(resolve,2));
    }
    if (exhausted) throw new Error('Guest memory exhausted');
    if (string('__state') !== 'done') throw new Error('Guest invocation failed');
    const result = payload === undefined ? undefined : { output: string('__output'), body: body() };
    // Reading a string copies it into the guest heap, which can run out too.
    if (exhausted) throw new Error('Guest memory exhausted');
    return result;
  } finally { release(); }
  // JS_FreeRuntime asserts every object was released; an Emscripten abort there
  // leaves the engine undefined, so the invocation fails and the worker retires.
  function release(): void {
    try { vm.dispose(); runtime.dispose(); } catch (error) { exhausted = true; throw error; }
  }
}
// Startup runs under top-level await. Its outcome is posted from a later macrotask, after this module's evaluation
// has settled, because the pool may terminate the worker as soon as either message arrives (a deadline, a startup
// error, close()); terminating mid module evaluation is what #708 avoids.
const postAfterEvaluation = (message: FunctionWorkerMessage): void => { setImmediate(post, message); };
try {
  for (const [source,name] of data.entries) await evaluate(source,name);
  if (exhausted) throw new Error('Guest memory exhausted');
  postAfterEvaluation({ready:true});
} catch { postAfterEvaluation({startupError:true}); }
const isPair = (pair: unknown): pair is [string, string] => Array.isArray(pair) && pair.length === 2 && pair.every(v => typeof v === 'string');
port.on('message', async ({id,source,name,request,context,maxBytes,timeoutMs,chain=[],native}: FunctionWorkerRequest) => { // trust boundary: posted by FunctionPool.execute
  try {
    const payload = JSON.stringify({request:{...request,body:Buffer.from(request.body || []).toString('utf8')},context,native});
    if (Buffer.byteLength(payload) > 4 * 1024 * 1024) throw new Error('Input limit');
    const result = await evaluate(source,name,payload,timeoutMs,chain);
    // The metadata is the status, at most 16 KiB of headers (each byte at most
    // six once JSON-escaped) and the framing around them.
    if (result === undefined || Buffer.byteLength(result.output) > 16384 * 6 + 65536) throw new Error('Output limit');
    const value = JSON.parse(result.output) as GuestResponsePayload | null; // trust boundary: guest JSON, checked below
    if (!value || !Number.isInteger(value.status) || value.status < 200 || value.status > 599 || !Array.isArray(value.headers) || value.headers.length > 256) throw new Error('Invalid response');
    // Only HEAD may state a length: it carries no body. Any other method is
    // framed by the body bytes, so a stated length there is a shape violation.
    if (value.contentLength !== undefined && (request.method !== 'HEAD' || !Number.isSafeInteger(value.contentLength) || value.contentLength < 0)) throw new Error('Invalid response');
    if (value.nativeBody) {
      if (!native || value.status !== native.status || result.body.length !== 0) throw new Error('Invalid native response');
      // Preserve native status and metadata (validators, ranges, redirect Location).
      for (const key of new Set(native.headers.map(([k]) => k.toLowerCase()))) {
        const originals = native.headers.filter(([k]) => k.toLowerCase() === key).map(([,v])=>v);
        const output = (value.headers as unknown[]).flatMap(pair => Array.isArray(pair) && typeof pair[0] === 'string' && pair[0].toLowerCase() === key ? [pair[1] as unknown] : []);
        if (JSON.stringify(originals) !== JSON.stringify(output)) throw new Error('Native metadata changed');
      }
    }
    const body = result.body;
    if (body.length > maxBytes) throw new Error('Response limit');
    let bytes = 0;
    for (const pair of value.headers as unknown[]) {
      if (!isPair(pair)) throw new Error('Invalid headers');
      bytes += Buffer.byteLength(pair[0]) + Buffer.byteLength(pair[1]) + 4;
    }
    if (bytes > 16384) throw new Error('Header limit');
    post({id,status:value.status,headers:value.headers,body,nativeBody:value.nativeBody === true,
      ...(typeof value.contentLength === 'number' ? {contentLength:value.contentLength} : {})});
  } catch { post(exhausted ? {id,error:true,retire:true} : {id,error:true}); }
});
