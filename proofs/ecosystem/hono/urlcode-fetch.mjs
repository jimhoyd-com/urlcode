// Operator-owned bridge from a standard fetch Request to URLCode's public in-process API (createRuntime's
// runtime.handle) and back to a standard Response. Everything here uses only the published package surface; that is
// the point of the fixture. Core does not export its own response writer (prepareResponse/prepareStream/
// errorResponse in packages/core/src/http-response.ts), so the response rules below are a hand copy of that contract
// (docs/RUNTIME-IMPLEMENTATION.md, RIM-OUTPUT-001, RIM-ERRORS-001, RIM-STREAM-001) and can drift from it. Features
// that belong to URLCode's own Node server (startServer) are not reproduced; see ../README.md.

// Hop-by-hop and framing headers a handler cannot set, and the two headers the runtime always owns.
const forbidden = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'upgrade', 'trailer', 'proxy-authenticate', 'proxy-authorization', 'te']);
const runtimeOwned = new Set(['x-content-type-options', 'x-request-id']);
const bodyless = new Set([204, 205, 304]);
// RIM-ERRORS-001's closed code set, copied because core does not export it.
const errorCodes = { 400: 'BAD_REQUEST', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED', 410: 'GONE', 413: 'CONTENT_TOO_LARGE', 414: 'URI_TOO_LONG', 415: 'UNSUPPORTED_MEDIA_TYPE', 421: 'MISDIRECTED_REQUEST', 422: 'UNPROCESSABLE_CONTENT', 500: 'INTERNAL_ERROR', 502: 'BAD_GATEWAY', 503: 'SERVICE_UNAVAILABLE', 504: 'GATEWAY_TIMEOUT' };

// Bytes, never a string: `new Response(string)` adds `Content-Type: text/plain;charset=UTF-8` on its own, which
// URLCode's writer does not (its text 405, for one, carries no content type). @hono/node-server still adds that
// default to any body without a type when it writes the response; the fixture records it as a host difference.
const encoder = new TextEncoder();
const bytes = body => (body === undefined || body === null || body.length === 0 ? null : typeof body === 'string' ? encoder.encode(body) : body);

class TooLarge extends Error { status = 413; constructor() { super('Request body too large'); } }

async function readBody(request, limit) {
  if (!request.body) return undefined;
  const stated = request.headers.get('content-length');
  if (stated !== null && Number(stated) > limit) throw new TooLarge();
  const chunks = []; let size = 0;
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > limit) throw new TooLarge();
    chunks.push(chunk);
  }
  const body = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

function responseHeaders(result, requestId) {
  if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599) throw Object.assign(new Error('Invalid function response'), { status: 502 });
  const headers = new Headers();
  for (const [name, value] of result.headers) {
    const key = name.toLowerCase();
    if (forbidden.has(key) || runtimeOwned.has(key)) continue;
    // A fetch Headers object keeps Set-Cookie lines apart but joins any other repeated name with ", ".
    headers.append(key, value);
  }
  headers.set('x-request-id', requestId);
  headers.set('x-content-type-options', 'nosniff');
  if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');
  return headers;
}

function streamBody(stream) {
  const encoder = new TextEncoder();
  let iterator;
  return new ReadableStream({
    start() { iterator = stream[Symbol.asyncIterator](); },
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else if (value.length) controller.enqueue(typeof value === 'string' ? encoder.encode(value) : value);
    },
    cancel() { void Promise.resolve(iterator.return?.()).catch(() => {}); },
  });
}

function cancel(stream) { try { void Promise.resolve(stream?.[Symbol.asyncIterator]().return?.()).catch(() => {}); } catch { /* never throws */ } }

function errorAnswer(runtime, error, { target, method, requestId, origin }) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const message = Number.isInteger(error?.status) ? String(error.message).replace(/[<>&"']/g, '') : 'Internal server error';
  const format = runtime.errorFormat(error, target);
  const answer = error?.answer;
  const [type, text] = format === 'json'
    ? ['application/json; charset=utf-8', answer?.envelope ?? JSON.stringify({ error: { code: errorCodes[status] ?? 'ERROR', message: message.split('\n')[0] } })]
    : [answer ? answer.contentType : 'text/plain; charset=utf-8', answer ? answer.text + '\n' : `${message}\n`];
  const headers = new Headers({ 'content-type': type, 'cache-control': 'no-store', 'x-request-id': requestId, 'x-content-type-options': 'nosniff' });
  for (const [name, value] of runtime.errorHeaders(error, origin)) if (!headers.has(name) && !forbidden.has(name.toLowerCase())) headers.append(name, value);
  return new Response(method === 'HEAD' ? null : bytes(text), { status, headers });
}

/**
 * `handle(request, {client, rawHeaders})`: `client` is the address the host vouches for (URLCode does not resolve
 * forwarded headers here; that is the host's trusted-proxy decision). `rawHeaders`, when the host has the original
 * Node header lines, lets URLCode see repeated request headers; a pure fetch Request has already joined them.
 */
export function createUrlcodeFetch(runtime, { origin, maxBodyBytes = 1048576 } = {}) {
  return async function handle(request, { client, rawHeaders } = {}) {
    const url = new URL(request.url);
    const target = url.pathname + url.search, method = request.method, requestId = crypto.randomUUID();
    try {
      const headers = new Headers(), headerCounts = Object.create(null);
      if (rawHeaders) for (let i = 0; i < rawHeaders.length; i += 2) {
        const key = rawHeaders[i].toLowerCase();
        headers.append(key, rawHeaders[i + 1]); headerCounts[key] = (headerCounts[key] ?? 0) + 1;
      }
      else for (const [key, value] of request.headers) { headers.append(key, value); headerCounts[key] = 1; }
      const body = await readBody(request, Math.min(maxBodyBytes, runtime.requestLimit(target, method) ?? maxBodyBytes));
      const result = await runtime.handle({ target, method, headers, headerCounts, body, requestId, origin, client, signal: request.signal });
      const responseHead = responseHeaders(result, requestId);
      const empty = method === 'HEAD' || bodyless.has(result.status);
      if (result.stream !== undefined) {
        if (empty) { cancel(result.stream); return new Response(null, { status: result.status, headers: responseHead }); }
        return new Response(streamBody(result.stream), { status: result.status, headers: responseHead });
      }
      if (method === 'HEAD' && result.contentLength !== undefined) responseHead.set('content-length', String(result.contentLength));
      return new Response(empty ? null : bytes(result.body), { status: result.status, headers: responseHead });
    } catch (error) {
      return errorAnswer(runtime, error, { target, method, requestId, origin });
    }
  };
}
