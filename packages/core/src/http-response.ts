import { validateHeaderName, validateHeaderValue } from './header-validation.ts';
import { HttpError } from './errors.ts';

export type HeaderPair = [string, string];
export type ResponseBody = string | Uint8Array | null | undefined;
/** What a handler, policy or asset produced; every host turns it into a wire response here. */
export interface HandlerResult { status: number; headers: HeaderPair[]; body?: ResponseBody; contentLength?: number }
export interface PreparedResponse { status: number; headers: HeaderPair[]; cookies: string[]; body: ResponseBody }
export interface ErrorAnswer { status: number; headers: HeaderPair[]; body: string | undefined }
export interface ResponseOptions { requestId: string; method: string }
/** The node:http ServerResponse surface this module writes to, kept structural so the module stays Node-free. */
export interface ResponseWriter {
  statusCode: number; headersSent: boolean;
  setHeader(name: string, value: string | string[]): unknown; getHeaderNames(): string[]; removeHeader(name: string): void;
  end(body?: ResponseBody): unknown; destroy(): unknown;
  strictContentLength?: boolean;
}

// Hop-by-hop and runtime-owned headers a handler must never set on the wire.
const forbiddenHeaders = new Set(['connection','keep-alive','transfer-encoding','content-length','upgrade','trailer','proxy-authenticate','proxy-authorization','te']);

// One place decides what a URLCode response *is*, independent of how a host
// delivers it. A Node server writes it to a socket; a Lambda returns it as
// JSON. Both go through here, so a project cannot behave differently on one
// host than another without this function changing.
export function prepareResponse(result: HandlerResult, { requestId, method }: ResponseOptions): PreparedResponse {
  const status = result.status;
  if (!Number.isInteger(status) || status < 200 || status > 599) throw new HttpError(502, 'Invalid function response');
  const headers: HeaderPair[] = [], cookies: string[] = [];
  for (const [key,value] of result.headers) {
    if (forbiddenHeaders.has(key.toLowerCase())) continue;
    validateHeaderName(key); validateHeaderValue(key,value);
    if (key.toLowerCase() === 'set-cookie') cookies.push(value);
    else headers.push([key,value]);
  }
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
  headers.push(['x-request-id',requestId],['x-content-type-options','nosniff']);
  if (!headers.some(([key]) => key.toLowerCase() === 'cache-control')) headers.push(['cache-control','no-store']);
  return { status, headers, cookies, body };
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
export function writeResponse(res: ResponseWriter, result: HandlerResult, options: ResponseOptions): number {
  const prepared = prepareResponse(result, options);
  // Node then refuses to send a body whose size differs from the stated length.
  res.strictContentLength = true;
  for (const [key,value] of prepared.headers) res.setHeader(key,value);
  if (prepared.cookies.length) res.setHeader('set-cookie',prepared.cookies);
  res.statusCode = prepared.status;
  res.end(prepared.body);
  return prepared.status;
}

// The one shape of an error answer on every host. `headers` are the policy
// headers the host resolved for this error (security profile); they never
// replace the fixed set below, which is what keeps an error from being cached
// or sniffed whatever a project declares.
export function errorResponse(error: unknown, { requestId, method, headers = [] }: ResponseOptions & { headers?: HeaderPair[] }): ErrorAnswer {
  const status = error instanceof HttpError ? error.status : 500;
  const fixed: HeaderPair[] = [['content-type',error instanceof HttpError && error.answer ? error.answer.contentType : 'text/plain; charset=utf-8'],['cache-control','no-store'],['x-request-id',requestId],['x-content-type-options','nosniff']];
  const taken = new Set(fixed.map(([key]) => key));
  const extra = headers.filter(([key]) => !taken.has(key.toLowerCase()) && !forbiddenHeaders.has(key.toLowerCase()));
  // Runtime error messages are fixed words, and the answer is text/plain
  // with nosniff; markup characters are still stripped so the body can never
  // be read as HTML by a client that ignores both.
  const text = error instanceof HttpError && error.answer ? error.answer.text + '\n' : `${error instanceof HttpError ? String(error.message).replace(/[<>&"']/g, '') : 'Internal server error'}\n`;
  const body = method === 'HEAD' ? undefined : text;
  // Stated explicitly so every host agrees, as prepareResponse does for results.
  return { status, headers: [...fixed, ['content-length', String(byteLength(text))], ...extra], body };
}
export function writeError(res: ResponseWriter, error: unknown, options: ResponseOptions & { headers?: HeaderPair[] }): number {
  const prepared = errorResponse(error, options);
  if (res.headersSent) { res.destroy(); return prepared.status; }
  for (const key of res.getHeaderNames()) res.removeHeader(key);
  for (const [key,value] of prepared.headers) res.setHeader(key,value);
  res.setHeader('connection','close');
  res.strictContentLength = true;
  res.statusCode = prepared.status;
  res.end(prepared.body);
  return prepared.status;
}
