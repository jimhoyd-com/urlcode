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
on stdio. Its tools are `inspect`, `validate`, `capabilities`, `explain`,
`import_preview`, `export_preview`, `recipes_list` and `recipes_show`. Tools accept
no project/file/output path argument; recipe names come from the fixed catalog.
There is no shell, arbitrary file read, remote fetch, binding access, write or
route-execution tool. Configuration includes and module references retain the
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

Only tools are advertised. Resources, prompts, subscriptions, sampling,
elicitation, HTTP transport, cancellation and durable tasks are not implemented.
Closing stdin ends the session after the current bounded operation. Existing
configuration-loader and semantic-compiler deadlines still apply. This local
process is not an authenticated remote service or an independent security review.

Protocol references: [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
[MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle),
and [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
