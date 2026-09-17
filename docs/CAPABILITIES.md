# Capabilities and normalized route representation

URLCode is a portable runtime for programmable URL behavior: **URL behavior as
code**. YAML describes behavior; operators supply infrastructure and authority.

## Inspect target support

```sh
urlcode capabilities
urlcode capabilities --target self-hosted
urlcode capabilities --target cloudflare --json
urlcode capabilities --target aws
urlcode capabilities --target vercel
```

This command needs no project or credentials. `node` is an alias for
`self-hosted`, matching the existing embedding API. Unknown target names fail.
JSON has `format: 1`, target deployment evidence and capability rows.
`doctor` also reports `capabilityTargets`; its `providers` list remains empty
because no provider deployment has been verified. Canonical
names follow the schema (`respond`, `link`, `policies.security`), not marketing
synonyms. Proxy, conditions and signals are not implemented or admitted by the
schema, and are not advertised as capabilities.

| Support | Meaning |
| --- | --- |
| native | Implemented by the local runtime or Node adapter |
| compiled | Implemented by the Cloudflare compiler and artifact runtime |
| conditional | Depends on configuration; inspect the actual project |
| delegated | Existing policy contract relies on provider behavior |
| refused | No implementation that this target can activate |
| unknown | No support evidence; fail closed during project analysis |

`native` and `compiled` describe local implementation tests. AWS, Vercel and
Cloudflare deployment evidence remains **unverified**. This is not a blanket
exact-portability promise. Cloudflare coalesces duplicate headers and receives a
normalized Request target; AWS accepts payload v2 only. See [Cloudflare](CLOUDFLARE.md),
[AWS](AWS.md) and [Vercel](VERCEL.md) for transport limits. Compression is
explicitly delegated, not verified equivalent to operator-selected settings.
Route throttle counters and caches remain per instance. No supported entry
bypasses semantic validation, required operator grants or deployment prerequisites.

## Programmatic analysis

The main package exports `getCapabilities`, `routeCapabilities`,
`analyzeProjectCapabilities`, `analyzeCompiledCapabilities`,
`assertTargetCompatibility`, `normalizeCapabilityTarget` and their report types.

```js
import { loadDocument, analyzeProjectCapabilities,
  assertTargetCompatibility } from '@jimhoyd/urlcode';

const loaded = await loadDocument('./project');
const report = analyzeProjectCapabilities(loaded, 'cloudflare');
console.log(report.issues); // path, capability, support, reason; never binding values
assertTargetCompatibility(report);
```

This low-level example examines declared routes. Runtime activation and builds
first expand `site` conventions using the operator origin, then analyze all
routes including generated ones. A report is a compatibility preflight, **not**
a substitute for compilation/validation. Disabled and expired routes are still
checked; project `dynamicLinks: true` is a requirement even with no link route.
`compatible` means there are no refused, unknown or unresolved conditional
requirements. Explicit delegation and transport limitations still apply.

Requirements include effective inherited/profile policies after route overrides
and `false` removals. Policy modules' existing `targets(config)` functions remain
the source of policy decisions. The catalog says serverless throttle is
conditional; a project report resolves `partition: route` to native and the
client partitions to refused. Reports contain paths and capability facts, not
sources, destinations, binding names/values, code, validator closures or assets.

Build/activation refusals aggregate all incompatible requirements and name each
route, capability, target and reason before any artifact files are written.
Unsupported bindings on Cloudflare fail before credentials are resolved.

## Existing IR, formalized

The implementation already has a useful internal representation:

```text
strict YAML + schema validation + includes
  → site expansion
  → shared capability preflight (declarations, no credentials)
  → semantic route compilation
  → CompiledRouteTable / CompiledRoute
  → capability analysis / target lowering
  → host assets + policy chains + isolated function pool, or Worker artifact
```

`CompiledRoute` in `src/types.ts` extends shared `MatchableRoute` with validated
parameters, normalized HTTP replies/headers, resolved bindings and source
references. `CompiledRouteTable` indexes literal paths, parameter buckets and
static mounts. `router.ts` owns precedence, collision checks, default methods,
input/reference validation and normalization. `match.ts` supplies portable
request-time matching to both runtime and Worker. No second parser or competing
route IR is introduced.

`routeCapabilities` is a value-free projection used for both declaration
preflight and compiled analysis. Preflight deliberately precedes full semantic
validation to report unsupported features before reading missing assets or
resolving secrets; it cannot authorize or validate a project. Normal compilation
and policy validation still run. AWS/Vercel consume the shared runtime IR;
Cloudflare additionally analyzes the compiled table before serializing its
allowlisted artifact fields and standalone validators.

The compiled table is internal, mutable during activation and **not serializable
as an interchange contract**: bindings contain resolved secrets, validators are
functions, assets contain bytes and policy chains own host state. The existing
Cloudflare artifact is a separate versioned lowering, not a replacement IR.
Future interchange should project safe normalized semantics and explicitly
report losses; never dump compiled routes. Phase A adds no YAML/schema fields,
no authority grants, no guest APIs and no request-time capability checks.

See the [repository review and incremental plan](NEXT-PHASE-PLAN.md) for the
remaining phases. Provider deployment tests, independent security review and
operational soak/recovery proof are separate work.

## Local performance check

2026-09-17, Node 26.8.2, macOS arm64, Apple M4 Pro, 48 GiB RAM.
`npm run benchmark -- <count>` runs 5,000 loopback requests at concurrency 16.
Single runs against baseline `1a00294` and this change, not a statistical study:

| Routes | Startup ms before / after | RSS MiB before / after | Heap MiB before / after | Requests/s before / after | p95 ms before / after |
| --- | --- | --- | --- | --- | --- |
| 1,000 | 135 / 138 | 183 / 182 | 29 / 34 | 24,645 / 24,701 | 1.18 / 1.23 |
| 10,000 | 312 / 303 | 211 / 207 | 55 / 63 | 6,762 / 6,829 | 4.08 / 4.09 |

Both baseline and updated 100,000-route runs failed with `Configuration worker
resource limit or failure` before route compilation. The worker's existing
resource bounds are unchanged; the configured 100k route ceiling is not evidence
that every 100k YAML document fits those bounds. Bulk-scale remediation and
repeatable memory profiling remain subsequent work. Capability analysis adds
linear activation work and temporary report allocations; no request-time checks
were added. These measurements are not provider, soak or capacity certification.
