import { effectiveExtensionPolicies, isSensitiveExtensionPolicy } from './extensions.ts';
import type { RuntimeExtension } from './extensions.ts';
import { validateProxy } from './proxy.ts';
import { validateSignal } from './signals.ts';
import type { EgressHeaders } from './types.ts';
import { normalizeMatch, assertDisjointMatches } from './conditions.ts';
import { effectivePolicies } from './policies.ts';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { compileHttp } from './http-policy.ts';
import { assertSafePattern, maxPatternInputLength } from './pattern-guard.ts';
import { uuidFormat } from './body-schema.ts';
import Ajv from 'ajv/dist/2020.js';
import { assert, revisionPinHint, routeError } from './errors.ts';
import { functionFile } from './config.ts';
import { parameterName } from './match.ts';
import type { CompiledParameter, ParameterSchema, Scalar, ValueRef } from './match.ts';
import type { CompiledRedirect, CompiledRoute, CompiledRouteTable, LoadedDocument, RedirectConfig } from './types.ts';
// Re-exported so existing importers keep one entry point for routing.
export { parseTarget, matchRoute, contextFor, resolveValue, redirectLocation } from './match.ts';

/** The grants compileRoutes consults: a validated OperatorPolicy (policy.ts) or nothing, which denies every binding. */
interface BindingPermissions { projectSha256?: string; routes?: Record<string, { env?: string[]; secrets?: string[] }> }
type Validator = CompiledParameter['validate'];
type AjvInstance = InstanceType<typeof Ajv.default>;

