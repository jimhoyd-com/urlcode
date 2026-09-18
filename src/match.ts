// Request-time routing. No Node built-ins and no filesystem: the same matching
// runs in the self-hosted server, in a provider adapter, and in a Web-standard
// runtime consuming a compiled artifact. Compile-time route building lives in
// router.ts, which imports from here.
import { HttpError } from './errors.ts';

export type ParameterLocation = 'path' | 'query' | 'header';
export type ScalarType = 'string' | 'integer' | 'number' | 'boolean';
export type Scalar = string | number | boolean;
/** A parsed scalar, a parsed array, or a schema default (which the schema may shape freely). */
export type ParameterValue = Scalar | Scalar[] | unknown;
export interface ParameterSchema { type: ScalarType | 'array'; items?: { type: ScalarType }; default?: unknown; [keyword: string]: unknown }
export interface CompiledParameter {
  name: string; in: ParameterLocation; required: boolean; schema: ParameterSchema;
  validate: (value: unknown) => boolean;
}
/** A value taken from a request input or a binding when a redirect is assembled. */
export interface ValueRef { from?: ParameterLocation; name?: string; env?: string; secret?: string }
export interface RedirectSpec { url: string; query?: { map?: Record<string, ValueRef | Scalar>; pass?: string[] } }
/** The part of a compiled route that request-time matching reads. router.ts widens it. */
export interface MatchableRoute {
  pattern: string; parts: string[]; prefix?: string; extension?: string; parameters: CompiledParameter[];
  env: Record<string, string>; secrets: Record<string, string>; redirect?: RedirectSpec;
}
export interface CompiledRoutes<R extends MatchableRoute = MatchableRoute> { exact: Map<string, R>; byLength: Map<number, R[]>; mounts: R[] }
export interface Target { path: string; parts: string[]; query: URLSearchParams }
export interface Match<R extends MatchableRoute = MatchableRoute> { route: R; path: Record<string, string> }
export interface Inputs { path: Record<string, string>; query: Record<string, ParameterValue>; header: Record<string, ParameterValue> }
export interface RequestContext { inputs: Inputs; env: Record<string, string>; secrets: Record<string, string> }
/** The subset of Headers both a node:http-derived map and the Fetch Headers class provide. */
export interface HeadersLike { has(name: string): boolean; get(name: string): string | null | undefined }

