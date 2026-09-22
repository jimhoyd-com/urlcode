import { hasExtensionPolicy, effectiveExtensionPolicies } from './extensions.ts';
import type { RuntimeExtension } from './extensions.ts';
import { ConfigError } from './errors.ts';
import { effectivePolicies, registry } from './policies.ts';
import type { CompiledRoute, CompiledRouteTable, EffectivePolicies, LoadedDocument, PolicyName, PolicyModule, PolicySupport, ProjectDocument, RouteConfig, TargetName } from './types.ts';

export const capabilityTargets = ['self-hosted', 'cloudflare', 'aws', 'vercel', 'static'] as const;
export type CapabilityTarget = typeof capabilityTargets[number];
/** `static` never reaches the policy-module handshake (packages/core/src/types.ts `TargetName`): it refuses every
 * runtime policy outright, so it needs no entry in that exhaustive per-target record. */
type PolicyCapableTarget = Exclude<CapabilityTarget, 'static'>;
export type CapabilitySupport = PolicySupport | 'conditional' | 'unknown';
export const capabilityNames = ['extension','policies.extensions','proxy', 'signals', 'conditional', 'conditions', 'redirect', 'respond', 'page', 'static', 'download', 'function', 'middleware', 'parameters', 'methods', 'enabled', 'expires', 'request.body', 'response.headers', 'bindings', 'policies.agents', 'policies.security', 'policies.cache', 'policies.compression', 'policies.throttle'] as const;
export type CapabilityName = typeof capabilityNames[number];
/** The resolved operator registration set, when known (loaded via --host-file, same as `inspectExtensions`). Keyed by extension name. */
export type ExtensionRegistry = ReadonlyMap<string, RuntimeExtension>;
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
  throw new ConfigError('Unknown capability target; use self-hosted, cloudflare, aws, vercel or static');
}
const internalTarget = (target: PolicyCapableTarget): TargetName => target === 'self-hosted' ? 'node' : target;
const deployment = (target: CapabilityTarget): CompatibilityReport['deployment'] => target === 'self-hosted' ? 'local-runtime' : 'unverified';
const policyNames = Object.keys(registry) as PolicyName[];

// static hosting (S3 + CloudFront) has no server at all, so no capability
// needing request-time evaluation can be represented; only capabilities a
// build can lower ahead of time (redirect/respond/page/static/download,
// methods/enabled/expires) survive.
const staticRefusals: Partial<Record<CapabilityName, string>> = {
  extension: 'no server, so no operator extension registry to delegate to',
  'policies.extensions': 'no server, so no operator extension registry to delegate to',
  proxy: 'no server, so no bounded egress at request time',
  signals: 'no server, so no fire-and-forget egress after a reply',
  conditional: 'no server, so request-time condition matching is not possible',
  conditions: 'no server, so request-time condition matching is not possible',
  function: 'no server, so no dynamic execution',
  middleware: 'no server, so no middleware execution',
  parameters: 'no server, so no request-time parameter validation',
  'request.body': 'no server, so there is no request body to read or validate',
  'response.headers': 'no server, so response headers cannot be added per request; set them via S3 object metadata or a CloudFront response headers policy instead',
  bindings: 'no server, so env/secret bindings cannot be resolved per request',
};

