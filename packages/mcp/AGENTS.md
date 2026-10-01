# Working on URLCode mcp

- Read CONTRIBUTING.md and SECURITY.md first. Core owns the generic extension
  contract (`@jimhoyd/urlcode/extensions`) and the bounded body-schema
  validator (`@jimhoyd/urlcode/body-schema`). The official MCP TypeScript SDK
  (`@modelcontextprotocol/server`, pinned in `package.json`) owns the
  protocol: `src/mcp.ts` builds one SDK `Server` per request and serves it
  through `createMcpHandler`, so JSON-RPC 2.0 parsing and framing, request
  ids, `initialize` version negotiation, the `MCP-Protocol-Version` header,
  `ping`, notifications and the standard error codes are the SDK's. Do not
  re-implement any of them here; a protocol change is an SDK upgrade.
- This package owns the declarative mapping onto that SDK: the declared,
  bounded tool/resource/prompt sets and their `tools/*`, `resources/*` and
  `prompts/*` handlers (lists return every declared entry; there is no
  pagination), argument and output checks, the trusted handler calls,
  admission before the SDK sees a request (mount path, core's same-origin
  rule, the UTF-8 body check), and the safe result and error behavior:
  generic caller-facing failures, `McpToolError`, and the host's
  `onToolError`/`onToolCall` reports.
- Apache-2.0. Do not publish packages by hand. This package is released with
  core and installed with `urlcode extensions add mcp`; `src/extension.ts`
  holds its definition (the scaffold and the `host()` registration).
  `"private": true` in `package.json` is the ordinary state for every
  workspace extension package here (none is an npm publish target), not a
  signal that distribution is pending.
- TypeScript run through Node type stripping; `dist/` is built, never
  committed. The peer is a workspace sibling: core resolves through the
  `file:../..` link that `scripts/check-workspace-links.ts` enforces, never
  from a registry.
- Reuse core's `compileBodySchema`/`bodySchemaIssues`/`bodySchemaLine` (and
  `illFormedMember`) for tool `inputSchema`/`outputSchema` and per-call
  argument validation; do not add a
  second JSON Schema engine or hand-roll the validation `request.body.<METHOD>.schema`
  already does. Reuse core's `loadExtensionHooks` trusted
  module loading for tool/resource/prompt handlers; do not add a second
  dynamic-import or project-relative path resolver.
- Run `npm run verify` for every change. Declared-behavior changes (argument
  and output checks, unknown names, admission, handler errors, resources and
  prompts) need a regression test in the same PR (`test/mcp.test.ts`, with
  `test/sdk-client.test.ts` for what an SDK client sees); scaffold and
  `host()` changes need one in `test/scaffold.test.ts`.
- Never commit credentials or customer data. Synthetic fixtures only.
- Report actual evidence and remaining limitations; CI is not a security
  review. The server is stateless: no sessions, no server-initiated GET
  stream (`GET`/`DELETE` answer `405`) and no replay. Streamed progress
  replies (`mcp({ streaming: true })` in `host.mjs`) are an operator opt-in
  that must stay off by default and leave the buffered behavior unchanged;
  its tests are `test/streaming.test.ts`. When on, the registration declares
  `streams: true`, and core's `streamingTargets`
  (`packages/core/src/extensions.ts`) decides where it is served: natively on
  the self-hosted server, delegated to the provider on Vercel, and refused on
  AWS before activation (the extension does not target Cloudflare at all). Delegated is adapter support with
  local tests, not proof of a real Vercel deployment. This extension's known
  remaining gaps (sessions and resumable streams, streaming on AWS, resource
  templates and subscriptions) are documented in README.md, not silently
  implied. Batching, like the rest of the wire protocol, is the SDK's: do not
  add a batching layer in this package.

## File what you find

Do not drop a defect, a gap or an idea you could not act on. Runtime, CLI and
schema, and this extension's own protocol surface, all live in this one
repository now, so file everything against
[urlcode](https://github.com/jimhoyd-com/urlcode/issues), using its issue
templates.

Feature requests are wanted, not just bugs: if you had to hand-write
application code that the URLCode vocabulary could have owned, that is the
evidence the roadmap runs on.
