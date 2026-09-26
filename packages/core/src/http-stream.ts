import type { ServerResponse } from 'node:http';
import { assert, HttpError } from './errors.ts';
import { cancelStream, prepareStream, setGroupedHeaders } from './http-response.ts';
import type { HandlerResult } from './http-response.ts';

// Delivery of a streamed HandlerResult over a node:http ServerResponse (RIM-STREAM-001,
// docs/SPECIFICATION.md#streamed-responses). Used by the self-hosted server and the Vercel
// adapter; a host that cannot write incrementally never imports this and refuses streaming
// before serving instead.

/** Operator limits for streamed responses, separate from the short-request admission limits. */
export interface StreamLimits {
  /** Streamed responses open at once on this host; one more is answered 503 before any byte. */
  maxStreams: number;
  /** Longest wait with no progress (no chunk produced, or a written chunk still not drained by the client). */
  idleTimeoutMs: number;
  /** Longest a stream may stay open from its start, however active it is. */
  maxDurationMs: number;
  /** Most body bytes one stream may send. */
  maxBytes: number;
}
export const defaultStreamLimits: Readonly<StreamLimits> = Object.freeze({ maxStreams: 32, idleTimeoutMs: 30000, maxDurationMs: 300000, maxBytes: 16777216 });
const ranges: Record<keyof StreamLimits, readonly [number, number, string]> = {
  maxStreams: [1, 1024, 'Stream limit must be 1–1024'],
  idleTimeoutMs: [1000, 3600000, 'Stream idle timeout must be 1000–3600000 ms'],
  maxDurationMs: [1000, 86400000, 'Stream duration limit must be 1000–86400000 ms'],
  maxBytes: [1, 268435456, 'Stream byte limit must be 1–268435456 bytes'],
};
/** Validated limits: each given value replaces its default. */
export function resolveStreamLimits(given: Partial<StreamLimits> = {}): StreamLimits {
  const limits: StreamLimits = { ...defaultStreamLimits };
  for (const key of Object.keys(ranges) as (keyof StreamLimits)[]) {
    const value = given[key];
    if (value === undefined) continue;
    const [min, max, message] = ranges[key];
    assert(Number.isInteger(value) && value >= min && value <= max, message);
    limits[key] = value;
  }
  return limits;
}
/** Why a stream ended; `complete` is the only reason that ends the chunked body normally. */
export type StreamEndReason = 'complete' | 'client-closed' | 'idle-timeout' | 'max-duration' | 'max-bytes' | 'error' | 'shutdown';
const endReasons: readonly string[] = ['complete', 'client-closed', 'idle-timeout', 'max-duration', 'max-bytes', 'error', 'shutdown'];
export interface StreamOutcome {
  status: number; bytes: number; durationMs: number; reason: StreamEndReason;
  /** What the producer threw, for operator diagnostics only; never written to the client or the event log. */
  error?: unknown;
}
/** A stream whose status and headers are on the wire; `finished` settles (never rejects) when it ends. */
export interface StreamStart { status: number; finished: Promise<StreamOutcome> }
export interface StreamStartOptions {
  requestId: string; method: string;
  /** The request's controller: its signal is the one handed to the producer; ending the stream aborts it with the end reason. */
  controller: AbortController;
  /** Socket inactivity timeout to restore once a stream completes and the connection may be reused. */
  restoreSocketTimeoutMs?: number | undefined;
  /** Called when the stream is refused for capacity (maxStreams), before the 503 is thrown. */
  onRefused?: (() => void) | undefined;
}

function preCommitError(reason: StreamEndReason, failure: unknown): HttpError {
  if (reason === 'error') return new HttpError(502, 'Function execution failed', undefined, { cause: failure });
  if (reason === 'max-bytes') return new HttpError(502, 'Streamed response exceeds limit');
  if (reason === 'shutdown') return new HttpError(503, 'Runtime shutting down');
  return new HttpError(504, 'Stream deadline exceeded');
}

// Closes the connection after what was already written has flushed, without the chunked terminator, so the client
// sees the body end early. A client that is not reading gets the socket destroyed after a short grace instead.
function truncate(res: ServerResponse): void {
  const socket = res.socket;
  if (!socket || socket.destroyed) { res.destroy(); return; }
  const timer = setTimeout(() => res.destroy(), 1000);
  timer.unref();
  socket.once('close', () => clearTimeout(timer));
  // The response's own write is still corked on the socket until the next turn; end after it is released.
  setImmediate(() => { if (!socket.destroyed) socket.end(); });
}
/**
 * Writes streamed results for one host and bounds them together. `start` owns the producer from the moment it is
 * called: every path either pulls it to its end or cancels it (`return()` on its iterator plus an abort of the
 * request signal).
 */
export class StreamHost {
  readonly limits: StreamLimits;
  private readonly open = new Set<(reason: StreamEndReason) => void>();
  constructor(limits: Partial<StreamLimits> = {}) { this.limits = resolveStreamLimits(limits); }
  /** Streams currently open on this host. */
  get active(): number { return this.open.size; }
  /** Ends every open stream now (graceful shutdown at the close deadline). */
  endAll(reason: 'shutdown' = 'shutdown'): void { for (const stop of [...this.open]) stop(reason); }

