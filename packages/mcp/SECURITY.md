# Security boundary

MCP is trusted operator code that runs in the host process. It is not a
sandbox or a multi-tenant boundary. Project configuration declares tool
names, descriptions, bounded input schemas and a project-relative handler
reference; it cannot select a transport, a JSON-RPC extension, a session
mechanism or an operator secret.

**Request framing is host-owned, not project-owned.** JSON-RPC parsing,
protocol version negotiation, method dispatch and error codes are all
implemented once, here, exactly as `docs/EXTENSIONS.md` requires of an
extension: project YAML cannot add a method, change an error code, or affect
how a request id is read. The extension reads only the standard JSON-RPC
2.0 envelope (`jsonrpc`, `method`, optional `id`, optional `params`) from a
bounded (256 KiB) `application/json` body; anything larger, any other content
type, or any HTTP method other than `POST`/`HEAD` is refused before JSON
parsing runs.

**Request ids are never substituted.** The value returned as the JSON-RPC
response `id` is always the exact value read from the request's own `id`
field (a JSON-RPC-legal string, integer or `null`) — never a value generated
internally, and never coerced between string and number. A message with no
`id` at all is a notification and receives no JSON-RPC response body (HTTP
`202`), matching the JSON-RPC 2.0 specification. This corrects the specific
defect (a hand-written implementation using something other than the actual
client-supplied id) that motivated adding this extension.

**Tool arguments are always schema-checked before a handler runs.** A
`tools/call` whose `arguments` fails the tool's declared `inputSchema` never
reaches the handler; the caller gets a structured `-32602 Invalid params`
error listing which declared constraint failed, using the same bounded
validator (`@jimhoyd/urlcode/body-schema`, the exact code
`request.body.schema` itself runs) a native route body already uses. Nothing
the caller sent is echoed back in an issue; only the schema's own declared
path and keyword are.

**A handler is trusted project code, exactly like a form's `onSubmit` hook or
a native `function`/`middleware` route.** It is loaded and invoked the same
way other extension hooks are (`docs/EXTENSIONS.md#project-level-lifecycle-hooks`):
unsandboxed, in-process, full Node access, refreshed once per activation.
`sandbox: true` on a tool handler reference is refused at activation rather
than silently run trusted — contract v1 defines no sandboxed tool protocol.
A handler receives only the already-validated `arguments` object, nothing
else about the underlying HTTP request (headers, client address, cookies).

**A thrown handler error never reaches the MCP caller as written.** The
caller always receives a fixed generic tool-result failure message
(`isError: true`) with no error text or stack. The real error, and which
server/tool it came from, is handed to the operator's own
`McpExtensionOptions.onToolError` callback (best-effort: a throwing callback
is itself swallowed rather than allowed to affect the response) — this is
the extension's entire, explicit "host-owned error behavior" contract; it
makes no logging or alerting decision beyond invoking that callback exactly
once per failure.

**No identity, authorization, rate limiting or idempotency model of its
own.** Put a mount behind `auth: true` (or a specific role/permission
requirement) where a tool call requires a signed-in caller; the extension
does not create sessions, ownership rules or abuse protection, and every
caller who can reach an unprotected mount can invoke every declared tool on
it. A tool handler whose external effects are not naturally idempotent needs
its own idempotency mechanism (for example a nonce or dedupe key it checks
itself), the same limitation the `forms` extension's `onSubmit` hook
documents: a client can retry a POST.

**Response caching.** Every response from an `extension: mcp` mount is
forced to `Cache-Control: no-store` by the core extension privacy floor
(`docs/EXTENSIONS.md`); this cannot be relaxed for a JSON-RPC endpoint, whose
responses are call-specific and never safe to cache.

Passing tests does not establish independent security assessment, hostile
multi-tenant readiness, production abuse resistance, or delivery guarantees.
Report suspected vulnerabilities through the repository's private reporting
channel described in the root SECURITY.md.
