# @jimhoyd/urlcode-mcp

Operator-installed declarative [MCP](https://modelcontextprotocol.io) (Model
Context Protocol) tool server for URLCode. Declare bounded tools — a name, a
description, a `request.body.schema`-shaped input schema and a trusted
project handler — plus optional bounded `resources` and `prompts`, and mount
the server; the extension owns JSON-RPC 2.0 framing, protocol version
negotiation, request-id handling, cursor pagination and
`initialize`/`ping`/`tools/list`/`tools/call`/`resources/list`/`resources/read`/`prompts/list`/`prompts/get`
dispatch. Project YAML never carries JSON-RPC mechanics or a transport
choice; the optional streaming transport (sessions, SSE progress and the
server stream) is an operator opt-in in `host.mjs`.

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
instance); `tools/list`, `resources/list` and `prompts/list` each page at 20
entries per response, encoding an opaque `cursor`/`nextCursor` — a client
must treat the cursor as opaque and never construct one itself.

`inputSchema` (and the optional `outputSchema` below) is the same bounded
JSON Schema subset `request.body.schema` accepts (`type`, `properties`,
`required`, `additionalProperties`, `items`, `enum`, string/number/array
bounds, `pattern` and `format: uuid`) and must declare `type: object` — an
MCP tool call's `arguments`, and its structured result, are always objects. A
call whose arguments fail `inputSchema` never reaches the handler. Under
MCP revision `2025-11-25` it answers a tool result with `isError: true` whose
text lists the failed checks; under earlier revisions it answers a JSON-RPC
`-32602 Invalid params` error carrying the same checks as a structured
`issues` list. Both use the wording `request.body.schema` produces,
rendered as `pointer`/`message` text — reused, not reimplemented.

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

## Streaming transport (operator opt-in)

The optional parts of the MCP Streamable HTTP transport are an operator
choice in `host.mjs`, never project YAML. They are off by default; with them
off the extension answers exactly as described above on every target.

```js
// host.mjs
export default await composeHost(import.meta.url, [
  mcp({ streaming: true }),
  // or with bounded overrides:
  // mcp({ streaming: { maxSessions: 200, sessionIdleTimeoutMs: 600000, keepAliveMs: 10000, replayMaxEvents: 32, replayMaxBytes: 32768 } }),
]);
```

| Option | Default | Range | Meaning |
|---|---|---|---|
| `maxSessions` | `1000` | 1–100000 | Sessions kept at once. `initialize` beyond it evicts the least recently used session (its open GET stream ends, its in-flight calls are aborted). |
| `sessionIdleTimeoutMs` | `1800000` (30 min) | 1000–86400000 | A session with no request, and no open GET stream, for this long is forgotten. |
| `keepAliveMs` | `15000` | 100–600000 | Interval of the `: ping` SSE comment on an open stream. Must be below `sessionIdleTimeoutMs`, and should be below the server's `--stream-idle-timeout-ms` (default 30000), or the server ends a quiet stream. |
| `replayMaxEvents` | `64` | 1–10000 | Server-initiated events a session keeps for `Last-Event-ID` replay. |
| `replayMaxBytes` | `65536` | 1024–16777216 | Bytes of those events a session keeps; a single larger event is not sent. |

