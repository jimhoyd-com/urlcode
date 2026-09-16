import { parentPort, workerData } from 'node:worker_threads';
import { posix } from 'node:path';
import { getQuickJS } from 'quickjs-emscripten';
import { guestBootstrap } from './guest-api.js';

const engine = await getQuickJS();
async function evaluate(entry, name, payload, timeoutMs = 5000) {
  // New heap/module state for every invocation, including validation. No Node
  // objects/functions are injected. Only strings and JSON cross the boundary.
  const allowed = new Set();
  function allow(name) { if (allowed.has(name)) return; allowed.add(name); for (const dep of workerData.dependencies[name] || []) allow(dep); }
  allow(entry);
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + timeoutMs;
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  runtime.setModuleLoader(moduleName => {
    if (!allowed.has(moduleName)) throw new Error('Module denied');
    return workerData.sources[moduleName];
  }, (base, requested) => {
    const resolved = requested.startsWith('./') || requested.startsWith('../') ? posix.resolve(posix.dirname(base),requested) : requested;
    if (!allowed.has(resolved)) throw new Error('Module denied');
    return resolved;
  });
  const vm = runtime.newContext();
  function run(code,filename='bootstrap.js',type='global') {
    const result = vm.evalCode(code,filename,{type});
    if (result.error) { result.error.dispose(); throw new Error('Guest evaluation failed'); }
    result.value.dispose();
  }
  function string(name) {
    const handle = vm.getProp(vm.global,name);
    try { return vm.getString(handle); } finally { handle.dispose(); }
  }
  try {
    run(guestBootstrap);
    if (payload !== undefined) {
      const data = vm.newString(payload); vm.setProp(vm.global,'__payload',data); data.dispose();
    }
    run(`import * as entry from ${JSON.stringify(entry)};
      if (typeof entry[${JSON.stringify(name)}] !== 'function') throw new Error('Invalid export');
      ${payload === undefined ? "globalThis.__state = 'done';" : `globalThis.__invoke(entry[${JSON.stringify(name)}], globalThis.__payload);`}`,
    '/__urlcode_entry.mjs','module');
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
  for (const [source,name] of workerData.entries) await evaluate(source,name);
  parentPort.postMessage({ready:true});
} catch { parentPort.postMessage({startupError:true}); }
parentPort.on('message', async ({id,source,name,request,context,maxBytes,timeoutMs}) => {
  try {
    const payload = JSON.stringify({request:{...request,body:Buffer.from(request.body || []).toString('utf8')},context});
    if (Buffer.byteLength(payload) > 4 * 1024 * 1024) throw new Error('Input limit');
    const output = await evaluate(source,name,payload,timeoutMs);
    if (Buffer.byteLength(output) > maxBytes * 6 + 65536) throw new Error('Output limit');
    const value = JSON.parse(output);
    if (!value || !Number.isInteger(value.status) || value.status < 200 || value.status > 599 || typeof value.body !== 'string' || !Array.isArray(value.headers) || value.headers.length > 256) throw new Error('Invalid response');
    const body = Buffer.from(value.body,'utf8');
    if (body.length > maxBytes) throw new Error('Response limit');
    let bytes = 0;
    for (const pair of value.headers) {
      if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(v=>typeof v === 'string')) throw new Error('Invalid headers');
      bytes += Buffer.byteLength(pair[0]) + Buffer.byteLength(pair[1]) + 4;
    }
    if (bytes > 16384) throw new Error('Header limit');
    parentPort.postMessage({id,status:value.status,headers:value.headers,body});
  } catch { parentPort.postMessage({id,error:true}); }
});
