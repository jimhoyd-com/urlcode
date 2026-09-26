# Security boundary

MCP is trusted operator code that runs in the host process. It is not a
sandbox or a multi-tenant boundary. Project configuration declares tool
names, descriptions, bounded input schemas and a project-relative handler
reference; it cannot select a transport, a JSON-RPC extension, a session
mechanism or an operator secret. The optional streaming transport (sessions,
SSE progress, the server stream) is enabled only by the operator's
`mcp({ streaming })` option in `host.mjs`.

**Request framing is host-owned, not project-owned.** JSON-RPC parsing,
protocol version negotiation, method dispatch and error codes are all
implemented once, here, exactly as `docs/EXTENSIONS.md` requires of an
extension: project YAML cannot add a method, change an error code, or affect
how a request id is read. The extension reads only the standard JSON-RPC
2.0 envelope (`jsonrpc`, `method`, optional `id`, optional `params`) from a
bounded (256 KiB) `application/json` body; anything larger, any other content
type, or any HTTP method other than `POST`/`HEAD` (plus `GET`/`DELETE` when
the operator enables streaming) is refused before JSON parsing runs.

**Origin is validated before anything else is read.** The MCP Streamable
HTTP transport requires a server to validate `Origin` to prevent DNS
rebinding. A request to a mount whose `Origin` header is present and is not
one of the site's origins (the operator's canonical `--origin`, or one of the
operator's site-wide `--alias-origin` entries) is refused with `403` before
its content type, size or body is examined. The rule is core's
`isSameOriginRequest` with `whenAbsent: 'admit'`, the one rule every
first-party extension applies: `Sec-Fetch-Site: cross-site` and duplicated
`Origin`, `Sec-Fetch-Site` or `Referer` headers are refused too, and so is a
request with no `Origin` whose `Referer` names a foreign origin. A request with
no provenance header at all is admitted, because non-browser MCP clients do not
send one and a browser always sends one on a cross-origin `POST`. There is no project-YAML or per-server allowlist: a
browser-based client served from an origin the operator has not listed cannot
reach the mount. Origin validation is not
authentication; put the mount behind `auth` when callers must be identified.
Independently of this extension, core's self-hosted server bound to loopback
refuses a request whose `Host` is not a loopback name on its bound port, the
`--origin` authority or an `--alias-origin` authority, before any route (this mount included) runs; a
non-loopback bind is not checked, so the `Origin` rule above remains the
mount's own defence there (`docs/OPERATIONS.md`, host admission on a loopback bind).

**The protocol revision header is checked.** Every message after
`initialize` must carry a supported `MCP-Protocol-Version` (`2025-11-25`,
`2025-06-18`, `2025-03-26` or `2024-11-05`), or none (treated as
`2025-03-26`, per the transport specification); any other value is refused
with `400` before dispatch.

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
reaches the handler; the caller gets a list of which declared constraint
failed (under MCP revision `2025-11-25` as an `isError: true` tool result,
under earlier revisions as a structured `-32602 Invalid params` error), using the same bounded
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
A handler receives the already-validated `arguments` object and a frozen
context: the mount route's operator-granted `env` values, the request id and
the server/tool names. Nothing else about the underlying HTTP request
(headers, client address, cookies) reaches it, and route `secrets` are
refused on the mount. The `env` grant governs what URLCode injects; a trusted
handler can still read `process.env` itself.

**A thrown handler error never reaches the MCP caller as written.** The
caller always receives a fixed generic tool-result failure message
(`isError: true`) with no error text or stack. The single exception is
opt-in: a tool handler that throws `McpToolError` has chosen that message for
the caller, so it is returned as the tool result's text (truncated to 4096
characters), with its `data` as `structuredContent` only when it conforms to
the tool's declared `outputSchema`. Only an error carrying the
`McpToolError` brand is treated this way; any other error, including one whose
message happens to look user-facing, keeps the generic message. The handler
author is responsible for keeping secrets and internal detail out of an
`McpToolError` message. The real error, and which
server/tool it came from, is handed to the operator's own
`McpExtensionOptions.onToolError` callback (best-effort: a throwing callback
is itself swallowed rather than allowed to affect the response) — this is
the extension's entire, explicit "host-owned error behavior" contract; it
makes no logging or alerting decision beyond invoking that callback exactly
once per failure.

**No identity, authorization, rate limiting or idempotency model of its
own.** Put a mount behind `auth: true` (or a specific role/permission
requirement) where a tool call requires a signed-in caller; the extension
does not create sign-in sessions, ownership rules or abuse protection (a
streaming `Mcp-Session-Id` is transport state, not an identity), and every
caller who can reach an unprotected mount can invoke every declared tool on
it. A tool handler whose external effects are not naturally idempotent needs
its own idempotency mechanism (for example a nonce or dedupe key it checks
itself), the same limitation the `forms` extension's `onSubmit` hook
documents: a client can retry a POST.

**Streaming sessions (operator opt-in).** With `streaming` on, `initialize`
issues an `Mcp-Session-Id` of 32 bytes from the platform CSPRNG, and every
later request must present it (`400` without, `404` for an unknown one). A
session records the principal (`provider:id`) that created it when the mount
runs behind a principal-providing extension, and the id presented under any
other principal, or none, answers `404` exactly like an unknown id, so its
existence is not revealed; `DELETE`, the GET stream and
`notifications/cancelled` are held to the same binding, so one caller cannot
end, read or cancel another's session. On a mount with no principal the id is
the only thing that ties requests together: it is a bearer secret, is never
logged by this extension, and is only as safe as the transport (use HTTPS).
Origin validation applies to `GET` and `DELETE` as to `POST`. The session
table is memory-bounded by operator options (`maxSessions`, least recently
used eviction; `sessionIdleTimeoutMs`; per-session `replayMaxEvents` and
`replayMaxBytes`), so a caller who can reach an unprotected mount can create
sessions and push out others (who then re-initialize), but cannot grow memory
without bound; open SSE streams are bounded by the server's own stream limits.
Sessions are not persisted and do not survive a restart. Client disconnect,
`notifications/cancelled` and session end abort the handler's
`context.signal`; a handler that ignores it keeps running to completion.

**Response caching.** Every response from an `extension: mcp` mount is
forced to `Cache-Control: no-store` by the core extension privacy floor
(`docs/EXTENSIONS.md`); this cannot be relaxed for a JSON-RPC endpoint, whose
responses are call-specific and never safe to cache. Core forces the same on
an SSE stream and never compresses it.

Passing tests does not establish independent security assessment, hostile
multi-tenant readiness, production abuse resistance, or delivery guarantees.
Report suspected vulnerabilities through the repository's private reporting
channel described in the root SECURITY.md.
