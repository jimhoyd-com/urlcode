# Tooling SDK and local MCP

The tooling API consolidates authoring operations without starting a runtime:

- `inspectProject(project, {origin?, target?, offset?, limit?})` loads and
  semantically compiles the project and returns route metadata, revision hash and
  target compatibility. Route pages default to 100 entries, maximum 1,000.
  Compatibility contains global `compatible`, `requirementCount` and `issueCount`
  plus a separate `issues` page. Both arrays use the same zero-based `offset`
  and `limit`, independently: an issue page is indexed over all compatibility
  issues, not filtered to the route page. Compatibility includes `hasMore` for
  its issue page. Empty pages never imply compatibility; the verdict and counts
  always cover the entire project. Full requirement arrays are omitted because
  route entries already contain their capability names.
- `validateProject(project, options)` returns the same compilation verdict and
  compatibility verdict and global counts without route or issue pages.
  `firstIssue` is the first issue across the whole project, or null; supplied
  pagination settings do not change it. It also refuses a route requirement
  (including the `auth:` short form) that fails its extension's policy schema:
  the registration's when `options.extensions` supplies one, else the installed
  package's `urlcode.json` in the enclosing site; an extension with neither is
  left to startup. Nothing is activated. The low-level
  `analyzeCompiledCapabilities` API still returns the complete report.
  For unusually long route paths, request smaller pages to fit the MCP output
  byte limit; page entry bounds do not override that transport limit.
