import { validateHeaderName, validateHeaderValue } from './header-validation.ts';
import { HttpError } from './errors.ts';

export type HeaderPair = [string, string];
export type ResponseBody = string | Uint8Array | null | undefined;
/** One piece of a streamed response body: text is sent as UTF-8. An empty chunk sends nothing but commits the status and headers. */
export type StreamChunk = string | Uint8Array;
/** A streamed response body: pulled one chunk at a time, cancelled through the iterator's `return()`. */
export type ResponseStream = AsyncIterable<StreamChunk>;
/**
 * What a handler, policy or asset produced; every host turns it into a wire response here.
 * `stream` is the alternative to `body` (never both): a body sent in chunks as the producer yields them, accepted
 * only from a route that declares streaming (`stream: true` on a trusted function route, `streams: true` on an
 * extension registration) and only by a host that can deliver it (docs/SPECIFICATION.md#streamed-responses).
 */
export interface HandlerResult { status: number; headers: HeaderPair[]; body?: ResponseBody; contentLength?: number; stream?: ResponseStream }
interface PreparedResponse { status: number; headers: HeaderPair[]; cookies: string[]; body: ResponseBody }
/** A streamed result once prepared: runtime-decorated status and headers (no Content-Length); `stream` is absent for HEAD and bodyless statuses. */
export interface PreparedStream { status: number; headers: HeaderPair[]; cookies: string[]; stream: ResponseStream | undefined }
interface ErrorAnswer { status: number; headers: HeaderPair[]; body: string | undefined }
// `enforceContentLength` defaults to on: the host asks Node itself to refuse
// a body that does not match the length just stated (belt-and-suspenders
// over this module's own byteLength()). A host sets it to false only where it
// knows that self-check is unsafe on the runtime it is executing on — see
// server.ts's `contentLengthEnforcementIsSafe` for the one such case.
interface ResponseOptions { requestId: string; method: string; enforceContentLength?: boolean }
/** The node:http ServerResponse surface this module writes to, kept structural so the module stays Node-free. */
export interface ResponseWriter {
  statusCode: number; headersSent: boolean;
  setHeader(name: string, value: string | string[]): unknown; getHeaderNames(): string[]; removeHeader(name: string): void;
  end(body?: ResponseBody): unknown; destroy(): unknown;
  strictContentLength?: boolean;
}

// Hop-by-hop and runtime-owned headers a handler must never set on the wire.
const forbiddenHeaders = new Set(['connection','keep-alive','transfer-encoding','content-length','upgrade','trailer','proxy-authenticate','proxy-authorization','te']);
// Unlike Cache-Control (a real default a handler may explicitly override),
// these two are always the runtime's own value, appended once below. A
// handler-set copy of either (defense-in-depth code setting nosniff itself,
// say) is dropped here rather than kept alongside the runtime's: now that
// repeated headers are sent as separate wire lines instead of silently
// collapsing to the last `setHeader` call, keeping both would put two
// X-Content-Type-Options or X-Request-Id lines on the wire instead of one.
const runtimeOwnedHeaders = new Set(['x-content-type-options','x-request-id']);

// One place decides what a URLCode response *is*, independent of how a host
// delivers it. A Node server writes it to a socket; a Lambda returns it as
// JSON. Both go through here, so a project cannot behave differently on one
// host than another without this function changing.
export function prepareResponse(result: HandlerResult, { requestId, method }: ResponseOptions): PreparedResponse {
  // A host that buffers must never receive a stream it would silently drop or read whole; streaming hosts call prepareStream.
  if (result.stream !== undefined) throw new HttpError(502, 'Invalid function response');
  const { status, headers, cookies } = responseHead(result);
  // A body these statuses must not carry, and HEAD, are suppressed once here
  // rather than in each host's writer.
  const bodyless = [204,205,304].includes(status);
  const body = method === 'HEAD' || bodyless ? undefined : result.body;
  // State the length rather than leaving a host to infer it. A Node server
  // computes this itself, but a host that returns JSON does not, so the policy
  // has to say it for every host to agree.
  // A response that carries its body is framed by the bytes it carries, never
  // by a stated length. Only HEAD may state one, because it sends no body and
  // reports the length GET would send (RFC 9110 §8.6); without a stated
  // length it is measured on the result's body before the body is dropped.
  if (!bodyless) headers.push(['content-length', String(method === 'HEAD' ? headLength(result) : byteLength(result.body))]);
  decorate(headers, requestId);
  return { status, headers, cookies, body };
}
function responseHead(result: HandlerResult): { status: number; headers: HeaderPair[]; cookies: string[] } {
  const status = result.status;
  if (!Number.isInteger(status) || status < 200 || status > 599) throw new HttpError(502, 'Invalid function response');
  const headers: HeaderPair[] = [], cookies: string[] = [];
  for (const [key,value] of result.headers) {
    if (forbiddenHeaders.has(key.toLowerCase()) || runtimeOwnedHeaders.has(key.toLowerCase())) continue;
    validateHeaderName(key); validateHeaderValue(key,value);
    if (key.toLowerCase() === 'set-cookie') cookies.push(value);
    else headers.push([key,value]);
  }
  return { status, headers, cookies };
}
function decorate(headers: HeaderPair[], requestId: string): void {
  headers.push(['x-request-id',requestId],['x-content-type-options','nosniff']);
  if (!headers.some(([key]) => key.toLowerCase() === 'cache-control')) headers.push(['cache-control','no-store']);
}
/** Whether `value` can be pulled as a response stream (it has an async iterator). */
export function isResponseStream(value: unknown): value is ResponseStream {
  return typeof value === 'object' && value !== null && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';
}
/**
 * The streamed counterpart of prepareResponse: the same status check, header ownership and runtime decoration,
 * but no Content-Length (the length is not known up front, so a host frames the body with chunked transfer or by
 * closing the connection). A result carrying both `body` and `stream`, or a `stream` that is not async-iterable,
 * is an invalid response (502). HEAD and 204/205/304 carry no stream; the caller cancels the producer.
 */
