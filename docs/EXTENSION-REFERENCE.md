# Extension field references

The [YAML field reference](YAML-REFERENCE.md) is core's schema, and it stops at
`extensions.<name>.config`: core accepts any object there and hands it to the
extension. Each first-party extension owns the syntax below that key. Its
package README ends with a **Field reference** generated from the package's
`urlcode.json`, the same schema the runtime validates against: configuration,
route policy, project hooks, peers and the authoring surfaces and limits. Every
property carries a description, and `npm run check` fails when one does not or
when a reference is stale.

Two distinctions hold throughout:

- **Schema-valid is not activatable.** A document can pass the schema and still
  refuse to start: a mount without its route, a collection a short link names
  but does not declare, a peer that is not installed. Activation checks those;
  a site's `npm run validate`
  (`urlcode validate --local --project app --host-file host.mjs --local-review`)
  activates the project and reports them.
- **Available is not installed.** This page, the release catalog (MCP
  `get_release_addon_catalog`) and the list below describe what this release
  ships. A site has an extension only when `urlcode extensions add <name>`
  installed it and `host.mjs` registers it. A third-party extension documents
  its own syntax; nothing here describes it.

## Where each extension's fields are documented

<!-- extension-reference:start -->
<!-- Generated from urlcode.json by scripts/generate-extension-reference.ts (npm run docs:extensions). Do not edit between these markers; change the extension's schema descriptions instead. -->

| Extension | What it declares | Peers | Described fields | Field reference |
|---|---|---|---|---|
| `audit` | Durable, bounded audit log other extensions record privileged actions into | — | config 1 | [@jimhoyd/urlcode-audit](../packages/audit/README.md#field-reference) |
| `auth` | Accounts and sessions from Better Auth on one mount; protected routes receive the signed-in user id | — | config 0 | [@jimhoyd/urlcode-auth](../packages/auth/README.md#field-reference) |
| `mcp` | Declarative MCP (Model Context Protocol) server: tools, resources and prompts backed by trusted project handlers | — | config 43 | [@jimhoyd/urlcode-mcp](../packages/mcp/README.md#field-reference) |
| `store` | SQLite-backed collections served as a bounded CRUD API, declared in YAML with no handler code | uses audit | config 63 | [@jimhoyd/urlcode-store](../packages/store/README.md#field-reference) |
<!-- extension-reference:end -->

## Capability to reference

Start from what you need. Each row names the keys to declare and where their
full definition and a checked example live.

| I need | Declare | Reference and example |
|---|---|---|
| Stored short links: create, redirect, click count | store: a collection with a `key`, a required `format: uri` destination property (HTTP(S) only) and one `increments` counter, plus `shortLinks.<name>: {mount, collection, destination, clicks}` and a `/go/*` route with `extension: store` | [store field reference](../packages/store/README.md#field-reference); the complete YAML is in [bounded keyed transitions](STORE.md#bounded-keyed-transitions) |
| Accept a form submission as JSON, validated before code runs | core: a route with `request.body.POST.schema` (JSON Schema 2020-12, standard formats such as `format: email`), answered by `respond` or a trusted `function`; the runtime answers 422 first | [recipe `contact-form`](../recipes/contact-form/README.md), [body schema](HTTP.md#body-schema-and-input-patterns) |
| Email each submission | core: a trusted `function` route that calls the mail provider's API, SDK or nodemailer directly, with its credentials in granted `secrets` | [sending mail from your own code](../recipes/contact-form/README.md#sending-mail-from-your-own-code-instead) |
| A JSON CRUD API with no handler code | store: `collections.<name>` and a `<mount>/*` route with `extension: store` | [store field reference](../packages/store/README.md#field-reference), [recipe `store-crud`](../recipes/store-crud/README.md) |
| Records private to each signed-in user | store: `ownership: owner` on the collection, and a principal-providing policy (`auth: true`) on its route | [per-record ownership](STORE.md#per-record-ownership) |
| A permission such as "reviewer" | store: a `membership: true` collection keyed by principal id, named by a transition's `members` or a collection's `readers: {<name>: {mount, members}}`; the operator adds members with `addMember` | [membership gates](STORE.md#membership-gates-and-cross-owner-reads), [private-requests proof](../proofs/private-requests/README.md) |
| Sign-in and protected routes | auth: mount Better Auth at `/api/auth/*` with `extension: auth`; `auth: true` on a protected route; the function reads `context.capabilities.auth.identity.userId` | [auth extension guide](../packages/auth/README.md), [private-requests proof](../proofs/private-requests/README.md) |
| Submission rate limits | core: `policies.throttle` on the route; sign-in is throttled by Better Auth's own limiter, keyed by the admitted client address | [policies](POLICIES.md), [auth security model](../packages/auth/SECURITY.md) |
| An audit trail of writes | audit: `retention`; store: `audit: true` on a collection | [audit field reference](../packages/audit/README.md#field-reference) |
| A frontend over the store's JSON mounts | your own code: `fetch` to the mounts, reading a list's `etags` and `may`; styling and components are the app's (for shadcn, the official tooling plus `urlcode artifacts stage`) | [the private-requests client](../proofs/private-requests/client/main.js), [what the caller may run](STORE.md#what-the-caller-may-run) |
| MCP tools, resources and prompts | mcp: `servers.<name>` with `tools`, each backed by a trusted handler module | [mcp field reference](../packages/mcp/README.md#field-reference) |

A plain per-route request budget is core's `policies.throttle`, not an
extension ([policies](POLICIES.md)).

## Bounded retrieval

An agent does not need the whole corpus to find one key.

- **Installed in the project:** `urlcode docs search "<term>" --project app`
  (MCP `search_docs`) reads each installed, pin-verified add-on's README (with
  its field reference) and `urlcode.json`, returns at most three bounded
  excerpts and says which sources it searched. MCP `get_addon_agent_tooling`
  lists the installed add-ons' agent references; `get_extensions` (with the
  operator's `--host-file`) returns the registered schemas themselves.
- **In this release, installed or not:** MCP `get_release_addon_catalog` lists
  every add-on's agent references by package path. It is availability, not
  installation.
- **A source checkout or GitHub:** `packages/<name>/README.md#field-reference`,
  one file per extension, linked from the table above.

[llms-full.txt](../llms-full.txt) bundles core's authoring pages and this page,
but not the package READMEs; its coverage note says so.
