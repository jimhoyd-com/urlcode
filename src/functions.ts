import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { collectFunctionSources, routeFunctions } from './function-sources.ts';
import { assert, ConfigError, HttpError } from './errors.ts';
import type { HandlerResult, HeaderPair } from './http-response.ts';
import type { ParameterValue, RequestContext } from './match.ts';

export type Log = (event: object) => void;
/** A `function:` or `middleware:` entry after configuration: a project-relative source and its export. */
export interface FunctionDefinition { source: string; export: string }
/** The part of a compiled route the pool reads. structural: the real route type lives in src/router.ts. */
export interface FunctionRoute { function?: FunctionDefinition | undefined; middleware?: FunctionDefinition[] | undefined }
/** What collectFunctionSources returns. structural: the real type lives in src/function-sources.ts. */
export interface FunctionSnapshot {
  sources: Record<string, string>; dependencies?: Record<string, string[]> | undefined;
  entries: [string, string][]; names: Map<string, string>; projectSha256?: string | undefined;
}
export interface FunctionPoolOptions {
  root?: string | undefined; snapshot?: FunctionSnapshot | undefined; workers?: number | undefined;
  timeoutMs?: number | undefined; maxBytes?: number | undefined; log?: Log | undefined;
}

// The worker protocol. Only JSON-shaped data and byte buffers cross it.
export interface FunctionWorkerData { sources: Record<string, string>; dependencies: Record<string, string[]> | undefined; entries: [string, string][] }
/** The request the guest receives (stringified as JSON in the worker). */
export interface GuestRequestPayload { url: string; method: string; headers: HeaderPair[]; body?: Uint8Array | undefined }
export type FunctionContext = RequestContext & { args?: Record<string, ParameterValue> };
/** A native response the sandbox wraps (page, static, redirect, link, reply). */
export interface NativeResponse extends HandlerResult { body: Uint8Array }
export interface FunctionWorkerRequest {
  id: string; source: string | undefined; name: string | undefined;
  chain: { source: string | undefined; name: string }[];
  native: { status: number; headers: HeaderPair[] } | undefined;
  request: GuestRequestPayload; context: FunctionContext; maxBytes: number; timeoutMs: number;
}
/** What the guest returns as JSON text; the worker enforces this shape before trusting it. */
export interface GuestResponsePayload { status: number; headers: HeaderPair[]; body: string; nativeBody?: boolean }
export interface FunctionResult extends HandlerResult { nativeBody?: boolean }
export type FunctionWorkerMessage =
  | { ready: true } | { startupError: true }
  | { id: string; status: number; headers: HeaderPair[]; body: Uint8Array; nativeBody: boolean }
  | { id: string; error: true };

interface Pending { id: string; timer: NodeJS.Timeout; resolve: (message: FunctionResult) => void; reject: (error: Error) => void }
interface Slot { worker: Worker; ready: boolean; pending: Pending | null }

