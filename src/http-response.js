import http from 'node:http';
import { HttpError } from './errors.js';

// Hop-by-hop and runtime-owned headers a handler must never set on the wire.
export const forbiddenHeaders = new Set(['connection','keep-alive','transfer-encoding','content-length','upgrade','trailer','proxy-authenticate','proxy-authorization','te']);

// One place decides what a URLCode response looks like on a Node response
// object, so a project behaves the same self-hosted and behind a provider
// adapter. A divergence here would quietly break the portability promise.
export function writeResponse(res, result, { requestId, method }) {
  const status = result.status;
  if (!Number.isInteger(status) || status < 200 || status > 599) throw new HttpError(502, 'Invalid function response');
  const cookies = [];
  for (const [key,value] of result.headers) {
    if (forbiddenHeaders.has(key.toLowerCase())) continue;
    http.validateHeaderName(key); http.validateHeaderValue(key,value);
    if (key.toLowerCase() === 'set-cookie') cookies.push(value);
    else res.setHeader(key,value);
  }
  if (result.contentLength !== undefined) res.setHeader('content-length', result.contentLength);
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.setHeader('x-request-id', requestId);
  res.setHeader('x-content-type-options', 'nosniff');
  if (!res.hasHeader('cache-control')) res.setHeader('cache-control', 'no-store');
  res.statusCode = status;
  res.end(method === 'HEAD' || status === 204 || status === 205 || status === 304 ? undefined : result.body);
  return status;
}

export function writeError(res, error, { requestId, method }) {
  const status = error instanceof HttpError ? error.status : 500;
  if (res.headersSent) { res.destroy(); return status; }
  for (const key of res.getHeaderNames()) res.removeHeader(key);
  res.writeHead(status, { 'content-type':'text/plain; charset=utf-8', 'cache-control':'no-store',
    'x-request-id': requestId, 'x-content-type-options':'nosniff', connection:'close' });
  res.end(method === 'HEAD' ? undefined : `${error instanceof HttpError ? error.message : 'Internal server error'}\n`);
  return status;
}
