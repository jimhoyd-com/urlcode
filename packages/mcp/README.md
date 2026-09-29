# @jimhoyd/urlcode-mcp

Operator-installed declarative [MCP](https://modelcontextprotocol.io) (Model
Context Protocol) tool server for URLCode. Declare bounded tools — a name, a
description, a `request.body.<METHOD>.schema`-shaped input schema and a trusted
project handler — plus optional bounded `resources` and `prompts`, and mount
the server. The protocol is the official MCP TypeScript SDK's
(`@modelcontextprotocol/server`, pinned in `package.json`; #846): JSON-RPC
over Streamable HTTP, version negotiation, request ids and errors. This
package owns what the YAML declares: the tool, resource and prompt sets,
their argument and output checks, the trusted handler calls and the failure
messages callers see. Project YAML never carries JSON-RPC mechanics or a
transport choice; streamed progress replies are an operator opt-in in
`host.mjs`.

Released as a tarball on core's GitHub Release, at core's version, and pinned
by sha512 in core's `dist/addons.json`; only core is on npm. See
[add-ons][add-ons] for the
site layout and commands, and [docs/EXTENSIONS.md][extensions]
for the generic extension contract this package implements.

`urlcode extensions add mcp` (or `urlcode init <site> --with mcp`) declares
`extensions.mcp` with an empty config (`servers` is optional) and adds `mcp()`
to `host.mjs`, but declares no server and no route: every tool needs a trusted
project handler module under `app/`, and a scaffold writes operator files only
outside the reviewed route project. Its printed notes walk through adding a
server, a tool and its handler module by hand, using the same example as
below.

## Declare a server

```yaml
version: "1"
extensions:
  mcp:
    version: "1"
    config:
      servers:
        default:
          mount: /mcp
          serverName: example-tools
          serverVersion: "1.0.0"
          instructions: Optional text shown to a connecting MCP client.
          tools:
            get_time:
              title: Current time
              description: Returns the current server time.
              annotations: {readOnlyHint: true, idempotentHint: true, openWorldHint: false}
              inputSchema: {type: object, properties: {}, additionalProperties: false}
              handler: ./mcp-tools/get-time.mjs
          resources:
            readme:
              uri: file:///project/README.md
              name: README
              title: Project README
              description: The project's README file.
              mimeType: text/markdown
              handler: ./mcp-resources/readme.mjs
          prompts:
            code_review:
              title: Code review
              description: Asks the model to review a code snippet.
              arguments:
                - {name: code, description: The code to review, required: true}
              handler: ./mcp-prompts/code-review.mjs
routes:
  /mcp/*:
    extension: mcp
    methods: [POST, HEAD]
```

The endpoint a client connects to is the declared `mount`, exactly:
`POST https://site.example/mcp`. `/mcp/*` is the route syntax URLCode
requires for an extension mount (core strips the `/*` to mount the server at
`/mcp`); it does not make the subtree an endpoint. `/mcp/` (trailing slash)
and any subpath such as `/mcp/tools` answer `404`, and the runtime does not
redirect or normalize them, so configure an MCP client with the URL exactly
as `mount` declares it.

A server's `tools`, `resources` and `prompts` maps are each independently
bounded (at most 64 entries per map, at most 8 servers per extension
instance); `tools/list`, `resources/list` and `prompts/list` return every
entry in one response.

`inputSchema` (and the optional `outputSchema` below) is the same bounded
JSON Schema 2020-12 profile `request.body.<METHOD>.schema` accepts (local `$defs`/`$ref`,
type lists, `anyOf`/`oneOf`/`allOf`/`not`, `properties`, `required`,
`additionalProperties`, `items`, scalar `enum`/`const`, string/number/array
bounds, a bounded `pattern` and the standard string formats such as `uuid`,
`date-time` and `email`; see
[HTTP][http-body-schema-and-input-patterns]), compiled once at
activation, and must declare `type: object` — an
MCP tool call's `arguments`, and its structured result, are always objects. A
call whose arguments fail `inputSchema` never reaches the handler. Under
MCP revision `2025-11-25` it answers a tool result with `isError: true` whose
text lists the failed checks; under earlier revisions it answers a JSON-RPC
`-32602 Invalid params` error carrying the same checks as a structured
`issues` list. Both use the wording `request.body.<METHOD>.schema` produces,
rendered as `pointer`/`message` text — reused, not reimplemented. Either
schema may instead be the name of one of the project's named schemas, shared
with the routes that name it ([below](#named-schemas)).

A tool may also declare `outputSchema`. When present, the handler's return
value must be an object conforming to it; `tools/call` then returns both a
serialized-JSON text content block (for clients that only read `content`,
per the specification's backward-compatibility guidance) and
`structuredContent` carrying the value itself. A handler result that does
not conform to a declared `outputSchema` is treated as a server-side
contract violation: the caller gets the same generic `isError: true` failure
a thrown handler produces, and `onToolError` observes the real mismatch.

A tool, a resource or a prompt may declare an optional `title` (1–256
characters), a human-readable display name echoed in `tools/list`,
`resources/list` or `prompts/list`. A tool may also declare optional
`annotations`, restricted to the four MCP behavior hints `readOnlyHint`,
`destructiveHint`, `idempotentHint` and `openWorldHint`, each a boolean; an
unknown key or a non-boolean value fails validation, and `title` belongs at
the tool's top level, not inside `annotations`. The declared hints are echoed
verbatim in `tools/list` so a client can decide, for example, whether a call
needs user confirmation. They are advisory metadata only: the extension never
enforces them or changes how a handler runs, and a client must not treat them
as a security guarantee. Absent fields are omitted from the list responses.

`handler` (for a tool, a resource or a prompt) is a project-relative module
reference (`source`, optional `export`, defaulting to `default`), loaded and
run exactly like any other extension project hook
(`docs/EXTENSIONS.md#project-level-lifecycle-hooks`): trusted first-party
code, in-process, with full Node access. `sandbox: true` is refused, the same
as every other extension hook — v1 of this contract has no sandboxed tool
protocol. A handler that throws never leaks its message or stack to the MCP
caller (the one exception is a tool handler's deliberate `McpToolError`,
below); see [SECURITY.md](SECURITY.md) and `McpExtensionOptions.onToolError`
for how the operator observes the real error.

Every handler is called as `handler(input, context)`. `context` is frozen and
carries:

- `env`: the mount route's own `env` bindings, declared with the same route
  `env:` block a function route uses and granted by the same revision-pinned
  operator policy entry, `permissions.routes["/mcp/*"].env`. An ungranted
  reference with no `default` fails activation, exactly like a function route;
  `secrets` are refused on the mount.
- `requestId`: the id the HTTP response carries in `X-Request-Id`.
- `server`, `tool` and `kind`: the server key, the tool/resource/prompt key
  and `'tool'`, `'resource'` or `'prompt'`.

```yaml
routes:
  /mcp/*:
    extension: mcp
    methods: [POST, HEAD]
    env:
      SKILLS: {env: MCP_ENABLED_SKILLS}
```

```js
// app/mcp-tools/skills-list.mjs
export default function skillsList(_args, { env }) {
  return { skills: env.SKILLS.split(',') };
}
```

The env grant is an injection convenience, not a restriction: handlers are
trusted in-process code and can read `process.env` themselves. A tool's
declared schemas never vary with the environment (see "What this does not
implement").

A **tool** handler receives the schema-validated `arguments` object as its
first argument and returns any JSON-serializable value (or a plain string); the extension wraps
it as a single MCP text content block (plus `structuredContent` when
`outputSchema` is declared, above).

A tool handler that needs to tell the caller why a call failed, so the model
can correct its arguments and retry, throws `McpToolError` (exported by
`@jimhoyd/urlcode-mcp`). The result is `isError: true` with the error's
message as its text content, a *tool execution error* in the specification's
terms:

```js
// app/mcp-tools/book-flight.mjs
import { McpToolError } from '@jimhoyd/urlcode-mcp';

export default function bookFlight({ date }) {
  if (Date.parse(date) < Date.now()) {
    throw new McpToolError(`Invalid departure date ${date}: it must be in the future.`, { data: { field: 'date' } });
  }
  // ...
}
```

The message is caller-facing text: write it for the model, and never put a
secret or internal detail in it. Messages longer than 4096 characters are
truncated. The optional `data` object is returned as `structuredContent` only
when the tool declares an `outputSchema` and `data` conforms to it; otherwise
it is dropped, the message is still returned, and `onToolError` observes the
mismatch. `onToolError` is not called for an `McpToolError` itself, and
`onToolCall` reports it as `outcome: 'tool_error'`. Any other thrown error
becomes a tool result with `isError: true` and the fixed generic message
`The tool could not complete the request.`; its text never reaches the
caller.

A **resource** handler receives an empty first argument (MCP resources are addressed
only by their declared `uri`; parameterized resource templates are not
implemented — see below) and returns either a plain string (served as
`text`), or `{text, mimeType?}` / `{blob, mimeType?}` (`blob` is
base64-encoded binary content), read over `resources/read`. An unknown `uri`
answers JSON-RPC `-32002 Resource not found`; a thrown handler error answers
`-32603`.

A **prompt** handler receives the schema-validated `arguments` object (every
declared prompt argument is a string; `required: true` arguments must be
present) and returns prompt message content for `prompts/get`: a plain
string (one user-role text message), or an array of `{role, text}` /
full-shape `{role, content: {type: 'text', text}}` entries. A thrown prompt
handler error answers `-32603`.

### Named schemas

A tool's `inputSchema` or `outputSchema` may be the name of one of the
project's named schemas (the top-level `schemas:` map in `urlcode.yaml`,
inline or loaded from a schema file; see
[HTTP][http-named-schemas]), so a POST route and a tool validate
against one document:

```yaml
version: "1"
schemas:
  contact: {file: schemas/contact.json}
extensions:
  mcp:
    version: "1"
    config:
      servers:
        default:
          mount: /mcp
          serverName: contacts
          serverVersion: "1.0.0"
          tools:
            save_contact:
              description: Saves a contact.
              inputSchema: contact
              handler: ./mcp-tools/save-contact.mjs
routes:
  /mcp/*:
    extension: mcp
    methods: [POST, HEAD]
  /contacts:
    methods: [POST]
    request:
      body:
        POST: {format: json, required: true, schema: contact}
    function: functions/save-contact.mjs
```

Core hands every activation the project's schemas, already admitted and
compiled (`ExtensionActivation.schemas`); the tool resolves the name there,
refuses a name the project does not declare at activation, and still requires
`type: object`. `tools/list` advertises the resolved schema itself, never the
name, so a client needs nothing but the listing. The same invalid input fails
the route with a 422 whose first issue has `pointer: /email` and the tool with
`Invalid arguments for tool save_contact: /email must be an email`: the same
pointer and the same words. The schema carries the arguments' shape only: who
may call the tool stays with the mount's `auth:`/`policies.extensions`, and
nothing in it is a default a handler can rely on (the profile refuses
`default`).

## Activate it in host.mjs

```js
// host.mjs (trusted operator code, outside app/)
import { composeHost } from '@jimhoyd/urlcode/host';
import mcp from '@jimhoyd/urlcode-mcp/extension';

export default await composeHost(import.meta.url, [
  mcp({
    onToolError(error, { server, tool, kind }) { console.error(`mcp ${kind} ${server}/${tool} failed`, error); },
    onToolCall({ server, tool, kind, outcome, durationMs, requestId }) {
      console.log(JSON.stringify({ event: 'mcp_call', server, tool, kind, outcome, durationMs, requestId }));
    },
  }),
]);
```

`onToolCall` runs once for every tool/resource/prompt handler invocation after
it settles, with `outcome: 'success'`, `'tool_error'` (a tool handler threw
`McpToolError`) or `'error'` (the same failures `onToolError` observes), its
duration and the request id. A call refused before
its handler runs (unknown name, arguments failing the schema) is not reported.
Both callbacks are best-effort: one that throws is swallowed and never changes
the response.

`composeHost` supplies the reviewed revision pin (from `--policy`, or
`PROJECT_SHA256`); the options are optional.

```sh
urlcode serve --project app --host-file host.mjs \
  --policy /etc/urlcode/policy.json --origin https://site.example
```

## Streaming progress (operator opt-in)

The server is stateless: every POST is answered on its own, with no
`Mcp-Session-Id` and no server-initiated GET stream (`GET` and `DELETE`
answer `405`). Replies are Server-Sent Events, as the Streamable HTTP
transport allows, so clients must send
`Accept: application/json, text/event-stream`.

Whether an SSE reply is passed through as it is produced is an operator
choice in `host.mjs`, never project YAML:

```js
// host.mjs
export default await composeHost(import.meta.url, [mcp({ streaming: true })]);
```

- **Off (the default).** The reply is read whole and returned buffered, on
  every target (node, aws, vercel). A tool's `context.progress` does
  nothing.
- **On.** The registration declares `streams: true`
  ([streamed responses][extensions-streamed-responses]), so core
  refuses it on `aws` before activation; the self-hosted server and Vercel
  deliver it. A `tools/call` whose `params._meta.progressToken` is set gets
  its `notifications/progress` messages, from
  `context.progress(progress, total?, message?)`, before its result. The
  server's stream limits (`--max-streams`, `--stream-idle-timeout-ms`,
  `--stream-max-duration-ms`, `--stream-max-bytes`;
  [operations][operations-streamed-responses]) bound every
  streamed reply.

Every handler receives `context.signal`. It aborts when the client
disconnects or the SDK cancels the request; a handler should stop when it
fires. A `notifications/cancelled` arrives as its own stateless POST, so it
cannot reach a call another request is running.

## Protecting a mount

Add `auth: true` to the route like any other extension mount, when tool calls require a signed-in caller. The
extension has no identity or authorization model of its own.

## What this implements

- The protocol through the official SDK: JSON-RPC 2.0 over Streamable HTTP
  POST with SSE replies, the exact client `id` echoed back, `initialize`
  negotiation for the revisions the pinned SDK supports (currently
  `2025-11-25` back to `2024-11-05`), the `MCP-Protocol-Version` header
  (an unsupported one answers `400`), notifications (`202`), `ping`, and the
  standard error codes: `-32700` parse error and `-32600` invalid request
  (HTTP `400`), `-32601` method not found, `-32602` invalid params (an unknown
  tool, prompt or resource, or prompt arguments that fail their declaration),
  `-32603` internal error. A body over 256 KiB answers `413`, a non-JSON
  media type `415`, and a request that does not accept both JSON and SSE
  `406`.
- `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`,
  `resources/read`, `prompts/list` and `prompts/get`. `initialize`
  advertises the `resources`/`prompts` capabilities only when the server
  declares at least one of that primitive. Lists return every declared entry
  (no pagination).
- Tool arguments that fail the declared `inputSchema` answer a tool
  execution error (`isError: true`, the schema issues as text) so the model
  can correct them, under every revision; the handler never runs.
- Tool `outputSchema` / `structuredContent`, validated against the same
  bounded schema profile as `inputSchema` (see "Declare a server" above).
- Optional `title` on tools, resources and prompts, and optional tool
  `annotations` (the four boolean behavior hints), echoed in the list
  responses.
- `Origin` validation against DNS rebinding, as the Streamable HTTP transport
  requires: a request whose `Origin` header is present and is not one of the
  site's origins, the canonical `--origin` or an operator `--alias-origin`
  (core's single same-origin rule, see
  [site origins][extensions-site-origins-and-same-origin-checks]),
  answers HTTP `403` before its body is parsed, as does `Sec-Fetch-Site:
  cross-site` or a duplicated provenance header. A request with no provenance
  header (non-browser MCP clients send none) is admitted.
- Host-owned error behavior: a thrown tool/resource/prompt handler error is
  reported to the MCP caller as a generic failure and to the operator, via
  `onToolError`, with the real error and which server/hook/kind it came from.
- Caller-facing tool execution errors: a tool handler that throws
  `McpToolError` answers `isError: true` with its own bounded message (and
  `structuredContent` from its `data` when that conforms to the declared
  `outputSchema`).
- Host-owned usage observation: `onToolCall` reports every handler
  invocation's outcome, duration and request id, success or failure.
- Handler request context: `handler(input, { env, requestId, server, tool, kind, signal })`,
  with `env` from the mount route's operator-granted `env` block, and
  `progress` on a tool (see "Streaming progress" above).

## What this does not implement

- Sessions, the server-initiated GET stream and `Last-Event-ID` replay: the
  server is stateless, so there is nothing to resume and nothing is kept
  between requests.
- Streaming on AWS: core refuses a streaming registration there; leave
  `streaming` off to deploy the same project to AWS.
- Resource templates and resource/prompt subscriptions — every declared
  resource is a fixed `uri`, and the sets are static for the life of an
  activation, so `listChanged` is always `false`.
- Environment-dependent tool, resource or prompt schemas (for example an
  `enum` filled from an env binding). Declined by design: the schemas a
  client sees are part of the reviewed, revision-pinned project. Declare the
  schema in YAML and have the handler check `context.env` at call time.
- OAuth/bearer authorization flows defined by the MCP authorization spec;
  protect a mount with a principal-providing extension instead, the same as
  any other extension route.
- Server-initiated requests (elicitation, sampling) and the `tasks` utility.

These are deliberate scope choices for a first, minimal, declarative surface
("MCP over HTTP becomes declarative", not a full-featured MCP server) rather
than oversights; see the package's tracked follow-up issues for status.

Requires the matching `@jimhoyd/urlcode` core as a peer. Apache-2.0.

<!-- The links below are pinned to this release, so an installed copy of this README reads the docs of the
version it describes; `npm run release:bump` moves them and scripts/check-local-links.ts checks their targets. -->
<!-- urlcode-current-version:start -->
[add-ons]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/EXTENSIONS.md#add-ons-extensions-and-artifacts
[extensions]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/EXTENSIONS.md
[http-body-schema-and-input-patterns]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/HTTP.md#body-schema-and-input-patterns
[extensions-streamed-responses]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/EXTENSIONS.md#streamed-responses
[operations-streamed-responses]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/OPERATIONS.md#streamed-responses
[extensions-site-origins-and-same-origin-checks]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/EXTENSIONS.md#site-origins-and-same-origin-checks
[http-named-schemas]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/HTTP.md#named-schemas
<!-- urlcode-current-version:end -->

<!-- extension-reference:start -->
<!-- Generated from urlcode.json by scripts/generate-extension-reference.ts (npm run docs:extensions). Do not edit between these markers; change the extension's schema descriptions instead. -->

## Field reference

Every key `mcp` accepts, rendered from this package's `urlcode.json` (the schema the runtime validates against). Required means required within its containing object; `*` is a key you choose and `[]` an array item.

**Schema-valid is not activatable.** JSON Schema checks shape only. Activation also checks what a schema cannot express: the route for each declared mount exists, referenced fields and collections are declared, peers are installed and active, and the cross-field rules the descriptions state. A project that validates can still refuse to start; run `urlcode validate --project . --host-file <host.mjs> --origin <origin>`, which activates it.

**Peers.** none.

### Configuration: `extensions.mcp.config`

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `extensions.mcp.config.servers` | object | no | minProperties: 1; maxProperties: 8; keys: "^[a-z][a-z0-9_-]{0,63}$" | MCP servers by name. Omitted (the scaffold default): nothing is mounted. Each needs a route `<mount>/*` with extension: mcp (POST, and HEAD). |
| `extensions.mcp.config.servers.*.mount` | string | yes | maxLength: 256; pattern: "^/[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*$" | Exact endpoint path clients POST to; the route is `<mount>/*`, but the mount itself is the only path served (subpaths answer 404). |
| `extensions.mcp.config.servers.*.serverName` | string | yes | minLength: 1; maxLength: 512 | Server name reported in the initialize result (serverInfo.name). |
| `extensions.mcp.config.servers.*.serverVersion` | string | yes | minLength: 1; maxLength: 64 | Server version reported in the initialize result (serverInfo.version). |
| `extensions.mcp.config.servers.*.instructions` | string | no | maxLength: 4096 | Optional usage instructions returned to clients in the initialize result. |
| `extensions.mcp.config.servers.*.tools` | object | yes | minProperties: 1; maxProperties: 64; keys: "^[a-z][a-z0-9_-]{0,63}$" | Tools by protocol name (tools/list, tools/call); at least one. |
| `extensions.mcp.config.servers.*.tools.*.title` | string | no | minLength: 1; maxLength: 256 | Human-readable display name (the MCP title field); the key stays the protocol name. |
| `extensions.mcp.config.servers.*.tools.*.description` | string | yes | minLength: 1; maxLength: 1024 | What the tool does, shown to MCP clients in tools/list. |
| `extensions.mcp.config.servers.*.tools.*.annotations` | object | no | unknown keys rejected | Optional MCP behavior hints, passed to clients as declared; they are advisory and grant or restrict nothing. |
| `extensions.mcp.config.servers.*.tools.*.annotations.readOnlyHint` | boolean | no | — | Hint to clients that the tool does not modify its environment. |
| `extensions.mcp.config.servers.*.tools.*.annotations.destructiveHint` | boolean | no | — | Hint that the tool may perform destructive updates. |
| `extensions.mcp.config.servers.*.tools.*.annotations.idempotentHint` | boolean | no | — | Hint that repeated calls with the same arguments have no additional effect. |
| `extensions.mcp.config.servers.*.tools.*.annotations.openWorldHint` | boolean | no | — | Hint that the tool interacts with external entities beyond the site. |
| `extensions.mcp.config.servers.*.tools.*.inputSchema` | object / string | yes | one of: object; string (pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$") | Schema of the arguments object, in the bounded `request.body.<METHOD>.schema` JSON Schema 2020-12 profile (checked and compiled at activation), or the name of one of the project's named schemas (top-level schemas:), which a route's `request.body.<METHOD>.schema` can name too; a call whose arguments fail it never reaches the handler. |
| `extensions.mcp.config.servers.*.tools.*.outputSchema` | object / string | no | one of: object; string (pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$") | Optional schema, in the same profile or named the same way, of the object the handler returns; the result is then sent as structuredContent and a result that fails it is an error. |
| `extensions.mcp.config.servers.*.tools.*.handler` | string / object | yes | one of: string (minLength: 1; maxLength: 1024); object (fields below) | Called with the validated arguments and a context (granted env, request id, server and tool names); returns the result or throws McpToolError for an isError answer. Trusted project module ({source, export} or a bare path), run in-process like other extension hooks; sandbox: true is refused. |
| `extensions.mcp.config.servers.*.tools.*.handler.source` | string | yes | minLength: 1; maxLength: 1024 | Project-relative path of the trusted hook module, resolved like a function route source and re-imported on each activation. |
| `extensions.mcp.config.servers.*.tools.*.handler.export` | string | no | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" | Named export to call (default: the module default export). |
| `extensions.mcp.config.servers.*.tools.*.handler.sandbox` | boolean | no | — | Schema-valid but refused at activation when true: extension hooks run trusted, in-process, and are never sandboxed. |
| `extensions.mcp.config.servers.*.tools.*.handler.sandboxReason` | string | no | minLength: 1; maxLength: 512 | Reviewer note recorded with a sandbox choice; it grants nothing. |
| `extensions.mcp.config.servers.*.resources` | object | no | maxProperties: 64; keys: "^[a-z][a-z0-9_-]{0,63}$" | Optional URI-addressed resources (resources/list, resources/read). |
| `extensions.mcp.config.servers.*.resources.*.uri` | string | yes | minLength: 1; maxLength: 2048 | URI clients read the resource by (resources/read); unique within the server. |
| `extensions.mcp.config.servers.*.resources.*.name` | string | yes | minLength: 1; maxLength: 512 | Resource name listed by resources/list. |
| `extensions.mcp.config.servers.*.resources.*.title` | string | no | minLength: 1; maxLength: 256 | Human-readable display name (the MCP title field); the key stays the protocol name. |
| `extensions.mcp.config.servers.*.resources.*.description` | string | no | maxLength: 1024 | What the resource holds, shown to clients. |
| `extensions.mcp.config.servers.*.resources.*.mimeType` | string | no | minLength: 1; maxLength: 255 | MIME type advertised for the resource content. |
| `extensions.mcp.config.servers.*.resources.*.handler` | string / object | yes | one of: string (minLength: 1; maxLength: 1024); object (fields below) | Returns the resource content: a string, or {text or blob, mimeType}. Trusted project module ({source, export} or a bare path), run in-process like other extension hooks; sandbox: true is refused. |
| `extensions.mcp.config.servers.*.resources.*.handler.source` | string | yes | minLength: 1; maxLength: 1024 | Project-relative path of the trusted hook module, resolved like a function route source and re-imported on each activation. |
| `extensions.mcp.config.servers.*.resources.*.handler.export` | string | no | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" | Named export to call (default: the module default export). |
| `extensions.mcp.config.servers.*.resources.*.handler.sandbox` | boolean | no | — | Schema-valid but refused at activation when true: extension hooks run trusted, in-process, and are never sandboxed. |
| `extensions.mcp.config.servers.*.resources.*.handler.sandboxReason` | string | no | minLength: 1; maxLength: 512 | Reviewer note recorded with a sandbox choice; it grants nothing. |
| `extensions.mcp.config.servers.*.prompts` | object | no | maxProperties: 64; keys: "^[a-z][a-z0-9_-]{0,63}$" | Optional prompt templates by name (prompts/list, prompts/get). |
| `extensions.mcp.config.servers.*.prompts.*.title` | string | no | minLength: 1; maxLength: 256 | Human-readable display name (the MCP title field); the key stays the protocol name. |
| `extensions.mcp.config.servers.*.prompts.*.description` | string | no | maxLength: 1024 | What the prompt produces, shown to clients. |
| `extensions.mcp.config.servers.*.prompts.*.arguments` | array | no | maxItems: 32 | Declared string arguments of the prompt template. |
| `extensions.mcp.config.servers.*.prompts.*.arguments[].name` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" | Argument name; its value is a string. |
| `extensions.mcp.config.servers.*.prompts.*.arguments[].description` | string | no | maxLength: 1024 | What the argument means, shown to clients. |
| `extensions.mcp.config.servers.*.prompts.*.arguments[].required` | boolean | no | — | true: prompts/get without it is refused before the handler runs. |
| `extensions.mcp.config.servers.*.prompts.*.handler` | string / object | yes | one of: string (minLength: 1; maxLength: 1024); object (fields below) | Receives the validated string arguments and returns the prompt message content (prompts/get). Trusted project module ({source, export} or a bare path), run in-process like other extension hooks; sandbox: true is refused. |
| `extensions.mcp.config.servers.*.prompts.*.handler.source` | string | yes | minLength: 1; maxLength: 1024 | Project-relative path of the trusted hook module, resolved like a function route source and re-imported on each activation. |
| `extensions.mcp.config.servers.*.prompts.*.handler.export` | string | no | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" | Named export to call (default: the module default export). |
| `extensions.mcp.config.servers.*.prompts.*.handler.sandbox` | boolean | no | — | Schema-valid but refused at activation when true: extension hooks run trusted, in-process, and are never sandboxed. |
| `extensions.mcp.config.servers.*.prompts.*.handler.sandboxReason` | string | no | minLength: 1; maxLength: 512 | Reviewer note recorded with a sandbox choice; it grants nothing. |

### Authoring surfaces and limits

Declare a bounded MCP (Model Context Protocol) tool/resource/prompt server: named tools with a description, a `request.body.<METHOD>.schema-shaped` input (and optional output) schema, an optional title and optional behavior annotations (readOnlyHint, destructiveHint, idempotentHint, openWorldHint), named URI-addressed resources, and named prompt templates (resources and prompts also take an optional title), each backed by a trusted project handler. The extension owns JSON-RPC 2.0 framing, protocol version negotiation, request-id handling, cursor pagination and initialize/ping/tools-*/resources-*/prompts-* dispatch; project YAML never carries JSON-RPC mechanics, a transport choice or provider settings.

- **servers** (configuration, `urlcode.yaml#extensions.mcp.config.servers`): Declare one or more MCP servers, each with a mount, serverName, serverVersion, optional instructions and bounded tools/resources/prompts maps.
- **tool handler** (hook, `urlcode.yaml#extensions.mcp.config.servers.<name>.tools.<name>.handler`): Each tool declares a trusted project module/export handler (source, optional export), loaded and run the same way as other extension hooks: not sandboxed, receives the schema-validated arguments object and a context carrying the granted env of the mount route, the request id and the server/tool names. It returns the result value, or throws McpToolError (exported by @jimhoyd/urlcode-mcp) with a caller-facing message (and optional data returned as structuredContent when it conforms to the declared outputSchema) to answer isError: true; any other thrown error answers a fixed generic message.
- **resource handler** (hook, `urlcode.yaml#extensions.mcp.config.servers.<name>.resources.<name>.handler`): Each resource declares a trusted project module/export handler returning that resource’s content (a string, or {text\|blob, mimeType}), served over resources/read.
- **prompt handler** (hook, `urlcode.yaml#extensions.mcp.config.servers.<name>.prompts.<name>.handler`): Each prompt declares a trusted project module/export handler receiving the schema-validated string arguments and returning prompt message content, served over prompts/get.
- **mount** (extension, `urlcode.yaml`): Mount each server at its declared path with POST (and HEAD); the protocol is stateless, so GET and DELETE are answered 405. The operator may enable streamed progress replies in host.mjs. Add `auth: true` when tool calls require a signed-in caller.

Fast checks: `urlcode validate --project . --host-file <host.mjs> --origin <origin>`, `urlcode test --project . --host-file <host.mjs> --origin <origin>`.
<!-- extension-reference:end -->