const grantHint = 'Run urlcode permissions to list what the project requests, then pass an operator policy that grants it with --policy <file> (kept outside the project; its projectSha256 must match the current project)';
const methodsDefault = ['GET', 'HEAD'];
const token = /^[A-Za-z_][A-Za-z0-9_]*$/;
const own = (obj: object, key: string): boolean => Object.hasOwn(obj, key);
const dict = (): Record<string, string> => Object.create(null) as Record<string, string>;
function inputValidator(schema: ParameterSchema, ajv: AjvInstance, validators: Map<string, Validator>): Validator {
  const { default: _default, ...shape } = schema;
  const key = JSON.stringify(shape);
  if (!validators.has(key)) {
    assert(validators.size < 1024, 'Maximum 1024 distinct input schemas per snapshot');
    validators.set(key, ajv.compile(shape));
  }
  return validators.get(key)!;
}
function segments(pattern: string): string[] {
  assert(pattern.startsWith('/') && !/[?#%\\\s\u0000-\u001f\u007f]/u.test(pattern), 'Route must be a literal absolute path with optional whole-segment {parameters}');
  const parts = pattern.split('/').slice(1);
  assert(parts.length <= 32 && pattern.length <= 2048, 'Route exceeds path limits');
  for (const part of parts) {
    assert(part !== '.' && part !== '..', 'Dot path segments are unsupported');
    // `/users/:id` is Express/Next syntax; it would otherwise be a literal segment that never matches `/users/42`.
    const express = /^:([A-Za-z_][A-Za-z0-9_]*)$/.exec(part)?.[1];
    assert(express === undefined, `Route segment :${express} is Express-style; write {${express}} and declare it under parameters: [{name: ${express}, in: path, required: true, schema: {type: string}}]`, { code: 'express-parameter' });
    if (part.includes('{') || part.includes('}')) assert(/^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(part), 'Invalid route parameter; a parameter is a whole segment such as {id}, using letters, digits and _');
  }
  return parts;
}
function referenceCheck(ref: ValueRef | Scalar | undefined, route: CompiledRoute, allowBindings = false): void {
  if (typeof ref !== 'object' || ref === null) return;
  if (ref.from) assert(route.parameters.some(p => p.in === ref.from && p.name === (ref.from === 'header' ? ref.name!.toLowerCase() : ref.name)), 'Reference uses undeclared input');
  else if (ref.env && allowBindings) assert(own(route.env, ref.env), 'Reference uses undeclared environment alias');
  else if (ref.secret && allowBindings) assert(own(route.secrets, ref.secret), 'Reference uses undeclared secret alias');
  else assert(false, 'Invalid argument reference');
}
// A declared `pass: false` reads as no passthrough, the same as leaving it
// out; dropping the key is what gives match.ts its RedirectSpec.
function compiledRedirect(redirect: RedirectConfig): CompiledRedirect {
  if (redirect.query?.pass !== false) return redirect as CompiledRedirect; // pass is string[] | undefined here; TypeScript cannot narrow through the optional query
  const { pass: _pass, ...query } = redirect.query;
  return { ...redirect, query };
}
export async function compileRoutes(loaded: LoadedDocument, bindings: Record<string, string | undefined>, permissions: BindingPermissions = {}, projectSha256?: string, extensions?: readonly Pick<RuntimeExtension,'name'|'cacheSensitive'>[]): Promise<CompiledRouteTable> {
  const deadline=performance.now()+10000;
  let processed=0;
  const exact = new Map<string, CompiledRoute>(), dynamic: CompiledRoute[] = [], mounts: CompiledRoute[] = [], modules = new Map<string, true>();
  // Node hands the CJS module.exports (the class) to a default import; TypeScript types it as the namespace, whose .default is the same class.
  const ajv = new Ajv.default({ strict: false, allErrors: false }), validators = new Map<string, Validator>();
  ajv.addFormat('uuid', uuidFormat);
  for (const [pattern, config] of Object.entries(loaded.routes)) {
    if (++processed % 64 === 0) await yieldTurn();
    assert(performance.now()<deadline, 'Route compilation deadline exceeded');
    try {
      const parts = segments(pattern);
      assert(!pattern.startsWith('/_urlcode'), 'The /_urlcode prefix is reserved for runtime operations');
      const names = parts.map(parameterName).filter((name): name is string => Boolean(name));
      // `/prefix/**` is the redirect-only suffix wildcard: a literal prefix, one terminal `**`, no path parameters.
      const wildcardRedirect = Boolean(config.redirect) && pattern.endsWith('/**');
      if (wildcardRedirect) assert(pattern !== '/**' && pattern.indexOf('*') === pattern.length - 2 && parts.at(-1) === '**' && !names.length && !config.conditional, 'A /** wildcard redirect needs a literal prefix, one terminal **, no path parameters and no conditional');
      assert(wildcardRedirect || !pattern.includes('*') || ((config.static || config.extension) && pattern.endsWith('/*') && parts.filter(p => p.includes('*')).length === 1 && parts.at(-1) === '*' && !names.length), 'Only static or extension routes support a terminal /* wildcard; a redirect uses a terminal /** instead');
      assert(!config.static || pattern.endsWith('/*'), `Static routes require a terminal /* wildcard; write ${pattern.replace(/\/+$/, '')}/*`);
      if (config.page || config.download || config.static) assert((config.methods || methodsDefault).every(m => methodsDefault.includes(m)), 'Asset routes support only GET and HEAD');
      assert(new Set(names).size === names.length, 'Duplicate path parameter');
      // `redirect` and `function` are re-attached below in their compiled shape.
      const { redirect: declaredRedirect, function: declaredFunction, ...declared } = config;
      const route: CompiledRoute = { ...declared, pattern, parts, names, specificity: parts.length - names.length,
        methods: config.methods || methodsDefault, parameters: [], env: dict(), secrets: dict(), responseHeaders: [], middleware: [] };
      if (config.coveredElsewhere) {
        const waived = Object.entries(config.coveredElsewhere);
        assert(waived.length > 0, 'coveredElsewhere must name at least one method');
        for (const [method, reason] of waived) {
          assert(route.methods.includes(method), `coveredElsewhere names ${method}, which is not one of the route's methods`);
          assert(typeof reason === 'string' && reason.trim().length > 0, `coveredElsewhere.${method} needs a non-empty reason`);
        }
      }
      compileHttp(route);
      if (config.match) route.match = normalizeMatch(config.match);
      if(config.extension){assert(!config.middleware?.length&&!config.parameters?.length&&!config.secrets,'Extension handlers cannot declare guest middleware, parameters or secrets');assert(pattern.endsWith('/*')&&!names.length&&pattern!=='/*','Extension handler requires a non-root literal /* mount');}
      const extensionPolicyNames = Object.keys(effectiveExtensionPolicies(loaded.document,config));
      if (config.match || config.conditional || config.extension || isSensitiveExtensionPolicy(extensionPolicyNames,extensions)) {
        const cache = effectivePolicies(loaded.document,config).cache;
        assert(!cache || cache.strategy === 'no-store', `${pattern}: conditional routing requires cache disabled or no-store`);
        assert(!route.responseHeaders.some(([name,value]) => ['cache-control','cdn-cache-control','vercel-cdn-cache-control','surrogate-control'].includes(name.toLowerCase()) && value !== 'no-store'), 'Conditional responses require no-store');
      }
      if (config.conditional) {
        const matches = config.conditional.cases.map(item => normalizeMatch(item.match));
        assertDisjointMatches(matches);
        const compileBranch = async (branch: { redirect?: RedirectConfig; respond?: import('./http-policy.ts').RespondSpec }) => {
          const entry = { ...branch, ...(config.parameters ? { parameters: config.parameters } : {}), ...(config.methods ? { methods: config.methods } : {}) };
          const table = await compileRoutes({ ...loaded, routes: { [pattern]: entry } }, {}, {});
          return table.exact.get(pattern) ?? [...table.byLength.values()].flat()[0]!;
        };
        route.conditionalRoutes = { cases: [] };
        for (const [index,item] of config.conditional.cases.entries()) {
          const { match: _match, ...branch } = item;
          route.conditionalRoutes.cases.push({ match: matches[index]!, route: await compileBranch(branch) });
        }
        if (config.conditional.fallback) route.conditionalRoutes.fallback = await compileBranch(config.conditional.fallback);
      }
      const seen = new Set<string>();
      for (const param of config.parameters || []) {
        const schema = param.schema, name = param.in === 'header' ? param.name.toLowerCase() : param.name;
        assert(!seen.has(`${param.in}:${name}`), 'Duplicate parameter declaration');
        seen.add(`${param.in}:${name}`);
        assert(param.in !== 'path' || (names.includes(name) && param.required === true && schema.type === 'string'), 'Path parameters must be declared required strings');
        assert(schema.type !== 'array' || (param.in === 'query' && schema.items), 'Only query arrays with scalar items are supported');
        assert(schema.type === 'array' || !schema.items, 'items requires array input');
        assert(param.in !== 'path' || !own(schema, 'default'), 'Path parameters cannot have defaults');
        assert(!['minLength','maxLength'].some(k => own(schema,k)) || schema.type === 'string', 'String bounds require string type');
        assert(!['minimum','maximum'].some(k => own(schema,k)) || ['integer','number'].includes(schema.type), 'Numeric bounds require numeric type');
        assert(!['pattern','format'].some(k => own(schema,k)) || schema.type === 'string', 'pattern and format require string type');
        assert(!own(schema,'format') || schema.format === 'uuid', 'Unsupported parameter format (supported: uuid)');
        if (own(schema,'pattern')) {
          assert(typeof schema.pattern === 'string', 'pattern must be a string'); assertSafePattern(schema.pattern);
          assert(typeof schema.maxLength === 'number' && schema.maxLength <= maxPatternInputLength, `pattern requires maxLength of at most ${maxPatternInputLength}`);
        }
        assert(!own(schema,'maxItems') || schema.type === 'array', 'maxItems requires array type');
        const p: CompiledParameter = { ...param, name, required: param.required === true, validate: inputValidator(schema, ajv, validators) };
        if (own(schema, 'default')) assert(p.validate(schema.default), 'Invalid parameter default');
        route.parameters.push(p);
      }
      const undeclared = names.find(name => !route.parameters.some(p => p.in === 'path' && p.name === name));
      assert(undeclared === undefined, `Every path placeholder requires an input declaration; {${undeclared}} has none. Add parameters: [{name: ${undeclared}, in: path, required: true, schema: {type: string}}]`, { code: 'undeclared-parameter' });
      for (const [alias, ref] of Object.entries(config.env || {})) {
        // `env` always requires an operator grant for that route/name. A missing grant is not
        // fatal when a `default` is declared: the binding just degrades to its literal default
        // and never reads the host (issue #258). With no `default`, a missing grant still fails
        // route compilation, as before. `value`-only bindings are plain literals and never
        // consult the grant or the host environment.
        let value: string | undefined;
        if (ref.env) {
          const granted = permissions.projectSha256 === projectSha256 && permissions.routes?.[pattern]?.env?.includes(ref.env);
          assert(granted || ref.default !== undefined, `Environment binding denied by operator policy${revisionPinHint(permissions.projectSha256, projectSha256) || `: ${alias} reads ${ref.env}, which no grant allows for this route. ${grantHint}; or declare a default`}`, { code: 'binding-denied' });
          const hostValue = bindings[ref.env];
          const hostSet = ref.default !== undefined ? typeof hostValue === 'string' && hostValue.length > 0 : hostValue !== undefined;
          value = granted ? (hostSet ? hostValue : ref.default) : ref.default;
        } else {
          value = ref.value;
        }
        assert(typeof value === 'string', 'Missing required environment binding');
        route.env[alias] = value;
      }
      for (const [alias, ref] of Object.entries(config.secrets || {})) {
        assert(permissions.projectSha256 === projectSha256 && permissions.routes?.[pattern]?.secrets?.includes(ref.secret), `Secret binding denied by operator policy${revisionPinHint(permissions.projectSha256, projectSha256) || `: ${alias} reads ${ref.secret}, which no grant allows for this route. ${grantHint}`}`, { code: 'binding-denied' });
        const value = bindings[ref.secret];
        assert(typeof value === 'string' && value.length, 'Missing required secret binding');
        route.secrets[alias] = value;
      }
      const resolveHeaders=(headers:EgressHeaders|undefined):Record<string,string> => Object.fromEntries(Object.entries(headers||{}).map(([key,value])=>{if(typeof value==='string')return [key,value];assert(own(route.secrets,value.secret),'Unknown egress secret alias');return [key,route.secrets[value.secret]!];}));
      if(config.proxy){
        assert(!config.middleware?.length,'Proxy middleware is not supported; authorize requests with host policy before egress');
        const cache=effectivePolicies(loaded.document,config).cache;
        assert(!cache||cache.strategy==='no-store','Proxy routes require cache disabled or no-store');
        assert(!route.responseHeaders.some(([name,value])=>['cache-control','cdn-cache-control','vercel-cdn-cache-control','surrogate-control'].includes(name.toLowerCase())&&value!=='no-store'),'Proxy response caching must be no-store');
        route.compiledProxy={...config.proxy,headers:resolveHeaders(config.proxy.headers)};validateProxy(route.compiledProxy);
        for(const match of config.proxy.url.matchAll(/(?:\{|%7B)([A-Za-z_][A-Za-z0-9_]*)(?:\}|%7D)/gi))assert(names.includes(match[1]!), 'Proxy placeholder requires a declared path parameter');
        assert(!Object.keys(config.response?.headers||{}).some(name=>name.toLowerCase()==='content-encoding'),'Proxy content encoding cannot be overridden');
      }
      if(config.signals){route.compiledSignals=config.signals.map(signal=>({...signal,headers:resolveHeaders(signal.headers)}));for(const signal of route.compiledSignals)validateSignal(signal);}
      if (config.expires) {
        assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(config.expires) && Number.isFinite(Date.parse(config.expires)), 'Expiry must be a UTC ISO timestamp');
        route.expiresAt = Date.parse(config.expires);
        assert(new Date(route.expiresAt).toISOString().replace('.000Z','Z') === config.expires.replace('.000Z','Z'), 'Invalid calendar expiry');
      }
      if (declaredRedirect) {
        const value = declaredRedirect.url;
        assert(!/[\u0000-\u0020\u007f\\]/u.test(value), 'Redirect URL contains unsafe characters');
        // A root-relative destination (`/profiles/{id}`) stays on this site: a single leading slash, so never `//host`, and no dot segments.
        const relative = value.startsWith('/') && !value.startsWith('//');
        let dest: URL;
        try { dest = new URL(value, relative ? 'https://relative.invalid' : undefined); } catch { assert(false, 'Redirect URL must be an absolute HTTP(S) URL or a root-relative path'); }
        if (relative) assert(dest.origin === 'https://relative.invalid' && !value.split(/[?#]/, 1)[0]!.split('/').some(part => part === '.' || part === '..'), 'Root-relative redirect must be a plain path without dot segments');
        else {
          assert(['http:', 'https:'].includes(dest.protocol) && !dest.username && !dest.password, 'Redirect must use HTTP(S) without credentials');
          const authority = value.match(/^https?:\/\/([^/?#]+)/i)?.[1];
          assert(authority && !/[{}]/.test(authority), 'Redirect placeholders are allowed only in path segments');
        }
        assert(!/[{}]/.test(dest.search + dest.hash), 'Redirect placeholders are allowed only in path segments');
        const placeholders = [...value.matchAll(/\{([^}]+)\}/g)].map(m => m[1]!);
        assert(placeholders.every(n => (n === '**' && wildcardRedirect) || (token.test(n) && names.includes(n))), 'Redirect placeholder must reference a declared path input');
        assert(placeholders.filter(n => n === '**').length <= 1, '{**} may appear once in a redirect destination');
        assert(!/[{}]/.test(value.replace(/\{(?:[A-Za-z_][A-Za-z0-9_]*|\*\*)\}/g, '')), 'Invalid redirect placeholder');
        const query = declaredRedirect.query || {};
        const reserved = new Set(dest.searchParams.keys());
        for (const [key, ref] of Object.entries(query.map || {})) {
          assert(!reserved.has(key), 'Redirect query mapping conflicts with destination');
          reserved.add(key); referenceCheck(ref, route);
        }
        for (const key of query.pass || []) assert(!reserved.has(key), 'Query passthrough conflicts with destination or mapping');
        route.redirect = compiledRedirect(declaredRedirect);
      }
      for (const item of config.middleware || []) {
        const source = await functionFile(loaded.root,item.source);
        modules.set(source,true);
        route.middleware.push({source,export:item.export || 'default'});
      }
      if (declaredFunction) {
        const source = await functionFile(loaded.root, declaredFunction.source);
        modules.set(source, true);
        route.function = { ...declaredFunction, source, export: declaredFunction.export || 'default' };
        for (const ref of Object.values(declaredFunction.args || {})) referenceCheck(ref, route, true);
      }
      if (wildcardRedirect) { route.prefix = pattern.slice(0, -2); route.wildcard = true; mounts.push(route); }
      else if (config.static || config.extension) { route.prefix = pattern.slice(0, -1); mounts.push(route); }
      else if (!names.length) exact.set(pattern, route);
      else {
        assert(dynamic.length < 1000, 'Maximum 1000 parameterized routes per snapshot');
        for (const existing of dynamic) {
          if (existing.parts.length === parts.length && existing.specificity === route.specificity) {
            assert(!parts.every((p, i) => p === existing.parts[i] || parameterName(p) || parameterName(existing.parts[i]!)), 'Equally specific parameterized routes overlap');
          }
        }
        dynamic.push(route);
      }
    } catch (error) { throw routeError(error, pattern); }
  }
  dynamic.sort((a, b) => b.specificity - a.specificity);
  // Index parameter routes by segment count; exact paths take the O(1) fast path.
  const byLength = new Map<number, CompiledRoute[]>();
  for (const route of dynamic) {
    if (!byLength.has(route.parts.length)) byLength.set(route.parts.length, []);
    byLength.get(route.parts.length)!.push(route);
  }
  for(const mount of mounts.filter(route=>route.extension)){const base=mount.parts.slice(0,-1);for(const candidate of [...exact.values(),...dynamic,...mounts]){if(candidate===mount)continue;const parts=candidate.parts;const shared=Math.min(base.length,parts.length-(candidate.prefix?1:0));const compatible=base.slice(0,shared).every((part,index)=>part===parts[index]||parameterName(parts[index]!));assert(!compatible||(!candidate.prefix&&parts.length<base.length),'Extension mount overlaps another route');}}
  assert(new Set(mounts.map(mount => mount.prefix)).size === mounts.length, 'A /** wildcard redirect cannot share its prefix with a static or extension mount');
  mounts.sort((a,b) => b.prefix!.length - a.prefix!.length);
  assert(performance.now()<deadline, 'Route compilation deadline exceeded');
  return { exact, byLength, mounts, modules: [...modules.keys()], count: exact.size + dynamic.length + mounts.length };
}
