# @jimhoyd/urlcode-mcp

## Unreleased

- The authoring contract's `servers` and `mount` surfaces carry planner goal words, so `urlcode plan-feature` names
  this extension for an MCP goal (it named nothing before), and the `mount` surface and the README's "Protecting a
  mount" state what an `auth: true` mount does not do (#1137): with the bundled auth extension a request without the
  site's own `Origin` is refused `403`, there is no OAuth or bearer authorization, and a handler is not told who
  called. No behavior changed; `test/account-composition.test.ts` at the repository root pins each.

The definition declares its deployment targets (node, aws, vercel), which `npm run build:addons` writes into `urlcode.json` as `targets` (#859); core refuses a registration whose targets differ, and the capability preflight refuses a recipe or plan that uses this extension on any other target.

- A tool, resource or prompt result that cannot be serialized to JSON (a BigInt, a cycle, a throwing `toJSON`, or a
  function or symbol that serializes to nothing) is reported to `onToolCall` once, as `'error'` (#1087). A tool result
  was serialized after `'success'` was reported, so the failure was reported as both `'success'` and `'error'`; a
  function result became a text item with no text. The caller still gets the generic `isError: true` answer.
- A request body that is not valid UTF-8 answers HTTP `400` with a `-32700` parse error and a null id (#1021); the
  SDK decoded it non-fatally, so a handler received U+FFFD. The media type (`415`) and size (`413`) checks still come
  first. The README and SECURITY.md no longer claim that an `inputSchema` failure is a `-32602` error under revisions
  before `2025-11-25`: it has always been an `isError: true` tool result under every revision, which `2025-11-25`
  requires and earlier revisions allow (they list invalid input among tool execution errors).
- A `tools/call` or `prompts/get` argument holding an unpaired UTF-16 surrogate escape (`"\ud800"` alone) is refused
  before the schema check with `-32602` naming the argument and `data: {argument, code: "invalid_unicode"}` (#1016);
  the handler never runs. The SDK parses the body itself, so core's JSON body reader never saw it and the handler
  received the lone surrogate. The check is core's `illFormedMember` (`@jimhoyd/urlcode/body-schema`).
- A tool's `inputSchema` or `outputSchema` may name one of the project's named
  schemas (core's top-level `schemas:`, #845), resolved at activation from
  `ExtensionActivation.schemas`; an unknown name refuses activation and
  `tools/list` advertises the resolved schema. A route naming the same schema
  refuses the same input at the same pointer.
- The protocol is the official MCP TypeScript SDK's (`@modelcontextprotocol/server`
  2.1.0; #846), serving every request statelessly. Removed: `Mcp-Session-Id`
  sessions, the GET stream and `Last-Event-ID` replay, list pagination, and
  the `streaming` object options (`maxSessions` and the rest); `streaming` is
  now a boolean that passes SSE replies through as they are produced so tool
  progress arrives before the result (on vercel too; aws still refuses it).
  Replies are SSE, clients must accept both JSON and SSE (`406` otherwise),
  schema-failing tool arguments are an `isError` result under every
  revision, a missing resource is `-32602`, and malformed input is an HTTP
  `400` with the JSON-RPC error. Handlers always receive `context.signal`.
- Requests use core's extension request helpers: the same-origin check is core's `isSameOriginRequest` (`whenAbsent: 'admit'`), so `Sec-Fetch-Site: cross-site`, duplicated provenance headers and a foreign `Referer` without `Origin` are now refused with `403` (the SDK now reads the body; see above).
- A present `Origin` is admitted when it is the canonical origin or one of the
  operator's site-wide alias origins (`--alias-origin`, `aliasOrigins`), using
  core's `isSiteOrigin`; an unlisted origin is still refused with `403` (#717).

- MCP protocol revision `2025-11-25` is supported and preferred: `initialize`
  echoes it when requested and offers it for an unrecognized revision, and
  `MCP-Protocol-Version: 2025-11-25` is accepted. Under that revision a
  `tools/call` whose arguments fail the declared `inputSchema` answers an
  `isError: true` tool result listing the failed checks, as its tools
  specification requires, instead of `-32602`; earlier revisions are
  unchanged. Its other additions (icons, tasks, elicitation and sampling
  changes) are optional and not implemented (#719).

- A tool handler can throw the new exported `McpToolError` to return a
  caller-facing tool execution error: the result is `isError: true` with the
  error's message (truncated to 4096 characters) as text, plus
  `structuredContent` from its optional `data` when the tool declares an
  `outputSchema` and the data conforms to it. `onToolCall` reports it as the
  new outcome `'tool_error'`, and `onToolError` is not called. Any other thrown
  error still answers the fixed generic message (#716).

- A request whose `Origin` header is present and is not exactly the site's
  canonical origin is refused with `403` before parsing, the DNS-rebinding
  check the Streamable HTTP transport requires (#676). A request with no
  `Origin` is still admitted.
- The `MCP-Protocol-Version` header is validated on every message after
  `initialize`: a missing header is treated as `2025-03-26`, and an
  unsupported value answers `400` (#676).
- Documented that the client endpoint is the declared `mount` exactly;
  `/mcp/*` is required route syntax, and `/mcp/` or any subpath answers `404`
  (#672).
- Tools, resources and prompts accept an optional `title` (1–256 characters),
  and tools accept optional `annotations` restricted to the four boolean MCP
  behavior hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`). Both are echoed in `tools/list`, `resources/list` and
  `prompts/list` and omitted when absent; an unknown hint or a non-boolean
  value fails validation (#677).
- Handlers are called as `handler(input, context)` with the mount route's
  operator-granted `env`, the request id and the `server`/`tool`/`kind` names;
  a new `onToolCall` host option reports every handler invocation's outcome,
  duration and request id (#678).

## 0.1.0

Initial package source (#573): a declarative MCP (Model Context Protocol)
tool server extension. JSON-RPC 2.0 framing, protocol version negotiation,
verbatim request-id handling, `initialize`/`ping`/`tools/list`/`tools/call`,
standard error codes, and per-tool input validation reused from
`@jimhoyd/urlcode/body-schema`. Not yet published to npm or included in a
signed `extension-bundles@v…` release; see
[docs/FRAMEWORK.md](../../docs/FRAMEWORK.md) for current distribution
status.