With streaming on, the registration declares `streams: true`
([streamed responses](../../docs/EXTENSIONS.md#streamed-responses)), so the
site must be served by the self-hosted server: core refuses the registration
on `aws` (and there is no `cloudflare` target for extensions) before
activation, and the extension refuses `vercel` at activation, because its
function instances do not share the in-memory session table. Leave streaming
off to deploy the same project to AWS or Vercel. The server's stream limits
(`--max-streams`, `--stream-idle-timeout-ms`, `--stream-max-duration-ms`,
`--stream-max-bytes`; [operations](../../docs/OPERATIONS.md#streamed-responses))
bound every SSE response, and each open GET stream counts against
`--max-streams`.

The mount must also accept the extra methods:

```yaml
routes:
  /mcp/*:
    extension: mcp
    methods: [GET, POST, DELETE, HEAD]
```

What changes when it is on:

- **Sessions.** A successful `initialize` answers with an `Mcp-Session-Id`
  header: 32 random bytes as base64url (43 visible-ASCII characters). Every
  later request, notification, GET and DELETE must carry it. A request
  without it (other than `initialize`) answers `400`; an unknown, ended,
  expired or evicted id answers `404`, which tells the client to
  re-initialize. `DELETE` with the header ends the session (`204`), ends its
  GET stream and aborts its in-flight calls. When the mount runs behind a
  principal-providing extension (for example `auth`), a session is bound to
  the principal that created it; the same id presented by another principal,
  or by an anonymous caller, answers `404` exactly like an unknown id. On an
  unauthenticated mount the id itself is the only credential, so treat it as
  a bearer secret and keep the mount on HTTPS.
- **Sessions live in memory only.** The table belongs to one extension
  instance in one process. A restart, a redeploy or a dev reload forgets
  every session, so a client's next request answers `404` and it
  re-initializes; nothing is persisted and there is no sharing between
  processes or replicas (pin a client to one process, for example with
  sticky routing, if you run several).
- **Progress over SSE.** A `tools/call` whose `params._meta.progressToken`
  is a string or integer, sent with an `Accept` that includes
  `text/event-stream`, is answered as an SSE stream
  (`Content-Type: text/event-stream`): zero or more
  `notifications/progress` messages, then the JSON-RPC response, then the
  end of the stream. Every other request keeps the plain JSON reply. A tool
  handler reports progress with `context.progress(progress, total?, message?)`;
  a value that does not increase is dropped, as the progress utility
  requires, and values reported faster than the client reads are coalesced
  to the latest one. Without a token or an SSE `Accept`, `progress` does
  nothing. A POST stream carries no event ids and cannot be resumed.
- **Cancellation.** Every handler receives `context.signal`. It aborts when
  the client disconnects (including closing a POST SSE stream), when the
  client sends `notifications/cancelled` naming the request's id in the same
  session, when the session ends, or at a server stream limit or shutdown. A
  handler should stop when it fires. A cancelled call's response is still
  sent if the handler returns one; the client ignores it.
- **The GET stream.** `GET` on the mount with `Accept: text/event-stream`
  and the session header opens the session's stream for server-initiated
  messages (`406` without that `Accept`). It sends `: ping` keep-alive
  comments every `keepAliveMs`, and every message event has an `id`: a
  per-session integer counting from 1, consecutive, so a client can see a
  gap. The session keeps the newest `replayMaxEvents` events (within
  `replayMaxBytes`). A reconnect with `Last-Event-ID: <n>` replays the kept
  events after `n` in order, then continues live; `Last-Event-ID: 0` replays
  everything kept. When some events after `n` were already dropped from the
  buffer, the reconnect replays only what is still kept, and the jump in ids
  shows what was lost. A `Last-Event-ID` that is not an id this session
  issued answers `400`. A GET without `Last-Event-ID` starts with the events
  not yet handed to an earlier stream. The server ends a stream at
  `--stream-max-duration-ms`; a client reconnects with `Last-Event-ID` as it
  would after any drop.
- **One GET stream per session.** A second GET for the same session
  replaces the open one, which ends cleanly; each message is sent on one
  stream only, as the transport requires. Replacing, rather than refusing
  with `409`, means a client whose connection died silently can always
  reconnect.
- **What is sent on it.** No declared feature of this package sends a
  server-initiated message yet: tool, resource and prompt sets are fixed for
  an activation, so `listChanged` stays `false`. The stream, its ids and
  replay are the plumbing such messages will use.
- `HEAD` stays `200` with no body, and any other method answers `405` with
  `Allow: GET, POST, DELETE`.

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
- Protocol version negotiation on `initialize` for MCP revisions
  `2025-11-25` (preferred), `2025-06-18`, `2025-03-26` and `2024-11-05`: the
  client's requested `protocolVersion` is echoed back when supported,
  otherwise `2025-11-25` is returned, per the MCP specification's negotiation
  flow. Behavior varies by revision in one place only: under `2025-11-25`
  (read from each request's `MCP-Protocol-Version` header, with or without
  a session), `tools/call` arguments that fail the declared
  `inputSchema` answer a tool execution error (`isError: true`, the schema
  issues as text) instead of `-32602`, as that revision's tools
  specification requires so the model can correct its arguments. Every
  schema the server advertises carries no `$schema` and is valid under the
  JSON Schema 2020-12 default dialect `2025-11-25` establishes.
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
- Optional `title` on tools, resources and prompts, and optional tool
  `annotations` (the four boolean behavior hints), echoed in the list
  responses (see "Declare a server" above).
- The `MCP-Protocol-Version` request header on every message after
  `initialize` (requests and notifications): a supported revision is
  accepted, a missing header is treated as `2025-03-26` (the Streamable HTTP
  transport's rule for older clients), and any other value answers HTTP
  `400` before dispatch. `initialize` itself negotiates from
  `params.protocolVersion` and ignores the header.
- `Origin` validation against DNS rebinding, as the Streamable HTTP transport
  requires: a request whose `Origin` header is present and is not one of the
  site's origins, the canonical `--origin` or an operator `--alias-origin`
  (core's single same-origin rule, see
  [site origins](../../docs/EXTENSIONS.md#site-origins-and-same-origin-checks)),
  answers HTTP `403` before its body is parsed, as does `Sec-Fetch-Site:
  cross-site` or a duplicated provenance header. A request with no provenance
  header (non-browser MCP clients send none) is admitted. The alias list is
  site-wide and operator-set; there is no per-server or YAML allowlist.
- Standard JSON-RPC error codes: `-32700` parse error, `-32600` invalid
  request (including a rejected batch array), `-32601` method not found,
  `-32602` invalid params (unknown tool/prompt name, a schema-failing
  arguments object before `2025-11-25` or for a prompt, a non-object
  `arguments`, or an invalid pagination cursor), `-32603` reserved for
  an unexpected internal failure (including a thrown resource/prompt handler
  and a tool result that fails its own declared `outputSchema`), `-32002`
  resource not found.
- Host-owned error behavior: a thrown tool/resource/prompt handler error is
  reported to the MCP caller as a generic failure and to the operator, via
  `onToolError`, with the real error and which server/hook/kind it came from
  — the extension makes no logging decision of its own beyond that callback.
- Caller-facing tool execution errors: a tool handler that throws
  `McpToolError` answers `isError: true` with its own bounded message (and
  `structuredContent` from its `data` when that conforms to the declared
  `outputSchema`).
- Host-owned usage observation: `onToolCall` reports every handler
  invocation's outcome, duration and request id, success or failure.
- Handler request context: `handler(input, { env, requestId, server, tool, kind })`,
  with `env` from the mount route's operator-granted `env` block (plus
  `signal`, and `progress` for a tool, when the operator enables streaming).
- The optional Streamable HTTP transport parts, when the operator enables
  `streaming`: `Mcp-Session-Id` sessions, SSE progress replies to
  `tools/call`, cancellation, and the per-session GET stream with keep-alive
  and bounded `Last-Event-ID` replay (see "Streaming transport" above).

## What this does not implement (v1)

- Streaming on AWS or Vercel: the streaming transport needs the self-hosted
  server (see "Streaming transport" above). Without `streaming` a GET answers
  `405`, the specification's own guidance when a server does not offer that
  stream, and no session id is issued.
- Resuming a POST SSE stream: its events carry no id, so a dropped progress
  stream is not replayed; the call is cancelled instead. Only the GET stream
  replays.
- The `2025-11-25` SSE polling behavior (priming an empty event with an id
  and closing the connection so the client polls): streams stay open with
  keep-alive comments instead.
- Persisted or shared sessions: sessions live in one process's memory and a
  restart forgets them (the client re-initializes after a `404`).
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
- Environment-dependent tool, resource or prompt schemas (for example an
  `enum` filled from an env binding). Declined by design: the schemas a
  client sees are part of the reviewed, revision-pinned project, and letting
  them vary with the deployment environment would mean the reviewed revision
  no longer determines what the server advertises or accepts. Declare the
  schema in YAML and have the handler check `context.env` at call time.
- OAuth/bearer authorization flows defined by the MCP authorization spec;
  protect a mount with the `auth` extension instead, the same as any other
  extension route.
- The optional `2025-11-25` additions: `icons` on tools, resources, prompts
  and `serverInfo`, `serverInfo.description`/`websiteUrl`, the experimental
  `tasks` utility (no `tasks` capability is advertised and no tool declares
  `execution.taskSupport`, so every call runs synchronously), and the
  client-side elicitation and sampling changes, which need server-initiated
  requests this server does not send (the GET stream carries only
  notifications, and the server never waits for a client response).

These are deliberate scope choices for a first, minimal, declarative surface
("MCP over HTTP becomes declarative", not a full-featured MCP server) rather
than oversights; see the package's tracked follow-up issues for status.

Requires the matching `@jimhoyd/urlcode` core as a peer. Apache-2.0.