  /**
   * Resolves once the status and headers are committed (the first chunk arrived, or the producer finished empty),
   * or the client left first. Rejects, with nothing written, when the producer fails or a limit ends it before its
   * first chunk, so the host answers through its ordinary error path; and with 503 when `maxStreams` are open.
   */
  async start(res: ServerResponse, result: HandlerResult, options: StreamStartOptions): Promise<StreamStart> {
    const { controller } = options;
    let prepared;
    try { prepared = prepareStream(result, options); }
    catch (error) { cancelStream(result.stream); throw error; }
    const commit = (): void => {
      res.strictContentLength = false;
      setGroupedHeaders(res, prepared.headers);
      if (prepared.cookies.length) res.setHeader('set-cookie', prepared.cookies);
      res.statusCode = prepared.status;
    };
    if (prepared.stream === undefined) {
      // HEAD (or a bodyless status): the handler already chose status and headers; the producer is never pulled.
      cancelStream(result.stream);
      commit(); res.end();
      return { status: prepared.status, finished: Promise.resolve({ status: prepared.status, bytes: 0, durationMs: 0, reason: 'complete' }) };
    }
    if (this.open.size >= this.limits.maxStreams) {
      if (!controller.signal.aborted) controller.abort('capacity');
      cancelStream(prepared.stream);
      options.onRefused?.();
      throw new HttpError(503, 'Stream capacity unavailable');
    }
    if (controller.signal.aborted || res.destroyed) {
      cancelStream(prepared.stream);
      return { status: prepared.status, finished: Promise.resolve({ status: prepared.status, bytes: 0, durationMs: 0, reason: 'client-closed' }) };
    }
    const iterator = prepared.stream[Symbol.asyncIterator]();
    const limits = this.limits, started = performance.now();
    let reason: StreamEndReason | undefined, failure: unknown, bytes = 0, committed = false;
    // The one pending wait (a pull or a drain) that an early end must wake; replaced, never accumulated, per wait.
    let wake: (() => void) | undefined;
    const stop = (why: StreamEndReason): void => {
      if (reason !== undefined) return;
      reason = why;
      if (why !== 'complete' && !controller.signal.aborted) controller.abort(why);
      wake?.();
    };
    const onAbort = (): void => { const given: unknown = controller.signal.reason; stop(typeof given === 'string' && endReasons.includes(given) ? given as StreamEndReason : 'client-closed'); };
    const onClose = (): void => { if (!res.writableFinished) stop('client-closed'); };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    res.once('close', onClose);
    this.open.add(stop);
    // The server's socket inactivity timeout is tuned for short requests; this stream's own idle timer replaces it.
    res.socket?.setTimeout(0);
    const duration = setTimeout(() => stop('max-duration'), limits.maxDurationMs);
    const idle = setTimeout(() => stop('idle-timeout'), limits.idleTimeoutMs);
    duration.unref(); idle.unref();
    const drained = (): Promise<void> => new Promise<void>(resolve => {
      if (reason !== undefined) { resolve(); return; }
      const done = (): void => { res.off('drain', done); wake = undefined; resolve(); };
      res.once('drain', done);
      wake = done;
    });
    type Step = { value: IteratorResult<unknown> } | { error: unknown } | undefined;
    const pull = (): Promise<Step> => new Promise<Step>(resolve => {
      wake = () => resolve(undefined);
      iterator.next().then(value => { wake = undefined; resolve({ value }); }, (error: unknown) => { wake = undefined; resolve({ error }); });
    });
    let settleStart: ((value: StreamStart) => void) | undefined, failStart: ((error: unknown) => void) | undefined;
    const startPromise = new Promise<StreamStart>((resolve, reject) => { settleStart = resolve; failStart = reject; });
    const outcome = (): StreamOutcome => ({ status: prepared.status, bytes, durationMs: Math.round((performance.now() - started) * 100) / 100, reason: reason ?? 'error', ...(failure === undefined ? {} : { error: failure }) });
    const run = async (): Promise<StreamOutcome> => {
      try {
        while (reason === undefined) {
          const step = await pull();
          if (step === undefined || reason !== undefined) break;
          if ('error' in step) { failure = step.error; stop('error'); break; }
          if (step.value.done) { reason = 'complete'; break; }
          const chunk: unknown = step.value.value;
          if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) { failure = new TypeError('A stream chunk must be a string or a Uint8Array'); stop('error'); break; }
          const data: Uint8Array = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          if (bytes + data.byteLength > limits.maxBytes) { stop('max-bytes'); break; }
          if (!committed) {
            commit(); res.flushHeaders(); committed = true;
            settleStart?.({ status: prepared.status, finished });
          }
          bytes += data.byteLength;
          if (data.byteLength && !res.write(data)) await drained();
          if (reason === undefined) idle.refresh();
        }
      } catch (error) { failure = error; stop('error'); }
      finally {
        clearTimeout(duration); clearTimeout(idle);
        this.open.delete(stop);
        controller.signal.removeEventListener('abort', onAbort);
        res.off('close', onClose);
      }
      const ended = reason ?? 'error';
      if (ended !== 'complete') cancelStream(undefined, iterator);
      if (ended === 'complete') {
        if (!committed) { commit(); res.flushHeaders(); committed = true; }
        res.end();
        if (options.restoreSocketTimeoutMs !== undefined) res.socket?.setTimeout(options.restoreSocketTimeoutMs);
        settleStart?.({ status: prepared.status, finished });
      } else if (committed || ended === 'client-closed') {
        // No terminating chunk: the client sees a truncated body, never a complete-looking one.
        truncate(res);
        settleStart?.({ status: prepared.status, finished });
      } else {
        if (options.restoreSocketTimeoutMs !== undefined) res.socket?.setTimeout(options.restoreSocketTimeoutMs);
        failStart?.(preCommitError(ended, failure));
      }
      return outcome();
    };
    const finished: Promise<StreamOutcome> = run().catch((error: unknown) => {
      // Only a host-side fault reaches here; the stream is already cancelled and the socket is released.
      failure ??= error; reason ??= 'error'; res.destroy();
      failStart?.(new HttpError(502, 'Function execution failed', undefined, { cause: error }));
      return outcome();
    });
    return await startPromise;
  }
}
