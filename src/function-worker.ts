import { parentPort, workerData } from 'node:worker_threads';
import { posix } from 'node:path';
import { getQuickJS, type QuickJSHandle } from 'quickjs-emscripten';
import { guestBootstrap } from './guest-api.ts';
import type { FunctionWorkerData, FunctionWorkerMessage, FunctionWorkerRequest } from './functions.ts';
import type { GuestResponsePayload } from './guest-api.ts';

if (!parentPort) throw new Error('Function worker requires a parent');
const port = parentPort;
const data = workerData as FunctionWorkerData; // trust boundary: set by FunctionPool.spawn
const post = (message: FunctionWorkerMessage): void => port.postMessage(message);
const engine = await getQuickJS();
async function evaluate(entry: string | undefined, name: string | undefined, payload?: string, timeoutMs = 5000, chain: FunctionWorkerRequest['chain'] = []): Promise<string | undefined> {
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
  try {
    run(guestBootstrap);
    if (payload !== undefined) {
      const value = vm.newString(payload); vm.setProp(vm.global,'__payload',value); value.dispose();
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
        ${payload === undefined ? "globalThis.__state = 'done';" : `globalThis.__invoke(entry[${JSON.stringify(name)}], globalThis.__payload);`}`,
      '/__urlcode_entry.mjs','module');
    }
    while (string('__state') === 'pending') {
      if (Date.now() >= deadline) throw new Error('Guest deadline exceeded');
      const jobs = runtime.executePendingJobs(100);
      if (jobs.error) { jobs.error.dispose(); throw new Error('Guest promise failed'); }
      run('globalThis.__pump()');
      if (string('__state') === 'pending') await new Promise(resolve => setTimeout(resolve,2));
    }
    if (string('__state') !== 'done') throw new Error('Guest invocation failed');
    return payload === undefined ? undefined : string('__output');
  } finally { vm.dispose(); runtime.dispose(); }
}
try {
  for (const [source,name] of data.entries) await evaluate(source,name);
  post({ready:true});
} catch { post({startupError:true}); }
const isPair = (pair: unknown): pair is [string, string] => Array.isArray(pair) && pair.length === 2 && pair.every(v => typeof v === 'string');
port.on('message', async ({id,source,name,request,context,maxBytes,timeoutMs,chain=[],native}: FunctionWorkerRequest) => { // trust boundary: posted by FunctionPool.execute
  try {
    const payload = JSON.stringify({request:{...request,body:Buffer.from(request.body || []).toString('utf8')},context,native});
    if (Buffer.byteLength(payload) > 4 * 1024 * 1024) throw new Error('Input limit');
    const output = await evaluate(source,name,payload,timeoutMs,chain);
    if (output === undefined || Buffer.byteLength(output) > maxBytes * 6 + 65536) throw new Error('Output limit');
    const value = JSON.parse(output) as GuestResponsePayload | null; // trust boundary: guest JSON, checked below
    if (!value || !Number.isInteger(value.status) || value.status < 200 || value.status > 599 || typeof value.body !== 'string' || !Array.isArray(value.headers) || value.headers.length > 256) throw new Error('Invalid response');
    if (value.nativeBody) {
      if (!native || value.status !== native.status || value.body !== '') throw new Error('Invalid native response');
      // Preserve native status and metadata (validators, ranges, redirect Location).
      for (const key of new Set(native.headers.map(([k]) => k.toLowerCase()))) {
        const originals = native.headers.filter(([k]) => k.toLowerCase() === key).map(([,v])=>v);
        const output = (value.headers as unknown[]).flatMap(pair => Array.isArray(pair) && typeof pair[0] === 'string' && pair[0].toLowerCase() === key ? [pair[1] as unknown] : []);
        if (JSON.stringify(originals) !== JSON.stringify(output)) throw new Error('Native metadata changed');
      }
    }
    const body = Buffer.from(value.body,'utf8');
    if (body.length > maxBytes) throw new Error('Response limit');
    let bytes = 0;
    for (const pair of value.headers as unknown[]) {
      if (!isPair(pair)) throw new Error('Invalid headers');
      bytes += Buffer.byteLength(pair[0]) + Buffer.byteLength(pair[1]) + 4;
    }
    if (bytes > 16384) throw new Error('Header limit');
    post({id,status:value.status,headers:value.headers,body,nativeBody:value.nativeBody === true});
  } catch { post({id,error:true}); }
});
