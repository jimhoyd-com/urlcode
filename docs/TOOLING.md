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
- `explainRoute(project, target, options)` reports the selected route pattern and
  method list. It performs path selection only: it does not evaluate request
  inputs, conditions, policies or the handler.
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

Inspection reads declared configuration and function source graphs to validate
references and compute revision hashes. It compiles route and policy semantics
using dummy binding values. It never reads environment or dotenv credentials,
starts guest execution, follows network destinations, or opens operator link
stores. The result contains no raw compiled route, binding values or source text.
Inspection is not deployment readiness: missing operator grants, live service
availability, asset snapshot activation and provider behavior require their own
checks. Build output remains an explicit separate build API/CLI operation.

The package root also exports existing operator-invoked workflow APIs:
`buildCloudflare(project, options)` compiles and writes a Cloudflare artifact;
`runProjectTests(project, options)` starts the local runtime, executes request
fixtures and closes it; `scaffoldProject(project, {dryRun})` creates missing
placeholders while preserving existing files; `initProject(destination)` creates
the standard starter; and `addRedirect(project, destination, alias?)` updates
project YAML under the authoring lock. `CloudflareBuildOptions`,
`CloudflareBuildReport`, `ProjectTestOptions`, `ProjectTestResult`, `ScaffoldReport`
and `ScaffoldUnresolved` describe these existing operations.

These SDK functions have explicit write or execution effects and are available
to trusted callers only. Project tests use normal runtime activation, grants and
sandboxing; granted proxy/signal fixtures can perform real outbound operations.
Compilation and authoring write caller-selected destinations under each existing
helper's documented rules. They are **not** MCP tools. MCP remains limited to
the read-only operations below; adding a package-root export does not grant an
assistant file-write, guest-execution, deployment or network authority.

`serveMcp({project, input?, output?, origin?})` serves one operator-selected root
on stdio. Its tools are `inspect`, `validate`, `capabilities`, `get_capability`,
`get_schema`, `explain`, `import_preview`, `export_preview`, `recipes_list` and
`recipes_show`. Tools accept no project/file/output path argument; recipe names
come from the fixed catalog, `get_capability` names from the capability catalog
and `get_schema` paths from the bundled schema.
There is no shell, arbitrary file read, remote fetch, binding access, write or
route-execution tool without the explicit [authoring mode](#authoring-mode) flag. Configuration includes and module references retain the
runtime's existing root containment checks. Returned project and recipe content
is data, not trusted instructions for the consuming agent.

The server implements the MCP **2025-11-25** lifecycle and stdio framing. Clients
initialize, verify the returned protocol version, then send
`notifications/initialized` before tool operations. Other requested revisions
negotiate to this explicit supported version; a client that cannot support it
must disconnect. Newer lifecycle revisions are not claimed. Requests use UTF-8
newline-delimited JSON-RPC 2.0, with one request at a time and stream backpressure.
There is a 1 MiB input-frame and output-message limit; oversized input terminates
the session after a fixed error, and truncated/invalid frames return protocol
errors. Import text is additionally capped at 512 KiB. Tool schemas reject
unknown arguments. Tool operation errors are generic to avoid exposing local
source paths, credentials or configuration excerpts; inspect locally for details.

## Authoring mode

`urlcode mcp --allow-authoring --project DIR` adds six tools to the ten read
tools above. The flag is honored from the operator's command line only: no
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
