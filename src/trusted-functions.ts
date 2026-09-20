// Trusted (unsandboxed) execution for `function`/`middleware` routes that do
// not declare `sandbox: true` (docs/SPIKE-DEFAULT-TRUST-MODEL.md). This is the
// new default: an ordinary dynamic `import()` of the project's own module,
// called in the host process with full Node access — no worker thread, no
// QuickJS/WASM, no fresh-heap-per-call, no module-graph allowlist. The
// sandboxed path (FunctionPool, function-worker.ts) is untouched by this file
// and keeps its own guarantees exactly as before for any route that opts in
// with `sandbox: true`.
//
// The request/response contract mirrors the sandboxed path (guest-api.ts) as
// closely as an in-process call can: a `Request` and a `context` in, a
// `Response` out, the same middleware `(request, context, next)` chain with
// `next()` callable at most once and no arguments, and the same native-reply
// passthrough (a middleware chain wrapping a native reply — redirect, asset,
// static reply — can return that exact Response unchanged to avoid
// re-encoding its body). Node's own `Request`/`Response`/`Headers` are used
// instead of guest-api.ts's restricted classes, so a trusted function can
// return richer bodies (e.g. binary) than a sandboxed one can; that is a
// documented, intentional capability difference, not a contract violation.
//
// Deadline: unlike the sandboxed path, there is no interrupt mechanism that
// can stop trusted code running in the host's own event loop. `timeoutMs`
// here is an advisory race against the handler's promise settling — it
// rejects the *call* once the deadline passes, but cannot preempt trusted
// code that is blocking the event loop synchronously (a WASM interrupt has no
// equivalent in-process). This is a documented difference from the
// sandboxed path's forced worker termination; see docs/CAPACITY.md.
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ConfigError, HttpError } from './errors.ts';
import { routeFunctions } from './function-sources.ts';
import type { FunctionRoute } from './function-sources.ts';
import type { FunctionContext, FunctionResult } from './functions.ts';
import type { GuestRequestPayload } from './guest-api.ts';
import type { HandlerResult, HeaderPair } from './http-response.ts';

export interface TrustedFunctionsOptions { timeoutMs?: number | undefined; maxBytes?: number | undefined }
interface TrustedDefinition { source: string; export: string }
export type TrustedRoute = FunctionRoute<TrustedDefinition>;
type TrustedHandler = (request: Request, context: FunctionContext) => Response | Promise<Response>;
type TrustedMiddleware = (request: Request, context: FunctionContext, next: () => Promise<Response>) => Response | Promise<Response>;