export function prepareStream(result: HandlerResult, { requestId, method }: ResponseOptions): PreparedStream {
  if (!isResponseStream(result.stream) || (result.body !== undefined && result.body !== null) || result.contentLength !== undefined) throw new HttpError(502, 'Invalid function response');
  const { status, headers, cookies } = responseHead(result);
  decorate(headers, requestId);
  const bodyless = [204,205,304].includes(status);
  return { status, headers, cookies, stream: method === 'HEAD' || bodyless ? undefined : result.stream };
}
/**
 * Stops a producer that will not be pulled to its end: calls the iterator's `return()` once, never awaiting it
 * (a producer stuck on an await settles its `finally` when that await does) and never throwing.
 */
export function cancelStream(stream: ResponseStream | undefined, iterator?: AsyncIterator<StreamChunk>): void {
  try {
    const it = iterator ?? stream?.[Symbol.asyncIterator]();
    const done = it?.return?.();
    if (done && typeof (done as Promise<unknown>).then === 'function') (done as Promise<unknown>).then(undefined, () => {});
  } catch { /* A producer's own failure to stop cannot fail the host. */ }
}
function headLength(result: HandlerResult): number {
  if (result.contentLength === undefined) return byteLength(result.body);
  if (!Number.isSafeInteger(result.contentLength) || result.contentLength < 0) throw new HttpError(502, 'Invalid function response');
  return result.contentLength;
}
/** The UTF-8 bytes a body occupies on the wire; a string's `.length` counts UTF-16 units, not bytes. */
export function byteLength(body: ResponseBody): number {
  if (body === null || body === undefined) return 0;
  if (typeof body !== 'string') return body.byteLength;
  let bytes = 0;
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < body.length && (body.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { bytes += 4; i++; }
    else bytes += 3; // other BMP characters, and a lone surrogate encoded as U+FFFD
  }
  return bytes;
}
// `res.setHeader(name, value)` called twice for the same name (case
// insensitively) replaces the first call rather than adding to it, so a
// handler, policy or profile that legitimately repeats a header (`Link`,
// `WWW-Authenticate`, a second `Vary` fragment produced upstream of this
// module) would otherwise lose every value but the last on the wire. Group
// by name first, in the case first seen, and hand Node the whole array; that
// is the one call shape ResponseWriter#setHeader accepts for a repeated
// header on every host this module writes to.
export function setGroupedHeaders(res: ResponseWriter, headers: readonly HeaderPair[]): void {
  const order: string[] = [], grouped = new Map<string, string[]>();
  for (const [key, value] of headers) {
    const lower = key.toLowerCase();
    const values = grouped.get(lower);
    if (values) values.push(value);
    else { grouped.set(lower, [value]); order.push(key); }
  }
  for (const key of order) { const values = grouped.get(key.toLowerCase())!; res.setHeader(key, values.length === 1 ? values[0]! : values); }
}
export function writeResponse(res: ResponseWriter, result: HandlerResult, options: ResponseOptions): number {
  const prepared = prepareResponse(result, options);
  // Node then refuses to send a body whose size differs from the stated length.
  res.strictContentLength = options.enforceContentLength !== false;
  setGroupedHeaders(res, prepared.headers);
  if (prepared.cookies.length) res.setHeader('set-cookie',prepared.cookies);
  res.statusCode = prepared.status;
  res.end(prepared.body);
  return prepared.status;
}

/**
 * How a runtime-generated error is written (route `errors.format`, or `site.errors` for a path scope): `text` is the
 * plain-text line every host has always sent; `json` is the fixed envelope below (docs/HTTP.md#error-format).
 */
