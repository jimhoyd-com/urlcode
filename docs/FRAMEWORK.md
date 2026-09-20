# The URLCode framework

One page for people and AI agents. It says what the four packages are, how a
project grows from a handful of redirects into an application with accounts
and an administration console, and which facts an agent must not guess. Every
claim here is implemented in the linked repository; nothing is roadmap.

## Four packages, one project shape

| Package | Repository | What it adds | How a project declares it |
|---|---|---|---|
| `@jimhoyd/urlcode` | [urlcode](https://github.com/jimhoyd-com/urlcode) | The runtime: YAML routes, functions and middleware (trusted by default, `sandbox: true` opt-in), pages and assets, policies, site conventions, CLI, provider adapters, the extension contract | `urlcode.yaml` with `version: "1"` |
| `@jimhoyd/urlcode-ui` | [urlcode-ui](https://github.com/jimhoyd-com/urlcode-ui) | Shared presentation: escaped templates, shadcn/ui partials, one stylesheet with light and dark, themes, translations, the `ui` extension that serves the kit's assets | `extensions.ui` plus an asset mount route |
| `@jimhoyd/urlcode-auth` | [urlcode-auth](https://github.com/jimhoyd-com/urlcode-auth) | Accounts: password, passkeys, OpenID Connect, email codes, TOTP, recovery, sessions, roles, registration modes, account page, operator CLI | `extensions.auth` plus an `/account/*` mount and `policies.extensions.auth` on protected routes |
| `@jimhoyd/urlcode-admin` | [urlcode-admin](https://github.com/jimhoyd-com/urlcode-admin) | Administration: users, sessions, roles, audit, registration approval, two-person cases, support impersonation, health | `extensions.admin` plus an `/admin/*` mount |

The core is Apache-2.0 and released. The three extension packages are
Apache-2.0 and published to npm as alphas (`@jimhoyd/urlcode-ui@0.1.0-alpha.4`,
`@jimhoyd/urlcode-auth@0.1.0-alpha.2`, `@jimhoyd/urlcode-admin@0.1.0-alpha.2`,
on core `0.4.0-alpha.1`). An alpha on npm is a distribution channel, not an
endorsement: the source is complete, but independent review, deployment
evidence and an accessibility assessment are still pending
([issue 58](https://github.com/jimhoyd-com/urlcode/issues/58)). Their status
files say exactly what is built: [auth](https://github.com/jimhoyd-com/urlcode-auth/blob/main/IMPLEMENTATION-STATUS.md),
[admin](https://github.com/jimhoyd-com/urlcode-admin/blob/main/IMPLEMENTATION-STATUS.md),
[ui](https://github.com/jimhoyd-com/urlcode-ui/blob/main/IMPLEMENTATION-STATUS.md).
Which core version each package supports, how it declares that, and the order
in which a core change reaches the downstream repositories are recorded in
[core version alignment](VERSION-ALIGNMENT.md).

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

Stored short links previously sat here as a native `link` route; that handler
was removed from core. A `urlcode-dynamic-link` package owned them the same way
`auth`/`admin` own their mounts, but it has been retired and unpublished; no
package occupies this rung today.

Rungs 1 to 3 need only the core package. Rungs 4 to 6 need the extension
packages, installed from npm as `0.1.0-alpha.x` prereleases, and a Node host
with a patched SQLite build; see each repository's README for the exact
requirement.

## The composition contract

An extended project starts with the packages and one command:

```sh
npm install @jimhoyd/urlcode @jimhoyd/urlcode-ui @jimhoyd/urlcode-auth @jimhoyd/urlcode-admin
urlcode init my-site --with auth,admin
```

Installing from npm is the normal path; `scripts/pack-sources.mjs` still builds
local tarballs from a reviewed checkout for operators who install only source
they have read — one revision now covers core and every extension. Three files make an extended
project. Nothing else is discovered by convention.

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
    policies:
      extensions:
        auth: {}
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

Auth and admin already render their screens through `ui.kit` when the host
supplies the UI extension; their package-owned templates and catalogues must be
registered with that kit. Without it, both retain shared primitive rendering
through `presentation`. The example above uses that primitive fallback. The UI
block is optional, and a migration to the kit is not unfinished framework work.
See each package README for its complete kit registration example.

```sh
urlcode serve --project /absolute/site --host-file /absolute/operator/host.mjs --origin https://site.example
```

`urlcode init <dir> --with auth,admin` writes this layout in one step: it
resolves each installed `@jimhoyd/urlcode-<name>` from the current directory,
calls its `scaffold` export and merges the fragments into `app/urlcode.yaml`,
one `host.mjs` and one `README.md`, refusing before writing anything when a
package is missing or two fragments collide (the contract is documented under
[scaffolding](EXTENSIONS.md#scaffolding-with-init---with)). `urlcode-auth init`
and `urlcode-admin init` write the same layout for a single package; `urlcode-auth bootstrap` creates the first
administrator from JSON on stdin. `inspectExtensionRevision(project)` prints
the SHA-256 that `projectSha256` must carry; changing extension YAML, policies
or mounts changes the revision and needs an explicit operator reapproval.

## Rules an agent must follow

These are the facts that keep generated projects valid. The full matrix is in
[AI authoring](AI-AUTHORING.md); this is the short list.

- **Extension YAML names logical extensions, not host packages or credentials.**
  Function and middleware `source` fields do name project modules. Extensions are
  logical names; the host file chooses the implementation. There is no
  `--extension` flag, no `import` in YAML, no interpolation.
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
| Add accounts | [auth README](https://github.com/jimhoyd-com/urlcode-auth#readme), [auth security](https://github.com/jimhoyd-com/urlcode-auth/blob/main/SECURITY.md) |
| Add administration | [admin README](https://github.com/jimhoyd-com/urlcode-admin#readme) |
| Restyle every page | [ui README](https://github.com/jimhoyd-com/urlcode-ui#readme), [ui contract](https://github.com/jimhoyd-com/urlcode-ui/blob/main/CONTRACT.md) |
| Write an extension | [extensions](EXTENSIONS.md), [extension model review](archive/2026-09-19/SPIKE-EXTENSION-MODEL.md) |
| Run it | [operations](OPERATIONS.md), [install](INSTALL.md), [deployment checks](DEPLOYMENT-CHECKS.md) |
