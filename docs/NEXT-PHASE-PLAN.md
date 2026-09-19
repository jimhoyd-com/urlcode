# Next-phase implementation status

Repository review and source implementation, 2026-09-17. Phase A established
the capability catalog; the subsequent source work implements the bounded
Phase B–D features below. This describes the source additions after `0.3.0` that ship in
`0.4.0-alpha.1`, not a claim that provider deployments have been verified.

> **Update:** this document describes the `0.4.0-alpha.1` source work as it
> stood on 2026-09-17, when every `function`/`middleware` route was sandboxed.
> The default changed in `0.4.0-alpha.2`: those routes now run trusted and
> unsandboxed in the host process unless the route declares `sandbox: true`,
> which gives it exactly the QuickJS/WASM execution described below. See
> [SPIKE-DEFAULT-TRUST-MODEL.md](SPIKE-DEFAULT-TRUST-MODEL.md).

## Implementation and evidence

| Phase | Implemented source | Evidence and remaining limits |
| --- | --- | --- |
| A: capabilities and normalized representation | Shared catalog, route/project analysis, CLI/SDK and adapter preflight reuse the existing compiled IR | Capability tests and target refusals; compiled routes with secrets/closures are never a portable public artifact |
| B1: provider conformance | Synthetic 12-case common-subset fixture; local self-hosted/AWS/Vercel/Cloudflare replay; bounded HTTPS deployment runner and versioned reports | Local adapter evidence exists; actual AWS/Vercel/Cloudflare deployments and provider-specific transport/policy guarantees remain unverified |
| B2: Netlify/Cloudflare conversion | Strict literal redirect import/export, source diagnostics, dry-run, no-clobber output and explicit provider-difference acknowledgment | Provider normalization, query forwarding, method coverage and asset precedence differ; acknowledged migrations are explicitly non-lossless |
| B3: Vercel/TOML conversion | Conservative Vercel redirect subset and redirects-only Netlify TOML grammar | Unsupported fields, patterns, conditions, forced rules and general TOML syntax are rejected rather than discarded |
| C1: bounded proxy | Self-hosted native proxy and external revision-pinned HTTPS-origin grants, connection-pinned public DNS, body/time/concurrency limits and header filtering | No guest fetch, host execution fallback, automatic redirects or retries; providers refuse proxy; independent security review remains open |
| C2: conditions | Exact bounded query/header/cookie/host/method predicates; explicit disjoint redirect/respond cases and fallback; no-store | Duplicate YAML keys remain errors; ambiguous cases fail; self-hosted/AWS/Vercel share logic, Cloudflare refuses pending artifact support |
| C3: best-effort signals | Self-hosted bounded webhook broker, external pinned grants, fixed redacted event shape, accepted/delivered/failed/dropped counters and shutdown handling | No queue, retry, ordering or durability guarantee; saturation drops; providers refuse signals |
| D: recipes | Three ordinary local Git-owned recipe projects with list/show/add and new-directory dry-run publication | Runtime integration tests exercise redirect, JSON API and built TypeScript recipe; no remote registry or implicit project merge |
| D: bulk | Strict CSV/JSON/YAML conversion, input fingerprint/source provenance, sorted 1,000-route include shards | 1k/10k/100k local measurements pass without relaxing loader limits; no implicit merge or arbitrary bulk mutation |
| D: TypeScript guests | Fixed trusted build-time compiler, bounded relative graph, rewritten JavaScript imports, referenced-asset snapshot and safe new output | Transpilation is not type checking; no tsconfig/plugins/package execution or dotenv copying; runtime remains QuickJS JavaScript only |
| D: consolidated SDK/MCP | Inspection, semantic validation, path explanation, compatibility, conversion previews and recipe discovery; operator-rooted stdio MCP | Read-only tooling; no arbitrary path, credential, guest execution or write authority; not a remote authenticated service |

See [interchange](INTERCHANGE.md), [provider evidence](PROVIDER-VERIFICATION.md),
[egress](EGRESS.md), [conditions](CONDITIONS.md), [recipes](RECIPES.md),
[bulk measurements](BULK.md), [TypeScript authoring](TYPESCRIPT-AUTHORING.md), and
[tooling/MCP](TOOLING.md) for the executable interfaces and exact restrictions.

## Preserved architecture

The schema and semantic compiler remain the behavior contract. `CompiledRoute`
and `CompiledRouteTable` remain the runtime IR; `MatchableRoute` remains the
shared matching representation. New handlers and conditions extend those paths
rather than introducing a second route compiler. Capability analysis precedes
binding resolution and activation and distinguishes implementation support from
actual deployment evidence. Unknown or unsupported targets fail closed.

Project YAML describes route behavior. Provider infrastructure and outbound
origin grants stay in operator configuration. Through `0.4.0-alpha.1`,
functions remained untrusted QuickJS/WASM guests with no host-code fallback
(see the update note above). <!-- trust-model-prose: historical -->
Existing explicit external bindings and new egress grants remain pinned to the
exact configuration/source revision. Compilation and conversion do not resolve credentials or manufacture
grants. File authors publish new projects without overwriting unrelated work.

The five policy modules remain the authority for their target-sensitive
compatibility. Delegated compression does not imply identical edge behavior;
coalesced headers and normalized URLs remain transport limitations. Conditional
routes are no-store to prevent cross-branch shared-cache leakage. Conditions are
selection rules, not authentication or authority.

## Validation and outstanding external work

New regression suites cover conservative conversion refusals, source diagnostics,
local provider replay, conditions/ambiguity, proxy and signal security boundaries,
recipe execution, TypeScript graph limits, bulk sharding and MCP authority limits.
Package smoke exercises actual archive installation with production dependencies,
CLI authoring/conversion/MCP and the public declaration surface. Schema changes
require regenerated reference documentation and executable examples. Local integration passed `npm run verify` (384 tests: 383 passed, one existing
TLS-fixture skip) and `npm run test:package`, including a production-only install
with TypeScript 6.0.3. Required CI checks and normal pull-request review still
apply to each exact proposed revision.

The bulk benchmark uses fresh sequential processes and records conversion,
normal runtime activation, memory samples and checked runtime lookups for
1,000, 10,000 and 100,000 synthetic redirects. Splitting the last dataset into
100 includes avoids the earlier single-document worker memory failure without
increasing the 256 MiB worker heap or ten-second loader deadline. This is local
capacity evidence, not a cross-platform SLO or peak-memory bound.

### Deferred follow-up: live provider testing (non-blocking)

Decision, 2026-09-17: defer live Cloudflare, AWS and Vercel testing and return to
it later. This does not block the current implementation work or pull-request
review and merge, subject to the normal required checks and authorization.
Provider deployment status remains **unverified** until real tests are recorded;
deferral does not change capability claims or remove other release/security gates.

When resumed, choose a provider and supply an operator-owned test account/project
with normal local login access and authorization for a temporary deployment
(including any hosting charges), or supply an already deployed conformance
fixture URL. Run the existing provider verification tool and record the results.
No credentials or provider setup are needed from the user for the current work.

Actual provider provisioning/deployment observations require operator-owned
accounts and explicit fixture URLs. Real ingress normalization, repeated header
and cookie behavior, distributed policy guarantees, soak/recovery tests and
independent assessment of the new network bridge remain separate release and
operational gates. No implementation test, capability report, benchmark, or CI
pass substitutes for that evidence. The self-hosted release remains useful and
portable without requiring provider accounts or a paid control plane.
