import { validateHeaderName, validateHeaderValue } from './header-validation.js';
import { HttpError } from './errors.js';

// Hop-by-hop and runtime-owned headers a handler must never set on the wire.
export const forbiddenHeaders = new Set(['connection','keep-alive','transfer-encoding','content-length','upgrade','trailer','proxy-authenticate','proxy-authorization','te']);

// One place decides what a URLCode response *is*, independent of how a host
// delivers it. A Node server writes it to a socket; a Lambda returns it as
// JSON. Both go through here, so a project cannot behave differently on one
// host than another without this function changing.
export function prepareResponse(result, { requestId, method }) {
  const status = result.status;
  if (!Number.isInteger(status) || status < 200 || status > 599) throw new HttpError(502, 'Invalid function response');
  const headers = [], cookies = [];
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
  if (!bodyless) headers.push(['content-length', String(result.contentLength ?? (body?.length ?? 0))]);
  headers.push(['x-request-id',requestId],['x-content-type-options','nosniff']);
  if (!headers.some(([key]) => key.toLowerCase() === 'cache-control')) headers.push(['cache-control','no-store']);
  return { status, headers, cookies, body };
}
export function writeResponse(res, result, options) {
  const prepared = prepareResponse(result, options);
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
export function errorResponse(error, { requestId, method, headers = [] }) {
  const status = error instanceof HttpError ? error.status : 500;
  const fixed = [['content-type','text/plain; charset=utf-8'],['cache-control','no-store'],['x-request-id',requestId],['x-content-type-options','nosniff']];
  const taken = new Set(fixed.map(([key]) => key));
  const extra = headers.filter(([key]) => !taken.has(key.toLowerCase()) && !forbiddenHeaders.has(key.toLowerCase()));
  const text = `${error instanceof HttpError ? error.message : 'Internal server error'}\n`;
  const body = method === 'HEAD' ? undefined : text;
  // Stated explicitly so every host agrees, as prepareResponse does for results.
  return { status, headers: [...fixed, ['content-length', String(new TextEncoder().encode(text).length)], ...extra], body };
}
export function writeError(res, error, options) {
  const prepared = errorResponse(error, options);
  if (res.headersSent) { res.destroy(); return prepared.status; }
  for (const key of res.getHeaderNames()) res.removeHeader(key);
  for (const [key,value] of prepared.headers) res.setHeader(key,value);
  res.setHeader('connection','close');
  res.statusCode = prepared.status;
  res.end(prepared.body);
  return prepared.status;
}
