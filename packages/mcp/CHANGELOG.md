# @jimhoyd/urlcode-mcp

## Unreleased

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

## 0.1.0

Initial package source (#573): a declarative MCP (Model Context Protocol)
tool server extension. JSON-RPC 2.0 framing, protocol version negotiation,
verbatim request-id handling, `initialize`/`ping`/`tools/list`/`tools/call`,
standard error codes, and per-tool input validation reused from
`@jimhoyd/urlcode/body-schema`. Not yet published to npm or included in a
signed `extension-bundles@v…` release; see
[docs/FRAMEWORK.md](../../docs/FRAMEWORK.md) for current distribution
status.
