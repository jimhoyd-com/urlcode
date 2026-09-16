import { compileHttp } from './http-policy.js';
import Ajv from 'ajv/dist/2020.js';
import { assert, HttpError } from './errors.js';
import { functionFile } from './config.js';

const methodsDefault = ['GET', 'HEAD'];
const token = /^[A-Za-z_][A-Za-z0-9_]*$/;
const own = (obj, key) => Object.hasOwn(obj, key);
const dict = () => Object.create(null);
function inputValidator(schema, ajv, validators) {
  const { default: _default, ...shape } = schema;
  const key = JSON.stringify(shape);
  if (!validators.has(key)) {
    assert(validators.size < 1024, 'Maximum 1024 distinct input schemas per snapshot');
    validators.set(key, ajv.compile(shape));
  }
  return validators.get(key);
}
function segments(pattern) {
  assert(pattern.startsWith('/') && !/[?#%\\\s\u0000-\u001f\u007f]/u.test(pattern), 'Route must be a literal absolute path with optional whole-segment {parameters}');
  const parts = pattern.split('/').slice(1);
  assert(parts.length <= 32 && pattern.length <= 2048, 'Route exceeds path limits');
  for (const part of parts) {
    assert(part !== '.' && part !== '..', 'Dot path segments are unsupported');
    if (part.includes('{') || part.includes('}')) assert(/^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(part), 'Invalid route parameter');
  }
  return parts;
}
function parameterName(segment) { return segment.startsWith('{') ? segment.slice(1, -1) : null; }
function referenceCheck(ref, route, allowBindings = false) {
  if (typeof ref !== 'object' || ref === null) return;
  if (ref.from) assert(route.parameters.some(p => p.in === ref.from && p.name === (ref.from === 'header' ? ref.name.toLowerCase() : ref.name)), 'Reference uses undeclared input');
  else if (ref.env && allowBindings) assert(own(route.env, ref.env), 'Reference uses undeclared environment alias');
  else if (ref.secret && allowBindings) assert(own(route.secrets, ref.secret), 'Reference uses undeclared secret alias');
  else assert(false, 'Invalid argument reference');
}
export function resolveValue(ref, context) {
  if (typeof ref !== 'object' || ref === null) return ref;
  if (ref.from) return context.inputs[ref.from][ref.from === 'header' ? ref.name.toLowerCase() : ref.name];
  if (ref.env) return context.env[ref.env];
  if (ref.secret) return context.secrets[ref.secret];
}
export async function compileRoutes(loaded, bindings, permissions = {}, projectSha256) {
  const exact = new Map(), dynamic = [], mounts = [], modules = new Map();
  const ajv = new Ajv({ strict: false, allErrors: false }), validators = new Map();
  for (const [pattern, config] of Object.entries(loaded.routes)) {
    const parts = segments(pattern);
    assert(!pattern.startsWith('/_urlcode'), 'The /_urlcode prefix is reserved for runtime operations');
    const names = parts.map(parameterName).filter(Boolean);
    assert(!pattern.includes('*') || (config.static && pattern.endsWith('/*') && parts.filter(p => p.includes('*')).length === 1 && parts.at(-1) === '*' && !names.length), 'Only static routes support a terminal /* wildcard');
    assert(!config.static || pattern.endsWith('/*'), 'Static routes require a terminal /* wildcard');
    if (config.page || config.download || config.static) assert((config.methods || methodsDefault).every(m => methodsDefault.includes(m)), 'Asset routes support only GET and HEAD');
    assert(new Set(names).size === names.length, 'Duplicate path parameter');
    const route = { ...config, pattern, parts, names, specificity: parts.length - names.length,
      methods: config.methods || methodsDefault, parameters: [], env: dict(), secrets: dict() };
    compileHttp(route);
    const seen = new Set();
    for (const param of config.parameters || []) {
      const p = { ...param, name: param.in === 'header' ? param.name.toLowerCase() : param.name };
      assert(!seen.has(`${p.in}:${p.name}`), 'Duplicate parameter declaration');
      seen.add(`${p.in}:${p.name}`);
      assert(p.in !== 'path' || (names.includes(p.name) && p.required === true && p.schema.type === 'string'), 'Path parameters must be declared required strings');
      assert(p.schema.type !== 'array' || (p.in === 'query' && p.schema.items), 'Only query arrays with scalar items are supported');
      assert(p.schema.type === 'array' || !p.schema.items, 'items requires array input');
      assert(p.in !== 'path' || !own(p.schema, 'default'), 'Path parameters cannot have defaults');
      assert(!['minLength','maxLength'].some(k => own(p.schema,k)) || p.schema.type === 'string', 'String bounds require string type');
      assert(!['minimum','maximum'].some(k => own(p.schema,k)) || ['integer','number'].includes(p.schema.type), 'Numeric bounds require numeric type');
      assert(!own(p.schema,'maxItems') || p.schema.type === 'array', 'maxItems requires array type');
      p.validate = inputValidator(p.schema, ajv, validators);
      if (own(p.schema, 'default')) assert(p.validate(p.schema.default), 'Invalid parameter default');
      route.parameters.push(p);
    }
    assert(names.every(name => route.parameters.some(p => p.in === 'path' && p.name === name)), 'Every path placeholder requires an input declaration');
    for (const [alias, ref] of Object.entries(config.env || {})) {
      if (ref.env) assert(permissions.projectSha256 === projectSha256 && permissions.routes?.[pattern]?.env?.includes(ref.env), 'Environment binding denied by operator policy');
      const value = own(ref, 'value') ? ref.value : bindings[ref.env];
      assert(typeof value === 'string', 'Missing required environment binding');
      route.env[alias] = value;
    }
    for (const [alias, ref] of Object.entries(config.secrets || {})) {
      assert(permissions.projectSha256 === projectSha256 && permissions.routes?.[pattern]?.secrets?.includes(ref.secret), 'Secret binding denied by operator policy');
      assert(typeof bindings[ref.secret] === 'string' && bindings[ref.secret].length, 'Missing required secret binding');
      route.secrets[alias] = bindings[ref.secret];
    }
    if (config.expires) {
      assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(config.expires) && Number.isFinite(Date.parse(config.expires)), 'Expiry must be a UTC ISO timestamp');
      route.expiresAt = Date.parse(config.expires);
      assert(new Date(route.expiresAt).toISOString().replace('.000Z','Z') === config.expires.replace('.000Z','Z'), 'Invalid calendar expiry');
    }
    if (config.redirect) {
      const value = config.redirect.url;
      assert(!/[\u0000-\u0020\u007f\\]/u.test(value), 'Redirect URL contains unsafe characters');
      let dest;
      try { dest = new URL(value); } catch { assert(false, 'Redirect URL must be absolute HTTP(S)'); }
      assert(['http:', 'https:'].includes(dest.protocol) && !dest.username && !dest.password, 'Redirect must use HTTP(S) without credentials');
      const authority = value.match(/^https?:\/\/([^/?#]+)/i)?.[1];
      assert(authority && !/[{}]/.test(authority) && !/[{}]/.test(dest.search + dest.hash), 'Redirect placeholders are allowed only in path segments');
      const placeholders = [...value.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
      assert(placeholders.every(n => token.test(n) && names.includes(n)), 'Redirect placeholder must reference a declared path input');
      assert(!/[{}]/.test(value.replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, '')), 'Invalid redirect placeholder');
      const query = config.redirect.query || {};
      const reserved = new Set(dest.searchParams.keys());
      for (const [key, ref] of Object.entries(query.map || {})) {
        assert(!reserved.has(key), 'Redirect query mapping conflicts with destination');
        reserved.add(key); referenceCheck(ref, route);
      }
      for (const key of query.pass || []) assert(!reserved.has(key), 'Query passthrough conflicts with destination or mapping');
    }
    if (config.function) {
      const source = await functionFile(loaded.root, config.function.source);
      modules.set(source, true);
      route.function = { ...config.function, source, export: config.function.export || 'default' };
      for (const ref of Object.values(config.function.args || {})) referenceCheck(ref, route, true);
    }
    if (config.static) { route.prefix = pattern.slice(0, -1); mounts.push(route); }
    else if (!names.length) exact.set(pattern, route);
    else {
      assert(dynamic.length < 1000, 'Maximum 1000 parameterized routes in the alpha');
      for (const existing of dynamic) {
        if (existing.parts.length === parts.length && existing.specificity === route.specificity) {
          assert(!parts.every((p, i) => p === existing.parts[i] || parameterName(p) || parameterName(existing.parts[i])), 'Equally specific parameterized routes overlap');
        }
      }
      dynamic.push(route);
    }
  }
  dynamic.sort((a, b) => b.specificity - a.specificity);
  // Index parameter routes by segment count; exact paths take the O(1) fast path.
  const byLength = new Map();
  for (const route of dynamic) {
    if (!byLength.has(route.parts.length)) byLength.set(route.parts.length, []);
    byLength.get(route.parts.length).push(route);
  }
  mounts.sort((a,b) => b.prefix.length - a.prefix.length);
  return { exact, byLength, mounts, modules: [...modules.keys()], count: exact.size + dynamic.length + mounts.length };
}
export function parseTarget(target) {
  if (!target.startsWith('/') || target.startsWith('//') || target.length > 8192 || /[\u0000-\u0020\u007f\\#]/u.test(target)) throw new HttpError(400, 'Invalid request target');
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
