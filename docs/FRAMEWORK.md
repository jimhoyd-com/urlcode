# The URLCode framework

One page for people and AI agents. It says what the five workspace packages are, how a
project grows from a handful of redirects into an application with accounts,
data and tools, and which facts an agent must not guess. Every
claim here is implemented in the linked repository; nothing is roadmap.

## Five workspace packages, one project shape

| Package | Source | What it adds | How a project declares it |
|---|---|---|---|
| `@jimhoyd/urlcode` | this repository | The runtime: YAML routes, functions and middleware (trusted by default, `sandbox: true` opt-in), pages and assets, policies, site conventions, CLI, provider adapters, a fetch handler for hosting inside another Node framework, the extension contract | `urlcode.yaml` with `version: "1"` |
| `@jimhoyd/urlcode-audit` | [`packages/audit`](../packages/audit) | The durable audit log: producers (audited store collections) write events into their own transactional outbox, and audit drains them into one bounded SQLite log with a query API, retention and an operator CLI | `extensions.audit`; no route |
| `@jimhoyd/urlcode-auth` | [`packages/auth`](../packages/auth) | A thin adapter over [Better Auth](https://better-auth.com/): Better Auth owns accounts, passwords, sessions, cookies and its SQLite tables; the extension serves an allowlist of its endpoints on one mount, gates protected routes and hands their code the verified user id (`context.capabilities.auth.identity.userId`). No roles or permissions; Node only; requires nothing | `extensions.auth: {version: "1", config: {}}` plus an `/api/auth/*` mount (`methods: [GET, POST]`) and `auth: true` (`policies.extensions.auth: {}`) on protected routes |
| `@jimhoyd/urlcode-store` | [`packages/store`](../packages/store) | Durable bounded collections in one SQLite database exposed as a typed JSON CRUD API; a collection with `audit: true` records its writes through `audit` | `extensions.store` plus a protected collection mount |
| `@jimhoyd/urlcode-mcp` | [`packages/mcp`](../packages/mcp) | Declarative [MCP](https://modelcontextprotocol.io) tool server over the official MCP SDK (stateless Streamable HTTP): a bounded, project-declared map of tools, resources and prompts with trusted handlers | `extensions.mcp` plus a `POST, HEAD` mount (streamed progress when the operator opts into `mcp({ streaming: true })`, not on aws); `urlcode extensions add mcp` wires the extension but leaves the server/tool declaration and its trusted handler module for the operator (every tool needs project code) |

All five are Apache-2.0. Core is published through npm, GitHub Releases and
Homebrew. The four extensions, and the inert `store-schema` artifact in
[`artifacts/store-schema`](../artifacts/store-schema), are add-ons: each is
released as a tarball on the same GitHub Release as core, at core's version,
and core pins every one of them (download URL and sha512) in its own
`addons.json`. A site installs them with `urlcode extensions add` and `urlcode
artifacts add`, never by choosing an npm package. See
[add-ons](EXTENSIONS.md#add-ons-extensions-and-artifacts).

Prefer tested first-party extensions when suitable. External/private extensions
are also supported through the same public host contract; follow the
[external-extension workflow](EXTENSIONS.md#external-extensions-and-ai-tooling)
for installation, AI discovery and validation outside the release catalog.

A release channel is not an
independent assessment: review, deployment
evidence and an accessibility assessment are still pending
([issue 58](https://github.com/jimhoyd-com/urlcode/issues/58)). Auth's
[README](../packages/auth/README.md#not-included) lists what it
does not include.
The current version of each package is its own manifest, and the peer ranges it
declares are in that manifest too; do not read a version number out of this
page. How versions, channels and release tags line up is recorded in
[package and channel alignment](VERSION-ALIGNMENT.md); the GitHub Releases
page and `npm view @jimhoyd/urlcode dist-tags` show the live state.

## The ladder

A project climbs these rungs by adding YAML, never by rewriting what it has.
Each rung's YAML is valid on every rung above it.

1. **Redirects.** A `urlcode.yaml` with `redirect` routes. No code, no database,
   runs anywhere, including Vercel, AWS Lambda and Cloudflare Workers.
   Thousands of rows import from CSV or provider files with `bulk-import`.
2. **Responses, pages and files.** `respond`, `page`, `static` and `download`
   handlers, `site` conventions (robots, sitemap, favicon, security.txt,
   llms.txt) and `policies` (throttle, agents, security headers, compression,
   cache). Still no code.
3. **Functions and middleware.** `function` routes and ordered `middleware`
   in JavaScript, trusted and in-process by default; a route declaring
   `sandbox: true` runs isolated instead (QuickJS inside WebAssembly, fresh
   heap per call, no Node, filesystem or network). The `env`/`secrets` the
   runtime injects into a function come only from an operator grant pinned to
   the project revision; the grant governs that injected context, not the
   ambient Node environment trusted in-process code can reach on its own.
4. **Accounts.** The `auth` extension: Better Auth's sign-in, sign-out and
   sessions on one mount, and `auth: true` on protected routes, whose code reads
   the verified user id from `context.capabilities.auth.identity.userId`. The
   operator installs it in a host file outside the project; YAML only declares
   the mount and the empty configuration. Browsers sign in with Better Auth's
   own client. Roles, ownership and approvals stay application data keyed by
   the user id.
5. **Bounded data.** The `store` extension supplies declared durable
   collections, a trusted operator extension rather than a core YAML handler.
   Add `auth: true` where a collection is per-account. A form is an ordinary
   frontend that posts JSON to a store mount, or to a function route whose
   `request.body.POST.schema` validates it before code runs (the
   [contact-form recipe](../recipes/contact-form/README.md)). The frontend,
   its components and its look are the application's own: it calls the JSON
   mounts with `fetch`, as the
   [private-requests client](../proofs/private-requests/client/main.js) does.
6. **MCP tools.** The `mcp` extension serves a bounded, project-declared MCP
   tool server: the official MCP SDK serves the protocol; each tool's own logic is a trusted project handler module the
   operator writes (`urlcode extensions add mcp` wires the extension but
   leaves that handler for you, unlike the other rungs here). Add `auth: true` where a
   mount needs a signed-in caller.

Owner-private records, a reviewed state change and a reviewer permission are
declarative: an owned store collection, a `by: others` transition and a
[membership collection](STORE.md#membership-gates-and-cross-owner-reads) keyed
by the signed-in user id. The
[private-requests proof](../proofs/private-requests/README.md) is an
end-to-end application built that way, with no application server code.

When the declarative contracts do not express an application's rules, keep
each operation as an ordinary YAML function route with `auth: true`, explicit
methods and bounded request bodies (the
[authenticated-json-api recipe](../recipes/authenticated-json-api/README.md)
shows the route shape). With the first-party auth extension, a trusted function
reads the verified user id from
`context.capabilities.auth.identity.userId`
([request-bound capabilities](EXTENSIONS.md#request-bound-capabilities)).
Better Auth owns accounts and sessions; the application owns its business
rules and authorization.

Stored short links are a collection declared through the `store` extension
above (see [docs/STORE.md](STORE.md)); core has no native `link` route.

Rungs 1 to 3 need only the core package. Rungs 4 to 6 need an extension added
to the site with `urlcode extensions add`, which wires it into the explicit
operator host. Auth and audit additionally need the Node/SQLite
runtime their packages document; mcp declares Node, AWS and Vercel targets (its opt-in streaming transport is
self-hosted only), while store (its database is `node:sqlite`) is Node-only. See each package's README ([auth](../packages/auth/README.md),
[audit](../packages/audit/README.md),
[store](../packages/store/README.md),
[mcp](../packages/mcp/README.md)) for the exact requirement.

## Using npm libraries directly

A trusted `function` or `middleware` route can import any installed npm
package through the package's own API. Node resolves it from the site's
`node_modules`. No adapter, extension descriptor, catalog entry or wrapper is
involved. The package gets no URLCode authority: bindings, egress grants,
revision pins and target refusals apply unchanged. Prefer a declarative
contract where one fits. For example, use `request.body.<METHOD>.schema`
rather than hand-written validation; `urlcode review` points these cases out.
Use a library for what the vocabulary cannot express.

- A `sandbox: true` route imports only relative project modules. A package
  import there is refused before serving (`sandbox-import`); direct use does
  not waive the sandbox.
- Review labels the route `execution: trusted (in-process)`. It does not list
  what the route imports, and the operator approval digest covers only the
  entry file ([function security](FUNCTION-SECURITY.md#granting-selected-bindings)).
- Functions run only on the self-hosted Node runtime, including a runtime
  embedded in another Node host
  ([operations](OPERATIONS.md#hosting-urlcode-inside-another-framework)).

Write an extension only when a library must take part in URLCode's own
behavior: verified identity, admission, lifecycle, or a mount the operator
hosts. The [ecosystem fixture](../proofs/ecosystem/README.md) is the
executable check, with zod.

## The composition contract

An extended project is a site: core plus the add-ons that core pins.

```sh
npx @jimhoyd/urlcode init my-site --with auth,store --example
```

That is `urlcode init my-site` followed by `urlcode extensions add auth
store --example` in it. Without `--example` each extension installs only its
capability (auth's `/api/auth/*` mount and secret); with it, each
extension that ships a demo also writes it, such as the store's per-user
`todos` collection below. Nothing else is discovered by convention:

```
my-site/
  app/                   the route project: urlcode.yaml, routes/, functions (Git-owned, untrusted content)
  host.mjs               trusted operator code: composeHost(import.meta.url, [auth(), store()])
  package.json           exact core pin and the add-on tarball URLs core pins
  package-lock.json      integrity of every installed package
  data/                  private: auth.secret, auth.sqlite (after npx urlcode-auth migrate), store.sqlite (gitignored)
```

The project declares logical extensions and exclusive mounts:

```yaml
version: "1"
extensions:
  auth:  { version: "1", config: {} }
  store:
    version: "1"
    config:
      collections:
        todos:
          mount: /api/todos
          ownership: owner
          maxRecords: 1000
          maxRecordBytes: 4096
          schema:
            type: object
            additionalProperties: false
            required: [title]
            properties:
              title: { type: string, minLength: 1, maxLength: 200 }
              done: { type: boolean }
          defaults: { done: false }
routes:
  /api/auth/*:  { extension: auth, methods: [GET, POST] }
  /api/todos/*:
    extension: store
    methods: [GET, HEAD, POST, PUT, PATCH, DELETE]
    auth: true
  /private:
    respond: { text: Signed in }
    auth: true
```

The operator host lists the extensions. Registration is an activation
boundary; it does not isolate trusted application code from the host:

```js
import { composeHost } from '@jimhoyd/urlcode/host';
import auth from '@jimhoyd/urlcode-auth/extension';
import store from '@jimhoyd/urlcode-store/extension';

export default await composeHost(import.meta.url, [
  auth(),
  store(),
]);
```

`composeHost` orders the list by each extension's `requires` and `uses`,
and the runtime activates the declared ones in that order, so a dependency is
always active before the extension that reads it. Auth requires nothing and
exports nothing to other extensions: it reaches the owned store collection
only through the generic request principal, and the route's own code only
through its `identity` capability. Everything about the Better Auth instance
(sign-up, extra endpoints, plugins, database and secret file) is an option of
`auth({...})` in `host.mjs`, never YAML. No extension reads another's
configuration ([nesting](EXTENSIONS.md#nesting)). Operator options go inside a
call, for example `auth({signUp: true})`.

The whole graph, as each extension declares it:

```
audit    requires []
auth     requires []
store    requires []                  uses [audit]
mcp      requires []
```

A `requires` entry must be installed and declared; a `uses` entry is optional,
and the extension works without it (store refuses only a collection that asks
for `audit: true` when audit is absent).

Treat that composition as one application with package ownership boundaries. Keep accounts, passwords and sessions in
Better Auth behind the auth extension, roles and permissions in the
application's own data, the durable log in audit and email delivery in the
application's own function code, through the provider's library, and the
frontend, its components and styling in the application's own source.
Apply product differences through the installed extensions' declared authoring
surfaces: configuration first, then a supported hook. Create another extension only for
a reusable capability those surfaces cannot express. `urlcode extensions`
and the MCP `get_extensions` tool report those surfaces and their fast checks,
so people and agents can discover the supported path instead of replacing
package behavior.

Every extension sees the same generic per-request facts through the core
contract: `ExtensionRequest.requestId` (the response's `X-Request-Id`, also
`context.requestId` in functions) and `ExtensionRequest.env`, the mount's own
route `env` block resolved under the same revision-pinned operator grant a
function route uses. Project hooks are called as `hook(input, context)` with
`{requestId, env}` plus any fields the extension adds (mcp adds the server and
tool names). See [request context](EXTENSIONS.md#request-context-route-env-and-request-id).
Activation likewise carries the canonical `origin` and the operator's full
`origins` list (`--alias-origin`); every same-origin check goes through core's
`isSiteOrigin`, and every write goes through core's one same-origin rule,
`isSameOriginRequest`, so mcp, store and auth admit the same
origins ([site origins](EXTENSIONS.md#site-origins-and-same-origin-checks)).
A SQLite-backed extension refuses a network filesystem and a live peer on
another host through core's `refuseNetworkFilesystem` and `joinHostLease`, each
with a lease table in its own database, so store, auth and audit enforce one
topology rule ([request helpers](EXTENSIONS.md#request-helpers)).
An extension reports a startup condition the operator should act on through
the activation's generic `warn()`, which reaches the operator's startup log as
an `extension_warning` event and never a response
([activation warnings](EXTENSIONS.md#activation-warnings)).
Who a request is for travels the same generic way: an extension that declares
`providesPrincipal` (auth) sets an opaque, bounded `ExtensionRequest.principal`
from its `authorize()`, and another extension on the route (an owned store
collection) reads it, without either knowing the other
([request principal](EXTENSIONS.md#request-principal)). The route's own code
receives what an extension declares as a request-bound capability, such as
auth's `context.capabilities.auth.identity.userId`
([request-bound capabilities](EXTENSIONS.md#request-bound-capabilities)). A long-lived answer
(server-sent events, progress) is generic too: a registration that declares
`streams: true` may return `HandlerResult.stream` instead of `body`, which the
self-hosted server and Vercel adapter write as it is produced under operator
stream limits and every other target refuses before serving
([streamed responses](EXTENSIONS.md#streamed-responses)). A composition reaches
the add-ons it requires only through their typed, versioned exports, read with
`ctx.get`, never their configuration ([nesting](EXTENSIONS.md#nesting)).

An artifact is a separate, optional authoring input, not another way to
compose executable behavior. `urlcode artifacts add store-schema` installs
inert schema/example data that MCP `get_extension_artifacts` and
`get_extension_artifact` expose; the extension and the explicit operator host
remain the executable path. See [artifacts](EXTENSIONS.md#artifacts).

```sh
cd my-site
npm run dev        # urlcode dev --project app --host-file host.mjs
```

Each `extensions add` calls the extension's `scaffold` (and, with `--example`,
its optional `example`, merged on top) and writes its
configuration into `app/urlcode.yaml`, its routes into `app/routes/<name>.yaml`,
its operator files beside `host.mjs`, and one line each in `host.mjs`, refusing
and rolling everything back when two fragments collide (the contract is
documented under [add-ons](EXTENSIONS.md#add-ons-extensions-and-artifacts)).
For auth, `npx urlcode-auth migrate` then creates Better Auth's tables and
`npx urlcode-auth create-user` creates an account from JSON on stdin (`npx urlcode-auth find-user --email <email>` prints an existing one's id).
Neither is needed for tests: `urlcode test`, `audit` and `benchmark` compose the
host on a fresh data directory every run (`HostContext.data` and `hermetic`) and
seed accounts and memberships from `app/tests/seed.json`
([test data and seeds](READINESS.md#test-data-and-seeds)). `extensions add` prints the project revision the host must be pinned to
(the reviewed `--policy` file's `projectSha256`, or `PROJECT_SHA256`; see
[the revision pin](EXTENSIONS.md#the-revision-pin)); changing extension YAML, policies or mounts changes the revision and
needs an explicit operator reapproval before serving. The site's check scripts
(`npm run validate`, `npm test`, `npm run audit`) pass `--local-review` and
review each edit locally without one, on throwaway data, so no migration is
needed before them either
([the local review loop](EXTENSIONS.md#the-local-review-loop)).

## Rules an agent must follow

These are the facts that keep generated projects valid. The full matrix is in
[AI authoring](AI-AUTHORING.md); this is the short list.

- **Extension YAML names logical extensions, not host packages or credentials.**
  Function and middleware `source` fields do name project modules. Extensions are
  logical names; the host file chooses the implementation. There is no
  `--extension` flag, no `import` in YAML, no interpolation.
- **Build one product through declared authoring surfaces.** Inspect extension
  authoring metadata before generating code. Prefer configuration, then
  supported hooks. The frontend is the application's own code; for shadcn/ui
  use the official tooling and `urlcode artifacts stage`. Add an extension only for a reusable missing capability. Run the
  reported fast checks while iterating and the full repository checks before
  handoff.
- **One handler per route.** `redirect`, `respond`, `page`, `static`, `download`,
  `function`, `proxy`, `conditional` or `extension`, plus optional
  `middleware`. Paths are exact or single-segment `{param}`; `/*` only on
  `static` and `extension` mounts. No regex.
- **`function`/`middleware` code is trusted by default, sandboxed opt-in.**
  It runs in-process with full Node access unless the route declares
  `sandbox: true`, which isolates it to a text/JSON `Request`/`Response`
  subset, validated `args` and granted `env`, with no `fetch`, Node,
  filesystem or general network access; bounded timers are available. Either way, `args`/`env`/`secrets` are exactly what
  the route declares and an operator grants — trust changes where code runs,
  not what it is handed. See docs/SPIKE-DEFAULT-TRUST-MODEL.md and
  docs/FUNCTION-SECURITY.md.
- **Authentication is host processing.** Do not build login forms, session
  cookies or password checks in functions. With the auth extension declared,
  use `auth: true` (it expands to `policies.extensions.auth: {}`, because `auth`
  is the declared extension that provides the principal; there is no
  role or permission key) and read `context.capabilities.auth.identity.userId`;
  keep permissions in application data keyed by that id. The runtime filters
  credential headers passed to application handlers. This is not a security boundary against trusted Node code.
- **Everything is validated before it runs.** `urlcode validate --local`,
  `urlcode test`, `urlcode audit --expect-routes N`. Unsupported features fail
  with the route named; nothing degrades silently.
- **Provider targets refuse what they cannot enforce.** Cloudflare runs
  redirects and declared responses only. Serverless adapters refuse functions,
  proxy, signals and extensions. The `static` target (S3 + CloudFront,
  no server) refuses everything that needs request-time logic, keeping only
  `redirect`/`respond`/`page`/`static`/`download` — see [static
  hosting](STATIC.md). Check `urlcode capabilities --target NAME` before
  promising a deployment.
- **Report evidence, not hope.** The commands above are the evidence. Local
  tests are not deployment, soak or independent security review.

## Ownership

The [#841](https://github.com/jimhoyd-com/urlcode/issues/841) redesign replaced
owned subsystems with maintained libraries: Better Auth for accounts, SQLite for
the store, the official MCP SDK, Ajv for body schemas, and the application's own
frontend in place of the UI kit and forms. This section records the result as
measured, including what was added, not as a target.

**Commits.** The baseline is `a996f0d`, the commit audited in #841. The result
is `2f94bfab`, the main commit after
[#883](https://github.com/jimhoyd-com/urlcode/issues/883) slice 6. Between them
are 36 commits; `git diff --shortstat` over the whole repository reports 725
files changed, 21,249 insertions and 59,454 deletions.

**Method.** Each count is physical lines (`wc -l`, comments and blank lines
included) of files tracked at that commit:

- *Source* is `packages/<name>/src/**/*.ts`.
- *Tests* is `packages/<name>/test/**`. Core has no package test directory, so
  its row counts the root `test/**`. That includes fixtures and the packed
  add-on and proof integrations.
- *Package docs* is the package's top-level `*.md` files plus `llms.txt`.
- *Dependencies* are `package-lock.json` entries under `node_modules/`,
  excluding workspace links, split by the lockfile's `dev` flag.
- *Exports* are the symbols (values and types) of every `@jimhoyd/urlcode`
  subpath entry in `package.json#exports`, resolved with the TypeScript
  checker. The value count of `.` matches `Object.keys()` of the built
  `dist/index.js`.
- *MCP tools* come from `mcpToolInventory`. *CLI commands* are the top-level
  commands in `urlcode --help`.

| Package | Source before | Source after | Tests before | Tests after | Package docs before | Package docs after |
|---|---:|---:|---:|---:|---:|---:|
| core (`@jimhoyd/urlcode`) | 18,136 | 20,431 | 18,529 | 23,296 | 19 | 19 |
| auth | 17,336 | 249 | 7,369 | 127 | 1,644 | 227 |
| store | 1,502 | 2,393 | 2,052 | 3,526 | 412 | 515 |
| audit | 890 | 891 | 830 | 827 | 386 | 384 |
| mcp | 1,058 | 557 | 1,140 | 1,004 | 859 | 720 |
| admin (deleted) | 1,305 | — | 1,174 | — | 717 | — |
| ui (deleted) | 2,495 | — | 2,005 | — | 1,062 | — |
| forms (deleted) | 589 | — | 1,237 | — | 813 | — |
| form-records (deleted) | 443 | — | 805 | — | 410 | — |
| mail (deleted) | 714 | — | 693 | — | 318 | — |
| abuse (deleted) | 588 | — | 654 | — | 296 | — |
| **Total** | **45,056** | **24,521** | **36,488** | **28,780** | **6,936** | **1,865** |

Owned source fell 45.6%, to 24,521 lines. That is above the 12,100–19,000
range #841 estimated. The estimate expected core to shrink to 8,000–11,000
lines, but core grew by 2,295 lines: its deletions were small, and most of the
additions below landed in core.

| Measure | Before | After |
|---|---:|---:|
| Packages in `packages/` | 11 | 5 |
| npm workspaces (packages plus `artifacts/store-schema`) | 12 | 6 |
| Lockfile entries, installed | 235 | 189 |
| Lockfile entries, not dev-only | 48 | 42 |
| Lockfile entries, dev-only | 187 | 147 |
| Direct runtime dependencies: core / auth / mcp | 6 / 5 / 0 | 7 / 1 / 1 |
| `@jimhoyd/urlcode` exported symbols, all 15 entries (values + types) | 423 (180 + 243) | 431 (184 + 247) |
| of which `.` / `./extensions` | 190 / 81 | 200 / 70 |
| Authoring MCP tools (read + `--host-file` + `--allow-authoring`) | 43 (35 + 1 + 7) | 40 (32 + 1 + 7) |
| `urlcode` CLI commands | 38 | 39 |
| Package CLIs (`urlcode-*` bins) | 4 | 3 |
| `docs/*.md` lines (pages) | 16,484 (81) | 17,122 (79) |
| `recipes/` lines (files) | 4,733 (111) | 3,365 (99) |

The baseline's read list included 6 deprecated aliases, so the canonical read
list grew from 29 to 32. The application `mcp` extension ships no tools of its
own before or after, because every tool is project-declared.

What was added over the same span:

| Addition | Owned source | Owned tests | Library it builds on |
|---|---:|---:|---|
| Better Auth adapter (all of `packages/auth/src`) | 249 | 127 | `better-auth` (23 installed lockfile entries) |
| SQLite store, transactions, membership, backup (store source, net of the deleted screens) | +891 | +1,474 | `node:sqlite` |
| OpenAPI 3.1 export (`openapi.ts`) | 313 | 415, plus a 1,411-line vendored official schema | `@hey-api/openapi-ts` (dev, generated-client check) |
| Body schema profile and formats (`body-validation.ts`, `body-formats.ts`; `body-schema.ts` −118) | 423 net | 364 | Ajv |
| Artifact inspection and staging (`artifact-inspect.ts`, `source-stage.ts`, plus `addon-manifest.ts`, `addon-install.ts` and `extensions-cli.ts` growth) | 1,349 | 712 | `yaml` |
| Embedding in another host (`embed.ts`, `host-request.ts`) | 243 | 214 | — |
| Proofs (`proofs/`) | 1,607 lines of application, operator and client files | 1,005 in three integrations | Better Auth, Auth.js, zod, Hono, esbuild |

The MCP SDK swap removed 501 lines from `packages/mcp` and moved core's
authoring server onto `@modelcontextprotocol/server`.

## Agent workflow trial

On 2026-09-29, for [#841](https://github.com/jimhoyd-com/urlcode/issues/841)
order 5, one agent built three small sites from scratch on main `4a095468`.

**Method.** `scripts/pack-addons.ts` packed core and the add-ons. Each site was
created by `urlcode init` from the packed core, with its runtime pin pointed at
that tarball. The agent then worked only through the installed CLI (`context`,
`plan-feature`, `docs search`, `capabilities`, `schema`, `recipes`, `explain`,
`fixtures suggest`, `validate`, `test`, `audit`, `review`, `openapi`), the
installed READMEs and each site's `AGENTS.md`. It read no repository source.
The trial measured:

- *CLI runs*: every `urlcode` invocation, including help.
- *Correction rounds*: a failed command or behavior that needed a change.
- *YAML*: the lines of `app/**/*.yaml` the agent wrote or kept, excluding the
  generated `routes/auth.yaml`.
- *Code*: the hand-written files, counted separately for server and frontend.
- *New gaps*: framework defects, and tooling or docs gaps, each counted in
  the task that first found it. There were 13 in total, and each was drafted
  as an issue.

Signed-in behavior was checked with a separate script: it signed in as each
user and ran the create, read, update and delete requests. The notes frontend
was also exercised in a browser.

| Task | CLI runs (validate / test / audit) | Correction rounds | YAML lines | Code lines (server + frontend) | New gaps | Final state |
|---|---:|---:|---:|---:|---:|---|
| Private notes: Better Auth plus an owned store collection, and a static frontend | 38 (6 / 3 / 4) | 8 | 44 | 0 + 44 | 7 | validate and 16 fixtures pass; audit not ready (`uncovered-route-methods`) |
| Request approval: an owned collection, a `reviewers` membership, a `by: others` transition and a readers mount | 18 (3 / 2 / 2) | 3 | 67 | 0 + 0 | 3 | valid on the first edit; 14 fixtures pass; audit not ready (same reason) |
| Public contact endpoint: body schema, `respond: 202`, a signal and an OpenAPI export | 15 (1 / 2 / 1) | 0 | 28 | 0 + 0 | 3 | audit ready; the OpenAPI output of all three sites passes a third-party 3.1 validator |

No task needed server code. The only hand-written code was the frontend,
which the application owns by design.

Most correction rounds were setup, not YAML:

- The generated npm scripts (`dev`, `validate`, `test`, `audit`) stop working
  after `extensions add`. With an extension installed they need
  `PROJECT_SHA256` and `--origin`.
- `init --with` failed with a generic error.
- A static `/*` route overlapped the extension mounts, and the error named
  neither route.

Neither protected site can be audit-ready. Request fixtures cannot sign in, so
every method of an `auth: true` mount is uncovered. The audit also ignores
`coveredElsewhere` waivers when a route has no method covered normally.

[#914](https://github.com/jimhoyd-com/urlcode/issues/914) answered both: a
`steps` fixture that signs in through the provider's own endpoint covers an
`auth: true` route, a waiver on a fully gated route counts once the gate's
`401` is asserted, and fixtures name the origin as `{{origin}}`
([authenticated routes](READINESS.md#authenticated-routes-auth-true)).

The measured defects and gaps were drafted as GitHub issues. This is a single
run by one agent, not a benchmark.

### Second run

On 2026-09-29 the same method ran again on main `036e86d8`, after the fixes
for #910–#917 and the store's `intervals` and `transfers`
([#902](https://github.com/jimhoyd-com/urlcode/issues/902)). It repeated the
three tasks and added two for #902 item 6. Each site pinned the packed core
before `extensions add`, as the `init --with` refusal instructs. Every
validate, test, audit and openapi run was given `PROJECT_SHA256` and
`URLCODE_ORIGIN`. Two runs were deliberate probes of suspected gaps and
are counted. First-run values are in parentheses.

| Task | CLI runs (validate / test / audit) | Correction rounds | YAML lines | Code lines (server + frontend) | New gaps | Audit ready | `openapi --check` |
|---|---:|---:|---:|---:|---:|---|---|
| Private notes | 20 (5 / 1 / 2) | 5 (8) | 36 (44) | 0 + 45 | 3 | yes (no) | passes |
| Request approval | 10 (1 / 1 / 1) | 0 (3) | 74 (67) | 0 + 0 | 0 | yes (no) | passes |
| Public contact endpoint, now with a throttle | 15 (1 / 2 / 2) | 1 (0) | 41 (28) | 0 + 0 | 1 | yes (yes) | passes |
| Room booking: `intervals`, a `cancel` transition, a readers mount | 14 (1 / 3 / 1) | 0 | 56 | 0 + 0 | 2 | yes | passes |
| Credits: `transfers` with an issuer and a no-overdraft `send` | 17 (1 / 8 / 1) | 1 | 44 | 0 + 0, plus a 5-line test-data reset script | 3 | yes | passes |

Compared with the first run:

- All three repeated tasks now reach audit readiness. Sign-in `steps`
  fixtures cover `auth: true` mounts.
- Every refusal named its fix: the `init --with` version skew, the revision
  pin, the origin, uninitialized auth tables and unasserted cases.
- The notes correction rounds fell from 8 to 5. Four of the five were still
  setup. The generated npm scripts still refuse after `extensions add`, and
  the revision changes on every edit.
- Approval was valid on the first edit and needed no corrections.

For #902 item 6, both counterexamples were declared with no handler code:

- **Scheduling.** 7 lines: the `intervals` line, the `cancel` transition,
  `defaults` and `readOnlyProperties`. Overlaps across owners answer `409`.
  A slot freed by `cancel` can be booked again.
- **Credits.** 13 lines: two `transfers` and an 8-line `issuers` membership.
  Overdraft, fractions and non-issuers are refused, and an `Idempotency-Key`
  retry replays.

The edit effort was one validate per task. The plumbing these features
remove is measured [below](#plumbing-removed-by-intervals-and-transfers).

Nine gaps were found. The main five:

- A 12-hour booking was accepted. Fixed-length slots can't be declared, and
  hour alignment needed a `pattern`. Since fixed
  ([#929](https://github.com/jimhoyd-com/urlcode/issues/929)):
  `intervals.length` and `step` answer `422`.
- A non-member could create a booking. Creates can't be limited to a
  membership list. Since fixed (#929): `create: {members}` answers `403`.
- `DELETE` of a wallet holding credits succeeded, which breaks the
  sum-never-changes guarantee. Since fixed
  ([#928](https://github.com/jimhoyd-com/urlcode/issues/928)): it answers
  `409 balance_not_zero`.
- Fixtures run against the site's own `data/` databases. Accounts and members
  are created out of band, and a rerun of the credits fixtures failed.
- `READINESS.md` and the store's interval and transfer sections are not
  installed, so `docs search` cannot find them.

Each gap was drafted as an issue.

### Third run

On 2026-09-29 the method ran again on main `f850492a`, after the fixes for
#928–#932, #936 and #938. This run changed three things:

- It used the generated npm scripts (`npm run validate`, `npm test`,
  `npm run audit`), which now pass `--local-review`, rather than
  `PROJECT_SHA256` and `URLCODE_ORIGIN`.
- Accounts and members came from `app/tests/seed.json`, with sign-in `steps`
  fixtures against the real auth extension.
- `npm test` ran twice after the last edit, to show that a rerun passes.

It repeated the booking, credits and approval tasks. Booking and credits now
use `intervals.length`/`step`, `create.members` and a projected `readers`
directory, since #929 made them declarable.

| Task | CLI runs (validate / test / audit) | Correction rounds (second run) | YAML lines (second run) | Fixture lines (requests + seed) | Code lines | Audit ready | `openapi --check` |
|---|---:|---:|---:|---:|---:|---|---|
| Room booking: one-hour slots, members-only create, `cancel` | 24 (3 / 4 / 2) | 3 (0) | 52 (56) | 35 + 10 | 0 | yes | passes |
| Credits: an issuer, pay after a directory lookup, no overdraft | 16 (2 / 3 / 2) | 2 (1) | 53 (44) | 36 + 11 | 0 | yes | passes |
| Request approval: `submit`/`withdraw`, `by: others` approve/reject, a reviewers queue | 23 (3 / 6 / 2) | 2 (0) | 77 (74) | 38 + 10 | 0 | yes | passes |

The table counts one more booking round, not shown in it: `openapi --local-review` was refused
([#958](https://github.com/jimhoyd-com/urlcode/issues/958)). Two approval test runs were
deliberate probes and are included in its count.

No correction round came from the YAML. All three projects were valid on
their first edit. The credits and approval fixtures passed on their first
run. The booking fixtures passed too; the audit then asked for one more
success case. Every round was one of these:

- `npm run validate` refused on each new site until `npx urlcode-auth migrate`
  was run, though `test` and `audit` no longer read the site's database
  ([#954](https://github.com/jimhoyd-com/urlcode/issues/954)).
- `npm run audit` answered `route-count-mismatch` on each site until
  `--expect-routes` was edited in `package.json`, `AGENTS.md` and the
  workflow ([#955](https://github.com/jimhoyd-com/urlcode/issues/955)).
- Booking only: `init --with` refused the version skew and named its fix,
  and a `PATCH` with only a `422` case left that method uncovered. The
  audit's note for it pointed at sign-in instead
  ([#959](https://github.com/jimhoyd-com/urlcode/issues/959)).

The rounds went up, from 0/1/0 to 3/2/2. That is mostly the method. The
second run gave the pin, origin and route count on the command line, not
through the generated scripts. This run counts the migrate and route-count
fixes as rounds on every site. The fixes held:

- A 12-hour booking and a 10:30 start answer `422`, and a non-member's
  booking `403` (#929).
- The credits and approval reruns pass on fresh seeded databases, and
  `expectJson` asserts balances beside generated ids (#930).

Two new store gaps came from behavior, not setup:

- **Approval.** After a reviewer approves a request, its owner can still
  `PATCH` the amount (`200`, still `approved`, still `reviewedBy` the
  reviewer) or `DELETE` it (`204`). Edits can't be limited to a state
  ([#952](https://github.com/jimhoyd-com/urlcode/issues/952)).
- **Credits.** The recipient directory finds wallets by name, but names
  can't be unique across owners. A second user's wallet named `bob` appears
  in the same lookup ([#953](https://github.com/jimhoyd-com/urlcode/issues/953)).

The remaining findings were tooling and docs:

- The booking and credits recipes predate #929 and #930
  ([#956](https://github.com/jimhoyd-com/urlcode/issues/956)).
- There is no approval recipe, and `plan-feature` lists the booking and
  credits recipes for an approval goal
  ([#957](https://github.com/jimhoyd-com/urlcode/issues/957)).
- Before any site existed, the add-ons packed without a build, and install
  reported them as having "no ./extension entry"
  ([#960](https://github.com/jimhoyd-com/urlcode/issues/960)).

**Caveats.**

- The agent knows this repository, and that biases the result. It read the
  add-on install source once, to diagnose #960, and the store's `urlcode.json`
  schema directly rather than through `docs search`.
- It guessed some response shapes (`/items/0/id`, `/from/balance`) from
  general REST convention. They were right.
- It ran the tasks in order, so the credits and approval sites skipped the
  `init --with` refusal it had already seen.
- It is still one run by one agent, not a benchmark. The frontend and the
  served (non-test) path were not exercised.

### Plumbing removed by intervals and transfers

For [#902](https://github.com/jimhoyd-com/urlcode/issues/902) item 6, both
counterexamples were also written without the declarations: trusted operator
extensions that serve the same mount through
[`StoreExports.transaction`](STORE.md#host-transactions). They are measurement
fixtures in `packages/store/test/plumbing/`, not recipes. The declarations are
what to use.

**Method.**

- Each counterexample serves its recipe's API: the statuses,
  `Cache-Control: no-store`, `401` without a principal, `403` for a
  cross-origin write, another owner's record as `404`, the `409`s
  (`interval_conflict`, `insufficient_balance`, `balance_not_zero`,
  `owner_quota_exceeded`), the `422`s and `If-Match`. The credits version also
  has the issuer's membership gate and `Idempotency-Key` retries.
- `packages/store/test/plumbing.test.ts` runs each recipe's own
  `tests/requests.json` and `tests/seed.json` against its counterexample
  through the CLI, twice, and the audit reports it ready. The recipe fixtures send no `Idempotency-Key`, so
  a ten-request retry fixture (`credits-retries.json`) runs against both the
  recipe and the counterexample.
- `npm run measure:plumbing` (`scripts/docs/measure-plumbing.ts`) counts, per
  file kind, lines that are neither blank nor only a comment. It also reports
  physical lines, which is what the #843 approval's "127 lines removed"
  counted.
- Both sides run on the same `host.mjs`. The counterexample adds two lines to
  register its extension, counted as code.

Counted when the counterexamples were added:

| Contract | Declared: YAML / code | Host transaction: YAML / code | Code removed | Physical lines, declared / host |
|---|---:|---:|---:|---:|
| Scheduling (`store-booking`) | 38 / 0 | 39 / 137 | 137 | 43 / 201 |
| Credits (`store-credits`) | 42 / 0 | 43 / 170 | 170 | 50 / 246 |

The declarations remove 137 and 170 lines of trusted code, and the YAML stays
the same size. The counterexamples drop the 5 `intervals` lines and the 4
`transfers` and `readOnlyProperties` lines, along with `ownership`,
`maxRecordsPerOwner` and `idempotency`, which move into the code. They add an
`owner` property, the extension's declaration and a disabled store route.

Most of the removed code is not the rule itself:

- **Scheduling.** The overlap check is 12 lines, plus 8 to page through every
  booking.
- **Credits.** The transfers are 33 lines (the floors, the body check and the
  transfer), and retries 9.
- **Both.** The rest is what the store already serves for a declared
  collection: routing, bodies, the error shape, the owner, the quota and the
  extension registration (33 lines in the booking version).

The owner is plumbing because of the scope rule. A host transaction on an
owned collection sees only the caller's records, so it cannot find another
owner's overlapping booking or credit another owner's wallet. Each
counterexample therefore uses a shared collection with an `owner` property.
The extension stamps it and filters by it on every read, and it refuses any
body that names it.

**Caveats.**

- Route `function`s cannot reach `StoreExports.transaction`, which is for
  trusted extensions only. So each counterexample is an operator extension
  serving the mount, not a function route. A function route version would
  need an extension to hand it the store as well.
- Every store collection needs a store mount, so each counterexample declares
  one on a disabled route.
- The fixtures check statuses and some headers, not bodies. The
  counterexamples use the store's error shape and codes, but the equivalence
  is only as good as the fixtures and the retry cases.
- Known differences from the store:
  - A list answers all of the caller's records (at most 100 bookings or 10
    wallets) in one page, without cursors, `etags`, `may`, sorting or
    filtering.
  - A retried request replays a kept snapshot, where the store answers the
    records as they are now.
  - With `audit: true`, a transfer would record two updates, not
    `store.record.transferred`.
  - There is no OpenAPI description (`describe`), so `urlcode openapi` leaves
    the mount opaque.
- Cost differs too. The overlap check, the quota and the membership lookup
  scan every record of the collection inside the write transaction. The
  declared `intervals` check is one index step (2.4 µs against 197 µs for one
  room's records in JavaScript; see [cost](STORE.md#non-overlapping-intervals)).
- Line counts depend on style. The counterexamples use one statement per line,
  with lines of at most 140 characters.
- The edit effort of the host version is not comparable. One agent wrote both
  counterexamples with the recipes, the fixtures and the store source at hand,
  and both passed the recipe fixtures on their first run. The agent in the
  second trial read no source.
- The counterexamples' concurrency is not tested here. Each request is one
  `BEGIN IMMEDIATE` transaction, like the store's own writes.

## Where to read next

| Need | Read |
|---|---|
| Write or change routes | [YAML guide](YAML-GUIDE.md), [field reference](YAML-REFERENCE.md), [cookbook](../examples/cookbook/README.md) |
| Configure an extension: every key it accepts | [extension field references](EXTENSION-REFERENCE.md) (each package README ends with one, generated from its `urlcode.json`) |
| Add accounts | [auth README](../packages/auth/README.md), [auth security](../packages/auth/SECURITY.md) |
| Audit log | [audit](../packages/audit/README.md) |
| Rate limits, email | [`policies.throttle`](POLICIES.md), [contact-form recipe](../recipes/contact-form/README.md) |
| Build the frontend | [private-requests client](../proofs/private-requests/client/main.js), [what the caller may run](STORE.md#what-the-caller-may-run), [staging source assets](EXTENSIONS.md#staging-source-assets) |
| Write an extension | [extensions](EXTENSIONS.md), [authoring rules](EXTENSIONS.md#generic-add-on-authoring-rules) |
| Run it | [operations](OPERATIONS.md), [install](INSTALL.md), [deployment checks](DEPLOYMENT-CHECKS.md) |
