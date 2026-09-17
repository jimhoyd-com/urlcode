# Next-phase implementation plan

Repository review, 2026-09-17. Scope of this change: Phase A only.

## Existing implementation and gaps

| Direction | Repository evidence | Next step |
| --- | --- | --- |
| Portable behavior | Strict composed YAML, schema, bounded semantic compiler, indexed matching; seven handlers, parameters, HTTP rules, site-generated routes | Preserve the contract and matching precedence |
| IR | `CompiledRoute` / `CompiledRouteTable` in `src/types.ts`, produced by `router.ts`; shared `MatchableRoute`; Cloudflare projects this into its versioned artifact | Formalize these stages rather than add a second route compiler |
| Capabilities | Five policy modules expose configuration-dependent `targets()`; handler refusal lists in `adapters.ts` and `build-cloudflare.ts`; bindings checked separately | One capability catalog and project/route analysis, reusing policy decisions |
| Providers | AWS payload v2 and Vercel Node adapters; Cloudflare declarative compiler; local parity tests | Keep deployment evidence explicitly unverified; no new provider claims |
| Conversion | Link-store NDJSON backup and single redirect authoring exist, not provider or bulk route interchange | Add strict redirect interchange and conversion reports after Phase A |
| Proxy / conditions / signals | No portable schema or runtime implementation; existing route methods/expiry and operator observers are narrower concepts | Separate security/specification changes; do not relabel these as implemented |
| Recipes | Starter, cookbook, scaffold, schema, generated YAML reference and AI guide exist | Build a Git-owned catalog over executable examples |
| Bulk routes | Includes, duplicate/overlap checks, 100k route cap, indexed literals, routing benchmark exist | Add provenance-preserving CSV/JSON/YAML conversion and 1k/10k/100k measurements |
| TypeScript | Runtime source and shipped declarations exist; guest sources remain JS/MJS | Separate build-time guest transpilation from WASM execution |
| SDK / MCP | Public embedding, config, policy, compliance, observability and provider APIs exist | Add capability API now; stabilize inspection/conversion before MCP |

## Architectural decisions for Phase A

Use schema names: `respond`, `link`, `request.body`, `response.headers`,
`policies.agents`, `policies.security`, `policies.cache`, `policies.compression`,
`policies.throttle`, plus handler/input/binding and project `dynamicLinks`
capabilities. Avoid duplicate `response`/`respond` and `securityPolicy` names.
Policies keep their existing config-sensitive target functions as the authority.

The catalog distinguishes native, compiled, delegated, conditional, refused and
unknown support. Local implementation evidence is separate from provider
verification. Delegated compression does not promise identical edge settings;
header coalescing and target normalization remain transport limitations.
Unknown targets fail closed. No YAML/schema changes are needed for Phase A:
capabilities are derived, never self-granted declarations or infrastructure.

Reuse the compiled IR for analysis. A lightweight declaration preflight uses
the same requirement projection before bindings, source snapshots, assets or
workers are activated. This catches all unsupported routes without resolving
secrets or requiring a missing asset first. It is not semantic validation;
normal compilation and policy validation still follow. Compiled routes contain
resolved secrets, validator closures and later host state: never serialize them
as a public portable artifact. Export only capability facts and reasons.

Provider adapters share this check; Cloudflare still owns serialization and
validator generation. No request-time capability lookup is needed. Preserve
policy delegation and operator grants. An embedding target is a compatibility
constraint, not permission to execute untrusted host code.

## Small PR sequence

1. **Phase A (this PR):** catalog/API/CLI, shared compatibility checks, normalized
   representation documentation, negative and provider regression tests. These
   changes are one cohesive replacement of duplicated target decisions.
2. **Phase B1:** provider deployment fixtures and recorded evidence; resolve
   transport differences and policy guarantees before widening support.
3. **Phase B2:** lossless simple Netlify/Cloudflare redirects import/export with
   source diagnostics, dry-run and conversion reports; reject unsupported rules.
4. **Phase B3:** Vercel conversion and TOML investigation with explicit semantics.
5. **Phase C1:** proxy threat model and specification, then implementation: external
   operator allowlists, public-address checks with connection-pinned DNS, no
   automatic redirects, body/time limits, header filtering and secret redaction.
6. **Phase C2:** bounded conditions, duplicate-path representation and deterministic
   precedence; schema migration design and ambiguity tests before runtime work.
7. **Phase C3:** bounded best-effort signals; explicit delivery/drop, concurrency,
   timeout, retry, ordering and shutdown semantics before a webhook broker.
8. **Phase D:** local recipes; safe bulk conversion/benchmarks; build-time guest TS;
   consolidated SDK then optional MCP. No framework or general job platform.

## Validation and documentation

Exercise catalog/CLI JSON, aliases and invalid targets; all handlers and effective
policy inheritance/disable/profile/partition cases; disabled and generated routes;
aggregate route-specific refusals; rejection before secret resolution or output
writes. Retain provider HTTP parity, sandbox, binding denial and asset tests.
Run `npm run verify` and `npm run test:package`, and measure routing startup and
lookup because activation gains a linear preflight. No schema regeneration or
starter behavior change is required. Add architecture/capability docs and links
from the contract, roadmap, AI authoring guide, README and llms.txt. CI/container,
provider deployment, soak and independent security evidence remain distinct.
