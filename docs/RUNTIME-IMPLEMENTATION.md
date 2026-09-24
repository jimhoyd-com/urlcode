# Implementing the URLCode contract

This is a contributor directive and implementation map for people and agents
building or changing a URLCode runtime. It turns the project-format contract
into small, language-neutral units of work. It is not a second source format,
an SDK specification, or a claim that another runtime already exists.

The normative behavior remains the [implemented specification](SPECIFICATION.md),
the [JSON Schema](../schemas/urlcode.schema.json), and the focused topic
contracts they link to. If this guide conflicts with one of those sources, fix
this guide; do not make a runtime choose between them.

This file is contributor documentation. It is deliberately not included in
`llms-full.txt`, the npm tarball, or the production container image. The guide
must not be copied into runtime source comments merely to make it visible to an
agent: this repository's type-stripping build preserves source comments in
`dist/`.

## Directive

> Implement URLCode as a checked behavioral contract, not as a translation of
> TypeScript. A runtime must either reproduce a declared capability and pass its
> fixtures, or refuse that capability before serving.

When changing a core semantic boundary, maintainers must:

1. identify the affected contract ID below;
2. update the implementation card and the authoritative semantic document;
3. add or update a behavior fixture at the narrowest relevant layer; and
4. preserve explicit refusal where a target or runtime cannot provide the
   behavior.

Do not add a prose prompt beside every implementation function. Such prompts
drift, make deployed artifacts larger, and cannot prove equivalence. Keep the
portable instruction here, link it to the source symbol, and use executable
fixtures as the proof.

## What is portable

The YAML-defined behavior is the portability target: validation, normalization,
route selection, input parsing, declared responses, redirects, assets,
conditions, policies, and refusal behavior where a runtime implements them.

Project `function` and `middleware` modules are different. The trusted default
means JavaScript executed in-process with ordinary Node access. Another runtime
does **not** implement that by translating the module or pretending its host
access is equivalent. It must either provide an explicitly documented compatible
guest mode or refuse that route before activation. The existing `sandbox: true`
QuickJS/WASM behavior is also a separate, bounded execution contract, not a
general promise that arbitrary code is portable. See [function security](FUNCTION-SECURITY.md).

Operator bindings, host plugins, extension registration, deployment transport,
filesystem layout and resource limits are host-owned. An alternate runtime must
state its own operational limits and must never let project YAML grant itself
authority.

## Contract cards

Each card is a useful unit for an implementation agent. The card says what to
build; the linked specification says every accepted value and edge case.