// Policy modules remain the authority for configuration-dependent support.
// `extension`/`policies.extensions` cannot get a target-independent answer:
// each registered extension declares its own `targets` (src/extensions.ts),
// so refusal on aws/vercel/self-hosted depends on that extension, not on the
// capability name. `extensionNames` names the specific extension(s) this
// requirement involves; `extensions` is the resolved registration set, when
// the caller has one (loaded via --host-file, same as `inspectExtensions`).
function decision(capability: CapabilityName, target: CapabilityTarget, policies?: EffectivePolicies, extensionNames?: readonly string[], extensions?: ExtensionRegistry): CapabilityDecision {
  if(capability==='extension'||capability==='policies.extensions'){
    if(target==='cloudflare')return {support:'refused',reason:'Operator extensions have no Worker artifact lowering'};
    if(target==='static')return {support:'refused',reason:staticRefusals[capability]!};
    if(!extensions)return {support:'conditional',reason:'Depends on the specific registered extension\'s declared targets; resolve with --host-file (CLI) or the runtime\'s extensions option'};
    const names=extensionNames?.length?extensionNames:[...extensions.keys()];
    if(!names.length)return {support:'unknown',reason:'No extension registration to check'};
    const checked=names.map(name=>{const registration=extensions.get(name);return {name,support:(registration?(registration.targets.includes(internalTarget(target))?'native':'refused'):'unknown') as CapabilitySupport};});
    const unknown=checked.filter(item=>item.support==='unknown').map(item=>item.name);
    if(unknown.length)return {support:'unknown',reason:`Not registered by the host file: ${unknown.join(', ')}`};
    const refused=checked.filter(item=>item.support==='refused').map(item=>item.name);
    if(refused.length)return {support:'refused',reason:`Refused by the extension's own declared targets: ${refused.join(', ')}`};
    return {support:'native',reason:'Registered extension declares support for this target'};
  }
  const policy = policyNames.find(name => capability === `policies.${name}`);
  if (policy) {
    if (target === 'static') return { support: 'refused', reason: 'no server, so runtime policies are not enforced for static hosting' };
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
  if (target === 'static') {
    const reason = staticRefusals[capability];
    if (reason) return { support: 'refused', reason };
    // redirect/respond/page/static/download/methods/enabled/expires fall through to the target's own success reason below.
  } else if (target !== 'self-hosted') {
    const reason = ['proxy','signals'].includes(capability) ? 'bounded egress currently requires the self-hosted Node lifecycle'
      : target === 'cloudflare' && ['conditional','conditions'].includes(capability) ? 'conditional routing has no Worker artifact lowering yet'
      : capability === 'function' ? 'functions need the self-hosted Node lifecycle, whether trusted (in-process) or sandboxed (worker threads and the WASM engine)'
      : capability === 'middleware' ? 'middleware needs the self-hosted Node lifecycle, whether trusted (in-process) or sandboxed (worker threads and the WASM engine)'
      : target === 'cloudflare' && ['page', 'static', 'download'].includes(capability) ? 'assets need a static-asset binding'
      : target === 'cloudflare' && capability === 'bindings' ? 'env and secret bindings would have to be baked into the artifact'
      : undefined;
    if (reason) return { support: 'refused', reason };
  }
  return { support: target === 'cloudflare' || target === 'static' ? 'compiled' : 'native', reason: target === 'self-hosted'
    ? 'Implemented and tested in the local runtime'
    : target === 'static'
    ? 'Compiled ahead of time into S3/CloudFront redirect metadata or static objects; provider deployment unverified'
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
  if(route.extension)result.push('extension');
  if(hasExtensionPolicy(document,route))result.push('policies.extensions');
  if(route.proxy)result.push('proxy');
  if(route.signals?.length)result.push('signals');
  if (route.match) result.push('conditions');
  if (route.conditional) {
    result.push('conditional');
    for (const branch of [...route.conditional.cases, ...(route.conditional.fallback ? [route.conditional.fallback] : [])]) {
      if (branch.redirect && !result.includes('redirect')) result.push('redirect');
      if (branch.respond && !result.includes('respond')) result.push('respond');
    }
  }
  for (const name of ['redirect', 'respond', 'page', 'static', 'download', 'function'] as const) if (route[name]) result.push(name);
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

function analyze(document: ProjectDocument, routes: Iterable<readonly [string, RouteConfig | CompiledRoute]>, requestedTarget: string, registrations?: readonly RuntimeExtension[]): CompatibilityReport {
  const target = normalizeCapabilityTarget(requestedTarget);
  const extensions: ExtensionRegistry | undefined = registrations ? new Map(registrations.map(registration => [registration.name, registration])) : undefined;
  const requirements: CapabilityRequirement[] = [];
  if (Object.keys(document.extensions??{}).length) requirements.push({path:'(project)',capability:'extension',...decision('extension',target,undefined,Object.keys(document.extensions??{}),extensions)});
  for (const [path, route] of routes) {
    const policies = effectivePolicies(document, route);
    for (const capability of routeCapabilities(route, document)) {
      const extensionNames = capability==='extension' ? (route.extension?[route.extension]:[])
        : capability==='policies.extensions' ? Object.keys(effectiveExtensionPolicies(document,route)) : undefined;
      requirements.push({ path, capability, ...decision(capability, target, policies, extensionNames, extensions) });
    }
  }
  const issues = requirements.filter(item => item.support === 'refused' || item.support === 'unknown' || item.support === 'conditional');
  return { target, deployment: deployment(target), compatible: issues.length === 0, requirements, issues };
}

/**
 * Preflight only: call after schema validation/site expansion, before resolving bindings.
 * `registrations` is the resolved operator extension set, when known (the same
 * shape --host-file loads for `inspectExtensions`); without it, `extension`/
 * `policies.extensions` requirements report `conditional`/`unknown` rather
 * than a blanket `native` that ignores the specific extension's own targets.
 */
export function analyzeProjectCapabilities(loaded: LoadedDocument, target: string, registrations?: readonly RuntimeExtension[]): CompatibilityReport {
  return analyze(loaded.document, Object.entries(loaded.routes), target, registrations);
}

/** Analyze normalized route semantics without exporting validators, resources or resolved secrets. */
export function analyzeCompiledCapabilities(document: ProjectDocument, compiled: CompiledRouteTable, target: string, registrations?: readonly RuntimeExtension[]): CompatibilityReport {
  function* entries(): Generator<readonly [string, CompiledRoute]> {
    for (const route of compiled.exact.values()) yield [route.pattern, route];
    for (const bucket of compiled.byLength.values()) for (const route of bucket) yield [route.pattern, route];
    for (const route of compiled.mounts) yield [route.pattern, route];
  }
  return analyze(document, entries(), target, registrations);
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

export type CapabilityKind = 'handler' | 'policy' | 'routing' | 'request' | 'binding' | 'egress' | 'middleware' | 'project';
export interface CapabilityDetail {
  kind: CapabilityKind;
  summary: string;
  /** Dotted schema paths (`urlcode schema <path>`) whose fragments describe this capability's YAML. */
  schema: string[];
  constraints: string[];
  /** Operator authority the capability needs at activation; never binding values. */
  grants: string[];
}
const policyDetail = (name: string, summary: string, constraints: string[]): CapabilityDetail => ({ kind: 'policy', summary, schema: [`policies.${name}`], constraints:
  ['Route policies merge over project/profile policies; `false` removes one', ...constraints], grants: [] });
/** Static facts about each catalog entry. Per-target support stays in `decision`; recipe and cookbook usage is scanned by `getCapability`. */
export const capabilityDetails: Record<CapabilityName, CapabilityDetail> = {
  extension: { kind: 'project', summary: 'Route delegated to a versioned logical extension declared under top-level `extensions`.', schema: ['extension', 'extensions'],
    constraints: ['Extension names match ^[a-z][a-z0-9-]{0,63}$; at most 16 project extensions', 'Each declaration needs `version: "1"` and a `config` object', 'Never loads project code; the registry is operator host code'],
    grants: ['Operator extension registry loaded with --host-file, pinned to the exact project revision'] },
  'policies.extensions': { kind: 'policy', summary: 'Extension-provided policy attached through `policies.extensions`.', schema: ['policies.extensions'],
    constraints: ['Names must reference declared top-level `extensions`', 'Refused on Cloudflare: no Worker artifact lowering'], grants: ['Operator extension registry loaded with --host-file'] },
  proxy: { kind: 'egress', summary: 'Bounded HTTPS proxy to one declared upstream URL.', schema: ['proxy'],
    constraints: ['`url` at most 8192 characters; headers at most 32, string values at most 4096 characters or `{secret}` references', 'Forwarded query keys and request headers are explicit allowlists (at most 32 each)', 'Self-hosted only: bounded egress requires the Node lifecycle'],
    grants: ['External operator policy (--policy) with a revision-pinned exact-origin grant for the route', 'Secret bindings referenced by headers must be granted separately'] },
  signals: { kind: 'egress', summary: 'Fire-and-forget HTTPS notifications after a route reply.', schema: ['signals'],
    constraints: ['1 to 8 signals per route; each `url` at most 8192 characters with at most 32 headers', 'Self-hosted only: bounded egress requires the Node lifecycle'],
    grants: ['External operator policy (--policy) with a revision-pinned exact-origin grant per signal destination'] },
  conditional: { kind: 'routing', summary: 'Disjoint request-condition cases selecting a redirect or respond reply.', schema: ['conditional'],
    constraints: ['1 to 16 cases plus an optional fallback; cases must be disjoint', 'Each case replies with `redirect` or `respond`, never a handler needing assets or code', 'Refused on Cloudflare until artifact lowering exists'], grants: [] },
  conditions: { kind: 'routing', summary: 'Route-level `match` on query, headers or cookies.', schema: ['match'],
    constraints: ['At least one of query, headers, cookies; at most 16 entries each with values up to 1024 characters', 'Refused on Cloudflare until artifact lowering exists'], grants: [] },
  redirect: { kind: 'handler', summary: 'HTTP redirect to a URL template with optional query passing or mapping.', schema: ['redirect'],
    constraints: ['`url` required, at most 8192 characters', 'status one of 301, 302, 303, 307, 308', '`query.pass` is `false` or an explicit list; `query.map` maps from path, query or header inputs'], grants: [] },
  respond: { kind: 'handler', summary: 'Static text or JSON reply with a status code.', schema: ['respond'],
    constraints: ['status 200 to 599', '`text` at most 1 MiB; `text` and `json` are mutually exclusive'], grants: [] },
  page: { kind: 'handler', summary: 'Serve one HTML file from the project.', schema: ['page'],
    constraints: ['`file` required, project-relative, 1 to 1024 characters', 'Fixed `cacheControl` choices; `contentType` must be a media type', 'Refused on Cloudflare: assets need a static-asset binding'], grants: [] },
  static: { kind: 'handler', summary: 'Serve a project directory as a static mount.', schema: ['static'],
    constraints: ['`directory` required, project-relative, 1 to 1024 characters; `index` must be a .html name', 'Refused on Cloudflare: assets need a static-asset binding'], grants: [] },
  download: { kind: 'handler', summary: 'Serve a project file as an attachment.', schema: ['download'],
    constraints: ['`file` required, project-relative, 1 to 1024 characters; `filename` at most 255 characters', 'Refused on Cloudflare: assets need a static-asset binding'], grants: [] },
  function: { kind: 'handler', summary: 'Project function producing the reply; trusted and unsandboxed by default, sandboxed opt-in.', schema: ['function'],
    constraints: ['`source` at most 1024 characters, project-relative; `export` defaults to the default export', '`args` are literals, `{from: path|query|header}` inputs or `{env}` references', 'Self-hosted only', 'Trusted by default (`sandbox` false or absent): runs in-process with full Node network/filesystem access, like any other project code', 'Route-level `sandbox: true` runs the whole `function`/`middleware` chain isolated instead: worker threads, the WASM engine, no network or filesystem in the guest (docs/FUNCTION-SECURITY.md)'], grants: [] },
  middleware: { kind: 'middleware', summary: 'Modules run before the handler; trusted and unsandboxed by default, sandboxed opt-in.', schema: ['middleware'],
    constraints: ['At most 16 entries, each with a project-relative `source` and optional `export`', 'Self-hosted only', 'Same trusted-by-default / `sandbox: true` opt-in as `function`, applied uniformly to the whole route'], grants: [] },
  parameters: { kind: 'request', summary: 'Validated path, query and header inputs.', schema: ['parameters'],
    constraints: ['Names match ^[A-Za-z_][A-Za-z0-9_-]*$ and `in` is path, query or header', 'Schema types: string, integer, number, boolean, array; length bounds up to 8192'], grants: [] },
  methods: { kind: 'routing', summary: 'Allowed HTTP methods; defaults to GET and HEAD.', schema: ['methods'],
    constraints: ['Unique subset of GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS with at least one entry'], grants: [] },
  enabled: { kind: 'routing', summary: 'Route on/off switch; disabled routes are still validated.', schema: ['enabled'], constraints: ['Boolean; defaults to true'], grants: [] },
  expires: { kind: 'routing', summary: 'Timestamp after which the route stops matching.', schema: ['expires'], constraints: ['UTC timestamp YYYY-MM-DDTHH:MM:SS[.mmm]Z; expired routes are still validated'], grants: [] },
  'request.body': { kind: 'request', summary: 'Request body admission limits and format.', schema: ['request.body'],
    constraints: ['`maxBytes` 0 to 1048576; up to 16 lowercase `contentTypes`', '`format` text or json', '`schema` (JSON only): a bounded JSON Schema subset; failures return 422'], grants: [] },
  'response.headers': { kind: 'request', summary: 'Static response headers added to the reply.', schema: ['response.headers'],
    constraints: ['At most 64 headers; values up to 4096 characters or lists of at most 16', 'Cloudflare coalesces duplicate headers'], grants: [] },
  bindings: { kind: 'binding', summary: 'Route `env` literals/references and `secrets` references.', schema: ['env', 'secrets'],
    constraints: ['Names match ^[A-Za-z_][A-Za-z0-9_]*$', '`env` entries are `{value}` literals or `{env}` references; `secrets` entries are `{secret}` references', 'Refused on Cloudflare: bindings would be baked into the artifact'],
    grants: ['External operator policy (--policy) granting each referenced env/secret name; values never enter the project'] },
  'policies.agents': policyDetail('agents', 'Agent allow/deny rules by bundled list name.', ['List names come from the bundled agent lists']),
  'policies.security': policyDetail('security', 'Security response headers.', ['Fixed header set with validated values']),
  'policies.cache': policyDetail('cache', 'Host cache strategy for route replies.', ['Refused on Cloudflare: no cache enforcement in the artifact']),
  'policies.compression': policyDetail('compression', 'Response compression.', ['Delegated on AWS, Vercel and Cloudflare; exact settings are unverified']),
  'policies.throttle': policyDetail('throttle', 'Per-instance request quota per window.', ['`quota` and `window` are required', 'Only `partition: route` is implemented on serverless targets; `client` is refused there; counters are per instance']),
};
