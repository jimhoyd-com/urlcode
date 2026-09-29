import { compileTrustedProxies, loopbackHostCheck } from './client-address.ts';
import { assert, HttpError } from './errors.ts';
import { handleHostRequest, hostErrorOptions, joinedHeaderCounts, normalizeBasePath, readHeaderLines } from './host-request.ts';
import type { HeaderCounts } from './host-request.ts';
import { cancelStream, errorResponse, fetchHeaders, fetchResponse, prepareResponse, prepareStream } from './http-response.ts';
import type { HandlerResult, StreamChunk } from './http-response.ts';
import type { Runtime } from './runtime.ts';
import { siteOrigins } from './site-origins.ts';

// Hosting a self-hosted runtime inside another server's fetch handler (docs/OPERATIONS.md#hosting-urlcode-inside-another-framework,
// RIM-EMBED-001). The request pipeline is host-request.ts, shared with startServer; the answer is built by
// http-response.ts's prepareResponse/prepareStream/errorResponse, as on every host. What stays with startServer
// (probes, the request log, admission, timeouts, stream limits, reload) is listed in that page.

export interface EmbeddedHandlerOptions {
  /** The public origin a request sees (a function's `request.url`, conditions, policies). Omitted, it is the
   * incoming Request URL's origin, which a Node host builds from the client's Host header: set it for a public site. */
  origin?: string | undefined;
  /** Largest request body read, before any route's own `request.body.<METHOD>.maxBytes` (default 1048576, 1–16777216). */
  maxBodyBytes?: number | undefined;
  /** Peers (address or CIDR, at most 256) allowed to speak for a client through X-Forwarded-For, as `urlcode serve --trusted-proxy`. */
  trustedProxies?: string | readonly string[] | undefined;
  /** The prefix the host mounts this site under and strips before calling the handler (`/app`). */
  basePath?: string | undefined;
  /** Whether each call supplies the original header lines (`info.rawHeaders`). `unavailable` states the host has only
   * joined headers: a joined value containing a comma then counts as repeated, so refusals of repeated headers fire. */
  headerLines?: 'provided' | 'unavailable' | undefined;
  /** The host listens on this loopback address and port: refuse (421) a Host that is not a loopback name on that port,
   * `origin` or an alias origin, as the Node server does on a loopback bind. Ignored for a non-loopback address. */
  loopbackHost?: { address: string; port: number; aliasOrigins?: readonly string[] | undefined } | undefined;
}
export interface EmbeddedRequestInfo {
  /** The socket peer address the host vouches for; forwarded headers are read only when it is a trusted proxy. */
  peer?: string | undefined;
  /** The request's original header lines, Node's `rawHeaders` shape (name, value, name, value, ...). Required
   * unless `headerLines: 'unavailable'`; they replace `request.headers`. */
  rawHeaders?: readonly string[] | undefined;
}
export type EmbeddedHandler = (request: Request, info?: EmbeddedRequestInfo) => Promise<Response>;

async function readRequestBody(request: Request, limit: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array(0);
  const stated = request.headers.get('content-length');
  if (stated !== null && Number(stated) > limit) { void request.body.cancel().catch(() => {}); throw new HttpError(413, 'Request body too large'); }
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    let step: ReadableStreamReadResult<Uint8Array>;
    try { step = await reader.read(); } catch { throw new HttpError(400, 'Request aborted'); }
    if (step.done) break;
    size += step.value.byteLength;
    if (size > limit) { void reader.cancel().catch(() => {}); throw new HttpError(413, 'Request body too large'); }
    chunks.push(step.value);
  }
  const body = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

const encoder = new TextEncoder();
function chunkBytes(chunk: unknown): Uint8Array {
  if (typeof chunk === 'string') return encoder.encode(chunk);
  if (chunk instanceof Uint8Array) return chunk;
  throw new TypeError('A stream chunk must be a string or a Uint8Array');
}

