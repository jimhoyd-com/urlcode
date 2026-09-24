# @jimhoyd/urlcode-mcp

Operator-installed declarative [MCP](https://modelcontextprotocol.io) (Model
Context Protocol) tool server for URLCode. Declare bounded tools — a name, a
description, a `request.body.schema`-shaped input schema and a trusted
project handler — and mount the server; the extension owns JSON-RPC 2.0
framing, protocol version negotiation, request-id handling and
`initialize`/`ping`/`tools/list`/`tools/call` dispatch. Project YAML never
carries JSON-RPC mechanics or a transport choice.

Not yet published to npm or included in a signed `extension-bundles@v…`
release; see [docs/FRAMEWORK.md](../../docs/FRAMEWORK.md) for current
distribution status. See [docs/EXTENSIONS.md](../../docs/EXTENSIONS.md) for
the generic extension contract this package implements.

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
routes:
  /mcp/*:
    extension: mcp
    methods: [POST, HEAD]
```

A server's `tools` map is bounded (at most 64 tools, at most 8 servers per
extension instance). `inputSchema` is the same bounded JSON Schema subset
`request.body.schema` accepts (`type`, `properties`, `required`,
`additionalProperties`, `items`, `enum`, string/number/array bounds, `pattern`
and `format: uuid`) and must declare `type: object` — an MCP tool call's
`arguments` are always an object. A call whose arguments fail this schema
never reaches the handler; it answers a JSON-RPC `-32602 Invalid params`
error carrying the same structured `issues` list `request.body.schema`
produces, rendered as `pointer`/`message` text — reused, not reimplemented.

`handler` is a project-relative module reference (`source`, optional
`export`, defaulting to `default`), loaded and run exactly like any other
extension project hook (`docs/EXTENSIONS.md#project-level-lifecycle-hooks`):
trusted first-party code, in-process, with full Node access. `sandbox: true`
is refused for a tool handler, the same as every other extension hook — v1
of this contract has no sandboxed tool protocol. A handler receives only the
schema-validated `arguments` object and returns any JSON-serializable value
(or a plain string); the extension wraps it as a single MCP text content
block. A handler that throws never leaks its message or stack to the MCP
caller — the response is a tool result with `isError: true` and a fixed
generic message; see [SECURITY.md](SECURITY.md) and
`McpExtensionOptions.onToolError` for how the operator observes the real
error.

## Wire it in a host file

```js
// host.mjs (trusted operator code, outside the project)
import { createMcpExtension } from '@jimhoyd/urlcode-mcp';
export default {
  extensions: [createMcpExtension({
    projectSha256, // inspectExtensionRevision(project), reviewed and pinned by the operator
    onToolError(error, { server, tool }) { console.error(`mcp tool ${server}/${tool} failed`, error); },
  })],
};
```

```sh
urlcode serve --project ./site --origin https://site.example \
  --host-file /absolute/operator/host.mjs
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
- `initialize`, `ping`, `tools/list`, `tools/call`, and the
  `notifications/initialized` notification (accepted, produces no response —
  a notification, any message with no `id`, never gets one, matching plain
  JSON-RPC 2.0).
- Standard JSON-RPC error codes: `-32700` parse error, `-32600` invalid
  request (including a rejected batch array), `-32601` method not found,
  `-32602` invalid params (unknown tool name or a schema-failing arguments
  object), `-32603` reserved for unexpected internal failure.
- Host-owned error behavior: a thrown tool handler error is reported to the
  MCP caller as a generic tool-result failure and to the operator, via
  `onToolError`, with the real error and which server/tool it came from —
  the extension makes no logging decision of its own beyond that callback.

## What this does not implement (v1)

- The Streamable HTTP transport's optional GET/SSE stream for
  server-initiated messages (a GET request answers `405`, the specification's
  own guidance when a server does not offer that stream) and `Mcp-Session-Id`
  session resumption.
- JSON-RPC batching (arrays of requests); the 2025-06-18 MCP revision removed
  it, and this extension refuses a batch outright.
- The `resources` and `prompts` MCP primitives, tool `outputSchema` /
  `structuredContent`, and `tools/list` pagination (`cursor`) — the bounded
  tool map declared in YAML is returned in one page.
- OAuth/bearer authorization flows defined by the MCP authorization spec;
  protect a mount with the `auth` extension instead, the same as any other
  extension route.

These are deliberate scope choices for a first, minimal, declarative surface
("MCP over HTTP becomes declarative", not a full-featured MCP server) rather
than oversights; see the package's tracked follow-up issues for status.

Requires the matching `@jimhoyd/urlcode` core as a peer. Apache-2.0.
