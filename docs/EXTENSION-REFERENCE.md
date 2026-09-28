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
  refuse to start: a flow without its route, a collection a short link names
  but does not declare, a peer that is not installed. Activation checks those;
  `urlcode validate --project . --host-file <host.mjs> --origin <origin>`
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
| `abuse` | Persistent, pseudonymous rate limits, failure backoff and challenge escalation for extensions | — | config 1 | [@jimhoyd/urlcode-abuse](../packages/abuse/README.md#field-reference) |
| `audit` | Durable, bounded audit log other extensions record privileged actions into | — | config 1 | [@jimhoyd/urlcode-audit](../packages/audit/README.md#field-reference) |
| `auth` | Accounts and sessions from Better Auth on one mount; protected routes receive the signed-in user id | — | config 0 | [@jimhoyd/urlcode-auth](../packages/auth/README.md#field-reference) |
| `form-records` | Saves a declared form into an owned store collection, with a confirmation page and an edit page limited to declared fields. | requires forms, store, ui | config 42 | [@jimhoyd/urlcode-form-records](../packages/form-records/README.md#field-reference) |
| `forms` | Declarative server-rendered form flows with CSRF, field validation and a confirmation page, rendered through ui. | requires ui; uses abuse, mail | config 49, hook input/output 2 | [@jimhoyd/urlcode-forms](../packages/forms/README.md#field-reference) |
| `mail` | Plain-text transactional email: templates contributed by other extensions, one operator transport. | — | config 2 | [@jimhoyd/urlcode-mail](../packages/mail/README.md#field-reference) |
| `mcp` | Declarative MCP (Model Context Protocol) server: tools, resources and prompts backed by trusted project handlers | — | config 43 | [@jimhoyd/urlcode-mcp](../packages/mcp/README.md#field-reference) |
| `store` | File-backed JSON collections served as a bounded CRUD API, declared in YAML with no handler code | uses audit | config 36 | [@jimhoyd/urlcode-store](../packages/store/README.md#field-reference) |
| `ui` | Shared presentation kit: theme, copy, templates and the data screens other extensions contribute, for every extension page. | — | config 64, hook input/output 3 | [@jimhoyd/urlcode-ui](../packages/ui/README.md#field-reference) |
<!-- extension-reference:end -->

## Capability to reference

Start from what you need. Each row names the keys to declare and where their
full definition and a checked example live.

| I need | Declare | Reference and example |
|---|---|---|
| Stored short links: create, redirect, click count | store: a collection with a `key`, a required `format: http-url` destination field and one `increments` counter, plus `shortLinks.<name>: {mount, collection, destination, clicks}` and a `/go/*` route with `extension: store` | [store field reference](../packages/store/README.md#field-reference); the complete YAML is in [bounded keyed transitions](STORE.md#bounded-keyed-transitions) |
| Run project code when a form is submitted | forms: `hooks.onSubmit: hooks/on-submit.mjs`, a trusted module `(input, context)` called after CSRF and validation | [forms: handling a submission](../packages/forms/README.md#handling-a-submission-onsubmit) (its YAML and module run in the package tests); [hook contract](../packages/forms/README.md#project-hooks-extensionsformsconfighooks) |
| A server-rendered form with validation | forms: `flows.<name>` with `fields`, `confirmation`, and a `<mount>/*` route (GET, HEAD, POST) | [forms field reference](../packages/forms/README.md#field-reference); `urlcode extensions add forms --example` writes a working `/contact` |
| A field required only for some answers | forms: `fields.<field>.requiredWhen: {field, in}` | [conditionally required fields](../packages/forms/README.md#conditionally-required-fields) |
| Email each submission | forms: `flows.<name>.notify: {recipient, include}`; the recipient's address in `mail({recipients})` in `host.mjs` | [notifications](../packages/forms/README.md#notifications-notify), [mail field reference](../packages/mail/README.md#field-reference) |
| Save a form as a per-user record | form-records: `records.<name>: {mount, collection, form}` over an `ownership: owner` store collection | [form-records field reference](../packages/form-records/README.md#field-reference) |
| A JSON CRUD API with no handler code | store: `collections.<name>` and a `<mount>/*` route with `extension: store` | [store field reference](../packages/store/README.md#field-reference), [recipe `store-crud`](../recipes/store-crud/README.md) |
| Records private to each signed-in user | store: `ownership: owner` on the collection, and a principal-providing policy (`auth: true`) on its route | [per-record ownership](STORE.md#per-record-ownership) |
| Sign-in and protected routes | auth: mount Better Auth at `/api/auth/*` with `extension: auth`; `auth: true` on a protected route; the function reads `context.capabilities.auth.identity.userId` | [auth extension guide](../packages/auth/README.md), [private-requests proof](../proofs/private-requests/README.md) |
| Form rate limits | forms: `flows.<name>.abuse`, which needs the abuse extension; sign-in is throttled by Better Auth's own limiter, keyed by the admitted client address | [forms field reference](../packages/forms/README.md#field-reference), [auth security model](../packages/auth/SECURITY.md) |
| An audit trail of writes | audit: `retention`; store: `audit: true` on a collection | [audit field reference](../packages/audit/README.md#field-reference) |
| Brand, colours, copy and templates | ui: `theme`, `languages`, `copy`, `templates`, `stylesheet`, `hooks` | [ui field reference](../packages/ui/README.md#field-reference) |
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
