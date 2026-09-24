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
  pagination settings do not change it. The low-level
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
inert locked-artifact status, a deliberately small route/config outline where a
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
the already-verified local artifact cache and registrations that the operator
already supplied to the CLI/MCP session. It does not open a host file itself,
read binding values, execute guest or extension code, fetch a service, or make
a project change. A locked schema artifact remains inert and a registered
extension remains an operator decision: neither lets YAML select a package,
storage provider, key or grant. Canonical extension ordering is resolved only
by the operator-approved composition/scaffold contract, not by this planner.

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
`search_recipes`, `search_examples`, `list_skills`, `get_skill`, `search_docs`,
`get_example`, `validate_yaml`, `explain_error`, `get_extension_artifacts`,
`get_extension_artifact`, `plan_feature` and `review` (matching the CLI's
`urlcode review`). `run_tests` runs `tests/requests.json` the way `urlcode
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
The `list_skills`, `get_skill`, `search_docs`, `get_example`, `validate_yaml` and
`explain_error` tools are thin wrappers over `@jimhoyd/urlcode/agent-context`
(`listSkills`, `getSkill`, `searchDocs`, `getExample`, `validateYaml`,
`explainError`), a public package export — not an internal detail of this
server. A host building its own MCP server, or any other agent-tooling
integration, can import that module directly instead of reimplementing this
behavior or reaching into `dist/agent-context.js`; see
[TypeScript](TYPESCRIPT.md).
`get_extension_artifacts` validates the project-selected
`urlcode.extensions.lock.json` and cache, then returns artifact metadata,
status and allowlisted member paths. `get_extension_artifact` accepts only a
locked artifact name and one of those relative JSON/Markdown member paths; it
revalidates the cache and reads at most 512 KiB directly from the signed archive.
Both are local, read-only and inert: they never download, install, update or
activate an extension and never substitute for `get_extensions`, which reports
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
families (schema location, route handler, function load and execution, operator
grants and revision pins, bindings, inputs, route paths and conflicts) and
returns `matched` (the family, or `null`), `guidance`, `nextTools` and, for a
schema error, the decoded `location`. `plan_feature` lists `get_extensions` in
`next` only when a host file is loaded.

## Registering the server

`urlcode init` (and `init --with`) writes `.mcp.json` at the project root, the
shape Claude Code and Codex read:

```json
{ "mcpServers": { "urlcode": { "command": "urlcode", "args": ["mcp", "--project", "."] } } }
```

For an `init --with` site the file sits beside `host.mjs` and passes
`--project app`. An existing `.mcp.json` is never overwritten. The file registers
the read-only server only: `--allow-authoring` (and `--host-file`) are operator
choices added by hand, never by `init` or by an agent.

- **Claude Code** reads `.mcp.json` in the project directory as a project-scoped
  server and asks for approval on first use. A project that pins the runtime in its
  `package.json` (`--with`, `--manifest`) gets
  `"command": "npx"` with `--no --package @jimhoyd/urlcode urlcode mcp ...`, which runs the
  installed copy and never fetches (do not use a bare `npx urlcode`: that names an unrelated
  registry package). A project without one keeps the bare `urlcode` command for a global
  install; for a local-only install replace it with `"node"` and prefix the arguments with
  `node_modules/@jimhoyd/urlcode/dist/cli.js`.
- **Codex** reads the same `mcpServers` shape; alternatively register it in
  `~/.codex/config.toml`:

  ```toml
  [mcp_servers.urlcode]
  command = "urlcode"
  args = ["mcp", "--project", "."]
  ```
- **Any stdio client** spawns `urlcode mcp --project DIR` with the project as the
  working directory, speaks newline-delimited JSON-RPC 2.0 over stdin/stdout,
  and follows the 2025-11-25 lifecycle described above. Nothing listens on a
  port; closing stdin ends the session.

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

`urlcode mcp --allow-authoring --project DIR` adds six tools to the thirty-one read
tools above (thirty-two with `--host-file`). The flag is honored from the operator's command line only: no
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
