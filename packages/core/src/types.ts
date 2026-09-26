import type { ExtensionDeclaration, ExtensionPolicies } from './extensions.ts';
import type { ProxyDefinition } from './proxy.ts';
import type { SignalDefinition } from './signals.ts';
import type { RouteMatch } from './conditions.ts';
// Types shared across modules: the validated YAML document, the compiled
// route the router produces from it, and the host-side policy contract.
// This file is type-only (nothing here exists at run time) and append-only:
// other modules import from it, so a type is never renamed or narrowed in
// place. Request-time shapes (MatchableRoute, RequestContext, HeadersLike)
// live in match.ts; HandlerResult and HeaderPair in http-response.ts.
import type { HandlerResult, HeaderPair } from './http-response.ts';
import type { CompiledParameter, MatchableRoute, ParameterLocation, ParameterSchema, RedirectSpec, Scalar, ValueRef } from './match.ts';
import type { HttpRoute, Reply, RequestBodyPolicy, RespondSpec } from './http-policy.ts';
import type { AgentsConfig, AgentsDescription, AgentsState } from './policies/agents.ts';
import type { SecurityConfig, SecurityDescription, SecurityState } from './policies/security.ts';
import type { CacheConfig, CacheDescription, CacheState, CacheStore } from './policies/cache.ts';
import type { CompressionConfig, CompressionDescription, CompressionState } from './policies/compression.ts';
import type { ThrottleConfig, ThrottleDescription, ThrottleState, ThrottleTable } from './policies/throttle.ts';

/** An operator log sink; every record is a flat JSON object with an `event` name. */
export type LogFn = (event: Record<string, unknown>) => void;

// ---------------------------------------------------------------------------
// The YAML document, as schemas/urlcode.schema.json admits it. `validateDocument`
// is the one place a parsed value becomes a ProjectDocument.

/** One declared input: a path placeholder, a query parameter or a request header. */
export interface ParameterConfig { name: string; in: ParameterLocation; required?: boolean; schema: ParameterSchema }
/**
 * `env` binding: a plain literal `value` (always reviewable, never overridden); or the `env`
 * name to read from the process environment, with an optional `default` used when that
 * variable is unset. `env` always requires an operator grant for that route/name — if the
 * grant is missing, a declared `default` is used with no host read attempted (the binding
 * degrades to its literal default rather than failing); with no `default`, a missing grant
 * fails route compilation (docs/yaml/functions.md, "Host overrides").
 */
interface EnvBinding { value?: string; env?: string; default?: string }
/** `secrets` binding: the `secret` name to read from the process environment. */
interface SecretBinding { secret: string }
export interface FunctionConfig { source: string; export?: string; args?: Record<string, ValueRef | Scalar> }
export interface MiddlewareConfig { source: string; export?: string }
/** A route as YAML may spell it before normalization: `function` and middleware entries may be short-form module paths. */
export type AuthoredRouteConfig = Omit<RouteConfig, 'function' | 'middleware'> & { function?: string | FunctionConfig; middleware?: (string | MiddlewareConfig)[] };
export interface PageConfig { file: string; contentType?: string; cacheControl?: string }
export interface DownloadConfig extends PageConfig { filename?: string }
export interface StaticConfig { directory: string; contentType?: string; cacheControl?: string; index?: string }
/** `redirect` as declared: `query.pass` may be `false` (the schema allows it; readers treat it as an empty list). */
export interface RedirectConfig { url: string; status?: 301 | 302 | 303 | 307 | 308; query?: { pass?: string[] | false; map?: Record<string, ValueRef | Scalar> } }
export type PolicyName = 'agents' | 'throttle' | 'cache' | 'security' | 'compression';
/** Each first-party policy's YAML configuration, keyed by its `policies` name. */
export interface PolicyConfigs { agents: AgentsConfig; throttle: ThrottleConfig; cache: CacheConfig; security: SecurityConfig; compression: CompressionConfig }
/** One `policies` block or profile layer: every policy optional, `false` disables it. */
/** One layer of policy configuration (profile, project or route); a layer may declare part of a policy, the merge supplies the rest. */
export type PolicyLayer = { [K in PolicyName]?: Partial<PolicyConfigs[K]> | false } & { extensions?: ExtensionPolicies | false };
export interface PoliciesConfig extends PolicyLayer { profile?: string }
/** The result of layering profiles and route keys: what compiles, per policy. */
export type EffectivePolicies = Partial<PolicyConfigs>;
export interface RobotsConfig { disallow?: string[]; allow?: string[]; sitemap?: boolean; extra?: string[] }
type Changefreq = 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
export interface SitemapConfig { exclude?: string[]; changefreq?: Changefreq; priority?: number }
export interface SecurityTxtConfig {
  contact: string[]; expires: string; policy?: string[]; acknowledgments?: string[];
  preferredLanguages?: string[]; canonical?: string[]; encryption?: string[];
}
export interface SiteConfig { robots?: RobotsConfig; sitemap?: true | SitemapConfig; favicon?: string; securityTxt?: SecurityTxtConfig; llms?: string; notFound?: string }
/** One route as declared in YAML (plus `generated`, which site.ts stamps on the routes it adds). */
interface ConditionalReply { redirect?: RedirectConfig; respond?: RespondSpec }
interface ConditionalConfig { cases: (ConditionalReply & { match: RouteMatch })[]; fallback?: ConditionalReply }
export type EgressHeaders = Record<string,string|{secret:string}>;
interface ProxyConfig extends Omit<ProxyDefinition,'headers'> { headers?: EgressHeaders }
interface SignalConfig { url:string; headers?:EgressHeaders }
/**
 * Route-level `auth` short form: `true`, or an object that expands to `policies.extensions.auth`. Core owns only
 * the mapping and `required` (`false` emits no policy); every other key belongs to the auth extension, whose
 * `policySchema` validates it. Core deliberately does not know that vocabulary.
 */