const own = (obj: object, key: string): boolean => Object.hasOwn(obj, key);
const dict = <T,>(): Record<string, T> => Object.create(null) as Record<string, T>;
export function parameterName(segment: string): string | null { return segment.startsWith('{') ? segment.slice(1, -1) : null; }
export function resolveValue(ref: ValueRef | Scalar | null | undefined, context: RequestContext): ParameterValue {
  if (typeof ref !== 'object' || ref === null) return ref;
  if (ref.from) return context.inputs[ref.from][ref.from === 'header' ? ref.name!.toLowerCase() : ref.name!];
  if (ref.env) return context.env[ref.env];
  if (ref.secret) return context.secrets[ref.secret];
  return undefined;
}
export function parseTarget(target: string): Target {
  if (target.length > 8192) throw new HttpError(414, 'URI too long');
  if (!target.startsWith('/') || target.startsWith('//') || /[\u0000-\u0020\u007f\\#]/u.test(target)) throw new HttpError(400, 'Invalid request target');
  const [rawPath = '', query = ''] = target.split(/\?(.*)/s);
  if (/%(?![0-9a-f]{2})/i.test(target) || /%(?:2f|5c)/i.test(rawPath)) throw new HttpError(400, 'Invalid URL encoding');
  let path: string;
  try { path = decodeURIComponent(rawPath); decodeURIComponent(query.replace(/\+/g,' ')); } catch { throw new HttpError(400, 'Invalid URL encoding'); }
  if (/[\u0000-\u001f\u007f\\]/u.test(path)) throw new HttpError(400, 'Invalid path');
  const parts = path.split('/').slice(1);
  if (parts.length > 32 || parts.some(p => p === '.' || p === '..')) throw new HttpError(400, 'Invalid path');
  return { path, parts, query: new URLSearchParams(query) };
}
export function matchRoute<R extends MatchableRoute>(compiled: CompiledRoutes<R>, target: Target): Match<R> | null {
  const exact = compiled.exact.get(target.path);
  if (exact) return { route: exact, path: dict() };
  for (const route of compiled.byLength.get(target.parts.length) || []) {
    const path = dict<string>();
    if (route.parts.every((p,i) => {
      const name = parameterName(p);
      const actual = target.parts[i]!;
      if (name) { path[name] = actual; return actual.length > 0; }
      return p === actual;
    })) return { route, path };
  }
  for (const route of compiled.mounts) if (route.prefix !== undefined && (target.path.startsWith(route.prefix)||(route.extension&&target.path===route.prefix.slice(0,-1)))) return { route, path: dict() };
  return null;
}
function scalar(value: string, type: ScalarType): Scalar {
  if (type === 'string') return value;
  if (type === 'boolean') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  } else {
    const re = type === 'integer' ? /^-?(?:0|[1-9]\d*)$/ : /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
    if (re.test(value)) {
      const n = Number(value);
      if (Number.isFinite(n) && (type !== 'integer' || Number.isSafeInteger(n))) return n;
    }
  }
  throw new HttpError(400, 'Invalid parameter');
}
export function contextFor(route: MatchableRoute, path: Record<string, string>, query: URLSearchParams, headers: HeadersLike, headerCounts: Record<string, number> = {}): RequestContext {
  const inputs: Inputs = { path: dict(), query: dict(), header: dict() };
  for (const p of route.parameters) {
    const raw: string[] = p.in === 'path' ? [path[p.name]!] : p.in === 'query' ? query.getAll(p.name) : headers.has(p.name) ? [headers.get(p.name)!] : [];
    if (p.in === 'header' && (headerCounts[p.name] ?? 0) > 1) throw new HttpError(400, 'Duplicate scalar parameter');
    let value: ParameterValue;
    if (!raw.length) {
      if (own(p.schema, 'default')) value = structuredClone(p.schema.default);
      else if (p.required) throw new HttpError(400, 'Missing required parameter');
      else continue;
    } else if (p.schema.type === 'array') {
      if (raw.length > 100) throw new HttpError(400, 'Too many parameter values');
      const itemType = p.schema.items!.type;
      value = raw.map(v => scalar(v, itemType));
    } else {
      if (raw.length !== 1) throw new HttpError(400, 'Duplicate scalar parameter');
      value = scalar(raw[0]!, p.schema.type);
    }
    if (!p.validate(value)) throw new HttpError(400, 'Invalid parameter');
    (inputs[p.in] as Record<string, ParameterValue>)[p.name] = value;
  }
  return { inputs, env: route.env, secrets: route.secrets };
}
// The router accepts a placeholder only for a declared path input, and a path
// input always matches a segment, so the '' fallback is unreachable through a
// compiled route; it keeps a direct call with an undeclared name from writing
// the text "undefined" into the location.
export function redirectLocation(route: MatchableRoute & { redirect: RedirectSpec }, context: RequestContext, query: URLSearchParams): string {
  const location = new URL(route.redirect.url.replace(/\{([^}]+)\}/g, (_m, name: string) => encodeURIComponent(context.inputs.path[name] ?? '')));
  function append(key: string, value: ParameterValue): void {
    if (value === undefined) return;
    for (const item of Array.isArray(value) ? value : [value]) location.searchParams.append(key, String(item));
  }
  for (const [key, ref] of Object.entries(route.redirect.query?.map || {})) append(key, resolveValue(ref, context));
  for (const key of route.redirect.query?.pass || []) {
    if (own(context.inputs.query, key)) append(key, context.inputs.query[key]);
    else for (const value of query.getAll(key)) append(key,value);
  }
  if (location.href.length > 16384) throw new HttpError(400, 'Redirect URL too long');
  return location.href;
}
