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
urlcode capabilities --target static
```

This command needs no project or credentials. `node` is an alias for
`self-hosted`, matching the existing embedding API. Unknown target names fail.
JSON has `format: 1`, target deployment evidence and capability rows.
`doctor` also reports `capabilityTargets`; its `providers` list remains empty
because no provider deployment has been verified. Canonical
names follow the schema (`respond`, `extension`, `policies.security`), not
marketing synonyms. `proxy` and `signals` are self-hosted capabilities requiring
external revision-pinned origin grants. `conditions` (`match`) and `conditional`
(disjoint cases) are supported by self-hosted/AWS/Vercel and refused by
Cloudflare (no artifact lowering yet) and by `static` (no server to match a
request against). `extension`/`policies.extensions` report per-extension
support from the registered extension's own declared `targets` when a
`--host-file` is supplied; without one they report `conditional`/`unknown`
rather than a blanket answer. See [egress](EGRESS.md) and
[conditions](CONDITIONS.md).

| Support | Meaning |
| --- | --- |
| native | Implemented by the local runtime or Node adapter |
| compiled | Implemented by the Cloudflare or static-hosting compiler and its runtime/build output |
| conditional | Depends on configuration; inspect the actual project |
| delegated | Existing policy contract relies on provider behavior |
| refused | No implementation that this target can activate |
| unknown | No support evidence; fail closed during project analysis |

`native` and `compiled` describe local implementation tests. AWS, Vercel,
Cloudflare and static deployment evidence remains **unverified**. This is not a
blanket exact-portability promise. Cloudflare coalesces duplicate headers and
receives a normalized Request target; AWS accepts payload v2 only; `static` has
no server at all, so it refuses every capability that needs one (parameters,
request bodies, response headers, bindings, every `policies.*`) in addition to
`function`/`middleware`. See [Cloudflare](CLOUDFLARE.md), [AWS](AWS.md),
[Vercel](VERCEL.md) and [static hosting](STATIC.md) for transport and fidelity
limits. Compression is explicitly delegated, not verified equivalent to
operator-selected settings. Route throttle counters and caches remain per
instance. No supported entry bypasses semantic validation, required operator
grants or deployment prerequisites.

## One capability or one schema fragment

```sh
urlcode capabilities redirect
urlcode capabilities policies.throttle --json
urlcode schema route
urlcode schema policies.cache --json
urlcode schema site.sitemap --yaml
```

`urlcode capabilities <name>` prints one catalog entry: its kind (handler,
policy, routing, request, binding, egress, middleware or project), a summary,
the resolved schema fragment(s), constraints, the operator grants the capability
needs at activation, support per target, the targets that refuse it, and the
bundled recipes and cookbook routes that use it. Names are the catalog names
(`redirect`, `bindings`, `policies.cache`); an unknown name fails with exit 1
and lists the valid names. `--target` applies to the full catalog only.

`urlcode schema <path>` prints only that fragment of
`schemas/urlcode.schema.json` with local `$ref`s resolved inline. Paths are
top-level document keys (`routes`, `policies`, `site`, `extensions`), `route`,
or a route property (`redirect`, `middleware`, `match`, `env`), optionally
followed by nested property names (`policies.cache`, `request.body`,
`site.sitemap`). Resolution is bounded and cycle-safe; where a nested object is
its own path (`route` inside `routes`, `policies` inside `route`) it is
summarized with a `$comment` naming that path so every fragment stays under
16 KiB. Fragments describe shape only: they carry no defaults, validation
result or operator authority, and the full schema remains the contract.

Both commands read bundled package data and need no project, credentials or
network. The SDK exposes them as `getCapability(name)` and
`getSchemaFragment(path)`; the MCP server as `get_capability` and `get_schema`
(see [tooling](TOOLING.md)). Grant descriptions name the operator flag or policy
involved, never binding values.

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
checked. `analyzeProjectCapabilities`/`analyzeCompiledCapabilities` take an
optional resolved extension registration set (the same shape `--host-file`
loads); pass it to get per-extension `refused`/`native` from that extension's
own `targets` instead of the generic `conditional`/`unknown` answer.
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
  → host assets + policy chains + trusted or isolated function dispatch, or Worker artifact
```

`CompiledRoute` in `packages/core/src/types.ts` extends shared `MatchableRoute` with validated
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
[Interchange](INTERCHANGE.md) projects a validated literal-redirect subset and
explicitly reports unsupported semantics; it never dumps compiled routes.
The next-phase schema extends this same IR with normalized condition cases,
proxy headers and signal definitions. Resolved egress headers are private runtime
state and must never be serialized. Capability analysis itself adds no authority
and does not run in the request path.

Provider deployment tests, independent security review and operational
soak/recovery proof are separate work.

The configured 100,000-route ceiling is not evidence that every 100,000-route
YAML document fits the loader's resource bounds. See [bulk imports](BULK.md)
for the supported sharding approach. Capability analysis adds linear activation
work and temporary report allocations; no request-time checks are added.
