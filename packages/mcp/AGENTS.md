# Working on URLCode mcp

- Read CONTRIBUTING.md and SECURITY.md first. Core owns the generic extension
  contract (`@jimhoyd/urlcode/extensions`) and the bounded body-schema
  validator (`@jimhoyd/urlcode/body-schema`); this package owns JSON-RPC 2.0
  framing, protocol version negotiation, request-id handling, cursor
  pagination and
  `initialize`/`ping`/`tools/list`/`tools/call`/`resources/list`/`resources/read`/`prompts/list`/`prompts/get`
  dispatch for a declared, bounded MCP tool/resource/prompt server.
- Apache-2.0. Do not publish packages by hand. This package is not yet part
  of a signed `extension-bundles@v…` release (`"private": true` in
  `package.json`); do not change that without an explicit decision.
- TypeScript run through Node type stripping; `dist/` is built, never
  committed. The peer is a workspace sibling: core resolves through the
  `file:../..` link that `scripts/check-workspace-links.ts` enforces, never
  from a registry.
- Reuse core's `assertBodySchema`/`bodySchemaIssues`/`bodySchemaLine` for tool
  `inputSchema`/`outputSchema` and per-call argument validation; do not add a
  second JSON Schema engine or hand-roll the validation `request.body.schema`
  already does. Reuse `loadExtensionHooks`/`functionFile`-style trusted
  module loading for tool/resource/prompt handlers; do not add a second
  dynamic-import or project-relative path resolver.
- Run `npm run verify` for every change. The request-id fidelity, protocol
  negotiation, input-schema rejection, pagination, resources/prompts and
  error-code paths need a regression test in the same PR (`test/mcp.test.ts`).
- Never commit credentials or customer data. Synthetic fixtures only.
- Report actual evidence and remaining limitations; CI is not a security
  review. This extension's known remaining v1 gaps (SSE/streaming transport,
  session ids, resource templates/subscriptions) are documented in README.md,
  not silently implied. JSON-RPC batching is refused by design, re-confirmed
  against the current MCP revision, not merely deferred.

## File what you find

Do not drop a defect, a gap or an idea you could not act on. Runtime, CLI and
schema, and this extension's own protocol surface, all live in this one
repository now, so file everything against
[urlcode](https://github.com/jimhoyd-com/urlcode/issues), using its issue
templates.

Feature requests are wanted, not just bugs: if you had to hand-write
application code that the URLCode vocabulary could have owned, that is the
evidence the roadmap runs on.
