# @jimhoyd/urlcode-mcp

Operator-installed declarative [MCP](https://modelcontextprotocol.io) (Model
Context Protocol) tool server for URLCode. Declare bounded tools — a name, a
description, a `request.body.schema`-shaped input schema and a trusted
project handler — plus optional bounded `resources` and `prompts`, and mount
the server; the extension owns JSON-RPC 2.0 framing, protocol version
negotiation, request-id handling, cursor pagination and
`initialize`/`ping`/`tools/list`/`tools/call`/`resources/list`/`resources/read`/`prompts/list`/`prompts/get`
dispatch. Project YAML never carries JSON-RPC mechanics or a transport
choice.

Released as a tarball on core's GitHub Release, at core's version, and pinned
by sha512 in core's `dist/addons.json`; only core is on npm. See
[add-ons](../../docs/EXTENSIONS.md#add-ons-extensions-and-artifacts) for the
site layout and commands, and [docs/EXTENSIONS.md](../../docs/EXTENSIONS.md)
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
              description: Returns the current server time.
              inputSchema: {type: object, properties: {}, additionalProperties: false}
              handler: ./mcp-tools/get-time.mjs
          resources:
            readme:
              uri: file:///project/README.md
              name: README
              description: The project's README file.
              mimeType: text/markdown
              handler: ./mcp-resources/readme.mjs
          prompts:
            code_review:
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
instance); `tools/list`, `resources/list` and `prompts/list` each page at 20
entries per response, encoding an opaque `cursor`/`nextCursor` — a client
must treat the cursor as opaque and never construct one itself.

`inputSchema` (and the optional `outputSchema` below) is the same bounded
JSON Schema subset `request.body.schema` accepts (`type`, `properties`,
`required`, `additionalProperties`, `items`, `enum`, string/number/array
bounds, `pattern` and `format: uuid`) and must declare `type: object` — an
MCP tool call's `arguments`, and its structured result, are always objects. A
call whose arguments fail `inputSchema` never reaches the handler; it answers
a JSON-RPC `-32602 Invalid params` error carrying the same structured
`issues` list `request.body.schema` produces, rendered as `pointer`/`message`
text — reused, not reimplemented.

