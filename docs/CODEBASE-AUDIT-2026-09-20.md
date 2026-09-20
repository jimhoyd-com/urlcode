<!-- trust-model-prose: historical-file -->
<!-- This report quotes the defective wording it is reporting -- including the
     pre-trusted-default claims in finding 4 -- so the prose gate would read the
     quotations as the guidance itself. The file is a dated review of one
     commit and is not edited as the defects are fixed. -->

# Codebase, tooling and documentation audit — 2026-09-20

Reviewed commit: `bca8ac7` (core 0.4.0-alpha.2, auth 0.1.0-alpha.5,
admin 0.1.0-alpha.4, UI 0.1.0-alpha.6). Local environment: macOS,
Node 26.8.2. Date is UTC. This report records findings; it does not change
runtime behavior or remove supported features.

The trusted default is implemented correctly in the dispatch paths inspected:
only a route declaring `sandbox: true` enters the QuickJS pool. Ordinary
project functions and middleware run in Node. Host access by trusted code is
intentional, not an audit finding. Binding grants scope injected context;
they do not confine trusted code's independent filesystem, environment or
network access. Opt-in sandbox isolation and provider refusals remain necessary.

## Scope and method

Inventoried 966 tracked files. Reviewed the implemented specification,
contribution/security instructions, runtime activation/dispatch, module loading,
TypeScript authoring, inspection/manifests/diffs, extension hooks, workspace
contracts, package/build/check scripts, CI/release configuration, starter,
example/recipe coverage and documentation indexes. Used targeted source review,
the complete local verification suite and synthetic reproductions. This is a
repository-wide engineering audit, not a claim that every line or execution
path received independent security review.

Scanned tracked non-archive/non-spike Markdown for local links and YAML fences:
64 YAML fences, 49 route/project-shaped candidates. Added only an omitted
format version or the documented route wrapper for schema checks. Classified
partial illustrations separately from complete examples. Semantic constraints,
external services and prose fragments require more than schema validation.

Searched existing repository issues before filing. Five new issues and new
evidence on existing issue 168 retain all actionable findings below.

## Findings, ordered by practical impact

### 1. Inspection hides middleware execution-mode changes — P2