<!-- runtime-contract-map:start -->
| ID | Source seam in this runtime | Implementer task | Primary evidence |
|---|---|---|---|
| `RIM-CFG-001` | `packages/core/src/config.ts`: `parseYaml` | Parse the restricted YAML 1.2 JSON-value profile; reject ambiguity and unsafe YAML before schema validation. | [Files and validation](SPECIFICATION.md#files-and-validation), `test/config.test.ts` |
| `RIM-CFG-002` | `packages/core/src/config.ts`: `validateDocument`, `loadDocumentInWorker`, `normalizeRouteAuth` | Validate the schema, resolve includes and shared blocks, and normalize short forms before any consumer sees a route. | [Files and validation](SPECIFICATION.md#files-and-validation), [shared blocks](SPECIFICATION.md#shared-blocks), `test/config.test.ts` |
| `RIM-CAP-001` | `packages/core/src/capabilities.ts`: `analyzeProjectCapabilities`, `assertTargetCompatibility` | Inspect the fully normalized project and refuse each unsupported capability with its route named before activation. A capability whose configuration a target cannot honor (non-default `policies.compression` on Vercel/AWS/Cloudflare) is refused the same way, not silently accepted and dropped; a capability that is genuinely enforced but only with a caveat the analysis cannot verify (`policies.throttle`'s `partition: route` on Vercel/AWS, which is real per-instance in-process enforcement, not `native`, because its effective quota is quota × instance count) is reported `delegated` with that caveat named, never `native`. | [Capabilities](CAPABILITIES.md), [policies](POLICIES.md#portability-and-the-per-target-table), `test/capabilities.test.ts`, `test/policy-compression.test.ts` |
| `RIM-COMPILE-001` | `packages/core/src/router.ts`: `compileRoutes` | Compile validated declarations into a deterministic route table; reject ambiguous routes, invalid bindings, and invalid handler combinations before serving. | [Routes](SPECIFICATION.md#routes), `test/config.test.ts`, `test/http.test.ts` |
| `RIM-MATCH-001` | `packages/core/src/match.ts`: `parseTarget`, `matchRoute` | Decode a request target once and select exactly one route by the documented precedence; match before method admission. | [Routes](SPECIFICATION.md#routes), [routing](ROUTING.md), `test/match.test.ts` |
| `RIM-INPUT-001` | `packages/core/src/match.ts`: `contextFor`, `redirectLocation` | Parse and validate declared path/query/header inputs, apply defaults only when absent, and assemble redirects from explicit values only. | [Inputs](SPECIFICATION.md#inputs), [redirects](SPECIFICATION.md#redirects), `test/match.test.ts` |
| `RIM-PATTERN-001` | `packages/core/src/pattern-guard.ts`: `assertSafePattern`, `backtrackingPaths` (re-exported from `@jimhoyd/urlcode/extensions` for workspace packages); `packages/core/src/policies/agents.ts`: `validatePattern`, `onRequest`; `packages/forms/src/forms.ts`: `validateFlow` | Admit an author regex (parameter and body `pattern`; agents `denyPatterns`, `allowPatterns` and list entries; forms field `pattern`) only when its worst-case matching cost is bounded: refuse repeated quantified groups, lookaround and backreferences, cap unbounded quantifiers, charge every variable-width quantifier (`*`, `+`, `?`, `{n,}`, `{n,m}` with `m > n`) and alternation against one backtracking-path budget, and bound the input (128 characters for parameters, bodies and forms fields; only the first 512 bytes of `User-Agent` are matched). Refuse the same patterns on every target, even one with a linear-time engine, so a project validates identically everywhere. A workspace package that accepts an author-supplied pattern must call this shared guard rather than keep its own copy, so admission cannot drift. | [HTTP](HTTP.md), [agents policy](policies/agents.md#the-pattern-subset), `test/body-validation-limits.test.ts`, `test/policy-agents.test.ts`, `packages/forms/test/forms.test.ts` |
| `RIM-CONDITION-001` | `packages/core/src/conditions.ts`: `normalizeMatch`, `assertDisjointMatches`, `matchesRoute` | Normalize exact conditions, reject overlapping conditional branches, and use the configured origin rather than client host text. | [Exact conditions](SPECIFICATION.md#exact-conditions-and-duplicate-path-alternatives), `test/conditions.test.ts` |
| `RIM-HTTP-001` | `packages/core/src/http-policy.ts`: `compileHttp`, `checkRequest`, `decorateResponse` | Enforce body admission and response-header ownership before and after a handler without silently relaxing limits. A route with a JSON `request.body.schema` answers a failing body with a JSON 422 listing every issue, naming only schema-declared paths and identifier-shaped undeclared properties, never a value. | [HTTP configuration](SPECIFICATION.md#http-requestresponse-configuration), [HTTP](HTTP.md), `test/http-policy.test.ts`, `test/body-validation-json.test.ts` |
| `RIM-POLICY-001` | `packages/core/src/policies.ts`: `effectivePolicies`, `compilePolicies`, `policyRequest` | Merge profile/project/route policy layers, compile only enforceable policies, and run their request/response/error hooks in the declared order. | [Policies](SPECIFICATION.md#policies), [policy pipeline](POLICIES.md), `test/policies.test.ts` |
| `RIM-ASSET-001` | `packages/core/src/assets.ts`: `compileAssets`, `assetResponse` | Snapshot declared assets at activation and serve the selected asset with its documented HTTP semantics; a missing selected mount asset does not fall through. | [Assets](ASSETS.md), [Routes](SPECIFICATION.md#routes), `test/assets.test.ts` |
| `RIM-DISPATCH-001` | `packages/core/src/runtime.ts`: `createRuntime` | Activate a complete immutable snapshot, then run request parsing, matching, admission, policies, handler dispatch, response decoration and error handling in order. | [Specification](SPECIFICATION.md), [readiness](READINESS.md), `test/http.test.ts` |
| `RIM-GUEST-001` | `packages/core/src/trusted-functions.ts`: `TrustedFunctions`; `packages/core/src/functions.ts`: `FunctionPool` | Keep trusted Node execution and `sandbox: true` execution distinct. Do not substitute one for the other, and do not claim either is portable to an unrelated host. A failed trusted call answers the generic 502/504; its source, thrown message and stack go only to the opt-in operator diagnostics channel, never the response or event log. | [Functions](SPECIFICATION.md#functions), [function security](FUNCTION-SECURITY.md), `test/trusted-functions.test.ts`, `test/dev-diagnostics.test.ts`, `test/sandbox.test.ts` |
| `RIM-EXT-BUNDLE-001` | `packages/core/src/extension-bundles.ts`: `installBundle`, `loadExtensionBundle`; `packages/core/src/extension-artifacts.ts`: `installArtifact`; `packages/core/src/extension-transport.ts`: `verifiedReleaseAsset`, `peekCatalogCommit`; `packages/core/src/init-with.ts`: bundle distribution | Treat an executable extension bundle (and a declarative extension artifact) as trusted operator code/data, never project-selected: verify the exact immutable GitHub tag attestation, digest, bounded archive and locked cache before loading its declared module entry. A catalog's own `commit` field is not merely recorded -- it is bound to that catalog attestation's cert-derived `--source-digest` (peeked ahead of the catalog's full parse) before the field is trusted, and every subsequent asset attestation for that release is bound to the same confirmed commit; a mismatch fails closed (#577). `init --with --bundle-release` may obtain scaffolds only from that verified temporary staging cache, then writes the lock/cache and explicit host bindings; it never turns YAML into a release selector or npm extension dependency. Refuse an incompatible core version before import. Preserve the separate `sandbox: true` route contract unchanged. A package may publish a second, separately named catalog entry that locks a different, non-host-activation module (for example `ui-presentation` locking `ui`'s root export instead of its `host/index.js`); such an entry is signed, versioned and integrity-locked exactly like any other bundle name and is never treated as scaffoldable by `init --with` unless its `scaffold` export actually names it (#522). | [Extensions](EXTENSIONS.md), [function security](FUNCTION-SECURITY.md), `test/extension-bundles.test.ts`, `test/extension-artifacts.test.ts`, `test/init-with.test.ts`, `test/workspace-scaffold.integration.ts` |
| `RIM-OUTPUT-001` | `packages/core/src/http-response.ts`: `prepareResponse`, `errorResponse` | Produce a bounded HTTP response, preserve separate cookies, remove hop-by-hop headers, and suppress a HEAD body without changing handler selection. Content-Length is always the UTF-8 byte length of the body sent; a handler-stated length is honoured only on HEAD, where it reports what GET would send. A header repeated in the assembled result is written as separate wire lines, never collapsed to only its last value; the two runtime-owned singleton headers (`X-Content-Type-Options`, `X-Request-Id`) are the one exception, always exactly one line each regardless of what a handler set. | [Functions](SPECIFICATION.md#functions), [HTTP](HTTP.md#responses), `test/http.test.ts`, `test/response-length.test.ts` |
<!-- runtime-contract-map:end -->

The `test/runtime-implementation-contract.test.ts` guard verifies that every
source seam named above still exists. It does not prove semantic equivalence;
the focused fixtures do that work.

## Prompt shape for an implementation agent

Give an agent one card at a time. A good prompt is short because the contract
and fixtures carry the detail:

> Implement `RIM-MATCH-001` in the target language. Read the card, the linked
> specification section, and its fixtures. Preserve all stated rejection
> behavior and route precedence. Do not add new YAML fields or emulate a
> capability the target cannot enforce. Return the implementation plus every
> fixture result; label unsupported behavior as refusal.

The agent should not be asked to reproduce the TypeScript module structure or
to infer semantics from a happy-path example. A maintainer reviews the contract
diff, the focused implementation, and the fixture results.

## Building another runtime incrementally

Start with the smallest useful declarative profile: `respond`, `redirect`,
path matching, declared input validation, and the request/response rules those
handlers need. Run the shared fixtures against the existing Node runtime first,
then against the new runtime.

Add one capability only when its card, fixtures, rejection paths and operational
ownership are clear. Until then, reject activation with the route and capability
named. Do not call a runtime fully compatible because it accepts the schema; it
is compatible only for the capabilities it demonstrably implements.
