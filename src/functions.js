import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { collectFunctionSources, routeFunctions } from './function-sources.js';
import { assert, ConfigError, HttpError } from './errors.js';

export class FunctionPool {
  constructor(routes, { root, snapshot, workers = 2, timeoutMs = 5000, maxBytes = 1048576 } = {}) {
    assert(Number.isInteger(workers) && workers >= 1 && workers <= 32, 'Workers must be 1–32');
    assert(Number.isInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 60000, 'Function timeout must be 10–60000 ms');
    assert(Number.isInteger(maxBytes) && maxBytes >= 1 && maxBytes <= 16777216, 'Response limit must be 1–16777216 bytes');
    this.root = root; this.routes = routes; this.preparedSnapshot = snapshot;
    this.restarts = new Map();
    this.timeoutMs = timeoutMs; this.maxBytes = maxBytes;
    const modules = new Map();
    for (const definition of routes.flatMap(routeFunctions)) {
      const { source, export: name } = definition;
      if (!modules.has(source)) modules.set(source, new Set());
      modules.get(source).add(name);
    }
    this.modules = [...modules].map(([source, names]) => [source, [...names]]);
    this.size = this.modules.length ? workers : 0;
    this.slots = []; this.closed = false;
  }
  async start() {
    const snapshot = this.preparedSnapshot || (this.size ? await collectFunctionSources(this.routes,this.root) : {sources:{},entries:[],names:new Map()});
    this.snapshot = snapshot;
    try { await Promise.all(Array.from({ length: this.size }, (_, i) => this.spawn(i))); }
    catch { await this.close(); throw new ConfigError('Function initialization failed (check module syntax, imports and exports)'); }
    return this;
  }
  spawn(index) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('Pool closed'));
      // The WASM guest is the capability boundary. The outer worker supplies
      // an independent termination deadline if the guest engine stops responding.
      const worker = new Worker(new URL('./function-worker.js', import.meta.url), {
        env: {}, execArgv: [],
        workerData: { sources:this.snapshot.sources, dependencies:this.snapshot.dependencies, entries:this.snapshot.entries }, stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
      });
      worker.stdout.resume(); worker.stderr.resume(); // Engine diagnostics must not expose guest data.
      const slot = { worker, ready: false, pending: null };
      this.slots[index] = slot;
      let initialized = false;
      const timer = setTimeout(() => fail(), 5000);
      const fail = () => {
        clearTimeout(timer);
        slot.ready = false;
        if (!initialized) reject(new Error('Worker initialization failed'));
        if (slot.pending) {
          clearTimeout(slot.pending.timer);
          slot.pending.reject(new HttpError(502, 'Function execution failed'));
          slot.pending = null;
        }
        void worker.terminate();
      };
      worker.on('message', message => {
        if (message.ready && !initialized) {
          initialized = true; clearTimeout(timer); slot.ready = true; resolve(); return;
        }
        if (message.startupError) { fail(); return; }
        const pending = slot.pending;
        if (!pending || pending.id !== message.id) return;
        clearTimeout(pending.timer); slot.pending = null;
        if (message.error) pending.reject(new HttpError(502, 'Function execution failed'));
        else pending.resolve(message);
      });
      worker.on('error', fail);
      worker.on('exit', () => {
        fail();
        if (initialized && !this.closed && this.slots[index] === slot) {
          const now = Date.now();
          const failures = (this.restarts.get(index) || []).filter(time => now - time < 60000);
          failures.push(now); this.restarts.set(index, failures);
          // Stop repeated crashes: recover with an operator reload/restart after 3/minute.
          if (failures.length <= 3) void this.spawn(index).catch(() => {});
        }
      });
    });
  }
  get healthy() { return !this.closed && this.slots.every(slot => slot.ready); }
  execute(route, request, context, native) {
    const slot = this.slots.find(s => s.ready && !s.pending);
    if (this.closed || !slot) return Promise.reject(new HttpError(503, 'Function capacity unavailable'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        slot.pending = null; slot.ready = false;
        reject(new HttpError(504, 'Function deadline exceeded'));
        void slot.worker.terminate();
      }, this.timeoutMs);
      slot.pending = { id, timer, resolve: message => {
        // Native bytes never enter the guest; only this invocation's body can be retained.
        if (message.nativeBody && native) resolve({...message,body:native.body,contentLength:native.contentLength});
        else resolve(message);
      }, reject };
      slot.worker.postMessage({ id, source: route.function ? this.snapshot.names.get(route.function.source) : undefined, name: route.function?.export,
        chain: (route.middleware || []).map(item => ({source:this.snapshot.names.get(item.source),name:item.export})),
        native: native ? {status:native.status,headers:native.headers} : undefined,
        request, context, maxBytes: this.maxBytes, timeoutMs:this.timeoutMs + 100 });
    });
  }
  async close() {
    this.closed = true;
    for (const slot of this.slots) if (slot.pending) {
      clearTimeout(slot.pending.timer);
      slot.pending.reject(new HttpError(503, 'Runtime shutting down')); slot.pending = null;
    }
    await Promise.all(this.slots.map(s => s.worker.terminate()));
  }
}
