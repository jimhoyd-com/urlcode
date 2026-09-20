import { validateHeaderName, validateHeaderValue } from './header-validation.ts';
import { assert, HttpError } from './errors.ts';
import type { HandlerResult, HeaderPair } from './http-response.ts';
import type { HeadersLike } from './match.ts';
import { assertBodySchema, checkBodySchema } from './body-schema.ts';
import type { BodySchema } from './body-schema.ts';

export interface RespondSpec { status?: number; json?: unknown; text?: string }
export interface RequestBodyPolicy { maxBytes?: number; required?: boolean; contentTypes?: string[]; format?: 'json' | 'text'; schema?: BodySchema }
/** A static reply compiled from `respond`; the body is bytes so every host, including the Worker, shares the type. */
export interface Reply { status: number; headers: HeaderPair[]; body: Uint8Array }
/** The declared HTTP surface of a route: response headers, request body policy and a static reply. */
export interface HttpRoute {
  response?: { headers?: Record<string, string | string[]> };
  request?: { body?: RequestBodyPolicy };
  respond?: RespondSpec; page?: unknown; static?: unknown; download?: unknown;
  responseHeaders?: HeaderPair[]; reply?: Reply | undefined;
}

const encoder = new TextEncoder();
const byteLength = (value: string): number => encoder.encode(value).length;

export const reservedResponseHeaders = new Set(['connection','keep-alive','transfer-encoding','content-length','upgrade','trailer','proxy-authenticate','proxy-authorization','te','location','allow','content-range','accept-ranges','etag','last-modified','content-encoding','x-request-id','x-content-type-options']);
export function compileHttp(route: HttpRoute): void {
  const seen = new Set<string>(); let size = 0;
  const responseHeaders: HeaderPair[] = route.responseHeaders = [];
  for (const [name,value] of Object.entries(route.response?.headers || {})) {
    const key = name.toLowerCase();
    assert(!seen.has(key), 'Duplicate response header (case insensitive)'); seen.add(key);
    assert(!reservedResponseHeaders.has(key), 'Response header is owned by the runtime or handler');
    assert(!Array.isArray(value) || key === 'set-cookie', 'Only Set-Cookie supports a header array');
    assert(!(route.page || route.static || route.download) || !['content-type','content-disposition','cache-control'].includes(key), 'Configure asset metadata on its handler');
    for (const item of Array.isArray(value) ? value : [value]) {
      try { validateHeaderName(name); validateHeaderValue(name,item); } catch { assert(false,'Invalid response header'); }
      assert(!/[\u0000-\u001f\u007f]/u.test(item), 'Control characters in response header');
      size += Buffer.byteLength(name + item);
      responseHeaders.push([key,item]);
    }
  }
  assert(size <= 16384, 'Response headers exceed 16 KiB');
  const bodySchema = route.request?.body?.schema;
  if (bodySchema !== undefined) {
    assert(route.request?.body?.format === 'json', 'request.body.schema requires format json');
    assertBodySchema(bodySchema);
  }
  if (route.respond) {
    const status = route.respond.status ?? 200;
    assert(![206,304].includes(status), 'Use native asset handlers for partial/conditional responses');
    const json = Object.hasOwn(route.respond,'json');
    const body = Buffer.from(json ? JSON.stringify(route.respond.json) : route.respond.text || '');
    assert(body.length <= 1048576, 'Declared response exceeds 1 MiB');
    assert(![204,205].includes(status) || body.length === 0, '204/205 responses cannot declare a body');
    if (json) assert(!responseHeaders.some(([key,value]) => key === 'content-type' && !/^application\/(?:[\w.+-]+\+)?json(?:;|$)/i.test(value)), 'JSON response requires a JSON content type');
    route.reply = { status, headers: [['content-type',json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8']], body };
  }
}
export function checkRequest(route: HttpRoute, body: Uint8Array, headers: HeadersLike, counts: Record<string, number> = {}): void {
  const policy = route.request?.body;
  if (!policy) return;
  if (body.length > (policy.maxBytes ?? 1048576)) throw new HttpError(413,'Request body too large');
  if (!body.length) { if (policy.required) throw new HttpError(400,'Request body required'); return; }
  if ((counts['content-type'] ?? 0) > 1) throw new HttpError(400,'Duplicate Content-Type');
  if (headers.has('content-encoding') && headers.get('content-encoding')!.toLowerCase() !== 'identity') throw new HttpError(415,'Unsupported content encoding');
  const type = (headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase();
  if (policy.contentTypes && !policy.contentTypes.includes(type)) throw new HttpError(415,'Unsupported media type');
  if (policy.format) {
    let text: string;
    try { text = new TextDecoder('utf-8',{fatal:true}).decode(body); } catch { throw new HttpError(400,'Body must be UTF-8'); }
    if (policy.format === 'json') {
      if (!/^application\/(?:[\w.+-]+\+)?json$/.test(type)) throw new HttpError(415,'Expected JSON media type');
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new HttpError(400,'Invalid JSON body'); }
      if (policy.schema) {
        const failures = checkBodySchema(policy.schema, parsed);
        if (failures.length) throw new HttpError(422,`Request body failed validation\n${failures.join('\n')}`);
      }
    }
  }
}
export function decorateResponse(route: HttpRoute & { responseHeaders: HeaderPair[] }, result: HandlerResult): HandlerResult {
  if (!route.responseHeaders.length) return result;
  const replaced = new Set(route.responseHeaders.map(([key]) => key));
  const headers = [...result.headers.filter(([key]) => !replaced.has(key.toLowerCase())), ...route.responseHeaders];
  if (headers.reduce((n,[key,value]) => n + byteLength(key + value),0) > 16384 || headers.length > 256) throw new HttpError(502,'Response headers too large');
  return {...result,headers};
}
