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
          fields:
            title: { type: string, required: true, minLength: 1, maxLength: 200 }
            done: { type: boolean, default: false }
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
([streamed responses](EXTENSIONS.md#streamed-responses)). A mount that serves
only content-hashed files is named in the instance's
generic `assetMounts`, and `urlcode audit` covers it by that contract after
probing an unknown name for 404
([extension asset mounts](EXTENSIONS.md#extension-asset-mounts)). A composition reaches
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
`npx urlcode-auth create-user` creates an account from JSON on stdin. `extensions add` prints the project revision the host must be pinned to
(the reviewed `--policy` file's `projectSha256`, or `PROJECT_SHA256`; see
[the revision pin](EXTENSIONS.md#the-revision-pin)); changing extension YAML, policies or mounts changes the revision and
needs an explicit operator reapproval.

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
