# The URLCode framework

One page for people and AI agents. It says what the six workspace packages are, how a
project grows from a handful of redirects into an application with accounts
and an administration console, and which facts an agent must not guess. Every
claim here is implemented in the linked repository; nothing is roadmap.

## Six workspace packages, one project shape

| Package | Source | What it adds | How a project declares it |
|---|---|---|---|
| `@jimhoyd/urlcode` | this repository | The runtime: YAML routes, functions and middleware (trusted by default, `sandbox: true` opt-in), pages and assets, policies, site conventions, CLI, provider adapters, the extension contract | `urlcode.yaml` with `version: "1"` |
| `@jimhoyd/urlcode-ui` | [`packages/ui`](../packages/ui) | Shared presentation: escaped templates, shadcn/ui partials, one stylesheet with light and dark, themes, translations, the `ui` extension that serves the kit's assets | `extensions.ui` plus an asset mount route |
| `@jimhoyd/urlcode-auth` | [`packages/auth`](../packages/auth) | Accounts: password, passkeys, OpenID Connect, email codes, TOTP, recovery, sessions, roles, registration modes, account page, operator CLI | `extensions.auth` plus an `/account/*` mount and `policies.extensions.auth` on protected routes |
| `@jimhoyd/urlcode-admin` | [`packages/admin`](../packages/admin) | Administration: users, sessions, roles, audit, registration approval, two-person cases, support impersonation, health | `extensions.admin` plus an `/admin/*` mount |
| `@jimhoyd/urlcode-store` | [`packages/store`](../packages/store) | Durable bounded JSON collections exposed as a typed CRUD API | `extensions.store` plus a protected collection mount |
| `@jimhoyd/urlcode-forms` | [`packages/forms`](../packages/forms) | Bounded server-rendered form flows: escaped controls, admission, CSRF, validation and a fixed confirmation | `extensions.forms` plus a `GET, HEAD, POST` form mount; it composes with `ui` and optional `auth` |