type RouteAuthConfig = { required?: boolean } & Record<string, unknown>;
/**
 * Where a route's `auth:` short form came from, recorded by `normalizeRouteAuth` so the extension's policy errors
 * can point at `auth` rather than the canonical `policies.extensions.auth` the author never wrote. `requirement`
 * is the value as written minus `required`; with `required: false` it emits no policy but is still validated.
 */
export interface RouteAuthShortForm { required: boolean; requirement: Record<string, unknown> }
export interface RouteConfig {
  extension?:string; auth?: true | RouteAuthConfig;
  /** Route-level `cache` short form: the same object accepted by `policies.cache`, expanded to it before anything else reads the project. */
  cache?: CacheConfig;
  proxy?:ProxyConfig; signals?:SignalConfig[];
  match?: RouteMatch; conditional?: ConditionalConfig;
  methods?: string[]; enabled?: boolean; expires?: string; description?: string;
  /** Opt into the isolated QuickJS/WASM worker pool for this route's `function`/`middleware`
   * chain. Default false: trusted, in-process, unsandboxed
   * execution (docs/FUNCTION-SECURITY.md). Applies uniformly to the whole
   * chain — `function` and any `middleware` on the same route run in the same mode. */
  sandbox?: boolean;
  /** Optional, human-authored justification for this route's sandbox decision — why it
   * needs isolation when `sandbox: true`, or why it is safe to trust when it is not.
   * Parsed and schema-validated (max 500 characters, schemas/urlcode.schema.json), stored
   * on the compiled route and surfaced by `explain`/`context`/manifest next to `sandbox`.
   * Never inferred or enforced: the trust decision remains the author's judgment call
   * (docs/AI-AUTHORING.md, "Deciding when a route needs sandbox: true"). */
  sandboxReason?: string;
  /** Deliver this trusted `function` route's Response body as a stream (chunked, pulled as the function produces it,
   * bounded by the operator's stream limits) instead of reading it whole first. Requires `function`; refused with
   * `sandbox: true` and on every target except the self-hosted runtime (docs/SPECIFICATION.md#streamed-responses). */
  stream?: boolean;
  /** Per-method `audit` coverage waiver: method to a non-empty reason. Project file only (docs/READINESS.md). */
  coveredElsewhere?: Record<string, string>;
  parameters?: ParameterConfig[]; redirect?: RedirectConfig; function?: FunctionConfig;
  env?: Record<string, EnvBinding>; secrets?: Record<string, SecretBinding>;
  page?: PageConfig; download?: DownloadConfig; static?: StaticConfig;
  request?: { body?: RequestBodyPolicy }; response?: { headers?: Record<string, string | string[]> };
  respond?: RespondSpec; middleware?: MiddlewareConfig[]; policies?: PoliciesConfig;
  /** Name of a top-level `shared` block; expanded away at load time, so nothing downstream sees it. */
  use?: string;
  /** Set by site.ts on a route it generated (`site.<key>`); never declared in YAML. */
  generated?: string;
}
/** The route-level fields that select a handler, in priority order for the rare case more than one is set. */
export const handlerNames = ['extension','proxy','conditional','redirect','function','page','static','download','respond'] as const;
export type HandlerName = typeof handlerNames[number];
/** The first declared handler field's name, or `fallback` when the route (or, for a partial view such as `explain`'s route summary, the fields read) declares none. Shared by examples.ts and context.ts, whose only difference was this fallback string. */
export function resolveHandlerName(route: Partial<Record<HandlerName, unknown>>, fallback: string): string {
  return handlerNames.find(name => route[name] !== undefined) ?? fallback;
}
/** A named, reusable `request` and `response.headers` block a route selects with `use`. */
export interface SharedBlock { request?: RouteConfig['request']; response?: RouteConfig['response'] }
export interface ProjectDocument {
  version: '1'; extensions?:Record<string,ExtensionDeclaration>; routes: Record<string, RouteConfig>; includes?: string[];
  policies?: PoliciesConfig; profiles?: Record<string, PolicyLayer>; shared?: Record<string, SharedBlock>; site?: SiteConfig;
}
/** What config.ts returns: the entry document, the merged route table and the files it came from. */
export interface LoadedDocument { root: string; document: ProjectDocument; routes: Record<string, RouteConfig>; files: string[]; version: string; /** Routes whose `policies.extensions.auth` came from the `auth:` short form, by pattern. */ routeAuth?: Record<string, RouteAuthShortForm>;
  /** Only when loaded with `sources`: the file (`urlcode.yaml` or the include path as written) each route and extension declaration came from. */
  sources?: { routes: Record<string, string>; extensions: Record<string, string> } }

