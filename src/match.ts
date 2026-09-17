// Request-time routing. No Node built-ins and no filesystem: the same matching
// runs in the self-hosted server, in a provider adapter, and in a Web-standard
// runtime consuming a compiled artifact. Compile-time route building lives in
// router.js, which imports from here.
import { HttpError } from './errors.ts';

const own = (obj, key) => Object.hasOwn(obj, key);
const dict = () => Object.create(null);
export function parameterName(segment) { return segment.startsWith('{') ? segment.slice(1, -1) : null; }
export function resolveValue(ref, context) {
  if (typeof ref !== 'object' || ref === null) return ref;
  if (ref.from) return context.inputs[ref.from][ref.from === 'header' ? ref.name.toLowerCase() : ref.name];
  if (ref.env) return context.env[ref.env];
  if (ref.secret) return context.secrets[ref.secret];
}
export function parseTarget(target) {
  if (target.length > 8192) throw new HttpError(414, 'URI too long');
  if (!target.startsWith('/') || target.startsWith('//') || /[\u0000-\u0020\u007f\\#]/u.test(target)) throw new HttpError(400, 'Invalid request target');
  const [rawPath, query = ''] = target.split(/\?(.*)/s);
  if (/%(?![0-9a-f]{2})/i.test(target) || /%(?:2f|5c)/i.test(rawPath)) throw new HttpError(400, 'Invalid URL encoding');
  let path;
  try { path = decodeURIComponent(rawPath); decodeURIComponent(query.replace(/\+/g,' ')); } catch { throw new HttpError(400, 'Invalid URL encoding'); }
  if (/[\u0000-\u001f\u007f\\]/u.test(path)) throw new HttpError(400, 'Invalid path');
  const parts = path.split('/').slice(1);
  if (parts.length > 32 || parts.some(p => p === '.' || p === '..')) throw new HttpError(400, 'Invalid path');
  return { path, parts, query: new URLSearchParams(query) };
}
export function matchRoute(compiled, target) {
  const exact = compiled.exact.get(target.path);
  if (exact) return { route: exact, path: dict() };
  for (const route of compiled.byLength.get(target.parts.length) || []) {
    const path = dict();
    if (route.parts.every((p,i) => {
      const name = parameterName(p);
      if (name) { path[name] = target.parts[i]; return target.parts[i].length > 0; }
      return p === target.parts[i];
    })) return { route, path };
  }
  for (const route of compiled.mounts) if (target.path.startsWith(route.prefix)) return { route, path: dict() };
  return null;
}
function scalar(value, type) {
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
export function contextFor(route, path, query, headers, headerCounts = {}) {
  const inputs = { path: dict(), query: dict(), header: dict() };
  for (const p of route.parameters) {
    const raw = p.in === 'path' ? [path[p.name]] : p.in === 'query' ? query.getAll(p.name) : headers.has(p.name) ? [headers.get(p.name)] : [];
    if (p.in === 'header' && headerCounts[p.name] > 1) throw new HttpError(400, 'Duplicate scalar parameter');
    let value;
    if (!raw.length) {
      if (own(p.schema, 'default')) value = structuredClone(p.schema.default);
      else if (p.required) throw new HttpError(400, 'Missing required parameter');
      else continue;
    } else if (p.schema.type === 'array') {
      if (raw.length > 100) throw new HttpError(400, 'Too many parameter values');
      value = raw.map(v => scalar(v, p.schema.items.type));
    } else {
      if (raw.length !== 1) throw new HttpError(400, 'Duplicate scalar parameter');
      value = scalar(raw[0], p.schema.type);
    }
    if (!p.validate(value)) throw new HttpError(400, 'Invalid parameter');
    inputs[p.in][p.name] = value;
  }
  return { inputs, env: route.env, secrets: route.secrets };
}
export function redirectLocation(route, context, query) {
  const location = new URL(route.redirect.url.replace(/\{([^}]+)\}/g, (_m, name) => encodeURIComponent(context.inputs.path[name])));
  function append(key, value) {
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