All six are Apache-2.0. Core is published through npm, GitHub Releases and
Homebrew. The first-party executable extensions are published as signed,
immutable GitHub Release bundles; their source remains in these workspace
packages, but new sites do not install them from npm. The forms package is an
unreleased bundle source and is not implied by the currently recorded bundle
release. The legacy extension npm
packages are deprecated migration artifacts. A release channel is not an
independent assessment: review, deployment
evidence and an accessibility assessment are still pending
([issue 58](https://github.com/jimhoyd-com/urlcode/issues/58)). Their status
files say exactly what is built: [auth](../packages/auth/IMPLEMENTATION-STATUS.md),
[admin](../packages/admin/IMPLEMENTATION-STATUS.md),
[ui](../packages/ui/IMPLEMENTATION-STATUS.md).
The current version of each package is its own manifest, and the peer ranges it
declares are in that manifest too; do not read a version number out of this
page. How versions, channels and release tags line up is recorded in
[package and channel alignment](VERSION-ALIGNMENT.md), and `npm run
release:status` reports the live registry and tag state.

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
   the project; YAML only declares the mount and configuration.
5. **Administration.** The `admin` extension on the same service: manage the
   people who signed up, their sessions and roles, review the audit trail.

6. **Your own look.** A shared `presentation` (catalogue and theme variables)
   restyles auth and admin together; the `ui` extension adds the template kit,
   project copy, template and stylesheet overrides for kit-rendered pages.
7. **Bounded data and forms.** The `store` extension supplies declared durable
   collections; the `forms` extension supplies declared browser form flows over
   the shared UI kit. Both are trusted operator extensions, not core YAML
   handlers. Add `auth: true` where a flow or collection is per-account.

Stored short links previously sat here as a native `link` route; that handler
was removed from core. A `urlcode-dynamic-link` package owned them the same way
`auth`/`admin` own their mounts, but it has been retired and unpublished. It has
no direct successor; a project that wants stored short links declares a
collection through the `store` extension above (see [docs/STORE.md](STORE.md))
rather than a native `link` route.

Rungs 1 to 3 need only the core package. Rungs 4 to 7 need a verified extension
bundle installed into an explicit operator host, once its source package appears
in a selected catalog. Auth and admin additionally need the Node/SQLite runtime
their packages document; forms declares Node, AWS and Vercel targets, while store
is currently Node-only. See each package's README ([auth](../packages/auth/README.md),
[admin](../packages/admin/README.md), [ui](../packages/ui/README.md),
[store](../packages/store/README.md), [forms](../packages/forms/README.md)) for the
exact requirement.

## The composition contract

An extended project starts from core and an immutable bundle release. By
default `init --with` uses `extension-bundles@v<core>` for the installed core
version; `--bundle-release extension-bundles@vX.Y.Z` pins a different verified
tag from [package and channel alignment](VERSION-ALIGNMENT.md):

```sh
npm install @jimhoyd/urlcode
npx urlcode init my-site --with ui,auth,admin
```

This produces a manifest with core only and a bundle lockfile for extensions.
`scripts/pack-sources.mjs` remains available to review reproducible source
inputs. Three files make an extended project. Nothing else is discovered by
convention.

```
site/
  urlcode.yaml           the project: routes, extensions, policies (Git-owned, untrusted content)
  functions/, public/    guest code and assets referenced from the YAML
operator/
  host.mjs               trusted operator code: default-exports { extensions, plugins?, close? }
  operator-service.mjs   opens the auth store, keys and senders; imported by host.mjs
  data/                  private: auth.sqlite, encryption key, CSRF key
```

The project declares logical extensions and exclusive mounts:

```yaml
version: "1"
extensions:
  ui:    { version: "1", config: { theme: { name: Acme, colors: { primary: "24 95% 53%" } } } }
  auth:  { version: "1", config: { registration: "off" } }
  admin: { version: "1", config: {} }
routes:
  /assets/ui/*: { extension: ui,    methods: [GET, HEAD] }
  /account/*:   { extension: auth,  methods: [GET, HEAD, POST] }
  /admin/*:     { extension: admin, methods: [GET, HEAD, POST] }
  /private:
    respond: { text: Signed in }
    auth: true
```

The operator host explicitly registers the packages. Registration is an
activation boundary; it does not isolate trusted application code from the host:

```js
import { createUiExtension } from '@jimhoyd/urlcode-ui/host';
import { authExtension, createPresentation, englishCatalogue } from '@jimhoyd/urlcode-auth';
import { adminExtension } from '@jimhoyd/urlcode-admin';
import { service, csrfKey, projectSha256 } from './operator-service.mjs';

const ui = createUiExtension({ projectSha256, projectRoot: '/absolute/site', sources: [englishCatalogue] });
const presentation = createPresentation({ theme: { '--ui-accent': '#0645ad' } });
export default {
  extensions: [
    ui.registration,
    authExtension({ service, csrfKey, projectSha256, presentation }),
    adminExtension({ service, csrfKey, projectSha256, authMount: '/account', presentation }),
  ],
  async close() { await service.close(); },
};
```

Auth and admin render every screen through `ui.kit`; their package-owned
templates and catalogues must be registered with that kit. Both refuse
activation when the UI extension is absent or has not activated first. See each
package README for the complete registration example; the scaffold generated by
`urlcode init --with ui,auth,admin` wires the same composition.

Treat that composition as one application with package ownership boundaries,
not as three separate user interfaces. Keep identity, session and recovery
behavior in auth and authorization, freshness, auditing and mutations in admin.
Apply product differences through the installed extensions' declared authoring
surfaces, in this order: configuration and theme, copy, a component or screen
template, stylesheet, then a supported hook. Create another extension only for
a reusable capability those surfaces cannot express. `urlcode extensions`
and the MCP `get_extensions` tool report those surfaces and their fast checks,
so people and agents can discover the supported path instead of replacing
package behavior.

A signed declarative artifact is a separate, optional authoring input, not a
fifth way to compose executable behavior. A project may lock an attested
schema/example bundle and expose it through MCP `get_extension_artifacts` and
`get_extension_artifact`; the verified executable bundle and explicit operator
host remain the executable extension path. See [signed declarative artifacts](EXTENSIONS.md#signed-declarative-artifacts).

```sh
urlcode serve --project /absolute/site --host-file /absolute/operator/host.mjs --origin https://site.example
```

`urlcode init <dir> --with ui,auth,admin` writes this layout in one step. It verifies and locks the
named GitHub Release bundles, calls each verified module's `scaffold` export,
and merges fragments into `app/urlcode.yaml`, one
explicit `host.mjs` and one `README.md`, refusing before writing a site when a
bundle is missing or two fragments collide (the contract is documented under
[scaffolding](EXTENSIONS.md#scaffolding-with-init---with)). `urlcode-auth init`
and `urlcode-admin init` write the same layout for a single package; `urlcode-auth bootstrap` creates the first
administrator from JSON on stdin. `inspectExtensionRevision(project)` prints
the SHA-256 that `projectSha256` must carry; changing extension YAML, policies
or mounts changes the revision and needs an explicit operator reapproval.

The presentation tooling composes the same way, by naming logical extensions
rather than npm dependencies. The UI bundle is the kit until the locked auth
and admin bundles add their namespaces, so `list`,
`doctor`, `eject`, `preview` and `copy --missing` cover the `auth/*` and
`admin/*` templates and copy the host registers, and a project override of an
extension template is checked against the shipped view model. `urlcode init
--with` writes the resolved release pin into the generated README.

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
| Restyle every page | [ui README](../packages/ui/README.md), [ui contract](../packages/ui/CONTRACT.md) |
| Write an extension | [extensions](EXTENSIONS.md) |
| Run it | [operations](OPERATIONS.md), [install](INSTALL.md), [deployment checks](DEPLOYMENT-CHECKS.md) |
