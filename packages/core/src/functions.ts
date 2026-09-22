import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { collectSourcesFor, routeFunctions } from './function-sources.ts';
import type { FunctionDefinition, FunctionRoute, FunctionSources } from './function-sources.ts';
import { assert, ConfigError, HttpError } from './errors.ts';
import type { HandlerResult, HeaderPair } from './http-response.ts';
import type { ParameterValue, RequestContext } from './match.ts';
import type { LogFn } from './types.ts';
import type { GuestRequestPayload } from './guest-api.ts';
export type { FunctionDefinition, FunctionRoute } from './function-sources.ts';
export type { GuestRequestPayload, GuestResponsePayload } from './guest-api.ts';
/** A module entry point the sandbox must load: an absolute source file path
 * (already resolved and validated, e.g. via `functionFile()`) plus which
 * export of it needs to be reachable. The same shape a `FunctionDefinition`
 * already uses for `function`/`middleware` routes. */
export type SandboxEntry = FunctionDefinition;
/** What one `SandboxPool.execute()` call invokes: the same `{source, export}`
 * shape as a `SandboxEntry`, naming one of the pool's declared entries. */
export type SandboxTarget = FunctionDefinition;
/** `entry` runs last (the route's `function`/handler); `chain` runs first, in
 * order, each with `(request, context, next)` — the same wrap/middleware
 * semantics `__invokePipeline` already gives sandboxed routes. Neither is
 * required: an empty invocation with a `native` reply just returns it. */
export interface SandboxInvocation { entry?: SandboxTarget | undefined; chain?: SandboxTarget[] | undefined }
export interface SandboxPoolOptions {
  root?: string | undefined; snapshot?: FunctionSources | undefined; workers?: number | undefined;
  timeoutMs?: number | undefined; maxBytes?: number | undefined; log?: LogFn | undefined;
}
type FunctionPoolOptions = SandboxPoolOptions;

// The worker protocol. Only JSON-shaped data and byte buffers cross it.
export interface FunctionWorkerData { sources: Record<string, string>; dependencies: Record<string, string[]>; entries: [string, string][] }
/** `route.pattern` is the route key that matched, so one module can serve several routes without reading `request.url`. */
export type FunctionContext = RequestContext & { args?: Record<string, ParameterValue>; route?: { pattern: string } };
export interface FunctionWorkerRequest {
  id: string; source: string | undefined; name: string | undefined;
  chain: { source: string | undefined; name: string }[];
  native: { status: number; headers: HeaderPair[] } | undefined;
  request: GuestRequestPayload; context: FunctionContext; maxBytes: number; timeoutMs: number;
}
export interface FunctionResult extends HandlerResult { nativeBody?: boolean }
export type FunctionWorkerMessage =
  | { ready: true } | { startupError: true }
  | { id: string; status: number; headers: HeaderPair[]; body: Uint8Array; nativeBody: boolean; contentLength?: number }
  | { id: string; error: true };

interface Pending { id: string; timer: NodeJS.Timeout; resolve: (message: FunctionResult) => void; reject: (error: Error) => void }
interface Slot { worker: Worker; ready: boolean; pending: Pending | null }