// ---------------------------------------------------------------------------
// Compiled routes and assets.

interface CompiledFunction { source: string; export: string; args?: Record<string, ValueRef | Scalar> }
interface CompiledMiddleware { source: string; export: string }
/** One file read into the asset snapshot; a static route holds a Map of them keyed by relative path. */
export interface Asset {
  body: Buffer; modified: string; type: string; attachment: string | undefined; etag: string; cache: string;
  /** Precompressed variants the compression policy attaches at compile time, keyed by content coding. */
  encoded?: Record<string, Buffer>;
}
/** A handler result that came from the asset snapshot, so a later policy can serve a stored variant by identity. */
export interface AssetResult extends HandlerResult { asset?: Asset }
/** `redirect` once compiled: `query.pass` is a list or absent (a declared `false` is dropped), so match.ts's RedirectSpec holds. */
export interface CompiledRedirect extends RedirectSpec { status?: 301 | 302 | 303 | 307 | 308 }
/**
 * The route the router produces: the YAML route with its bindings resolved,
 * its parameters compiled and everything request-time matching, the HTTP
 * policy and the asset snapshot need. Widens MatchableRoute (match.ts).
 */
export interface CompiledRoute extends Omit<RouteConfig, 'methods' | 'parameters' | 'env' | 'secrets' | 'function' | 'middleware' | 'redirect'>, MatchableRoute, HttpRoute {
  pattern: string; parts: string[]; names: string[]; specificity: number; methods: string[];
  parameters: CompiledParameter[]; env: Record<string, string>; secrets: Record<string, string>;
  redirect?: CompiledRedirect; responseHeaders: HeaderPair[]; reply?: Reply; expiresAt?: number; prefix?: string; wildcard?: boolean;
  middleware: CompiledMiddleware[]; function?: CompiledFunction;
  respond?: RespondSpec; page?: PageConfig; download?: DownloadConfig; static?: StaticConfig;
  /** Attached by compileAssets: one asset for page/download, a Map for static. */
  asset?: Asset | Map<string, Asset>;
  /** Attached by the runtime once policies compile; null when the project declares none. */
  policy?: PolicyChain | null;
  /** Attached by build-cloudflare: the compiled policy states shipped in the Worker artifact. */
  compiledPolicies?: Record<string, unknown>;
  extensionPolicyNames?:string[];
  compiledProxy?:ProxyDefinition; compiledSignals?:SignalDefinition[];
  conditionalRoutes?: { cases: { match: RouteMatch; route: CompiledRoute }[]; fallback?: CompiledRoute };
}
export interface CompiledRouteTable {
  exact: Map<string, CompiledRoute>; byLength: Map<number, CompiledRoute[]>; mounts: CompiledRoute[];
  /** Absolute paths of every function module the routes reference. */
  modules: string[]; count: number;
}

// ---------------------------------------------------------------------------
// The host-side policy contract (packages/core/src/policies.ts documents the phases).

