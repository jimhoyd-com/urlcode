import { validateHeaderName, validateHeaderValue } from './header-validation.ts';
import { assert, HttpError } from './errors.ts';
import { byteLength } from './http-response.ts';
import type { HandlerResult, HeaderPair } from './http-response.ts';
import type { HeadersLike } from './match.ts';
import { assertBodySchema, bodyIssues, bodySchemaLine, bodySchemaJson, bodySchemaEnvelope, maxRequestBodyBytes } from './body-validation.ts';
import type { BodySchema, CompiledBodySchema } from './body-validation.ts';

export interface RespondSpec { status?: number; json?: unknown; text?: string }
export interface RequestBodyPolicy { maxBytes?: number; required?: boolean; contentTypes?: string[]; format?: 'json' | 'text'; schema?: BodySchema }
/**
 * `request.body`: one policy per HTTP method, keyed by an uppercase method the route declares (the OpenAPI shape:
 * each operation has its own request body). A method without an entry has no body policy (docs/HTTP.md).
 */
export type RequestBodyPolicies = Partial<Record<string, RequestBodyPolicy>>;
/**
 * Methods whose request content has no generally defined semantics (RFC 9110 sections 9.3.1, 9.3.2, 9.3.5): their
 * entry may only bound or forbid a body with `maxBytes`, never require, type or validate one.
 */
export const bodylessMethods: readonly string[] = ['GET', 'HEAD', 'DELETE'];
/** The body policy `method` has on `route`, if any. */
export function bodyPolicy(route: { request?: { body?: RequestBodyPolicies } }, method: string): RequestBodyPolicy | undefined {
  const policies = route.request?.body;
  return policies && Object.hasOwn(policies, method) ? policies[method] : undefined;
}
/** A static reply compiled from `respond`; the body is bytes so every host, including the Worker, shares the type. */
export interface Reply { status: number; headers: HeaderPair[]; body: Uint8Array }
/** The declared HTTP surface of a route: response headers, request body policy and a static reply. */
export interface HttpRoute {
  response?: { headers?: Record<string, string | string[]> };
  /** The methods the route answers; `request.body` keys must be among them. Defaults to GET and HEAD. */
  methods?: string[];
  request?: { body?: RequestBodyPolicies };
  respond?: RespondSpec; page?: unknown; static?: unknown; download?: unknown;
  responseHeaders?: HeaderPair[]; reply?: Reply | undefined;
  /**
   * Each method's compiled `request.body.<METHOD>.schema`, attached by the host that loaded the route: Ajv at load
   * time on Node (router.ts), the build's standalone validators on the Worker (cloudflare.ts). Never serialised.
   */
  bodySchemas?: Partial<Record<string, CompiledBodySchema>> | undefined;
}

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
  const methods = route.methods ?? ['GET', 'HEAD'];
  for (const [method, policy] of Object.entries(route.request?.body ?? {})) {
    assert(methods.includes(method), `request.body.${method}: ${method} is not one of the route's methods`);
    if (!policy) continue;
    if (bodylessMethods.includes(method)) {
      const extra = Object.keys(policy).find(key => key !== 'maxBytes');
      assert(extra === undefined, `request.body.${method}.${extra}: a ${method} body has no defined meaning (RFC 9110), so its entry may only set maxBytes`);
    }
    if (policy.schema !== undefined) {
      assert(policy.format === 'json', `request.body.${method}.schema requires format json`);
      assertBodySchema(policy.schema);
    }
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
export function checkRequest(route: HttpRoute, method: string, body: Uint8Array, headers: HeadersLike, counts: Record<string, number> = {}): void {
  const policy = bodyPolicy(route, method);
  if (!policy) return;
  if (body.length > (policy.maxBytes ?? maxRequestBodyBytes)) throw new HttpError(413,'Request body too large');
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
        // A declared schema that no host compiled is a runtime defect, never a reason to skip validation.
        const compiled = route.bodySchemas?.[method];
        if (!compiled) throw new Error(`request.body.${method}.schema was not compiled for this route`);
        const issues = bodyIssues(compiled, parsed);
        if (issues.length) {
          const text = `Request body failed validation\n${issues.map(bodySchemaLine).join('\n')}`;
          // A route that declares a JSON body schema is a JSON endpoint: its 422 is always JSON, listing its bounded issues.
          throw new HttpError(422, text, { contentType: 'application/json', text: bodySchemaJson(issues), envelope: bodySchemaEnvelope(issues) });
        }
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