export class FunctionPool {
  root: string | undefined; routes: FunctionRoute[]; preparedSnapshot: FunctionSnapshot | undefined; snapshot: FunctionSnapshot | undefined;
  restarts: Map<number, number>; restartTimers: Set<NodeJS.Timeout>; log: Log; timeoutMs: number; maxBytes: number;
  modules: [string, string[]][]; size: number; slots: (Slot | undefined)[]; closed: boolean;
  constructor(routes: FunctionRoute[], { root, snapshot, workers = 2, timeoutMs = 5000, maxBytes = 1048576, log = () => {} }: FunctionPoolOptions = {}) {
    assert(Number.isInteger(workers) && workers >= 1 && workers <= 32, 'Workers must be 1–32');
    assert(Number.isInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 60000, 'Function timeout must be 10–60000 ms');
    assert(Number.isInteger(maxBytes) && maxBytes >= 1 && maxBytes <= 16777216, 'Response limit must be 1–16777216 bytes');
    this.root = root; this.routes = routes; this.preparedSnapshot = snapshot;
    // Consecutive replacement attempts per slot; cleared by a completed invocation.
    this.restarts = new Map(); this.restartTimers = new Set();
    this.log = log;
    this.timeoutMs = timeoutMs; this.maxBytes = maxBytes;
    const modules = new Map<string, Set<string>>();
    for (const definition of routes.flatMap(routeFunctions)) {
      const { source, export: name } = definition;
      let names = modules.get(source);
      if (!names) { names = new Set(); modules.set(source, names); }
      names.add(name);
    }
    this.modules = [...modules].map(([source, names]) => [source, [...names]]);
    this.size = this.modules.length ? workers : 0;
    this.slots = []; this.closed = false;
  }
  async start(): Promise<this> {
    const snapshot: FunctionSnapshot = this.preparedSnapshot || (this.size ? await collectFunctionSources(this.routes,this.root) as FunctionSnapshot : {sources:{},entries:[],names:new Map()}); // structural: collectFunctionSources is typed in src/function-sources.ts
    this.snapshot = snapshot;
    try { await Promise.all(Array.from({ length: this.size }, (_, i) => this.spawn(i))); }
    catch { await this.close(); throw new ConfigError('Function initialization failed (check module syntax, imports and exports)'); }
    return this;
  }
  spawn(index: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('Pool closed'));
      const snapshot = this.snapshot;
      assert(snapshot, 'Pool not started');
      // The WASM guest is the capability boundary. The outer worker supplies
      // an independent termination deadline if the guest engine stops responding.
      const workerData: FunctionWorkerData = { sources:snapshot.sources, dependencies:snapshot.dependencies, entries:snapshot.entries };
      const worker = new Worker(new URL('./function-worker.ts', import.meta.url), {
        env: {}, execArgv: [],
        workerData, stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
      });
      worker.stdout.resume(); worker.stderr.resume(); // Engine diagnostics must not expose guest data.
      const slot: Slot = { worker, ready: false, pending: null };
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
      worker.on('message', (message: FunctionWorkerMessage) => { // trust boundary: the worker's own protocol
        if ('ready' in message && !initialized) {
          this.report('started', index);
          initialized = true; clearTimeout(timer); slot.ready = true; resolve(); return;
        }
        if ('startupError' in message) { fail(); return; }
        if (!('id' in message)) return;
        const pending = slot.pending;
        if (!pending || pending.id !== message.id) return;
        // Any answered invocation, success or guest error, proves this worker is
        // serving again; a worker that starts cleanly but dies on every request
        // must keep backing off rather than restarting in a tight loop.
        this.restarts.delete(index);
        clearTimeout(pending.timer); slot.pending = null;
        if ('error' in message) pending.reject(new HttpError(502, 'Function execution failed'));
        else pending.resolve(message);
      });
      worker.on('error', fail);
      worker.on('exit', () => {
        fail();
        if (initialized && !this.closed && this.slots[index] === slot) this.scheduleRespawn(index);
      });
    });
  }
  report(status: string, index: number, extra: object = {}): void {
    try { this.log({ event: 'function_worker', status, slot: index, ...extra }); } catch { /* Logging cannot fail the pool. */ }
  }
  // A worker exit must never latch a slot off permanently: a deadline or an
  // out-of-memory guest is reachable from ordinary request input, so replacement
  // backs off instead of stopping. Backoff bounds churn; it does not stop it.
  scheduleRespawn(index: number): void {
    if (this.closed) return;
    const attempt = (this.restarts.get(index) || 0) + 1;
    this.restarts.set(index, attempt);
    const delayMs = Math.min(30000, 250 * 2 ** Math.min(attempt - 1, 7));
    this.report('restarting', index, { attempt, delayMs });
    const timer = setTimeout(() => {
      this.restartTimers.delete(timer);
      if (this.closed) return;
      void this.spawn(index).catch(() => this.scheduleRespawn(index));
    }, delayMs);
    timer.unref(); this.restartTimers.add(timer);
  }
  get healthy(): boolean { return !this.closed && this.slots.length === this.size && this.slots.every(slot => slot?.ready); }
  execute(route: FunctionRoute, request: GuestRequestPayload, context: FunctionContext, native: NativeResponse | undefined): Promise<FunctionResult> {
    const slot = this.slots.find(s => s?.ready && !s.pending);
    const snapshot = this.snapshot;
    if (this.closed || !slot || !snapshot) return Promise.reject(new HttpError(503, 'Function capacity unavailable'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        slot.pending = null; slot.ready = false;
        reject(new HttpError(504, 'Function deadline exceeded'));
        void slot.worker.terminate();
      }, this.timeoutMs);
      slot.pending = { id, timer, resolve: message => {
        // Native bytes never enter the guest; only this invocation's body can be retained.
        if (message.nativeBody && native) resolve({...message,body:native.body,...(native.contentLength === undefined ? {} : {contentLength:native.contentLength})});
        else resolve(message);
      }, reject };
      const message: FunctionWorkerRequest = { id, source: route.function ? snapshot.names.get(route.function.source) : undefined, name: route.function?.export,
        chain: (route.middleware || []).map(item => ({source:snapshot.names.get(item.source),name:item.export})),
        native: native ? {status:native.status,headers:native.headers} : undefined,
        request, context, maxBytes: this.maxBytes, timeoutMs:this.timeoutMs + 100 };
      slot.worker.postMessage(message);
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.restartTimers) clearTimeout(timer);
    this.restartTimers.clear();
    for (const slot of this.slots) if (slot?.pending) {
      clearTimeout(slot.pending.timer);
      slot.pending.reject(new HttpError(503, 'Runtime shutting down')); slot.pending = null;
    }
    await Promise.all(this.slots.map(s => s?.worker.terminate()));
  }
}