export class TrustedFunctions {
  timeoutMs: number; maxBytes: number;
  // Node's ESM loader caches a resolved module forever by URL, unlike a
  // sandboxed worker, which gets a genuinely fresh module registry on every
  // reload/restart. A snapshot reload constructs a brand-new TrustedFunctions
  // (createRuntime runs again), so each instance gets its own cache-busting
  // query string: reloaded code is re-imported and re-executed, matching the
  // sandboxed pool's "new workers, new snapshot" reload contract, while a
  // single instance still only imports each module once per process.
  private readonly epoch = randomUUID();
  constructor({ timeoutMs = 5000, maxBytes = 1048576 }: TrustedFunctionsOptions = {}) {
    this.timeoutMs = timeoutMs; this.maxBytes = maxBytes;
  }
  // Eagerly imports and validates every declared export exists as a function,
  // the same guarantee FunctionPool.start() gives the sandboxed path: a
  // broken function/middleware module fails runtime activation up front
  // rather than the first request that happens to hit it.
  async start(routes: TrustedRoute[]): Promise<this> {
    try { await Promise.all(routes.flatMap(routeFunctions).map(definition => this.loadExport(definition))); }
    catch { throw new ConfigError('Function initialization failed (check module syntax, imports and exports)'); }
    return this;
  }
  // No dependency allowlist, no relative-static-import-only rule and no
  // per-module byte budget apply here — those are sandbox-snapshot
  // constraints (function-sources.ts), not trusted-path ones. A trusted
  // module may use bare specifiers, Node builtins, npm packages and dynamic
  // import exactly like any other project code.
  private async loadExport(definition: TrustedDefinition): Promise<unknown> {
    let mod: Record<string, unknown>;
    try { mod = await import(pathToFileURL(definition.source).href + '?urlcode-trusted-epoch=' + this.epoch) as Record<string, unknown>; }
    catch { throw new HttpError(502, 'Function execution failed'); }
    const value = mod[definition.export];
    if (typeof value !== 'function') throw new HttpError(502, 'Function execution failed');
    return value;
  }
  async execute(route: TrustedRoute, request: GuestRequestPayload, context: FunctionContext, native: HandlerResult | undefined): Promise<FunctionResult> {
    // The timer backing the deadline race must be cleared on every path —
    // success or failure — or a completed call leaves a live Timeout behind
    // for the full timeoutMs (see #138: 100 sequential calls, 100 leaked
    // timers). `finally` covers both outcomes of the race in one place.
    // The AbortController lets a fired deadline reach into `invoke`'s body
    // read and cancel it immediately (#137), instead of letting a losing
    // racer keep consuming an oversized or slow stream after this call has
    // already rejected with 504.
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new HttpError(504, 'Function deadline exceeded')); }, this.timeoutMs);
      timer.unref?.();
    });
    const invocation = this.invoke(route, request, context, native, controller.signal);
    try { return await Promise.race([invocation, timeout]); }
    catch (error) { throw error instanceof HttpError ? error : new HttpError(502, 'Function execution failed'); }
    finally {
      clearTimeout(timer);
      // `invocation` may still be running (e.g. blocked on a cancelled
      // reader settling) after the race above has already returned; a later
      // rejection from it must not surface as an unhandled rejection.
      invocation.catch(() => {});
    }
  }
  // Reads a Response body incrementally, rejecting/cancelling as soon as
  // `maxBytes` is exceeded instead of buffering the whole stream first
  // (#137: a single `.arrayBuffer()` call reads everything unconditionally,
  // so a configured limit only ever rejects *after* the oversized body has
  // already been fully read into memory). Also cancels the reader as soon as
  // `signal` aborts (the call's deadline firing), rather than letting a slow
  // stream keep being pulled after the request has already timed out.
  // Applies on every path that has a real body to measure, GET or HEAD alike
  // (#139): the caller decides whether to transmit the bytes, this only
  // decides how many there are, matching the convention the native/asset
  // path already uses (the full body and its length are always determined
  // up front; only `prepareResponse` in http-response.ts drops the body for
  // HEAD at write time).
  private async readBody(response: Response, signal: AbortSignal): Promise<Buffer> {
    if (response.body === null) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const cancel = (): void => { reader.cancel().catch(() => {}); };
    if (signal.aborted) { cancel(); throw new HttpError(504, 'Function deadline exceeded'); }
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.maxBytes) { cancel(); throw new HttpError(502, 'Function execution failed'); }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, total);
    } catch (error) {
      if (signal.aborted) throw new HttpError(504, 'Function deadline exceeded');
      throw error instanceof HttpError ? error : new HttpError(502, 'Function execution failed');
    } finally { signal.removeEventListener('abort', cancel); }
  }
  private async invoke(route: TrustedRoute, request: GuestRequestPayload, requestContext: FunctionContext, native: HandlerResult | undefined, signal: AbortSignal): Promise<FunctionResult> {
    // Matches guest-api.ts's __invokePipeline/__invoke: a fresh `state` object
    // per invocation, shared across the whole middleware+handler chain for
    // this one call only, never carried between requests.
    const context = requestContext as FunctionContext & { state: Record<string, unknown> };
    context.state = {};
    const hasBody = request.body !== undefined && request.body.length > 0 && !['GET','HEAD'].includes(request.method);
    const req = new Request(request.url, {
      method: request.method, headers: request.headers,
      ...(hasBody ? { body: request.body as Uint8Array<ArrayBuffer>, duplex: 'half' as const } : {}),
    });
    let nativeResponse: Response | undefined;
    if (native) {
      const nativeBytes = native.body as Uint8Array<ArrayBuffer> | undefined;
      const bodyless = [204,205,304].includes(native.status) || !nativeBytes || nativeBytes.length === 0;
      nativeResponse = new Response(bodyless ? null : nativeBytes, { status: native.status, headers: native.headers });
    }
    const middleware = route.middleware || [];
    const handlers = await Promise.all(middleware.map(definition => this.loadExport(definition))) as TrustedMiddleware[];
    const entry = route.function ? (await this.loadExport(route.function) as TrustedHandler) : undefined;
    const dispatch = async (index: number): Promise<Response> => {
      if (index === handlers.length) {
        if (entry) return await entry(req, context);
        if (nativeResponse) return nativeResponse;
        throw new HttpError(502, 'Function execution failed');
      }
      let called = false, open = true, pending: Promise<Response> | undefined;
      const next = async (...args: unknown[]): Promise<Response> => {
        if (args.length || called || !open) throw new TypeError('next may be called once during middleware');
        called = true; pending = dispatch(index + 1); return pending;
      };
      let response: Response;
      try { response = await handlers[index]!(req, context, next); if (pending) await pending.catch(() => {}); }
      finally { open = false; }
      if (!(response instanceof Response)) throw new HttpError(502, 'Function execution failed');
      return response;
    };
    const response = await dispatch(0);
    if (!(response instanceof Response) || !Number.isInteger(response.status) || response.status < 200 || response.status > 599) throw new HttpError(502, 'Function execution failed');
    const nativeBody = response === nativeResponse;
    const headers: HeaderPair[] = [...response.headers.entries()];
    if (nativeBody && native) {
      // The route returned the untouched native reply (possibly with extra
      // headers a middleware added, e.g. `x-seen` above `location`): reject
      // only if native's *own* metadata was changed, the same contract the
      // sandboxed path enforces (function-worker.ts's "Native metadata
      // changed" check) — an added header is fine, a changed one is not.
      for (const key of new Set(native.headers.map(([k]) => k.toLowerCase()))) {
        const originals = native.headers.filter(([k]) => k.toLowerCase() === key).map(([,v]) => v);
        const current = headers.filter(([k]) => k.toLowerCase() === key).map(([,v]) => v);
        if (JSON.stringify(originals) !== JSON.stringify(current)) throw new HttpError(502, 'Function execution failed');
      }
    }
    // Header count/byte limits apply either way, matching function-worker.ts.
    { let bytes = 0; for (const [k,v] of headers) bytes += Buffer.byteLength(k) + Buffer.byteLength(v) + 4;
      if (headers.length > 256 || bytes > 16384) throw new HttpError(502, 'Function execution failed'); }
    // Measured on HEAD too, not skipped: prepareResponse (http-response.ts)
    // is what decides not to put the bytes on the wire for HEAD, but it
    // still needs the real length rather than the 0 a skipped read leaves it
    // to assume (#139).
    const body: Uint8Array = nativeBody && native
      ? ((native.body as Uint8Array | undefined) ?? Buffer.alloc(0))
      : await this.readBody(response, signal);
    return { status: response.status, headers, body, nativeBody,
      ...(nativeBody && native?.contentLength !== undefined ? { contentLength: native.contentLength } : {}) };
  }
  // Symmetry with FunctionPool.close(): nothing to release for the trusted
  // path (no workers, no pending requests it owns), but the runtime can call
  // either executor's close() uniformly during shutdown.
  async close(): Promise<void> { /* no owned resources */ }
}
