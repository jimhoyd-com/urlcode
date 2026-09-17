import * as agents from './policies/agents.ts';
import * as throttle from './policies/throttle.ts';
import * as cache from './policies/cache.ts';
import * as security from './policies/security.ts';
import * as compression from './policies/compression.ts';
import { assert, ConfigError } from './errors.ts';
import type { HeaderPair } from './http-response.ts';
import type { SecurityState } from './policies/security.ts';
import type { EffectivePolicies, PoliciesConfig, PolicyChain, PolicyConfigs, PolicyContext, PolicyDescriptions, PolicyLayer, PolicyModule, PolicyName, PolicyRequest, PolicyShared, PolicyStates, ProjectDocument, RouteConfig, TargetName } from './types.ts';
export type { PolicyChain, PolicyContext, PolicyModule, PolicyRequest, PolicyShared } from './types.ts';

// Host-side behavior declared in YAML and enforced outside the sandbox. Every
// module here follows one contract so a first-party policy and an operator
// plugin share a code path (PolicyModule in src/types.ts):
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
/** The registry, typed per policy so `registry.cache.compile` returns a CacheState; erased to PolicyModule where iterated. */
export type PolicyRegistry = { [K in PolicyName]: PolicyModule<PolicyConfigs[K], PolicyStates[K], PolicyDescriptions[K]> };
export const registry: PolicyRegistry = { agents, throttle, cache, security, compression };
export const requestOrder: readonly PolicyName[] = ['agents','throttle','cache'];
export const responseOrder: readonly PolicyName[] = ['cache','throttle','security','compression'];
export const targets: readonly TargetName[] = ['node','vercel','aws','cloudflare'];
const isPolicyName = (name: string): name is PolicyName => Object.hasOwn(registry, name);

// What a profile is: a policies object without `profile`. The built-in one is
// a starting point that reads in one place, not a claim about any workload.
export const builtinProfiles: Readonly<Record<string, PolicyLayer>> = Object.freeze({
  hardened: Object.freeze<PolicyLayer>({
    security: { headers: 'oshp' },
    agents: { deny: ['ai-crawlers'], status: 403 },
    throttle: { quota: 120, window: 60, partition: 'client', status: 429 },
    compression: { encodings: ['br','gzip'], minBytes: 1024 },
    cache: { strategy: 'revalidate' },
  }),
});

function resolveProfile(name: string | undefined, document: ProjectDocument): PolicyLayer {
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
export function effectivePolicies(document: ProjectDocument, routeConfig: Pick<RouteConfig, 'policies'> | undefined): EffectivePolicies {
  const layers: PoliciesConfig[] = [];
  const project = document.policies || {};
  layers.push(resolveProfile(project.profile, document), project);
  const route = routeConfig?.policies || {};
  if (route.profile) layers.push(resolveProfile(route.profile, document));
  layers.push(route);
  const effective: Record<string, object> = {};
  for (const layer of layers) for (const [key, value] of Object.entries(layer)) {
    if (key === 'profile') continue;
    if (value === false) { delete effective[key]; continue; }
    effective[key] = { ...(effective[key] || {}), ...value };
  }
  return effective as EffectivePolicies; // the schema admits only the five policy keys in a layer
}

// Compiles every declared policy for a route into ordered request/response
// chains. A target that cannot honour a policy refuses the whole activation
// with the route and policy named, the same rule adapters apply to handlers.
export async function compilePolicies(document: ProjectDocument, routeConfig: Pick<RouteConfig, 'policies'> | undefined, { route, shared, target = 'node', root }: PolicyContext): Promise<PolicyChain> {
  const effective = effectivePolicies(document, routeConfig);
  const chain: PolicyChain = { request: [], response: [], error: [], describe: {} };
  const states: Partial<PolicyStates> = chain;
  // Generic over the name so the module, its config and its state stay correlated.
  async function compileOne<K extends PolicyName>(name: K, config: PolicyConfigs[K]): Promise<void> {
    const module = registry[name];
    const support = module.targets(config)[target];
    if (support === 'refused') throw new ConfigError(`${route.pattern} declares policies.${name}, which the ${target} target cannot enforce`);
    if (support === 'delegated') { chain.describe[name] = { target: support }; return; }
    const state = await module.compile(config, { route, shared, target, document, ...(root === undefined ? {} : { root }) });
    const described: Partial<PolicyDescriptions[K]> = module.describe?.(state) ?? {};
    chain.describe[name] = { ...described, target: support };
    states[name] = state;
  }
  for (const name of Object.keys(effective)) {
    assert(isPolicyName(name), `Unknown policy "${name}"`);
    await compileOne(name, effective[name]!);
  }
  const entry = (name: PolicyName): [PolicyModule, unknown] => [registry[name], chain[name]];
  for (const name of requestOrder) if (chain[name] && registry[name].onRequest) chain.request.push(entry(name));
  for (const name of responseOrder) if (chain[name] && registry[name].onResponse) chain.response.push(entry(name));
  for (const name of Object.keys(effective)) if (isPolicyName(name) && registry[name].onError) chain.error.push(entry(name));
  return chain;
}

// The security headers an error response gets. A thrown error has no route
// result to decorate, so the host asks for the header list instead: the
// matched route's own security state when there is one, otherwise the
// project-level policy compiled once here. Nothing else applies to errors:
// their bodies are fixed text and nothing may cache or count them twice.
export function compileErrorPolicy(document: ProjectDocument, { target = 'node' }: { target?: TargetName } = {}): SecurityState | null {
  const effective = effectivePolicies(document, {});
  const config = effective.security;
  if (!config || registry.security.targets(config)[target] === 'refused') return null;
  return security.compile(config, { route: { pattern: '(project)' } });
}
export function errorHeaders(state: SecurityState | null | undefined, origin: string | undefined): HeaderPair[] {
  if (!state) return [];
  return security.onResponse(state, { origin }, { status: 200, headers: [] }).headers;
}

export async function closePolicies(shared: PolicyShared): Promise<void> {
  for (const module of Object.values(registry) as PolicyModule[]) await module.close?.(shared);
}

// The request a policy sees. Nothing here is parsed twice: headers and target
// are the runtime's own objects, the client identity is what the host resolved
// through its trusted-proxy setting (never a raw forwarded header) and the
// route is the configured pattern, not request text.
export interface PolicyRequestInput {
  method: string; target: string; path: string; params?: Record<string, string>; query: URLSearchParams;
  headers: PolicyRequest['headers']; headerCounts?: Record<string, number> | undefined; client?: string | null | undefined; origin?: string | undefined;
  route: { pattern: string; secrets?: Record<string, string> };
}
export function policyRequest({ method, target, path, params = {}, query, headers, headerCounts, client, origin, route }: PolicyRequestInput): PolicyRequest {
  return { method, target, path, params, query, headers, headerCounts, client: client ?? null, origin, route: route.pattern, secrets: Object.keys(route.secrets || {}).length > 0 };
}