[Issue 199](https://github.com/jimhoyd-com/urlcode/issues/199).

For a `respond` route with `middleware: [mw.mjs]`, switching `sandbox` from
true to false produces identical manifest route records and an empty route
diff. This changes execution from QuickJS to full Node without appearing in
those review surfaces. The overall manifest digest can change; it does not
explain the change to reviewers.

`src/explain.ts` adds sandbox information only inside the function-handler
case. `src/manifest.ts` carries that handler object forward, while
`src/readiness.ts` and `src/route-diff.ts` omit execution mode from inventory.
Context already exposes it at route level.

Reproduction: create the same middleware/native route in both modes, call
`buildManifest`, obtain `createRuntime(...).testPlan()`, then call `diffRoutes`.
Observed diff: `{"added":[],"removed":[],"changed":[]}`. Add route-level
execution mode/reason to explain, manifest and inventory, with compatibility
handling for older inventory files and regressions for both handler kinds.

### 2. Auth/admin hook reactivation serves stale entry code — P2

[Issue 198](https://github.com/jimhoyd-com/urlcode/issues/198).

Both `packages/auth/src/lifecycle-hooks.ts` and
`packages/admin/src/admin-hooks.ts` import an unchanged file URL. Loading a
hook, editing its entry file, then loading it again in the same process returns
the old hook. A synthetic decision changed on disk from allow/v1 to deny/v2;
both loaders still returned allow/v1 after reactivation.

Native trusted routes already give entry modules a new URL per activation.
Apply an explicit hook reload policy and test it, or clearly require process
restart for hook changes. This reproduction exercised the loaders directly,
not the end-to-end development watcher and account flow. Transitive Node module
caching is a separate, already documented limitation. Keep trusted execution
as the default and reject unsupported sandbox hooks explicitly.

### 3. TypeScript authoring rejects valid mixed-trust module reuse — P2

[Issue 197](https://github.com/jimhoyd-com/urlcode/issues/197).

`src/typescript-authoring.ts:34` assigns each source one trust mode and rejects
reuse from a different mode. Two routes sharing a pure `f.ts`, one trusted and
one sandboxed, fail with “Module is imported by both a sandboxed and a trusted
route”. The equivalent JavaScript project activates and both routes return
200/ok. Shared transitive helpers have the same restriction.

Separate emission deduplication from sandbox reachability validation. A helper
reachable by a sandboxed route must still satisfy all sandbox import/source
budgets; trusted execution must not be downgraded or unnecessarily restricted.
Also reconcile the documented unlimited trusted source size with the builder's
16 MiB per-file authoring cap.

### 4. Live guidance still contradicts trust by default — P2

[Issue 196](https://github.com/jimhoyd-com/urlcode/issues/196).

- `docs/yaml/functions.md:57` denies Node/npm/network/filesystem APIs immediately
  after an ordinary trusted route example.
- `docs/yaml/middleware.md:26` describes a mandatory shared sandbox.
- `docs/MIDDLEWARE.md:49` applies guest clone/body restrictions without scoping
  them to sandboxed execution. Reproduced: trusted middleware reads a native
  response body and returns its uppercase text; the sandboxed version rejects
  that operation.
- `docs/SPECIFICATION.md` says `.js` ESM behavior is independent of package
  settings. Reproduced: ESM `f.js` under `type: commonjs` fails trusted activation
  and works in the sandbox. Ordinary Node resolution is the intended default;
  the documentation should explain `.mjs` and package type accurately.
- `README.md` and `docs/FRAMEWORK.md` overstate binding grants as the only way
  secrets reach code. Scope that statement to injected bindings.
- `docs/READINESS.md` calls the activated runtime isolated; the first test in
  `test/typescript-authoring.test.ts` claims QuickJS execution but omits sandbox.

The prose guards pass this revision despite these contradictions. Strengthen
specific regression fixtures and fix the guidance; do not impose old sandbox
restrictions on trusted code to make the prose true.

The POST/body-based sandbox advisory is a related cleanup candidate. It is
non-blocking and documented, but suggests isolation from request shape rather
than evidence about code trust. Review whether to remove or reword it while
retaining explicit `sandboxReason` information. This is a recommendation, not
a discovered isolation failure.

### 5. Copyable documentation examples fail validation — P2

[New evidence on issue 168](https://github.com/jimhoyd-com/urlcode/issues/168#issuecomment-5747024306).

- `docs/yaml/policies.md:18` uses `page.source`; the field is `page.file`.
- `docs/policies/compression.md:35` uses `secret: api-key`, rejected by the
  external binding-name grammar; an identifier such as `api_key` is admitted.
- `docs/AI-AUTHORING.md:249` omits the leading slash on `webhooks/stripe`.
  This also illustrates why schema checks alone cannot replace semantic route
  validation. The same section still lists the retired `link` handler.

The first two are complete fenced projects and fail `validateDocument`.
The partial profile illustration in `docs/POLICIES.md:169` was excluded from
findings because it deliberately omits a handler. Add classified executable
snippets: complete projects, context-dependent fragments and intentionally
invalid examples. Existing cookbook tests do not validate every prose example.

### 6. Monorepo ownership, navigation and release prose need cleanup — P3

[Issue 200](https://github.com/jimhoyd-com/urlcode/issues/200).

- Package AGENTS files still direct findings to former package repositories.
- Framework/status pages retain former source homes, old alpha combinations,
  private cross-repository credential instructions and peer-pin language.
- Two admin README links target nonexistent package-local release workflows.
- Documentation navigation duplicates cookbook entries with conflicting 25/40
  counts; llms.txt repeats semantics and TypeScript entries.
- Hook comments claim core lacks a sandbox primitive although SandboxPool is
  exported. The packages still explicitly reject sandboxed hooks; update the
  reason and tracked work rather than claiming they already support them.

Use local links and one canonical version/ownership inventory for live material;
keep dated release evidence clearly historical. Consolidate the duplicate
SQLite preflight predicates through development tooling without removing auth's
runtime gate. Shorten repeated issue-history narration in implementation comments
where a contract explanation and issue link are sufficient.

Do not remove the supported UI primitive fallback, opt-in sandbox path, provider
compatibility refusals, licenses or regression fixtures. No dead production module
was established with enough evidence to recommend deleting it in this audit.

## Verification evidence

The final sequential `npm run verify` passed, including lint, strict typecheck,
syntax/JSON/catalog checks, generated-document checks, workspace links, release
checks, build, core tests and all workspace suites:

| Suite | Passed | Skipped | Failed/cancelled |
|---|---:|---:|---:|
| Core | 518 | 1 | 0 |
| UI | 57 | 0 | 0 |
| Auth | 207 | 0 | 0 |
| Admin | 68 | 0 | 0 |
| Workspace scaffold integration | 1 | 0 | 0 |

Total: 851 passed, one intentional HTTPS-deployment test skip. The integration
test checks scaffold composition; it is not a live provider deployment.

`npm run test:package` passed installation of the packed archive and
starter/cookbook/authoring-consumer checks. Separate CLI HTTP fixture runs passed
for the starter, assets, cookbook, Vercel, AWS, Cloudflare, conditions (with its
documented public origin) and prerender source. The cookbook count audit passed
with 40 routes. Extension, fake-egress, monitoring, provider-conformance and
tunnel examples are also exercised by their dedicated core tests.

`npm audit --omit=dev --json`
reported zero known runtime advisories at audit time. Neither substitutes for
source review or establishes absence of unknown vulnerabilities.

The initial restricted-environment run could not run local HTTP tests. A first
unrestricted run had five test-file cancellations; those files passed alone.
An overlapping build also caused transient missing-declaration errors in a
workspace run. The final sequential full run passed without cancellations.
These intermediate results are not reported as confirmed product defects.

## Remaining evidence boundaries

No provider account was deployed, no release published, no production system
probed, and no container/Windows/Linux/Node 22 or 24 run was performed locally.
Live email/OIDC/passkey services, accessibility/browser/device assessment,
operational recovery/soak evidence and independent sandbox review remain separate.
Existing issues 58, 173, 174 and 185 already retain relevant acceptance,
model-benchmark, schema-discovery and release/CI-evidence work; this audit does
not close those gates.

## Follow-up: dead-code reachability

[Issue 203](https://github.com/jimhoyd-com/urlcode/issues/203) records a dedicated
unused-code pass requested after the initial audit. Runtime source remains the
same as the reviewed revision; the intervening commit only added this report.

A conservative relative-reference graph rooted at package exports and CLI entry
points reached all 157 tracked production TypeScript modules. Every direct
runtime dependency has a production source reference, and every root script
has a named reference elsewhere in the repository. No whole production file,
runtime dependency or root script was established as removable.

A TypeScript symbol/reference pass excluded 501 symbols exposed by public
package entrypoints. Candidates were then checked with repository-wide search
and manual inspection, including local uses, CLI imports, namespace dispatch,
worker URLs and dynamically loaded agent-list code. The confirmed small removals
are:

| Declaration/plumbing | Evidence | Proposed cleanup |
|---|---|---|
| `src/capability-query.ts:47`, `capabilityNameList()` | Declaration only; no caller or public entry export | Delete the unused wrapper |
| `src/catalog.ts:39`, `metadataFiles` | Declaration only; no reader or public entry export | Delete the unused constant |
| `src/trusted-functions.ts`, `log` option/property | Assigned but never read | Remove this unused executor plumbing, preserving runtime observer/logging behavior |
| `src/mcp-authoring.ts:57`, `expandHandler(path, handler)` | `path` is never read | Remove the argument and update callers |
| `src/policies/cache.ts:201`, `revalidate(state, req, result)` | `state` is never read | Remove the argument and update callers |

Several live implementation helpers are unnecessarily exported: admin's
`activeKit`, core's `routeState`, `forbiddenHeaders`, `normalizeRoute`,
`manifestFileName`, and local scaffold/render/name helpers in `init-with.ts`.
These are candidates for removing export modifiers, not deleting their bodies.
Check declaration dependencies before changing exported types.

An additional TypeScript check with `--noUnusedLocals --noUnusedParameters`
reported six unused parameters: the two production helpers above and four test
callbacks. It reported no unused local declarations. This stricter exploratory
check is separate from the normal passing typecheck.

Public APIs with no internal callers, types used in public signatures, registry
policy hooks, dynamic imports, supported UI fallback rendering and opt-in sandbox
execution are not dead code. This reachability analysis does not prove that
every branch executes. No production code was removed by this follow-up.

## Follow-up: unnecessary files and distribution weight

[File-level evidence on issue 200](https://github.com/jimhoyd-com/urlcode/issues/200#issuecomment-5747116642).

One package-local script is obsolete: `packages/admin/scripts/peer-revisions.mjs`.
It has no workflow/package-script caller and reads the deleted admin `peers.json`;
executing it fails with ENOENT. Its only other named reference is historical
monorepo prose. Remove it; workspace linking replaced its cross-repository
revision-output mechanism. The earlier root-script scan did not cover this
package-local leftover.

The three package `CODE_OF_CONDUCT.md` files are byte-identical to the root copy
(1,062 bytes each). Consolidate their links to the root policy before deleting
the duplicates. Package governance also repeats repository-wide controls and
can link to the root while retaining any package-specific information. Package
licenses and attribution notices serve a different purpose and must stay.

A dry-run npm package inventory includes 11 archived documentation files
(179,666 bytes) and six design-spike files (184,792 bytes): about 356 KiB
uncompressed combined. The audit report also ships because package.json includes
all of docs. Consider excluding maintainer/history/design records from npm
while retaining them in Git and keeping their references navigable. These
figures are content sizes, not estimates of compressed download savings.

The duplicate Claude plugin skills are intentional, checked distribution copies;
cookbook/recipe copies make each project independently usable; upstream UI
snapshots preserve attribution/provenance; the benchmark baseline is consumed
by its gate. None is established as unwanted. No tracked build output,
node_modules, tarballs, logs, backup files or TypeScript build-info files were
found. Ignored local dependencies/build products are regenerable development
output, not tracked repository clutter. No files were deleted in this audit.