A tool may also declare `outputSchema`. When present, the handler's return
value must be an object conforming to it; `tools/call` then returns both a
serialized-JSON text content block (for clients that only read `content`,
per the specification's backward-compatibility guidance) and
`structuredContent` carrying the value itself. A handler result that does
not conform to a declared `outputSchema` is treated as a server-side
contract violation: the caller gets the same generic `isError: true` failure
a thrown handler produces, and `onToolError` observes the real mismatch.

`handler` (for a tool, a resource or a prompt) is a project-relative module
reference (`source`, optional `export`, defaulting to `default`), loaded and
run exactly like any other extension project hook
(`docs/EXTENSIONS.md#project-level-lifecycle-hooks`): trusted first-party
code, in-process, with full Node access. `sandbox: true` is refused, the same
as every other extension hook — v1 of this contract has no sandboxed tool
protocol. A handler that throws never leaks its message or stack to the MCP
caller; see [SECURITY.md](SECURITY.md) and `McpExtensionOptions.onToolError`
for how the operator observes the real error.

A **tool** handler receives only the schema-validated `arguments` object and
returns any JSON-serializable value (or a plain string); the extension wraps
it as a single MCP text content block (plus `structuredContent` when
`outputSchema` is declared, above). A thrown tool handler error becomes a
tool result with `isError: true` and a fixed generic message.

A **resource** handler receives no arguments (MCP resources are addressed
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

## Activate it in host.mjs

```js
// host.mjs (trusted operator code, outside app/)
import { composeHost } from '@jimhoyd/urlcode/host';
import mcp from '@jimhoyd/urlcode-mcp/extension';

export default await composeHost(import.meta.url, [
  mcp({
    onToolError(error, { server, tool, kind }) { console.error(`mcp ${kind} ${server}/${tool} failed`, error); },
  }),
]);
```

`composeHost` supplies the reviewed `PROJECT_SHA256`; the options are
optional.

```sh
PROJECT_SHA256=<reviewed revision> urlcode serve --project app \
  --host-file host.mjs --origin https://site.example
```

## Protecting a mount

Add `auth: true` (or a specific `auth: {role: ...}`) to the route like any
other extension mount, when tool calls require a signed-in caller. The
extension has no identity or authorization model of its own.

## What this implements

- JSON-RPC 2.0 request/response framing over HTTP POST, with the exact
  client-supplied `id` (any JSON-RPC-legal string, integer, or `null`)
  echoed back verbatim — never a substitute id generated internally. This is
  the specific bug the evidence behind this package's issue reported in a
  hand-written implementation.
- Protocol version negotiation on `initialize`: the client's requested
  `protocolVersion` is echoed back when supported, otherwise the server's own
  preferred version is returned, per the MCP specification's negotiation
  flow. Behavior does not otherwise vary by negotiated version.
- `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`,
  `resources/read`, `prompts/list`, `prompts/get`, and the
  `notifications/initialized` notification (accepted, produces no response —
  a notification, any message with no `id`, never gets one, matching plain
  JSON-RPC 2.0). `initialize` advertises the `resources`/`prompts`
  capabilities only when the server declares at least one of that primitive.
- `tools/list`, `resources/list` and `prompts/list` cursor pagination
  (`params.cursor` in, `result.nextCursor` out when more entries remain), a
  stable 20-entries-per-page slice over each map sorted by name. An
  unrecognized or malformed cursor answers `-32602 Invalid params`.
- Tool `outputSchema` / `structuredContent`, validated against the same
  bounded schema subset as `inputSchema` (see "Declare a server" above).
- The `MCP-Protocol-Version` request header on every message after
  `initialize` (requests and notifications): a supported revision is
  accepted, a missing header is treated as `2025-03-26` (the Streamable HTTP
  transport's rule for older clients), and any other value answers HTTP
  `400` before dispatch. `initialize` itself negotiates from
  `params.protocolVersion` and ignores the header.
- `Origin` validation against DNS rebinding, as the Streamable HTTP transport
  requires: a request whose `Origin` header is present and is not exactly the
  site's canonical origin (`--origin`) answers HTTP `403` before its body is
  parsed. A request with no `Origin` (non-browser MCP clients send none) is
  admitted. There is no per-server allowlist of other origins.
- Standard JSON-RPC error codes: `-32700` parse error, `-32600` invalid
  request (including a rejected batch array), `-32601` method not found,
  `-32602` invalid params (unknown tool/prompt name, a schema-failing
  arguments object, or an invalid pagination cursor), `-32603` reserved for
  an unexpected internal failure (including a thrown resource/prompt handler
  and a tool result that fails its own declared `outputSchema`), `-32002`
  resource not found.
- Host-owned error behavior: a thrown tool/resource/prompt handler error is
  reported to the MCP caller as a generic failure and to the operator, via
  `onToolError`, with the real error and which server/hook/kind it came from
  — the extension makes no logging decision of its own beyond that callback.

## What this does not implement (v1)

- The Streamable HTTP transport's optional GET/SSE stream for
  server-initiated messages (a GET request answers `405`, the specification's
  own guidance when a server does not offer that stream) and `Mcp-Session-Id`
  session resumption. This is a transport-level gap, not merely an unwired
  feature: `HandlerResult` (the generic extension response type every
  runtime target implements) carries a single buffered body, not a stream, so
  serving SSE would need a core capability this extension contract does not
  have yet. Tracked as a core follow-up (see the package's tracked issues).
- JSON-RPC batching (arrays of requests); the 2025-06-18 MCP revision removed
  batching from the specification entirely, and this extension refuses a
  batch outright for every protocol revision it negotiates — a confirmed
  scope decision, re-checked against the current specification, not an
  unaddressed gap.
- Resource templates (`resources/templates/list`, parameterized `uriTemplate`
  resources) and resource/prompt subscriptions
  (`resources/subscribe`, `notifications/*/list_changed`) — every declared
  resource is a fixed `uri`, and the tool/resource/prompt sets are static for
  the life of an activation, so `listChanged` is always `false`.
- OAuth/bearer authorization flows defined by the MCP authorization spec;
  protect a mount with the `auth` extension instead, the same as any other
  extension route.

These are deliberate scope choices for a first, minimal, declarative surface
("MCP over HTTP becomes declarative", not a full-featured MCP server) rather
than oversights; see the package's tracked follow-up issues for status.

Requires the matching `@jimhoyd/urlcode` core as a peer. Apache-2.0.
