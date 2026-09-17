import { ConfigError } from './errors.ts';
import { effectivePolicies, registry } from './policies.ts';
import type { CompiledRoute, CompiledRouteTable, EffectivePolicies, LoadedDocument, PolicyName, PolicyModule, PolicySupport, ProjectDocument, RouteConfig, TargetName } from './types.ts';

export const capabilityTargets = ['self-hosted', 'cloudflare', 'aws', 'vercel'] as const;
export type CapabilityTarget = typeof capabilityTargets[number];
export type CapabilitySupport = PolicySupport | 'conditional' | 'unknown';
export const capabilityNames = ['redirect', 'respond', 'page', 'static', 'download', 'function', 'middleware', 'link', 'dynamicLinks', 'parameters', 'methods', 'enabled', 'expires', 'request.body', 'response.headers', 'bindings', 'policies.agents', 'policies.security', 'policies.cache', 'policies.compression', 'policies.throttle'] as const;
export type CapabilityName = typeof capabilityNames[number];
export interface CapabilityDecision { support: CapabilitySupport; reason: string }
export interface CapabilityRequirement extends CapabilityDecision { path: string; capability: CapabilityName }
export interface CompatibilityReport {
  target: CapabilityTarget; compatible: boolean; requirements: CapabilityRequirement[]; issues: CapabilityRequirement[];
  deployment: 'local-runtime' | 'unverified';
}
export interface CapabilityCatalog {
  format: 1;
  targets: { target: CapabilityTarget; deployment: CompatibilityReport['deployment'] }[];
  capabilities: { capability: CapabilityName; targets: Partial<Record<CapabilityTarget, CapabilityDecision>> }[];
}

export function normalizeCapabilityTarget(target: string): CapabilityTarget {
  if (target === 'node') return 'self-hosted';
  if ((capabilityTargets as readonly string[]).includes(target)) return target as CapabilityTarget;
  throw new ConfigError('Unknown capability target; use self-hosted, cloudflare, aws or vercel');
}
const internalTarget = (target: CapabilityTarget): TargetName => target === 'self-hosted' ? 'node' : target;
const deployment = (target: CapabilityTarget): CompatibilityReport['deployment'] => target === 'self-hosted' ? 'local-runtime' : 'unverified';
const policyNames = Object.keys(registry) as PolicyName[];

// Policy modules remain the authority for configuration-dependent support.
function decision(capability: CapabilityName, target: CapabilityTarget, policies?: EffectivePolicies): CapabilityDecision {
  const policy = policyNames.find(name => capability === `policies.${name}`);
  if (policy) {
    if (policy === 'throttle' && !policies && (target === 'aws' || target === 'vercel')) {
      return { support: 'conditional', reason: 'Only partition: route is implemented; counters are per instance' };
    }
    const module: PolicyModule = registry[policy];
    const support: CapabilitySupport = (module.targets(policies?.[policy]) as Partial<Record<TargetName, PolicySupport>>)[internalTarget(target)] ?? 'unknown';
    return { support, reason: support === 'refused' ? `${capability} cannot be compiled or enforced by this target`
      : support === 'delegated' ? 'Delegated to the provider; exact compression settings and deployment behavior are unverified'
      : support === 'unknown' ? 'No implementation evidence for this target'
      : 'Implemented by the existing policy module; configuration validation still applies' };
  }
  if (target !== 'self-hosted') {
    const reason = capability === 'function' ? 'isolated functions need worker threads and the WASM engine'
      : capability === 'middleware' ? 'declares middleware that needs the sandbox'
      : capability === 'link' || capability === 'dynamicLinks' ? 'stored live links need a durable writable store'
      : target === 'cloudflare' && ['page', 'static', 'download'].includes(capability) ? 'assets need a static-asset binding'
      : target === 'cloudflare' && capability === 'bindings' ? 'env and secret bindings would have to be baked into the artifact'
      : undefined;
    if (reason) return { support: 'refused', reason };
  }
  return { support: target === 'cloudflare' ? 'compiled' : 'native', reason: target === 'self-hosted'
    ? 'Implemented and tested in the local runtime'
    : 'Implemented with local adapter tests; provider deployment unverified; transport normalization limits apply' };
}