// The fetch counterpart of http-stream.ts's delivery: status and headers are committed by the first chunk (or an
// empty finish), so a producer that fails before it is answered through the ordinary error path, exactly as the
// Node server does. Later failures end the body early; the host sees an errored stream, never a complete one.
async function streamed(result: HandlerResult, requestId: string, method: string, controller: AbortController): Promise<Response> {
  let prepared;
  try { prepared = prepareStream(result, { requestId, method }); }
  catch (error) { if (!controller.signal.aborted) controller.abort('error'); cancelStream(result.stream); throw error; }
  const headers = fetchHeaders(prepared);
  if (prepared.stream === undefined) {
    if (!controller.signal.aborted) controller.abort('bodyless');
    cancelStream(result.stream);
    return new Response(null, { status: prepared.status, headers });
  }
  const iterator = prepared.stream[Symbol.asyncIterator]();
  const stop = (reason: string): void => { if (!controller.signal.aborted) controller.abort(reason); cancelStream(undefined, iterator); };
  let first: IteratorResult<StreamChunk>, bytes: Uint8Array | undefined;
  try { first = await iterator.next(); if (!first.done) bytes = chunkBytes(first.value); }
  catch (error) { stop('error'); throw new HttpError(502, 'Function execution failed', undefined, { cause: error }); }
  let pending = bytes;
  const body = new ReadableStream<Uint8Array>({
    start(stream) { if (first.done) stream.close(); },
    async pull(stream) {
      if (pending) { const chunk = pending; pending = undefined; if (chunk.byteLength) { stream.enqueue(chunk); return; } }
      try {
        for (;;) {
          const step = await iterator.next();
          if (step.done) { stream.close(); return; }
          const chunk = chunkBytes(step.value);
          if (chunk.byteLength) { stream.enqueue(chunk); return; }
        }
      } catch (error) { stop('error'); stream.error(error); }
    },
    cancel() { stop('client-closed'); },
  });
  return new Response(body, { status: prepared.status, headers });
}

/**
 * A fetch handler for a runtime built with `createRuntime(project, { target: 'node' })`: `(request, info) =>
 * Promise<Response>`. It reads the request, resolves the client and answers exactly as `startServer` does for the
 * same project; the embedding host keeps its own server, listener and lifecycle, and closes the runtime itself.
 */
export function createEmbeddedHandler(runtime: Runtime, options: EmbeddedHandlerOptions = {}): EmbeddedHandler {
  const { origin, maxBodyBytes = 1048576, trustedProxies = [], headerLines = 'provided', loopbackHost } = options;
  assert(Number.isInteger(maxBodyBytes) && maxBodyBytes >= 1 && maxBodyBytes <= 16777216, 'Request limit must be 1–16777216 bytes');
  assert(headerLines === 'provided' || headerLines === 'unavailable', 'headerLines must be provided or unavailable');
  if (origin !== undefined) {
    let url: URL | undefined;
    try { url = new URL(origin); } catch { /* refused below */ }
    assert(url && ['http:', 'https:'].includes(url.protocol) && url.origin === origin, 'Origin must be HTTP(S) without path or credentials');
  }
  const basePath = normalizeBasePath(options.basePath);
  const proxies = compileTrustedProxies(typeof trustedProxies === 'string' ? trustedProxies : [...trustedProxies]);
  const hostAdmitted = loopbackHost ? loopbackHostCheck(loopbackHost, siteOrigins(origin, loopbackHost.aliasOrigins)) : undefined;

  return async function handle(request, info = {}) {
    // A host that promised header lines and did not send them is a programming error, not a request to answer.
    if (headerLines === 'provided' && !Array.isArray(info.rawHeaders)) throw new TypeError('createEmbeddedHandler: pass info.rawHeaders, or create the handler with headerLines: "unavailable"');
    const requestId = crypto.randomUUID(), method = request.method;
    const url = new URL(request.url), target = url.pathname + url.search;
    const publicOrigin = origin ?? url.origin;
    const controller = new AbortController();
    const onAbort = (): void => { if (!controller.signal.aborted) controller.abort('client-closed'); };
    if (request.signal.aborted) onAbort(); else request.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const { headers, headerCounts } = info.rawHeaders
        ? readHeaderLines(info.rawHeaders)
        : { headers: new Headers(request.headers), headerCounts: joinedHeaderCounts(request.headers) as HeaderCounts };
      if (hostAdmitted) {
        const host = headers.get('host') ?? url.host;
        const lines = info.rawHeaders ? [...info.rawHeaders] : ['host', host];
        if (!hostAdmitted(lines, target)) throw new HttpError(421, 'Misdirected request');
      }
      const result = await handleHostRequest(runtime, { target, method, headers, headerCounts, peer: info.peer,
        readBody: limit => readRequestBody(request, limit), requestId, signal: controller.signal, trace: {}, origin: publicOrigin, basePath },
      { maxBodyBytes, trustedProxies: proxies });
      if (result.stream !== undefined) return await streamed(result, requestId, method, controller);
      return fetchResponse(prepareResponse(result, { requestId, method }), method);
    } catch (error) {
      return fetchResponse(errorResponse(error, { requestId, method, ...hostErrorOptions(runtime, error, { origin: publicOrigin, target }) }), method);
    }
  };
}