export type ErrorFormat = 'text' | 'json';
/** The closed set of envelope codes, keyed by the status the runtime generated. */
export const errorCodes: Readonly<Record<number, string>> = Object.freeze({
  400: 'BAD_REQUEST', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED', 410: 'GONE', 413: 'CONTENT_TOO_LARGE', 414: 'URI_TOO_LONG',
  415: 'UNSUPPORTED_MEDIA_TYPE', 421: 'MISDIRECTED_REQUEST', 422: 'UNPROCESSABLE_CONTENT', 500: 'INTERNAL_ERROR', 502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE', 504: 'GATEWAY_TIMEOUT',
});
/** The envelope code for `status`; `ERROR` for a status outside the closed set (the runtime generates none today). */
export const errorCode = (status: number): string => errorCodes[status] ?? 'ERROR';
export const jsonErrorType = 'application/json; charset=utf-8';
/**
 * The fixed JSON error envelope, `{"error":{"code":…,"message":…}}`, plus the bounded `issues`/`truncated` fields for
 * a body-schema 422 only. The message is the runtime's own fixed words, never request or operator data.
 */
export function errorEnvelope(status: number, message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ error: { code: errorCode(status), message, ...extra } });
}
/**
 * The paths a `site.errors` scope covers: each entry is an exact path, or a prefix ending in `/*` that covers the
 * prefix itself and everything below it (`/api/*` covers `/api`, `/api/` and `/api/v1/x`), as `site.sitemap.exclude`.
 */
export function errorScope(paths: readonly string[] | undefined): (path: string) => boolean {
  const rules = (paths ?? []).map(pattern => pattern.endsWith('/*') ? { prefix: pattern.slice(0, -1) } : { exact: pattern });
  return path => rules.some(rule => rule.exact !== undefined ? rule.exact === path : path.startsWith(rule.prefix!) || path === rule.prefix!.slice(0, -1));
}
/** A matched route's own `errors.format` wins; otherwise a path inside the site scope is `json`; anything else is `text`. */
export function resolveErrorFormat(declared: ErrorFormat | undefined, scope: (path: string) => boolean, path: string): ErrorFormat {
  return declared ?? (scope(path) ? 'json' : 'text');
}
const encoder = new TextEncoder();
/** The runtime's own 405 in the chosen format, always with `Allow`. The text form is the historical bytes, with no content type. */
export function methodNotAllowed(methods: readonly string[], format: ErrorFormat): HandlerResult {
  const allow: HeaderPair = ['allow', methods.join(', ')];
  return format === 'json'
    ? { status: 405, headers: [allow, ['content-type', jsonErrorType]], body: encoder.encode(errorEnvelope(405, 'Method not allowed')) }
    : { status: 405, headers: [allow], body: encoder.encode('Method not allowed\n') };
}

// The one shape of an error answer on every host. `headers` are the policy
// headers the host resolved for this error (security profile); they never
// replace the fixed set below, which is what keeps an error from being cached
// or sniffed whatever a project declares. `format: 'json'` swaps the text line
// for the fixed envelope; status, fixed headers and the HEAD rule are unchanged.
export function errorResponse(error: unknown, { requestId, method, headers = [], format = 'text' }: ResponseOptions & { headers?: HeaderPair[]; format?: ErrorFormat }): ErrorAnswer {
  const status = error instanceof HttpError ? error.status : 500;
  const answer = error instanceof HttpError ? error.answer : undefined;
  // Runtime error messages are fixed words; markup characters are still
  // stripped so the body can never be read as HTML by a client that ignores
  // both the content type and nosniff.
  const message = error instanceof HttpError ? String(error.message).replace(/[<>&"']/g, '') : 'Internal server error';
  const [contentType, text] = format === 'json'
    ? [jsonErrorType, answer?.envelope ?? errorEnvelope(status, message.split('\n')[0]!)]
    : [answer ? answer.contentType : 'text/plain; charset=utf-8', answer ? answer.text + '\n' : `${message}\n`];
  const fixed: HeaderPair[] = [['content-type', contentType],['cache-control','no-store'],['x-request-id',requestId],['x-content-type-options','nosniff']];
  const taken = new Set(fixed.map(([key]) => key));
  const extra = headers.filter(([key]) => !taken.has(key.toLowerCase()) && !forbiddenHeaders.has(key.toLowerCase()));
  const body = method === 'HEAD' ? undefined : text;
  // Stated explicitly so every host agrees, as prepareResponse does for results.
  return { status, headers: [...fixed, ['content-length', String(byteLength(text))], ...extra], body };
}
export function writeError(res: ResponseWriter, error: unknown, options: ResponseOptions & { headers?: HeaderPair[]; format?: ErrorFormat }): number {
  const prepared = errorResponse(error, options);
  if (res.headersSent) { res.destroy(); return prepared.status; }
  for (const key of res.getHeaderNames()) res.removeHeader(key);
  setGroupedHeaders(res, prepared.headers);
  res.setHeader('connection','close');
  res.strictContentLength = options.enforceContentLength !== false;
  res.statusCode = prepared.status;
  res.end(prepared.body);
  return prepared.status;
}