- `explainRoute(project, path, options)` selects the route for a path and
  describes its effective behavior from the compiled IR: methods, handler (with
  its destination, module and export, file, extension or link collection),
  the middleware chain in order, validated inputs (parameters and the request
  body policy), the policies in effect with each compiled policy's inventory,
  extension requirements, the cache outcome (the policy strategy, an explicit
  header, an asset declaration, or the `no-store` the runtime forces on
  extension, proxy and conditional routes), binding names (never values),
  egress origins, response headers, capabilities and per-target support. A miss
  returns `matched: false` with the nearest route patterns. With `extensions`
  (a host file's registrations) each extension requirement also reports whether
  a provider is registered, whether its revision pin matches and whether the
  requirement satisfies the provider's policy schema; nothing is activated.
  `explainProject(project, options)` returns every route the same way.
- `buildManifest(project, options)` returns the generated semantic manifest
  described under [`urlcode manifest`](#explain-and-manifest).
- `getCapabilities(target?)` describes local implementation support and separate
  deployment evidence.
- `getCapability(name)` returns one catalog entry: kind, summary, resolved schema
  fragments, constraints, required operator grants, per-target support, refused
  targets and the bundled recipes and cookbook routes that use it. Unknown names
  throw a `ConfigError` listing the valid names.
- `getSchemaFragment(path)` returns only the fragment of
  `schemas/urlcode.schema.json` for a dotted path (`route`, `redirect`,
  `policies.cache`, `site.sitemap`) with local `$ref`s inlined; `schemaPathNames()`
  lists the accepted top-level names. Both read bundled package data only.
- `previewImport(options)` and `previewExport(project, format, acknowledgment?)`
  return conversion reports and candidate text, never writing files. Provider
  semantic differences require the existing explicit acknowledgment and remain
  non-lossless.
- `listRecipes()` and `showRecipe(name)` expose the fixed bundled recipe catalog.
- `listAgentCatalog()` (from `@jimhoyd/urlcode/agent-context`) is the
  revision-pinned discovery index for hosted and local agent tooling. It lists
  core skills/reference entry points and every add-on in the signed core
  manifest. It deliberately does not flatten extension schemas, skills or
  artifacts into core prose: inspect an installed extension through
  `get_extensions`, and an installed inert artifact through
  `get_extension_artifacts`/`get_extension_artifact`.
- `readAddonCatalog()` (from `@jimhoyd/urlcode/agent-context` and
  `@jimhoyd/urlcode`) returns the release-wide add-on agent catalog, MCP
  `get_release_addon_catalog`: each add-on's package, version, description,
  `requires` and descriptor agent references, read from core's own
  `dist/addon-catalog.json` without importing or installing any add-on.
- `inspectExtensions({project, hostFile?})` reports each operator-registered
  extension's name, contract version, targets, credential headers, configuration
  and policy JSON Schemas, machine-readable project hook contracts, whether the project declares it, whether its revision
  pin matches and where routes mount or require it, plus the project's declared
  names. With `hostFile` it executes that trusted operator module under the
  `--host-file` rules (absolute path, outside the project) and releases it
  afterwards; without one it lists declarations only. `describeExtensions(project,
  registrations?)` produces the same report from registrations already in hand.
  Neither activates an extension. See [EXTENSIONS.md](EXTENSIONS.md).
- `buildContext(project, {target?, hostFile?, budget?})` returns the compact
  project context an authoring agent needs before it writes anything (see
  below); `renderContext` produces the YAML rendering and `estimateTokens`
  the characters-per-token estimate the budget uses.

## Project context

`urlcode context [--project DIR] [--target T] [--host-file F] [--budget N]
[--json] [--stats]` emits one deterministic YAML document (JSON with
`--json`) derived only from the compiled project and the capability catalog,
never from prose. It uses the same loader and semantic compiler as
`inspectProject`: no binding values, guest execution, environment reads or
network. Keys always appear in this order:

- `urlcode` (package version) and `schema` (`"1"`).
- `project`: entry file, route count, handlers used with counts, extensions
  declared, policies in effect at the top level and the number of routes each
  policy applies to, requested env and secret binding names,
  `site` keys, and `files` (include, function and middleware paths). With
  `--host-file`, `host` counts the operator module's extensions and plugins
  without activating them.
- `routes`: path, methods and handler per route, sorted by path.
- `constraints`: a fixed list that holds for every project (network and Node
  built-ins available to trusted code and withdrawn by `sandbox: true`, no
  regex routes, one handler per route, exact or `{param}` path segments,
  subtree mounts only for static and extension routes, no YAML interpolation,
  injected `env`/`secrets` by operator grant only), each with a value and a
  note spelling out how it differs between the two trust modes.
- `targets`: for each capability target (or the one `--target`), which of this
  project's used features are supported, conditional, refused or unknown.
- `commands`: the exact `validate`, `test`, `audit --expect-routes N` (N is
  the compiled route count), `routes` and `capabilities` invocations.

`--budget N` drops sections in a fixed order until the YAML rendering fits
the estimate: per-route detail, then `targets`, then the constraint notes
(keys and values stay), then `project.files`, then `commands`. The dropped
sections are listed under `omitted`. The estimate is `ceil(characters / 4)`;
there is no tokenizer dependency, so treat both numbers as approximate. A
budget the smallest rendering cannot meet is an error rather than an
overrun. `--stats` writes a JSON line to stderr comparing the estimated size
of the shipped documentation (`docs/*.md` and `llms.txt`) with the emitted
context, labeled `estimate: characters/4`. The MCP tool `get_context` takes
`target` and `budget` and returns the same object with `--project .` in the
commands; it never takes a host file or any other path.

Inspection reads declared configuration and function source graphs to validate
references and compute revision hashes. It compiles route and policy semantics
using dummy binding values. It never reads environment or dotenv credentials,
starts guest execution, follows network destinations, or opens operator link
stores. The result contains no raw compiled route, binding values or source text.
Inspection is not deployment readiness: missing operator grants, live service
availability, asset snapshot activation and provider behavior require their own
checks. Build output remains an explicit separate build API/CLI operation.

## Feature planning

After `get_context`, use `urlcode plan-feature "goal" --project DIR --target
self-hosted --json` (MCP `plan_feature {goal, target?}`) when the next question
is which already-supported contract applies. It returns a bounded structured
plan: matching local recipes and capability decisions for the current revision,
operator-owned extension prerequisites and their registration/target status,
installed inert artifact status, a deliberately small route/config outline where a
recipe defines one, application-code boundaries, explicit gaps, and the next
bounded calls. It never returns generated application code.

Recipes are ranked declarative first: one that runs no project code (no
`function` or `middleware`) comes before one that does, then more matched goal
terms win. Each listed recipe carries the goal terms it `matched` (its planner
terms, tags, capabilities and id) and an `outline` entry, so a simple JSON
endpoint lands on `respond` plus `request.body.schema` (the `json-endpoint`
recipe) rather than a function. A signature goal (HMAC, signature, webhook)
adds an application-code boundary naming a `secrets` binding and `node:crypto`
in a trusted function, and never reads "signed" there as signing a user in.
`search_recipes` applies the same tie-break: at an equal score, no-code
recipes are listed first.

The goal is a 1–512 character string reduced to at most sixteen normalized
terms; the returned JSON is capped at 32 KiB (an estimated token count is
included). It only uses the compiled project, packaged capability/recipe data,
the artifacts installed in the site and registrations that the operator
already supplied to the CLI/MCP session. It does not open a host file itself,
read binding values, execute guest or extension code, fetch a service, or make
a project change. An installed schema artifact remains inert and a registered
extension remains an operator decision: neither lets YAML select a package,
storage provider, key or grant. Canonical extension ordering is resolved only
by `composeHost` from each extension's declared `requires`, not by this planner.

The package root also exports existing operator-invoked workflow APIs:
`buildCloudflare(project, options)` compiles and writes a Cloudflare artifact;
`buildStatic(project, options)` compiles redirects and static files into plain
objects and redirect metadata for S3 + CloudFront (see [static
hosting](STATIC.md)); `runProjectTests(project, options)` starts the local
runtime, executes request fixtures and closes it; `scaffoldProject(project,
{dryRun})` creates missing placeholders while preserving existing files;
`initProject(destination)` creates the standard starter; and
`addRedirect(project, destination, alias?)` updates project YAML under the
authoring lock. `CloudflareBuildOptions`, `CloudflareBuildReport`,
`StaticBuildOptions`, `StaticBuildReport`, `ProjectTestOptions`,
`ProjectTestResult`, `ScaffoldReport` and `ScaffoldUnresolved` describe these
existing operations.

These SDK functions have explicit write or execution effects and are available
to trusted callers only. Project tests use normal runtime activation, grants and
sandboxing; granted proxy/signal fixtures can perform real outbound operations.
Compilation and authoring write caller-selected destinations under each existing
helper's documented rules. They are **not** MCP tools. MCP remains limited to
the read-only operations below; adding a package-root export does not grant an
assistant file-write, guest-execution, deployment or network authority.

## Project review

`urlcode review [--project DIR] [--target T] [--host-file F] [--json]` (MCP
`review {deployTarget?}`, still reachable as `review_project` for one release)
is an opt-in, read-only static review of the
compiled project plus its own `function`/`middleware` source, for the narrow,
agent-facing question "which of this generated code looks like avoidable
framework plumbing, and what is the supported alternative?" It scans only the
project's own root-confined source graph (the same `function`/`middleware`
file resolution `explain` and `manifest` use): no project code is executed, no
environment variable or secret is read, and no network call is made. Findings
are grouped:

- `native-alternative`: an already-supported declarative capability appears to
  cover the behavior (for example `request.body.schema` in place of
  hand-written `JSON.parse` or `request.json()` plus field checks, `respond`
  in place of a function that always answers the same thing, or one route per
  method in place of a hand-written `request.method` dispatch table).
- `extension-alternative`: the project **declares** an extension that could
  plausibly own the behavior. Without `--host-file`, the required operator
  setup (registration, revision pin) is stated as unconfirmed — a declaration
  is never reported as an active or executable extension. With `--host-file`,
  the already-loaded operator registrations (the same ones `explain` and
  `plan-feature` accept; the host file is trusted operator code outside the
  project, never project code, and review only reads the registrations it
  already returned — it still never activates or calls into an extension)
  sharpen the finding to state whether that specific extension is actually
  registered and, if so, whether the registration is pinned to this project's
  current revision (`registered`/`revisionPinned` on the observation). A
  registered extension is still never reported as active or executable —
  only as registered, which is a narrower, verifiable claim.
- `gap`: no current native or extension composition covers the pattern (for
  example durable, cross-instance counters); this is reported as a real
  capability gap, not a mistake to silently patch.
- `manual-review`: a security- or durable-state-sensitive pattern (manually
  assembled cookies/sessions, a direct outbound network call, or hand-written
  logic that duplicates a `policies.*` block already declared for the route)
  that this tool never classifies automatically. Trusted, unsandboxed
  execution is an explicit supported mode (`SPIKE-DEFAULT-TRUST-MODEL.md`);
  nothing here claims a function is unsafe solely because it is trusted.

Its scope covers eight signals, each with source location, a short bounded
excerpt (untrusted project text, never executed or treated as instructions), a
confidence level and a plain-language reason:

- Hand-written JSON body validation (`manual-body-validation`): a body parsed
  with `JSON.parse(` or a no-argument `.json()` on the incoming request
  (`request`, `req` or the handler's first parameter, never a fetched
  response), followed by at least two field checks (a `typeof` test, a length
  bound, `Array.isArray`/`Number.isInteger`, a `422`, or an error such as
  "required"/"missing"/"invalid"), on a route without `request.body.schema`.
- A handler that answers a constant response (`constant-response`), reported
  as `native-alternative` pointing at `get_capability("respond")`: a single
  default-exported function with one `return Response.json(…)`/`new
  Response(…)`, no branching, `await` or imports, and nothing read from the
  request or its context except literal YAML `args` (an arg bound `{from: …}`
  per request disqualifies it). Middleware never qualifies; `respond` routes
  can still run middleware.
- Manually assembled `Set-Cookie`/session construction (`manual-cookie-session`).
- Module-scope mutable state later mutated in the same file (`global-mutable-state`).
- A direct outbound call, `fetch`/`http(s).request`/`http(s).get` (`outbound-network-call`).
- Hand-written `request.method` branching or a `switch (request.method)`
  dispatch table (`method-dispatch`), reported as `native-alternative`:
  declaring one route per method is the native alternative (see
  `get_capability("methods")`); URLCode has no per-method-function YAML shape
  to point at instead (`YAML-REFERENCE.md` is explicit that "a `methods:` map
  of per-method functions is not implemented").
- Hand-rolled request counting paired with a `429`/`Retry-After` response
  (`manual-rate-limit`). Reported as `native-alternative` (pointing at
  `get_capability("policies.throttle")`) when `policies.throttle` is not
  effectively declared for the route, or as `manual-review` when it already
  is — duplicating an active policy is a real conflict, not just a missed
  opportunity, and needs a human decision to remove one side.
- Two or more hand-set security response headers, from `X-Frame-Options`,
  `Content-Security-Policy`, `Strict-Transport-Security`,
  `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` or
  `X-XSS-Protection` (`manual-security-headers`). Reported as
  `native-alternative` (pointing at `get_capability("policies.security")`)
  when `policies.security` is not effectively declared for the route, or as
  `manual-review` when it already is, for the same reason as rate limiting.

Both policy-duplication signals cross-reference each route's actual *effective*
policy (project/profile defaults plus the route's own `policies` block, the
same resolution `compilePolicies` performs) before deciding whether to word a
finding as "you could declare this" (`native-alternative`) or "this duplicates
what's already declared" (`manual-review`) — never the reverse, and never a
claim of duplication against a policy that was never declared for that route.

It is deliberately conservative and does not attempt every signal a generated
project could exhibit. Hand-written conditional redirect logic (branching in
code toward what could be a declarative `match`/`conditional` route) was
considered and set aside: ordinary application branching that happens to end
in a redirect is common and mostly has nothing to do with routing
configuration, so a bounded source-text signal for it would be prone to
false positives against legitimate business logic — an uncertain observation
is preferable to an incorrect automatic refactor.

## Fixture suggestions

`urlcode fixtures suggest [--project DIR] [--json]` (MCP
`suggest_fixtures {yaml?, maxFixtures?}`, SDK `suggestFixtures(yaml,
{maxFixtures?})` from `@jimhoyd/urlcode/agent-context`) proposes
[`tests/requests.json`](AI-AUTHORING.md#request-fixtures-testsrequestsjson)
cases from URLCode YAML, in one of two modes:

- **Project mode** (the CLI, and MCP `suggest_fixtures` without `yaml`) reads
  the project's `urlcode.yaml` and its
  [includes](ORGANIZATION.md#mix-inline-and-included-routes) through the same configuration loader that
  serving uses, so include paths are resolved, confined to the project root
  and checked (no nesting, no duplicate routes, the same size limits) exactly
  as `urlcode validate` does; an include the loader refuses is refused here
  with the same message. Included routes are analysed like entry routes, the
  result's `scope` is `project-yaml`, `files` lists the YAML files read
  (`urlcode.yaml` first), and every `cases`, `gaps` and `review` entry about a
  route names the `file` that declares it (`urlcode.yaml` or the include path
  as written, for example `"file":"routes/store.yaml"`).
- **Text mode** (the SDK, and MCP `suggest_fixtures` with `yaml`) reads the
  supplied text only, with `scope: "supplied-yaml-only"`. Its includes are not
  read: each is reported as an `include` gap, and because an unread include
  could hold a more specific route or match any path, parameterized and
  wildcard routes go to `review` as `include-shadowing` and no unknown-path
  case is generated. A hosted service that calls the SDK never touches a file.

Neither mode reads function or middleware sources, asset files, bindings or
operator policy; nothing is executed or fetched, and nothing is written. Review
the result and save the `fixtures` you accept yourself.

A case is generated only when the YAML alone determines the answer:

| Kind | Request | Expected |
|---|---|---|
| `redirect` | the route's path (sample values for inputs, `sample` for `/**`) | status and exact `location`, assembled by the runtime's own redirect code |
| `respond` | the first of `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` the route accepts | status, `content-type` and, up to 1 KiB, the exact body |
| `page`, `download` | `GET` | `200` (the file must exist for the project to activate) |
| `disabled` | the path of an `enabled: false` route | `404` |
| `method-refusal` | the first of `POST`, `PUT`, `PATCH`, `DELETE`, `GET` the route does not accept | `405` and the exact `allow` |
| `missing-parameter` | the first required query or header input without a default, omitted | `400` |
| `invalid-parameter` | a non-numeric value for an integer, number or boolean input, or an unlisted value for a string `enum` | `400` |
| `body-required` | no body for a route with `request.body.required` | `400` |
| `unknown-path` | a path no route matches | `404` |

Every other route is reported instead of tested. `gaps` lists a route (or, in
text mode, an include file) whose answer depends on something the YAML cannot know, with
`codes`: `function`, `middleware`, `proxy`, `signals`, `extension`,
`extension-policy` (including `auth:`), `external-binding` (an `env` read from
the host or a `secret`), `pattern-constrained` (an input with `pattern` or
`format`) and `include` (text mode only). `review` lists a route the helper could not write a
certain case for, with one `code`: `conditional` (`match`/`conditional`),
`expires`, `static-directory`, `policy` (an `agents` or `throttle` policy that
can answer first), `parameter-schema`, `shadowed`, `include-shadowing` (a
parameterized or wildcard route in a text-mode document with includes), `request-body`,
`site`, `unknown-path` and `size`. A route in `gaps` or `review` never appears
in `cases`, so a suggestion never reads as coverage it is not.

```json
{"format":1,"scope":"supplied-yaml-only","routeCount":3,
 "fixtures":[{"path":"/go","status":301,"expectHeaders":{"location":"https://example.com/"}},
             {"path":"/go","method":"POST","status":405,"expectHeaders":{"allow":"GET, HEAD"}},
             {"path":"/__urlcode-fixture-unmatched","status":404}],
 "cases":[{"route":"/go","kind":"redirect"},{"route":"/go","kind":"method-refusal"},{"route":null,"kind":"unknown-path"}],
 "review":[{"route":"/cond","code":"conditional","reason":"..."}],
 "gaps":[{"route":"/api","codes":["function"],"reason":"..."}],
 "limits":{"maxFixtures":200,"maxEntries":200,"maxBodyBytes":1024,"maxFixtureBytes":393216},
 "truncated":{"fixtures":0,"review":0,"gaps":0}}
```

`cases` is parallel to `fixtures`. Routes are visited in code-point order, so
the same text (or the same project files) always gives the same bytes. `maxFixtures` defaults to 200
(at most 1,000); fixtures also stop at 384 KiB of JSON, `review` and `gaps` at
200 entries each, and `truncated` counts what a limit dropped. Invalid YAML is
refused with the validator's message. The cases assume the local
`urlcode test` runner: an operator host's plugins or extensions registered for
routes the YAML does not name are outside what the YAML says.

## YAML change summaries

`urlcode diff BEFORE [AFTER] [--project DIR] [--json]` (MCP
`summarize_yaml_change {before, after?}`, SDK `summarizeYamlChange(before,
after)` from `@jimhoyd/urlcode/agent-context`) compares two versions of a
URLCode project. Both must validate. It reports names and keys, never values:
no redirect destination, literal, `env` default or secret appears in the
result, and it always exits 0.

Each side is read the way [fixture suggestions](#fixture-suggestions) read
theirs. On the CLI, `BEFORE` and `AFTER` are each a YAML file (read as text,
its includes unread) or a project directory (read through the configuration
loader with its root-confined includes); `AFTER` defaults to the `--project`
directory. So `urlcode diff old-checkout/ .` compares two projects include by
include. MCP `before` is always YAML text; `after` is YAML text, or by default
the served project with its includes. The SDK compares two texts only.
`scope` is `supplied-yaml-only` (two texts; the result shape is exactly that
of earlier releases), `project-yaml` (two projects) or `mixed`; for the last
two `sides` says how each side was read (`yaml` or `project`). A git revision
is not accepted: check the earlier revision out into a directory (for example
with `git worktree add`) and pass that.

On a project side every `routes.added`, `routes.removed`, `routes.changed` and
`code` entry names the `file` that declares its route. When both sides are
projects, a route that moved to another file carries `movedFrom`, the file it
was in before; one that only moved is listed under `changed` with empty `keys`. In a `mixed` comparison the text side's includes are
unread, so project-side routes (and extension declarations) from an include
the text side also lists cannot be classed: they are listed under
`routes.unresolved` (`{route, file, side}`) and left out of every other list,
never reported as added or removed.

- `routes`: `added` and `removed` (pattern, handler, execution `mode`, and
  `file` on a project side) and
  `changed`, each with the top-level route `keys` that differ (after `use:` and
  `auth:` expansion), the handler before and after and the route's capability
  names added and removed. A project-level policy or profile change that alters
  a route's effective capabilities lists that route with empty `keys`.
- `capabilities`: the project-wide union of [capability](CAPABILITIES.md) names
  added and removed.
- `code`: the project code seams, each `{route, kind: function|middleware,
  source, export, mode: trusted|sandboxed}`: `added`, `removed`, `argsChanged`
  (same function, different `args`), `modeChanged` (a `sandbox:` flip on a route
  with code in both versions) and the new version's `trusted` and `sandboxed`
  counts. See [function security](FUNCTION-SECURITY.md) for what each mode
  means.
- `grants`: what the new version `requested` that the old did not, and what it
  `released`: `env` and `secrets` names and `egress` origins per route (the same
  projection `urlcode permissions` prints), and `extensions` the operator must
  register (`via` a `declaration`, a `mount` or a route `policy`). The helper
  never grants anything; `note` restates that grants are revision-pinned
  operator policy that any change must re-review.
- `project`: the other top-level keys that changed and the `includes` entries
  added and removed (a text side does not read their routes; a project side
  reports them with the other routes).

```json
{"format":1,"scope":"supplied-yaml-only","changed":true,
 "routes":{"before":1,"after":2,"added":[{"route":"/p","handler":"proxy","mode":"trusted"}],"removed":[],
           "changed":[{"route":"/f","keys":["sandbox"],"handler":{"before":"function","after":"function"},"capabilities":{"added":[],"removed":[]}}]},
 "capabilities":{"added":["proxy"],"removed":[]},
 "code":{"added":[],"removed":[],"argsChanged":[],"modeChanged":[{"route":"/f","before":"trusted","after":"sandboxed"}],"trusted":0,"sandboxed":1},
 "grants":{"requested":{"env":[],"secrets":[],"egress":[{"route":"/p","purpose":"proxy","origin":"https://upstream.example"}],"extensions":[]},
           "released":{"env":[],"secrets":[],"egress":[],"extensions":[]},"note":"..."},
 "project":{"changed":[],"includes":{"added":[],"removed":[]}},
 "limits":{"maxEntries":200},"truncated":{}}
```

Every list is sorted and holds at most 200 entries; `truncated` names each
list a limit cut and how many entries it dropped. To compare two compiled
route reports (`urlcode routes` output) instead, use `urlcode routes --compare`.

## Review report

`urlcode report [BEFORE] [--project DIR] [--policy F] [--host-file F] [--json]` prints one
self-contained HTML page for a person reviewing a project or a change:
`urlcode report main-checkout/ > report.html`. It is a view over three
existing outputs and adds no analysis of its own: the routes are exactly what
[`explain`](#explain-and-manifest) returns, the findings are
[`review`](#project-review)'s, and with `BEFORE` (read like `urlcode diff`
reads it: a YAML file, or a project directory with its includes) the changes
are [`diff`](#yaml-change-summaries)'s. So it shows no value those outputs
omit: no binding value, secret or redirect destination from the change
summary, and no project code runs.

The page has three parts:

- **Needs attention**, the only thing the report derives. `Fix` items need
  the operator's files, which stay outside the project. With `--policy` (the
  binding policy `dev` and `serve` take): a policy pinned to a different
  project revision, and each env, secret or outbound origin a route requests
  that the policy does not grant, compared by name with what `urlcode
  permissions` prints. With `--host-file`: an add-on a route uses that the
  host file does not register, a registration pinned to a different
  revision, or a route requirement that fails the add-on's policy schema.
  When the project needs one of these and the file is not passed, the page
  says that part is unchecked. Passing both loads the host the way `dev`
  does, so a host file whose pin disagrees with the policy stops with that
  same error instead of producing a page. `Check` items: a disabled or
  expired route, each review finding, and, with `BEFORE`, new function or
  middleware code, a `sandbox:` flip, a newly requested operator grant and a
  removed route.
- **Changes since `BEFORE`**, in plain sentences, and the grant note.
- **Routes**: handler, methods, whether code runs trusted or sandboxed,
  policies and what the route needs from the host. Opening a route shows what
  happens to a request: match, policies, add-on requirements, middleware,
  handler, response caching and the targets that refuse it.

Handler details are printed generically from `explain`, so a new handler or
field appears without a change to the report. `--json` prints the same data
(`format`, `projectSha256`, `routeCount`, `host`, `policy`, `attention`, `routes`,
`review` and, with `BEFORE`, `change`), and `buildProjectReport` /
`renderProjectReport` in `project-report.ts` produce it and the page. The page
is deterministic, carries a Content-Security-Policy that allows no script and
escapes all project text, so it is safe to publish as a pull request artifact.
It is read-only: it grants nothing and does not replace `validate` or `test`.

## Explain and manifest

`urlcode explain [/route] [--project DIR] [--target T] [--host-file F] [--json]`
prints what `explainRoute` returns: one route in detail, or without a path a
one-line-per-route table (methods, handler, state, execution mode, middleware
count, policies, cache outcome and target support). `--target` narrows the support columns to
one deployment target; `--host-file` supplies the operator registry so
extension requirements show their provider. An unknown route exits 1 and names
the nearest patterns. Everything comes from the compiled configuration: no
request is evaluated, no function runs and no binding is read.

`urlcode manifest [--project DIR] [--json]` emits the semantic manifest:
`schemaVersion`, the `urlcode` version, the entry file and its includes, the
`revision` (the same digest `inspectExtensionRevision` returns, so an operator
pin can be checked against it), the config `configVersion`, every route (path,
methods, handler, state, execution mode (`sandbox`, with `sandboxReason` when
the route declares one), middleware, inputs, policy names, extension
requirements, cache outcome, binding names, egress origins, capabilities and
per-target support), the union of capabilities used, extension declarations
(version, configuration keys, mounts and protected routes), recipe provenance
(from a `recipe.yaml` beside the entry file when one exists), external
requirements (environment and secret names, proxy and signal origins,
extensions), the function and middleware
modules with the routes that use them, and per-target compatibility. Without
`--json` a short summary prints. The manifest is deterministic: the same
project produces the same bytes. `urlcode build` writes the same document as
`manifest.json` beside its output, and `buildManifest` returns it from the SDK.
It is generated output, never a checked-in source of truth; regenerate it
rather than editing it.

`serveMcp({project, input?, output?, origin?, allowAuthoring?, hostFile?})` serves one
operator-selected root on stdio. Its canonical, verb-first tools, in the order
`tools/list` returns them (`get_context` first — it is the documented first
call), are `get_context`, `inspect`, `validate`, `run_tests`,
`list_capabilities`, `get_capability`, `get_schema`, `explain`, `get_manifest`,
`preview_import`, `preview_export`, `list_recipes`, `get_recipe`,
`search_recipes`, `search_examples`, `list_skills`, `get_skill`, `list_agent_catalog`,
`get_release_addon_catalog`, `search_docs`,
`get_example`, `validate_yaml`, `explain_error`, `get_extension_artifacts`,
`get_extension_artifact`, `get_addon_agent_tooling`, `plan_feature` and `review` (matching the CLI's
`urlcode review`), with `suggest_fixtures` and `summarize_yaml_change` listed
after `explain_error` (see [fixture suggestions](#fixture-suggestions) and
[YAML change summaries](#yaml-change-summaries)). `run_tests` runs `tests/requests.json` the way `urlcode
test` does, against a disposable local server instance; it is read-only in
that it never writes a project file. `tools/list` additionally lists the
pre-#590 name of every renamed tool (`capabilities`, `import_preview`,
`export_preview`, `recipes_list`, `recipes_show`, `review_project`) as a
working, deprecated alias of its canonical tool — same input schema, same
handler, own "Deprecated alias for ..." description — kept for one release so
an already-configured client is not broken by the rename. `inspect`,
`list_capabilities`, `get_context`, `plan_feature` and `review` accept a
`deployTarget` argument (self-hosted/cloudflare/aws/vercel/static); their old
`target` argument name still works but is deprecated, kept distinct from
`explain`'s unrelated `target` (the path it explains). Every successful
`tools/call` reply also carries `structuredContent` mirroring the JSON already
in its text content, for a client that reads structured results directly. The skill,
documentation and example tools read only a fixed package-owned manifest; no
tool argument names an arbitrary local path or remote URL. The CLI equivalent of `search_docs` is
`urlcode docs search TEXT [--json]`, which returns the same at most three bounded excerpts. `validate_yaml` checks supplied
YAML syntax and schema only, while `validate` compiles the selected local project.
The `list_skills`, `get_skill`, `list_agent_catalog`, `get_release_addon_catalog`, `search_docs`, `get_example`, `validate_yaml`,
`explain_error`, `suggest_fixtures` and `summarize_yaml_change` tools are thin wrappers over `@jimhoyd/urlcode/agent-context`
(`listSkills`, `getSkill`, `listAgentCatalog`, `readAddonCatalog`, `searchDocs`, `getExample`, `validateYaml`,
`explainError`, `suggestFixtures`, `summarizeYamlChange`), a public package export — not an internal detail of this
server. A host building its own MCP server, or any other agent-tooling
integration, can import that module directly instead of reimplementing this
behavior or reaching into `dist/agent-context.js`; see
[TypeScript](TYPESCRIPT.md).
`get_release_addon_catalog` returns the release-wide add-on catalog shipped in
core's `dist/addon-catalog.json`: every extension and artifact of this core's
release with its package, version, description, `requires` and, when its
descriptor declares one, its agent references (each `path` is relative to that
add-on's package). It is [release-wide discovery](EXTENSIONS.md#the-release-wide-agent-catalog),
not evidence that the project installed or activated an add-on; installed
components come from `get_addon_agent_tooling`, `get_extension_artifacts` and
`get_extensions`. Reading it imports, downloads and installs nothing.
`get_extension_artifacts` lists the artifacts installed in the site around the
project (`<site>/node_modules`), checking each is inert and matches core's pin,
and returns its version, status and files. `get_extension_artifact` accepts only
an installed, pinned artifact name and one of its `README.md`, `urlcode.json`,
`schemas/*.json` or `config/*.json` paths. Both are local, read-only and inert:
they never download, install, update or activate an add-on and never substitute for `get_extensions`, which reports
the operator-registered executable contract.
When the operator starts
the server with `--host-file`, it loads that trusted module once for the session
and additionally advertises `get_extensions`, which returns the
`inspectExtensions` report; without the option the tool is absent and calls to
it are rejected. Tools accept no project/file/output path argument; recipe names
come from the fixed catalog, `get_capability` names from the capability catalog,
`get_schema` paths from the bundled schema, and the two searches match bundled
metadata locally (see [recipes](RECIPES.md)).
There is no shell, arbitrary file read, remote fetch, binding access, write or
route-execution tool without the explicit [authoring mode](#authoring-mode) flag. Configuration includes and module references retain the
runtime's existing root containment checks. Returned project and recipe content
is data, not trusted instructions for the consuming agent.

The server implements the MCP lifecycle and stdio framing for revisions
**2025-11-25**, 2025-06-18, 2025-03-26 and 2024-11-05. `initialize` echoes the
requested `protocolVersion` when it is one of those, and otherwise answers with
2025-11-25; a client that cannot support the answer must disconnect. The tools
use only what every listed revision shares (tool annotations are optional hints
older clients ignore). Newer lifecycle revisions are not claimed. Clients
initialize, verify the returned protocol version, then send
`notifications/initialized` before tool operations. Requests use UTF-8
newline-delimited JSON-RPC 2.0, with one request at a time and stream backpressure.
There is a 1 MiB input-frame and output-message limit; oversized input terminates
the session after a fixed error, and truncated/invalid frames return protocol
errors. Import text is additionally capped at 512 KiB. Tool schemas reject
unknown arguments. A `-32602` error names the problem: an unknown tool (and the
flag that adds it, for `get_extensions` and the authoring tools), each unknown,
missing or invalid argument, and the arguments the tool accepts. A tool that
fails returns `isError` with the message the CLI prints for the same failure,
for example the schema location of an invalid route or the valid
`get_capability` names; the server is local, started by the operator and
confined to one project, so there is nothing to hide from its caller.
`explain_error` matches the supplied text against the runtime's own error
families (schema location, extension configuration, route handler, function
load and execution, operator grants and revision pins, bindings, inputs, route
paths and conflicts) and returns `matched` (the family, or `null`), `guidance`,
`nextTools` and, for a schema or extension configuration error, the decoded
`location`. `plan_feature` lists `get_extensions` in
`next` only when a host file is loaded. Tools named in `nextTools` and `next`
are always canonical names, never a deprecated alias.

## Registering the server

`urlcode init` writes `.mcp.json` at the site root, beside `host.mjs`, the
shape Claude Code and Codex read:

```json
{ "mcpServers": { "urlcode": { "command": "npx", "args": ["--no", "--package", "@jimhoyd/urlcode", "urlcode", "mcp", "--project", "app"] } } }
```

An existing `.mcp.json` is never overwritten. The file registers
the read-only server only: `--allow-authoring` (and `--host-file`) are operator
choices added by hand, never by `init` or by an agent.

- **Claude Code** reads `.mcp.json` in the project directory as a project-scoped
  server and asks for approval on first use. The site pins the runtime in its
  `package.json`, so `init` writes
  `"command": "npx"` with `--no --package @jimhoyd/urlcode urlcode mcp ...`, which runs the
  installed copy and never fetches (do not use a bare `npx urlcode`: the unscoped `urlcode`
  name is unclaimed on the npm registry -- it 404s, it is not this project's under a
  different owner -- so a bare `npx urlcode` would try, and fail, to install it instead of
  running the pinned `@jimhoyd/urlcode` already in `node_modules`). For a global
  install, `urlcode mcp print-config --global` prints the bare `urlcode` command instead.
- **Codex** reads the same `mcpServers` shape; alternatively register it in
  `~/.codex/config.toml`:

  ```toml
  [mcp_servers.urlcode]
  command = "urlcode"
  args = ["mcp", "--project", "app"]
  ```
- **Any stdio client** spawns `urlcode mcp --project DIR` with the project as the
  working directory, speaks newline-delimited JSON-RPC 2.0 over stdin/stdout,
  and follows the 2025-11-25 lifecycle described above. Nothing listens on a
  port; closing stdin ends the session.

### Registering before `init` runs (pre-session bootstrap, #542)

A project-scoped MCP client (Claude Code, Codex) reads `.mcp.json` once, at the
start of its session, before the agent's first turn. Because `init` writes
`.mcp.json`, an agent whose very first turn is `urlcode init .` cannot see the
local server on that turn: the tools were never loaded. `urlcode mcp
print-config [project] [--global]` closes that gap without a new distribution
mechanism: it prints the same `.mcp.json` JSON `init` would write, but works in
an empty directory that holds no project yet, so a human can register it
*before* starting the agent session there:

```sh
npx --no --package @jimhoyd/urlcode urlcode mcp print-config > .mcp.json
```

Start the agent session in that same directory next. The server named in the
file starts normally against the still-empty directory — `tools/list` answers
immediately — and a project-reading tool such as `get_context` returns the same
actionable `run urlcode init there to create a project` message the CLI prints,
instead of failing to start. Once the agent runs `urlcode init .`, `init`
leaves an already-present `.mcp.json` exactly as written (it stops treating the
file as a reason to refuse an in-place `init`, and no longer regenerates it),
so no client restart is needed: the next MCP call in the same session succeeds
against the freshly initialized project. `print-config` defaults to the
portable `npx --no --package` form, which works whether or not
`@jimhoyd/urlcode` ends up pinned in a `package.json`; pass `--global` for the
bare `urlcode` command instead, if the runtime is installed globally. This path
covers `urlcode init <existing-or-empty-dir>`, with or without `--with`.

If a client cannot be bootstrapped this way (registration made outside the
project directory, or a client that cannot register a server before the
project it points at exists), fall back to running the agent's first turn as a
plain CLI call — `npx --no --package @jimhoyd/urlcode urlcode init .` — then
starting or restarting the MCP-aware session in the now-initialized directory;
`llms.txt`, `docs/AI-AUTHORING.md` and the generated `AGENTS.md`/skill all name
this as the fallback next to the bootstrap command above.

The generated `AGENTS.md` and the packaged skills tell agents to prefer
`get_context`, `get_capability`, `get_schema`, `search_recipes`, `explain` and
`get_manifest` when the server is registered and to fall back to the matching
CLI commands otherwise.

## Optional hosted AI MCP

The local `urlcode mcp` server remains the project-aware URLCode integration:
it reads the selected checkout, validates its configuration and never needs a
network credential. Do not replace its generated `.mcp.json` entry with a
hosted service.

[URLCode AI](https://urlcode.ai/) is a separate, opt-in hosted service for
shared skills and LLM-assisted work. A client that supports authenticated HTTP
MCP can add it as a second server with these connection details:

- URL: `https://urlcode.ai/mcp`
- request header: `Authorization: Bearer <URLCODE_AI_TOKEN>`

Store `URLCODE_AI_TOKEN` in the MCP client's secret or environment-variable
facility. Do not put a literal bearer token in `.mcp.json`, `urlcode.yaml`, a
checked-in client configuration, or a shell history. Each client has its own
remote-server configuration syntax, so configure that endpoint explicitly in
the client rather than asking `urlcode init` to generate it.

The hosted tools are not a proxy for this local server: they do not receive the
project root and do not replace local `get_context`, validation, manifest,
extension-artifact or authoring tools. Keep the local server registered for
framework- and project-specific work; add the hosted server only where its
shared skill catalog or LLM tools are useful.

## Authoring mode

`urlcode mcp --allow-authoring --project DIR` adds six tools to the thirty-six read
tools above (thirty-seven with `--host-file`). The flag is honored from the operator's command line only: no
tool argument, environment variable or client capability enables it, and
without it the server is exactly the read-only server described above.

What it can do, all inside the selected project root (resolved with realpath):

- `create_route {path, handler, middleware?, file?}` adds one route to
  `urlcode.yaml` or to an include listed in it. `handler` is a route object
  (`{redirect: {...}}`, `{function: {...}}`, `{page: {...}}`, ...) or a short
  form: an `http(s)://` URL becomes a redirect, a `.js`/`.mjs` path becomes a
  function whose `{param}` path segments expand to required bounded string
  parameters and matching `args`. `middleware` entries are sources or objects.
  The merged project is checked before the write (schema, duplicate routes,
  the `auth` short form, and the same reference compilation `urlcode add`
  performs when every referenced source exists). The edit runs under the
  authoring lock and replaces the file atomically. Missing sources are listed
  in `missingSources` for `scaffold_feature`.
- `add_recipe {name, destination, dryRun?}` runs `recipes add` into a new
  directory under the project. The parent must exist; an existing destination
  is refused, never merged. `dryRun` reports the destination and writes nothing.
- `scaffold_feature {dryRun?}` runs `urlcode scaffold`: placeholder modules,
  pages and directories for references the YAML makes and the disk lacks.
  Existing files are preserved, never overwritten.
- `run_validate`, `run_test`, `run_audit` spawn `urlcode validate --local`,
  `urlcode test` and `urlcode audit` against the project with a minimal
  environment (`PATH` only), a two-minute deadline and stdout/stderr each capped
  at 32 KiB. The result carries `exitCode`, `signal`, `stdout`, `stderr` and
  `truncated`. `run_test` activates the local runtime and executes fixtures,
  under the same rules as the CLI.

Every tool returns `validation`, the `validateProject` verdict of the project
after the operation (or `valid: false` with a generic note; use `run_validate`
for the CLI report).

What it cannot do:

- Write outside the project root. Paths are project-relative; absolute paths,
  `..`, backslashes, drive letters, and any symlink on the walk are refused
  before the write, and the recipe, scaffold and `urlcode add` paths keep their
  own containment checks.
- Touch `.env*`, anything under `.git`, `node_modules`, `package.json`,
  credential files (`.pem`, `.key`, `.p12`, `.pfx`), the authoring lock, or
  operator files by name: `*policy*.json`, `*compliance*`, `host.mjs` /
  `host-file.mjs` and link stores (`.sqlite`, `.db` and their WAL/SHM files).
  Operator files belong outside the checkout in the first place.
- Create or change grants, read bindings or secret values, deploy, build, run
  arbitrary commands, delete or edit existing files (except the one YAML file a
  `create_route` targets), or serve a project other than the one the operator
  selected.

Authoring mode is a local, unauthenticated stdio process for an operator who
already trusts the assistant to edit this checkout. Review the resulting diff
as you would any contributor's before running `serve` or deploying.

Only tools are advertised. Resources, prompts, subscriptions, sampling,
elicitation, HTTP transport, cancellation and durable tasks are not implemented.
Closing stdin ends the session after the current bounded operation. Existing
configuration-loader and semantic-compiler deadlines still apply. This local
process is not an authenticated remote service or an independent security review.

Protocol references: [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
[MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle),
and [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
