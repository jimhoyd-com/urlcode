import { assert, HttpError } from './errors.ts';

/** Bounded conjunction of exact string comparisons; no regex or implicit detection. */
export interface RouteMatch {
  query?: Record<string, string>; headers?: Record<string, string>; cookies?: Record<string, string>;
  host?: string; method?: string;
}
export interface ConditionRequest { query: URLSearchParams; headers: Headers; method: string; origin: string; headerCounts?: Record<string, number> | undefined }
const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
export function normalizeMatch(match: RouteMatch): RouteMatch {
  assert(match && typeof match === 'object' && !Array.isArray(match), 'match must be an object');
  assert(Object.keys(match).length > 0 && Object.keys(match).every(key => ['query','headers','cookies','host','method'].includes(key)), 'Unsupported or empty match');
  const normalized: RouteMatch = {};
  for (const group of ['query','headers','cookies'] as const) if (match[group] !== undefined) {
    assert(match[group] !== null && typeof match[group] === 'object' && !Array.isArray(match[group]), `match.${group} must be an object`);
    const fields = Object.entries(match[group]);
    assert(fields.length > 0 && fields.length <= 16, `match.${group} requires 1–16 entries`);
    const values: Record<string,string> = Object.create(null) as Record<string,string>;
    for (const [name,value] of fields) {
      const key = group === 'headers' ? name.toLowerCase() : name;
      assert(token.test(key) && key.length <= 128 && !Object.hasOwn(values,key), `Invalid or duplicate match.${group} name`);
      assert(typeof value === 'string' && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value), `Invalid match.${group} value`);
      if (group === 'headers') assert(!['host','cookie','authorization','proxy-authorization','connection','transfer-encoding','content-length','keep-alive','proxy-authenticate','te','trailer','upgrade'].includes(key), 'Use match.host/cookies; credential and transport headers cannot be conditions');
      if (group === 'cookies') assert(!/[;,\s"\\]/.test(value), 'Cookie conditions use unquoted wire values');
      values[key] = value;
    }
    normalized[group] = values;
  }
  if (match.method !== undefined) {
    assert(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(match.method), 'Invalid match.method');
    normalized.method = match.method;
  }
  if (match.host !== undefined) {
    assert(typeof match.host === 'string' && match.host.length <= 255 && /^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(match.host), 'match.host must be a literal host with optional port');
    const url = new URL('https://' + match.host);
    assert(url.host === match.host.toLowerCase(), 'match.host must be a canonical authority');
    normalized.host = url.host;
  }
  assert(Object.keys(normalized).length > 0, 'Empty match');
  return normalized;
}
function equalities(match: RouteMatch): Map<string,string> {
  const values = new Map<string,string>();
  for (const group of ['query','headers','cookies'] as const) for (const [name,value] of Object.entries(match[group] ?? {})) values.set(`${group}:${name}`,value);
  if (match.host) values.set('host',match.host);
  if (match.method) values.set('method',match.method);
  return values;
}
/** Cases must be disjoint: at least one shared fact must demand different values. */
export function assertDisjointMatches(matches: RouteMatch[]): void {
  assert(Array.isArray(matches) && matches.length >= 1 && matches.length <= 16, 'Conditional routes require 1–16 cases');
  const facts = matches.map(normalizeMatch).map(equalities);
  for (let i = 0; i < facts.length; i++) for (let j = i + 1; j < facts.length; j++) {
    assert([...facts[i]!].some(([key,value]) => facts[j]!.has(key) && facts[j]!.get(key) !== value), `Conditional cases ${i + 1} and ${j + 1} overlap`);
  }
}
export function matchesRoute(match: RouteMatch, request: ConditionRequest): boolean {
  if (match.method && match.method !== request.method) return false;
  // The operator's origin is authoritative, never forwarded/client Host text.
  if (match.host && new URL(request.origin).host !== match.host) return false;
  for (const [name,value] of Object.entries(match.query ?? {})) {
    const actual = request.query.getAll(name);
    if (actual.length > 1) throw new HttpError(400,'Duplicate condition query input');
    if (actual.length !== 1 || actual[0] !== value) return false;
  }
  for (const [name,value] of Object.entries(match.headers ?? {})) {
    if ((request.headerCounts?.[name] ?? 0) > 1) throw new HttpError(400,'Duplicate condition header input');
    if (request.headers.get(name) !== value) return false;
  }
  if (match.cookies) {
    const raw = request.headers.get('cookie') ?? '';
    if (raw.length > 8192) throw new HttpError(400,'Cookie conditions exceed input limit');
    const values = new Map<string,string[]>();
    for (const part of raw.split(';')) {
      const index = part.indexOf('=');
      if (index < 0) continue;
      const name = part.slice(0,index).trim(), value = part.slice(index + 1).trim();
      if (!Object.hasOwn(match.cookies,name)) continue;
      const entries = values.get(name) ?? []; entries.push(value); values.set(name,entries);
    }
    for (const [name,value] of Object.entries(match.cookies)) {
      const actual = values.get(name) ?? [];
      if (actual.length > 1) throw new HttpError(400,'Duplicate condition cookie input');
      if (actual.length !== 1 || actual[0] !== value) return false;
    }
  }
  return true;
}