/** Catalog, not a claim that every configuration or provider deployment works. */
export function getCapabilities(target?: string): CapabilityCatalog {
  const selected = target === undefined ? [...capabilityTargets] : [normalizeCapabilityTarget(target)];
  return { format: 1, targets: selected.map(target => ({ target, deployment: deployment(target) })),
    capabilities: capabilityNames.map(capability => ({ capability,
      targets: Object.fromEntries(selected.map(target => [target, decision(capability, target)])) })) };
}

/** A safe projection shared by declaration preflight and the existing compiled IR. No values escape. */
export function routeCapabilities(route: RouteConfig | CompiledRoute, document: ProjectDocument): CapabilityName[] {
  const result: CapabilityName[] = [];
  for (const name of ['redirect', 'respond', 'page', 'static', 'download', 'function', 'link'] as const) if (route[name]) result.push(name);
  if (route.middleware?.length) result.push('middleware');
  if (route.parameters?.length) result.push('parameters');
  // Defaults are still semantics required by every route.
  result.push('methods', 'enabled');
  if (route.expires) result.push('expires');
  if (route.request?.body) result.push('request.body');
  if (Object.keys(route.response?.headers ?? {}).length) result.push('response.headers');
  if (Object.keys(route.env ?? {}).length || Object.keys(route.secrets ?? {}).length) result.push('bindings');
  const policies = effectivePolicies(document, route);
  for (const name of policyNames) if (policies[name]) result.push(`policies.${name}`);
  return result;
}

function analyze(document: ProjectDocument, routes: Iterable<readonly [string, RouteConfig | CompiledRoute]>, requestedTarget: string): CompatibilityReport {
  const target = normalizeCapabilityTarget(requestedTarget);
  const requirements: CapabilityRequirement[] = [];
  if (document.dynamicLinks) requirements.push({ path: '(project)', capability: 'dynamicLinks', ...decision('dynamicLinks', target) });
  for (const [path, route] of routes) {
    const policies = effectivePolicies(document, route);
    for (const capability of routeCapabilities(route, document)) requirements.push({ path, capability, ...decision(capability, target, policies) });
  }
  const issues = requirements.filter(item => item.support === 'refused' || item.support === 'unknown' || item.support === 'conditional');
  return { target, deployment: deployment(target), compatible: issues.length === 0, requirements, issues };
}

/** Preflight only: call after schema validation/site expansion, before resolving bindings. */
export function analyzeProjectCapabilities(loaded: LoadedDocument, target: string): CompatibilityReport {
  return analyze(loaded.document, Object.entries(loaded.routes), target);
}

/** Analyze normalized route semantics without exporting validators, resources or resolved secrets. */
export function analyzeCompiledCapabilities(document: ProjectDocument, compiled: CompiledRouteTable, target: string): CompatibilityReport {
  function* entries(): Generator<readonly [string, CompiledRoute]> {
    for (const route of compiled.exact.values()) yield [route.pattern, route];
    for (const bucket of compiled.byLength.values()) for (const route of bucket) yield [route.pattern, route];
    for (const route of compiled.mounts) yield [route.pattern, route];
  }
  return analyze(document, entries(), target);
}

export function assertTargetCompatibility(report: CompatibilityReport): void {
  if (report.compatible) return;
  throw new ConfigError(`Cannot activate/build project for ${report.target}:\n` + report.issues.map(issue =>
    `${issue.path}\n  capability: ${issue.capability}\n  unsupported by target: ${report.target}\n  ${issue.reason}`).join('\n'));
}

export function formatCapabilities(catalog: CapabilityCatalog): string {
  return ['Capability'.padEnd(24) + catalog.targets.map(({ target }) => target.padEnd(16)).join(''),
    ...catalog.capabilities.map(row => row.capability.padEnd(24) + catalog.targets.map(({ target }) => (row.targets[target]?.support ?? 'unknown').padEnd(16)).join('')),
    '', 'Provider deployments: unverified. native/compiled describe local implementation tests.',
    'conditional requires configuration analysis; delegated relies on the provider (unverified).',
    'See docs/CAPABILITIES.md for transport limits and programmatic project analysis.', ''].join('\n');
}