// The generalized sandbox primitive: the pool of worker threads, each running
// the same function-worker.ts (QuickJS engine setup, dependency-closure module
// allowlisting, memory/stack limits, deadline enforcement via both the
// interrupt handler and outer worker termination, response-shape validation),
// driven by an explicit list of `{source, export}` entries rather than
// anything route/YAML-shaped. This is the ONE place that owns worker
// spawning/QuickJS setup/deadline enforcement; `FunctionPool` below is a thin
// route-shaped wrapper over it, not a second copy of the mechanics. Exported
// publicly (as `@jimhoyd/urlcode/sandbox`, see src/sandbox.ts) for an
// extension package that needs to run PROJECT code — a hook a project's own
// config names — through the same trusted/sandboxed dispatch selection route
// dispatch gets, when that hook declares `sandbox: true`
// (docs/EXTENSIONS.md#project-level-lifecycle-hooks). There is no "trusted"
// mode here: an extension wanting trusted execution just calls the project's
// function directly via `import()` (already possible via
// `ExtensionActivation.root`); this primitive is only ever the sandboxed path.
export class SandboxPool {
  root: string | undefined; entries: SandboxEntry[]; preparedSnapshot: FunctionSources | undefined; snapshot: FunctionSources | undefined;
  restarts: Map<number, number>; restartTimers: Set<NodeJS.Timeout>; log: LogFn; timeoutMs: number; maxBytes: number;
  modules: [string, string[]][]; size: number; slots: (Slot | undefined)[]; closed: boolean;
  constructor(entries: SandboxEntry[], { root, snapshot, workers = 2, timeoutMs = 5000, maxBytes = 1048576, log = () => {} }: SandboxPoolOptions = {}) {
    assert(Number.isInteger(workers) && workers >= 1 && workers <= 32, 'Workers must be 1–32');
    assert(Number.isInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 60000, 'Function timeout must be 10–60000 ms');
    assert(Number.isInteger(maxBytes) && maxBytes >= 1 && maxBytes <= 16777216, 'Response limit must be 1–16777216 bytes');
    this.root = root; this.entries = entries; this.preparedSnapshot = snapshot;
    // Consecutive replacement attempts per slot; cleared by a completed invocation.
    this.restarts = new Map(); this.restartTimers = new Set();
    this.log = log;
    this.timeoutMs = timeoutMs; this.maxBytes = maxBytes;
    const modules = new Map<string, Set<string>>();
    for (const definition of entries) {
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
    let snapshot = this.preparedSnapshot;
    if (!snapshot && this.size) { assert(this.root !== undefined, 'Function pool requires a project root'); snapshot = await collectSourcesFor(this.entries,this.root); }
    snapshot ??= {sources:{},dependencies:{},entries:[],names:new Map()};
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
  /** `invocation.entry` runs last (chain-wrapped), `invocation.chain` first, in
   * declared order — the same `__invokePipeline` wrap/middleware discipline
   * (`next()` callable at most once) the sandboxed route path already
   * enforces; there is no second dispatch mechanism for this. Every entry and
   * chain source named here must already be one of this pool's declared
   * `entries` (constructor), or the worker's own module allowlist denies it. */
  execute(invocation: SandboxInvocation, request: GuestRequestPayload, context: FunctionContext, native: HandlerResult | undefined): Promise<FunctionResult> {
    const slot = this.slots.find(s => s?.ready && !s.pending);
    const snapshot = this.snapshot;
    if (this.closed || !slot || !snapshot) return Promise.reject(new HttpError(503, 'Function capacity unavailable'));
    const id = randomUUID();
    const { entry, chain = [] } = invocation;
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
      const message: FunctionWorkerRequest = { id, source: entry ? snapshot.names.get(entry.source) : undefined, name: entry?.export,
        chain: chain.map(item => ({source:snapshot.names.get(item.source),name:item.export})),
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
// Thin, route-shaped wrapper over `SandboxPool`: every existing internal
// caller (route-level `function`/`middleware` dispatch, `src/runtime.ts`)
// keeps working exactly as before, translating `FunctionRoute[]`/`FunctionRoute`
// into the generalized `{source, export}` entries/target shape at the edge,
// never duplicating worker spawning, module allowlisting or deadline
// enforcement — that all still lives in the wrapped `SandboxPool`. Composition
// rather than inheritance because `execute()`'s route-shaped and
// entries-shaped parameters are genuinely different, incompatible types; the
// fields/methods below the constructor exist only so the (unchanged) test
// suite and `src/runtime.ts` keep reaching the wrapped pool's own state
// exactly as they did before this file had two classes.
export class FunctionPool {
  routes: FunctionRoute[]; private pool: SandboxPool;
  constructor(routes: FunctionRoute[], options: FunctionPoolOptions = {}) {
    this.routes = routes;
    this.pool = new SandboxPool(routes.flatMap(routeFunctions), options);
  }
  async start(): Promise<this> { await this.pool.start(); return this; }
  execute(route: FunctionRoute, request: GuestRequestPayload, context: FunctionContext, native: HandlerResult | undefined): Promise<FunctionResult> {
    return this.pool.execute({ entry: route.function, chain: route.middleware }, request, context, native);
  }
  scheduleRespawn(index: number): void { this.pool.scheduleRespawn(index); }
  close(): Promise<void> { return this.pool.close(); }
  get healthy(): boolean { return this.pool.healthy; }
  get restarts(): Map<number, number> { return this.pool.restarts; }
  get restartTimers(): Set<NodeJS.Timeout> { return this.pool.restartTimers; }
  get slots(): (Slot | undefined)[] { return this.pool.slots; }
  get size(): number { return this.pool.size; }
  get closed(): boolean { return this.pool.closed; }
  get snapshot(): FunctionSources | undefined { return this.pool.snapshot; }
  get log(): LogFn { return this.pool.log; }
  get timeoutMs(): number { return this.pool.timeoutMs; }
  get maxBytes(): number { return this.pool.maxBytes; }
}
