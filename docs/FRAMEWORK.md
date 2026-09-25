# The URLCode framework

One page for people and AI agents. It says what the eleven workspace packages are, how a
project grows from a handful of redirects into an application with accounts
and an administration console, and which facts an agent must not guess. Every
claim here is implemented in the linked repository; nothing is roadmap.

## Eleven workspace packages, one project shape

| Package | Source | What it adds | How a project declares it |
|---|---|---|---|
| `@jimhoyd/urlcode` | this repository | The runtime: YAML routes, functions and middleware (trusted by default, `sandbox: true` opt-in), pages and assets, policies, site conventions, CLI, provider adapters, the extension contract | `urlcode.yaml` with `version: "1"` |
| `@jimhoyd/urlcode-ui` | [`packages/ui`](../packages/ui) | Shared presentation: escaped templates, shadcn/ui partials, one stylesheet with light and dark, themes, translations, the `ui` extension that serves the kit's assets | `extensions.ui` plus an asset mount route |
| `@jimhoyd/urlcode-audit` | [`packages/audit`](../packages/audit) | The durable audit log: producers (auth, audited store collections) write events into their own transactional outbox, and audit drains them into one bounded SQLite log with a query API, retention and an operator CLI | `extensions.audit`; no route |
| `@jimhoyd/urlcode-abuse` | [`packages/abuse`](../packages/abuse) | Abuse protection for other extensions: keyed budgets and backoff over pseudonymous (HMAC) keys, an optional challenge provider and a honeypot helper | `extensions.abuse`; no route. Consumers declare their budgets in their own configuration |
| `@jimhoyd/urlcode-mail` | [`packages/mail`](../packages/mail) | Plain-text transactional email: templates contributed by other extensions, translatable copy, one operator transport (a loopback outbox by default, SES or your own) | `extensions.mail`; no route. The transport is chosen in `host.mjs` |
| `@jimhoyd/urlcode-auth` | [`packages/auth`](../packages/auth) | Accounts: password, passkeys, OpenID Connect, email codes, TOTP, recovery, sessions, roles, registration modes, account page, operator CLI. Requires `ui`, `audit` and `mail`; uses `abuse` when installed | `extensions.auth` plus an `/account/*` mount and `auth:` (`policies.extensions.auth`) on protected routes |
| `@jimhoyd/urlcode-admin` | [`packages/admin`](../packages/admin) | Administration: users, sessions, roles, the audit log, registration approval, two-person cases, support impersonation, health. Requires `auth`, `ui` and `audit` | `extensions.admin` plus an `/admin/*` mount carrying `auth: {onDeny: 404}` |
| `@jimhoyd/urlcode-store` | [`packages/store`](../packages/store) | Durable bounded JSON collections exposed as a typed CRUD API, plus optional list-and-form screens it contributes to `ui`; a collection with `audit: true` records its writes through `audit` | `extensions.store` plus a protected collection mount (and an `extension: ui` mount per screen) |
| `@jimhoyd/urlcode-forms` | [`packages/forms`](../packages/forms) | Bounded server-rendered form flows: escaped controls, admission, CSRF, validation and a confirmation that shows only opted-in fields; per-flow submission budgets through `abuse` and a notification through `mail` | `extensions.forms` plus a `GET, HEAD, POST` form mount; it composes with `ui` and optional `auth`, `abuse` and `mail` |
| `@jimhoyd/urlcode-form-records` | [`packages/form-records`](../packages/form-records) | The forms-to-store composition: a declared form's submission becomes a record private to its signed-in creator in an owned collection, with a confirmation that reads it back, an edit page limited to declared fields and an optional per-user list page, through the typed exports of `forms` and `store` (and `ui` for the list) | `extensions.form-records` plus a `GET, HEAD, POST` mount with `auth: {csrf: origin}`, over an `ownership: owner` collection |
| `@jimhoyd/urlcode-mcp` | [`packages/mcp`](../packages/mcp) | Declarative [MCP](https://modelcontextprotocol.io) tool server: JSON-RPC 2.0 framing, protocol version negotiation, request-id handling, `initialize`/`ping`/`tools/list`/`tools/call` dispatch over a bounded, project-declared tool map | `extensions.mcp` plus a `POST, HEAD` mount; `urlcode extensions add mcp` wires the extension but leaves the server/tool declaration and its trusted handler module for the operator (every tool needs project code) |

All eleven are Apache-2.0. Core is published through npm, GitHub Releases and
Homebrew. The ten extensions, and the inert `store-schema` artifact in
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
([issue 58](https://github.com/jimhoyd-com/urlcode/issues/58)). Their status
files say exactly what is built: [auth](../packages/auth/IMPLEMENTATION-STATUS.md),
[admin](../packages/admin/IMPLEMENTATION-STATUS.md),
[ui](../packages/ui/IMPLEMENTATION-STATUS.md).
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
4. **Accounts.** The `auth` extension: sign-in, registration, MFA, account
   page and protected routes. The operator installs it in a host file outside
   the project; YAML only declares the mount and configuration. Adding auth
   also adds the `audit` log every privileged action is recorded in and the
   `mail` extension that sends its messages; `abuse` adds sign-in and sign-up
   budgets when it is installed too.
5. **Administration.** The `admin` extension over auth's typed exports:
   manage the people who signed up, their sessions and roles, and review the
   audit log.

6. **Your own look.** The `ui` extension's kit renders every auth, admin,
   forms and store screen; its theme, project copy, template and stylesheet
   overrides restyle them together.
7. **Bounded data and forms.** The `store` extension supplies declared durable
   collections; the `forms` extension supplies declared browser form flows over
   the shared UI kit. Both are trusted operator extensions, not core YAML
   handlers. Add `auth: {csrf: origin}` where a flow or collection is per-account
   (a form mount must not use `auth: true`: auth's token mode refuses its POSTs).
   The `form-records` extension composes them when a form should become a
   record its creator can see again and edit: it saves the submission into
   an owned collection and serves the confirmation and a constrained edit
   page, with no handler code.
8. **MCP tools.** The `mcp` extension serves a bounded, project-declared MCP
   tool server: JSON-RPC 2.0 framing, protocol negotiation and dispatch are the
   extension's; each tool's own logic is a trusted project handler module the
   operator writes (`urlcode extensions add mcp` wires the extension but
   leaves that handler for you, unlike the other rungs here). Add `auth: true` where a
   mount needs a signed-in caller.

Stored short links are a collection declared through the `store` extension
above (see [docs/STORE.md](STORE.md)); core has no native `link` route.

Rungs 1 to 3 need only the core package. Rungs 4 to 8 need an extension added
to the site with `urlcode extensions add`, which wires it into the explicit
operator host. Auth, admin, audit and abuse additionally need the Node/SQLite
runtime their packages document; forms (except a flow with `abuse`), mail and
mcp declare Node, AWS and Vercel targets, while store, and so form-records, are
currently Node-only. See each package's README ([auth](../packages/auth/README.md),
[admin](../packages/admin/README.md), [ui](../packages/ui/README.md),
[audit](../packages/audit/README.md), [abuse](../packages/abuse/README.md),
[mail](../packages/mail/README.md),
[store](../packages/store/README.md), [forms](../packages/forms/README.md),
[form-records](../packages/form-records/README.md),
[mcp](../packages/mcp/README.md)) for the exact requirement.

## The composition contract

An extended project is a site: core plus the add-ons that core pins.

```sh
npx @jimhoyd/urlcode init my-site --with ui,auth,admin --example
```

That is `urlcode init my-site` followed by `urlcode extensions add ui auth
admin --example` in it, which also adds `audit` and `mail`, because auth and
admin require them. Without `--example` each extension installs only its
capability (auth's `/account/*` pages, admin's console, ui's assets); with it,
each also writes its demo, such as the `/private` page below. Nothing else is discovered by convention:

```
my-site/
  app/                   the route project: urlcode.yaml, routes/, functions (Git-owned, untrusted content)
  host.mjs               trusted operator code: composeHost(import.meta.url, [audit(), mail(), ui(), auth(), admin()])
  operator-service.mjs   opens the auth store and keys (written by auth's scaffold)
  package.json           exact core pin and the add-on tarball URLs core pins
  package-lock.json      integrity of every installed package
  data/                  private: auth.sqlite, audit.sqlite, the mail outbox, encryption key, CSRF key (gitignored)
```

The project declares logical extensions and exclusive mounts:

```yaml
version: "1"
extensions:
  ui:    { version: "1", config: { theme: { name: Acme, colors: { primary: "24 95% 53%" } } } }
  audit: { version: "1", config: {} }
  mail:  { version: "1", config: {} }
  auth:  { version: "1", config: { registration: "off" } }
  admin: { version: "1", config: {} }
routes:
  /assets/ui/*: { extension: ui,    methods: [GET, HEAD] }
  /account/*:   { extension: auth,  methods: [GET, HEAD, POST] }
  /admin/*:     { extension: admin, methods: [GET, HEAD, POST], auth: { onDeny: 404 } }
  /private:
    respond: { text: Signed in }
    auth: true
```

The operator host lists the extensions. Registration is an activation
boundary; it does not isolate trusted application code from the host:

```js
import { composeHost } from '@jimhoyd/urlcode/host';
import audit from '@jimhoyd/urlcode-audit/extension';
import mail from '@jimhoyd/urlcode-mail/extension';
import ui from '@jimhoyd/urlcode-ui/extension';
import auth from '@jimhoyd/urlcode-auth/extension';
import admin from '@jimhoyd/urlcode-admin/extension';

export default await composeHost(import.meta.url, [
  audit(),
  mail(),
  ui(),
  auth(),
  admin(),
]);
```

`composeHost` orders the list by each extension's `requires` and `uses`,
and the runtime activates the declared ones in that order, so a dependency is
always active before the extension that reads it. It hands admin auth's typed
`AuthExports` (version 1) through `ctx.get('auth')`: the signed-in account, a
CSRF token and the administration API, never auth's keys, database or raw
tokens. Auth sends every message itself, admin-initiated ones included,
through `MailExports`, and both record privileged actions in the audit log.
`composeHost` also collects the templates and catalogues auth and admin
contribute to `ui`, so both render every screen through the one `ui.kit`, and
the message templates auth and forms contribute to `mail`. The store contributes to `ui` too,
without requiring it: the CRUD screens declared under
`extensions.store.config.screens` reach ui as generic screen descriptions
through `contributes.ui.screens`, so ui never reads another extension's
configuration ([nesting](EXTENSIONS.md#nesting)). Operator options go inside a call, for
example `mail({transport: sesTransport({region}), from})`.

The whole graph, as each extension declares it:

```
ui       requires []
audit    requires []
abuse    requires []
mail     requires []
auth     requires [ui, audit, mail]   uses [abuse]
admin    requires [auth, ui, audit]
store    requires []                  uses [audit]
forms    requires [ui]                uses [abuse, mail]
form-records requires [forms, store, ui]
mcp      requires []
```

A `requires` entry must be installed and declared; a `uses` entry is optional,
and the extension works without it (store refuses only a collection that asks
for `audit: true` when audit is absent).

Treat that composition as one application with package ownership boundaries,
not as separate user interfaces. Keep identity, sessions, recovery,
authorization, freshness and every account mutation in auth, the console's
screens in admin, the durable log in audit and delivery in mail.
Apply product differences through the installed extensions' declared authoring
surfaces, in this order: configuration and theme, copy, a component or screen
template, stylesheet, then a supported hook. Create another extension only for
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
`isSameOriginRequest`, so mcp, forms, store, auth and admin admit the same
origins ([site origins](EXTENSIONS.md#site-origins-and-same-origin-checks)).
When the operator sets `--passkey-rp-id`, activation also carries
`passkeyRpId`, and auth runs passkey ceremonies under that shared domain for
every site origin ([shared passkey RP ID](EXTENSIONS.md#shared-passkey-relying-party-domain)).
An extension reports a startup condition the operator should act on through
the activation's generic `warn()`, which reaches the operator's startup log as
an `extension_warning` event and never a response
([activation warnings](EXTENSIONS.md#activation-warnings)).
Who a request is for travels the same generic way: an extension that declares
`providesPrincipal` (auth) sets an opaque, bounded `ExtensionRequest.principal`
from its `authorize()`, and another extension on the route (an owned store
collection) reads it, without either knowing the other
([request principal](EXTENSIONS.md#request-principal)). A composition reaches
the add-ons it requires only through their typed, versioned exports:
`form-records` reads `FormsExports` and `StoreExports` with `ctx.get`, never
their configuration ([nesting](EXTENSIONS.md#nesting)).

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
`npx urlcode-auth bootstrap` creates the first administrator from JSON on
stdin. The command prints the project revision the host must be pinned to
(the reviewed `--policy` file's `projectSha256`, or `PROJECT_SHA256`; see
[the revision pin](EXTENSIONS.md#the-revision-pin)); changing extension YAML, policies or mounts changes the revision and
needs an explicit operator reapproval.

The presentation tooling composes the same way. `npx urlcode-ui` with
`--extensions @jimhoyd/urlcode-auth,@jimhoyd/urlcode-admin` adds the namespaces
those installed packages contribute (read from each package's `./extension`
definition, `contributes.ui`), so `list`, `doctor`, `eject`, `preview` and
`copy --missing` cover the `auth/*` and `admin/*` templates and copy the host
registers, and a project override of an extension template is checked against
the shipped view model.

## Rules an agent must follow

These are the facts that keep generated projects valid. The full matrix is in
[AI authoring](AI-AUTHORING.md); this is the short list.

- **Extension YAML names logical extensions, not host packages or credentials.**
  Function and middleware `source` fields do name project modules. Extensions are
  logical names; the host file chooses the implementation. There is no
  `--extension` flag, no `import` in YAML, no interpolation.
- **Build one product through declared authoring surfaces.** Inspect extension
  authoring metadata before generating code. Prefer configuration/theme, copy,
  the smallest template override, stylesheet and supported hooks, in that
  order. Add an extension only for a reusable missing capability. Run the
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
  prefer `auth: true` or `auth: {role: admin}`; these expand to
  `policies.extensions.auth`. The runtime filters credential headers passed to
  application handlers. This is not a security boundary against trusted Node code.
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
| Add accounts | [auth README](../packages/auth/README.md), [auth security](../packages/auth/SECURITY.md) |
| Add administration | [admin README](../packages/admin/README.md) |
| Audit log, abuse budgets, email | [audit](../packages/audit/README.md), [abuse](../packages/abuse/README.md), [mail](../packages/mail/README.md) |
| Save a form as an editable record | [form-records README](../packages/form-records/README.md), [data store](STORE.md) |
| Restyle every page | [ui README](../packages/ui/README.md), [ui contract](../packages/ui/CONTRACT.md) |
| Write an extension | [extensions](EXTENSIONS.md), [authoring rules](EXTENSIONS.md#generic-add-on-authoring-rules) |
| Run it | [operations](OPERATIONS.md), [install](INSTALL.md), [deployment checks](DEPLOYMENT-CHECKS.md) |