export type TargetName = 'node' | 'vercel' | 'aws' | 'cloudflare';
export type PolicySupport = 'native' | 'compiled' | 'delegated' | 'refused';
/** Per-runtime state policies share; released by closePolicies. Each policy owns one key. */
export interface PolicyShared {
  target?: string; log?: LogFn; routes?: number;
  /** Clock override for tests. */
  now?: () => number;
  cache?: CacheStore; throttle?: ThrottleTable; compressionBytes?: number;
}
/** The route facts a policy may read at compile time; a CompiledRoute satisfies it, tests pass less. */
export interface PolicyRoute {
  pattern: string; secrets?: Record<string, string>; methods?: readonly string[]; responseHeaders?: readonly HeaderPair[];
  asset?: Asset | Map<string, Asset>; policies?: PoliciesConfig;
}
export interface PolicyContext { route: PolicyRoute; shared: PolicyShared; target?: TargetName; document?: ProjectDocument; root?: string }
/** The request a policy sees (built by policyRequest): runtime objects, never re-parsed text. */
export interface PolicyRequest {
  method: string; target: string; path: string; params: Record<string, string>; query: URLSearchParams;
  /** The Fetch Headers surface (agents.ts reads it on the Worker); the Node host wraps its header map to match. */
  headers: { has(name: string): boolean; get(name: string): string | null }; headerCounts: Record<string, number> | undefined;
  client: string | null; origin: string | undefined; route: string; secrets: boolean;
}
/**
 * One policy module. Hooks are declared as methods so a module typed with its
 * own Config and State (PolicyModule<CacheConfig, CacheState>) is assignable
 * to the erased PolicyModule the registry and the compiled chain hold.
 */
export interface PolicyModule<Config = unknown, State = unknown, Description extends object = object> {
  name: string; phases: readonly string[];
  targets(config: Config): Record<TargetName, PolicySupport>;
  compile(config: Config, context: PolicyContext): State | Promise<State>;
  onRequest?(state: State, request: PolicyRequest): HandlerResult | undefined | Promise<HandlerResult | undefined>;
  onResponse?(state: State, request: PolicyRequest, result: HandlerResult): HandlerResult | Promise<HandlerResult>;
  onError?(state: State, request: PolicyRequest, error: unknown): HandlerResult | undefined | void | Promise<HandlerResult | undefined | void>;
  /** A JSON summary for the audit and inventory; each module returns its own description shape. */
  describe?(state: State): Description;
  close?(shared: PolicyShared): void | Promise<void>;
}
export interface PolicyStates { agents: AgentsState; throttle: ThrottleState; cache: CacheState; security: SecurityState; compression: CompressionState }
export interface PolicyDescriptions { agents: AgentsDescription; throttle: ThrottleDescription; cache: CacheDescription; security: SecurityDescription; compression: CompressionDescription }
/** A route's policy inventory: each policy's describe() plus the support it got; a delegated policy carries only `target`. */
export type PolicyInventory = { [K in PolicyName]?: Partial<PolicyDescriptions[K]> & { target: PolicySupport } };
/** A module paired with the state it compiled for one route, in phase order. */
type PolicyEntry = [PolicyModule, unknown];
/** What compilePolicies returns for a route: ordered hook chains, the audit summary and each state by name. */
export type PolicyChain = {
  request: PolicyEntry[]; response: PolicyEntry[]; error: PolicyEntry[];
  describe: PolicyInventory;
} & Partial<PolicyStates>;

// ---------------------------------------------------------------------------
// The test plan (readiness.ts builds it from a CompiledRouteTable; compliance
// rules and plugins read it). Declared here structurally so the modules that
// consume it need not import the host module that produces it.

export type RouteState = 'active' | 'disabled' | 'expired';
/** One route in the audit inventory: its handler kind, methods, execution mode and lifecycle state. */
export interface PlanInventoryEntry {
  path: string; handler: string | undefined; methods: string[]; middleware: number; policies: string[]; generated?: string; state: RouteState;
  /** The route's execution mode: `true` when its `function`/`middleware` chain runs in the
   * QuickJS sandbox, `false` when it runs trusted in-process. Route-level, because the mode
   * applies to the whole chain — a native handler with `middleware` has one too. Optional
   * only at the report-parsing boundary: reports written before it existed omit it. */
  sandbox?: boolean;
  /** The route's declared `sandboxReason`, when it has one. */
  sandboxReason?: string;
  /** The route's declared `coveredElsewhere` audit waivers (method to reason), when it has any. */
  coveredElsewhere?: Record<string, string>;
}
export interface TestPlan {
  inventory: PlanInventoryEntry[]; cases: unknown[]; resolve?(path: string): string | undefined;
  policies?: Record<string, PolicyInventory>;
}
