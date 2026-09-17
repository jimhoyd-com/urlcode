import * as agents from './policies/agents.js';
import * as throttle from './policies/throttle.js';
import * as cache from './policies/cache.js';
import * as security from './policies/security.js';
import * as compression from './policies/compression.js';
import { assert, ConfigError } from './errors.js';

// Host-side behavior declared in YAML and enforced outside the sandbox. Every
// module here follows one contract so a first-party policy and an operator
// plugin share a code path:
//
//   name          the YAML key under `policies`
//   phases        'request' | 'response' | both; fixed order below
//   targets(cfg)  {node, vercel, aws, cloudflare} → 'native' | 'compiled' | 'delegated' | 'refused'
//                 delegated: the platform already provides it, so the policy is
//                 accepted and dropped rather than refusing the deployment
//   compile(cfg, {route, shared, target, document, root}) → state, or throws ConfigError
//   onRequest(state, req)          → result to short-circuit, or undefined
//   onResponse(state, req, result) → result (same or replaced)
//   onError(state, req, error)     → result to answer with instead, or undefined
//   describe(state)                → JSON summary for audit/inventory
//   close(shared)                  → release cross-request state
//
// Request order: agents (cheapest denial first), throttle, cache lookup.
// Response order: cache store, throttle headers (after the store, so a cached
// copy is never stamped with one client's remaining budget), security headers,
// compression last so every header it depends on is already final. YAML response.headers are applied by
// the runtime before this phase, so explicit headers beat profile defaults.
export const registry = { agents, throttle, cache, security, compression };
export const requestOrder = ['agents','throttle','cache'];
export const responseOrder = ['cache','throttle','security','compression'];
export const targets = ['node','vercel','aws','cloudflare'];

// What a profile is: a policies object without `profile`. The built-in one is
// a starting point that reads in one place, not a claim about any workload.
export const builtinProfiles = Object.freeze({
  hardened: Object.freeze({
    security: { headers: 'oshp' },
    agents: { deny: ['ai-crawlers'], status: 403 },
    throttle: { quota: 120, window: 60, partition: 'client', status: 429 },
    compression: { encodings: ['br','gzip'], minBytes: 1024 },
    cache: { strategy: 'revalidate' },
  }),
});

function resolveProfile(name, document) {
  if (!name) return {};
  const custom = document.profiles?.[name];
  if (custom) return custom;
  const builtin = builtinProfiles[name];
  assert(builtin, `Unknown policy profile "${name}"`);
  return builtin;
}

// Effective configuration for one route: profile ← project keys ← route
// profile ← route keys. `false` disables a policy at any level; an object
// merges shallowly over what is below it, so a route can tighten one number
// without restating the rest.
export function effectivePolicies(document, routeConfig) {
  const layers = [];
  const project = document.policies || {};
  layers.push(resolveProfile(project.profile, document), project);
  const route = routeConfig?.policies || {};
  if (route.profile) layers.push(resolveProfile(route.profile, document));
  layers.push(route);
  const effective = {};
  for (const layer of layers) for (const [key, value] of Object.entries(layer)) {
    if (key === 'profile') continue;
    if (value === false) { delete effective[key]; continue; }
    effective[key] = { ...(effective[key] || {}), ...value };
  }
  return effective;
}

// Compiles every declared policy for a route into ordered request/response
// chains. A target that cannot honour a policy refuses the whole activation
// with the route and policy named, the same rule adapters apply to handlers.
export async function compilePolicies(document, routeConfig, { route, shared, target = 'node', root }) {
  const effective = effectivePolicies(document, routeConfig);
  const chain = { request: [], response: [], error: [], describe: {} };
  for (const name of Object.keys(effective)) {
    const module = registry[name];
    assert(module, `Unknown policy "${name}"`);
    const support = module.targets(effective[name])[target];
    if (support === 'refused') throw new ConfigError(`${route.pattern} declares policies.${name}, which the ${target} target cannot enforce`);
    if (support === 'delegated') { chain.describe[name] = { target: support }; continue; }
    const state = await module.compile(effective[name], { route, shared, target, document, root });
    chain.describe[name] = { ...(module.describe?.(state) ?? {}), target: support };
    chain[name] = state;
  }
  for (const name of requestOrder) if (chain[name] && registry[name].onRequest) chain.request.push([registry[name], chain[name]]);
  for (const name of responseOrder) if (chain[name] && registry[name].onResponse) chain.response.push([registry[name], chain[name]]);
  for (const name of Object.keys(effective)) if (registry[name].onError) chain.error.push([registry[name], chain[name]]);
  return chain;
}

// The security headers an error response gets. A thrown error has no route
// result to decorate, so the host asks for the header list instead: the
// matched route's own security state when there is one, otherwise the
// project-level policy compiled once here. Nothing else applies to errors:
// their bodies are fixed text and nothing may cache or count them twice.
export function compileErrorPolicy(document, { target = 'node' } = {}) {
  const effective = effectivePolicies(document, {});
  const config = effective.security;
  if (!config || registry.security.targets(config)[target] === 'refused') return null;
  return registry.security.compile(config, { route: { pattern: '(project)' }, shared: {}, target, document });
}
export function errorHeaders(state, origin) {
  if (!state) return [];
  return registry.security.onResponse(state, { origin }, { headers: [] }).headers;
}

export async function closePolicies(shared) {
  for (const module of Object.values(registry)) await module.close?.(shared);
}

// The request a policy sees. Nothing here is parsed twice: headers and target
// are the runtime's own objects, the client identity is what the host resolved
// through its trusted-proxy setting (never a raw forwarded header) and the
// route is the configured pattern, not request text.
export function policyRequest({ method, target, path, params = {}, query, headers, headerCounts, client, origin, route }) {
  return { method, target, path, params, query, headers, headerCounts, client: client ?? null, origin, route: route.pattern, secrets: Object.keys(route.secrets || {}).length > 0 };
}
