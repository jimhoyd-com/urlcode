# Operator-installed extensions

Extensions are trusted operator modules, separate from a project's own
`function`/`middleware` code. The first-party extensions (`ui`, `auth`,
`admin`, `store`, `forms`, `mcp`) are workspace packages in this repository
(`packages/<name>`); the runtime supplies only the generic integration contract
and never imports them. No project file can import a host extension or choose
a package: the operator's `host.mjs` does that (see
[Add-ons](#add-ons-extensions-and-artifacts)).

Stored short links are declared through the `store` extension's
`extensions.store.config.shortLinks`: a collection with a bounded unique key, a
required HTTP(S) destination field and one counter, served on a public
`GET`/`HEAD` redirect mount with no function. See
[short links in the data store](STORE.md).

The `store` extension is the data-owning counterpart: it serves declared,
bounded collections as a CRUD API from an operator-owned directory. See
[data store](STORE.md).

The `forms` extension is the browser-flow counterpart: it renders bounded
declared fields through the `ui` kit, validates URL-encoded submissions with
its host-supplied CSRF secret, and redirects a successful submission to a
fixed confirmation page. It is a trusted operator extension, needs `ui`, and
may be mounted with `auth: true`; its optional `onSubmit` hook is trusted
project code rather than a sandbox bridge. See the [forms package](../packages/forms/README.md).

The `mcp` extension declares an [MCP](https://modelcontextprotocol.io) tool
server: named tools with a description, a `request.body.schema`-shaped input
schema (validated with the exact same bounded validator, reused rather than
reimplemented) and a trusted project handler loaded the same way as other
extension hooks. The extension owns JSON-RPC 2.0 framing, protocol version
negotiation, exact request-id round-tripping and
`initialize`/`ping`/`tools/list`/`tools/call` dispatch and error codes, and
it refuses a foreign `Origin` (403) and an unsupported `MCP-Protocol-Version`
(400) before dispatch; project YAML never carries JSON-RPC mechanics. Clients
connect to the declared mount exactly (`/mcp`, not `/mcp/`). It may be
mounted with `auth: true`. See the [mcp package](../packages/mcp/README.md).

A project declares versioned configuration and exclusive route mounts:

```yaml
version: "1"
extensions:
  auth:
    version: "1"
    config: {}
routes:
  /auth/*:
    extension: auth
    methods: [GET, HEAD, POST]
  /private:
    respond: {text: Private}
    policies:
      extensions:
        auth: {signedIn: true}
```

## Protecting a route: the `auth` short form

When the project declares `extensions.auth`, a route may say `auth` instead of
spelling out `policies.extensions.auth`. This is the preferred way to protect a
route:

```yaml
routes:
  /account:
    respond: {text: Account}
    auth: {role: member}          # or `auth: true` for any signed-in principal
  /docs:
    respond: {text: Docs}
    auth: {required: false}       # documents intent; emits no requirement
```

The compiler expands the short form before anything else reads the project:
`auth: true` becomes `policies.extensions.auth: {}` and an object becomes the
same object minus `required`. The long form stays the canonical representation,
so `routes`, `audit` and `explain` show the expansion, the extension revision
hash covers it, and the installed auth extension validates the expanded
requirement with its own policy schema. The keys other than `required` are
exactly that schema's keys (`role`, `permission`, `verified`,
`freshWithinSeconds`, `onDeny`, `bearer`); the runtime adds nothing of its own.
Loading fails, naming the route, when `auth` appears without an
`extensions.auth` declaration, next to `policies.extensions.auth`, or next to
`policies.extensions: false`.

### Bearer/API-key routes

`bearer` protects a route with an operator-issued API key instead of a
signed-in session, and is exclusive of the session keys above (a route uses
one or the other, never both):

```yaml
routes:
  /api/items:
    respond: {text: '[]'}
    auth: {bearer: {scopes: [items.read]}}
```

The extension checks the `Authorization: Bearer <key>` header against a
credential store an operator manages outside route YAML (the same
`AuthService` object that owns sessions, via `service.issueApiKey`/
`listApiKeys`/`revokeApiKey`, or the `urlcode-auth api-key-issue`/
`api-key-list`/`api-key-revoke` CLI commands — see
[packages/auth/README.md](../packages/auth/README.md#bearerapi-key-authentication)).
A missing or malformed header is a 401 with no `WWW-Authenticate` error
parameter; an unknown, wrong, expired or revoked key is a 401 with
`error="invalid_token"`; a valid key missing a scope the route requires is a
403 with `error="insufficient_scope"`. On success, the verified key's
id/name/scopes (never the raw key) are written into the reserved
`x-urlcode-context-auth-principal` header, base64-encoded JSON, so the
route's own `function`/`middleware` can read who authenticated directly off
its `Request` object — see [handing data forward into a protected route's own
context](#handing-data-forward-into-a-protected-routes-own-context).

The same shape is used for the cache policy: a route-level `cache: {strategy,
maxAge, ...}` expands to `policies.cache` in the same pass (see
[policies](POLICIES.md)).

The configuration and requirement objects above are validated by the installed
extension's schemas. They are examples of extension-owned fields, not built-in
authentication behavior. See the executable generic fixture in
[examples/extensions](../examples/extensions). Included files can declare
extensions; duplicate names fail rather than silently override one another.

The operator passes `extensions: RuntimeExtension[]` to `createRuntime`,
`startServer`, or the AWS/Vercel adapter. Types and
`inspectExtensionRevision(project)` are exported from
`@jimhoyd/urlcode/extensions`. Inspection does not grant access: review the
project and place the exact returned SHA-256 in each registration's
`projectSha256`. YAML extension configuration, policies and routes participate
in the revision. Changing them requires an explicit operator reapproval.

Registrations provide a name, contract version, target list, JSON configuration
schema, optional policy schema, an optional declared `cacheSensitive` (below)
and activation factory. Activation receives the
canonical operator origin, target, revision and mount bases. Its instance handles
bounded requests and, when named in a route's policies, gates the request via
`authorize`, wraps the rest of the pipeline via `middleware`, or both (see
[Wrapping a route](#wrapping-a-route-extension-middleware) above). Missing
registrations, stale grants, invalid configuration and unsupported targets fail
activation. Multiple mounts cannot overlap other declared routes.

For extension-protected routes, agents/throttle run before authorization and
cache access happens only after authorization. This part is unconditional:
naming any extension in `policies.extensions` always runs its `authorize()`
(when it implements one) before the route's own handler, whatever this
section says next.

An `extension:` mount is always confidential: its route rejects cache
strategies other than no-store, and every response is forced to no-store
after host response hooks, with compression disabled. A `policies.extensions`
route (no mount, `authorize`/`middleware` only) gets the same treatment
**unless every extension it names explicitly declares
`cacheSensitive: false`** on its `RuntimeExtension` registration. That field
defaults to sensitive (unset or `true`): the safe default is unchanged, and
relaxing it is an explicit, reviewed operator opt-in an extension author
makes once, in host code, never inferred from a route or from a response the
extension happens to return. It exists for a generic, cache-transparent
extension whose `middleware()` is pure request/response wrapping with no
access-control semantics of its own (a logging or header-rewriting
extension, for example) — declared this way, its wrapped route keeps
whatever `Cache-Control` its own handler sets, exactly like the native
`middleware:` array already does, and compression is not disabled either. A
route naming more than one extension stays confidential if any one of them
is sensitive (or leaves the field unset); one `cacheSensitive: false`
extension cannot relax a route that also names a sensitive one. This can
only relax the no-store floor a generic extension would otherwise inherit —
it has no effect on `authorize()`, which runs the same way regardless, and
`auth`/`admin`-style extensions gating real access must leave it at the
default.

## Wrapping a route: extension middleware

`authorize` is a gate: it runs once, before the route's handler, and can only
either let the request through unchanged or answer instead of it. It cannot
see or change what the handler itself returns.

`middleware` is a wrap. An extension instance may implement it alongside or
instead of `authorize`, attached the same way, via
`policies.extensions.<name>` on a route (no `extension:` mount required); its
`config` is exactly the same per-route value `authorize`'s `requirement`
receives, validated once against the extension's `policySchema`:

```ts
middleware?(config: Readonly<Record<string, unknown>>, request: ExtensionRequest,
  next: () => Promise<HandlerResult>): HandlerResult | Promise<HandlerResult>;
```

`next()` invokes the rest of the pipeline for that route: any other extension
`middleware()` also declared on the route (see below), then the route's own
native `middleware:` chain and handler, dispatched through the sandboxed or
trusted engine exactly as it is today. Calling it lets the hook run code
before and after the rest of the pipeline, inspecting or mutating the
`HandlerResult` it resolves to — the same "add a header to whatever the
handler returns" shape as the native `middleware/headers.mjs` cookbook
recipe, but declared by an operator-installed extension instead of project
code. Skipping it short-circuits everything after that point, the same
capability `authorize` already has, just usable from either side of the
handler now. `next()` may be called at most once; calling it again throws.

A route naming more than one extension in `policies.extensions` chains every
one that implements `middleware`, in the order the keys are declared, each
one's `next()` reaching the next one and the innermost `next()` reaching the
native pipeline — the first declared name is outermost. This is purely
additive at the `policies.extensions` layer and never touches the native
`middleware:` array, its schema, or its dispatch, all of which are unchanged.

`authorize` and `middleware` compose on the same route, from the same or
different extensions, without special-casing: `authorize` always runs first
(unchanged), and any declared `middleware()` wraps everything after that
point, including the rest of the authorize-gated pipeline. A route naming an
extension via `policies.extensions` only requires that extension to
implement `authorize`, `middleware`, or both — never both unconditionally.

One exception exists for content-hashed assets. A registration may declare
`immutableAssets: {prefix: '/static'}`, a normalized literal path under each
of its mounts (no `.` or `..` segments, no trailing slash). The runtime then
answers `Cache-Control: public, max-age=31536000, immutable` instead of
no-store only when every condition holds: the request path lies under
`<mount><prefix>/`, the method is GET or HEAD, the status is 200 or 304, the
response carries exactly one strong ETag, sets no Set-Cookie, and does not
vary on Cookie, Authorization or `*`. A stricter Cache-Control the extension
set (no-store, no-cache, private or a shorter max-age) is preserved; other CDN
cache headers are still stripped and compression stays disabled. Anything
that fails a condition, including a cookie added by a later response hook,
stays no-store. The extension owns the content-hashed filename: a file under
the prefix must change its name when its bytes change, because clients never
revalidate it. The prefix belongs to the operator registration, not to the
pinned project revision. The runtime withholds Cookie and Authorization plus any declared
credential headers from all application guest requests and mapped parameters.
This does not isolate browser JavaScript running on the same origin: application
HTML/JS on an authentication origin must be trusted by that site's operator.

### Handing data forward into a protected route's own context

`authorize()` and `middleware()` gate a request; by default neither has a way
to hand data forward into the route's own trusted `function`/`middleware`
context. The reserved `x-urlcode-context-*` header namespace is that channel:
the runtime strips it from every inbound request's headers before any
extension or guest code observes them, so a client can never inject or spoof
a value there. A hook can then write into it on `request.headers` (the
per-request `ExtensionRequest.headers` clone) —
`request.headers.set('x-urlcode-context-auth-principal', ...)` — and the
value carries forward into the guest-facing headers a route's own
`function`/`middleware` receives on its `Request` object. It stops there: a
`proxy` route can never opt this namespace into `requestHeaders`/
`responseHeaders` and have it forwarded to an external upstream — `validateProxy`
refuses a reserved-namespace name the same way it already refuses a
credential-shaped one. This is generic core infrastructure
(`extensionContextHeaderPrefix`, `stripReservedContextHeaders`,
`@jimhoyd/urlcode/extensions`); core never reads or interprets a value
written there. It is not a credential channel:
the withheld headers above (`cookie`, `authorization`, any declared
credential header) are stripped from that guest-facing projection exactly as
before, and an extension must never write a raw session or bearer credential
into this namespace — only a derived, non-secret value. `packages/auth`'s
`bearer` requirement uses it to expose the verified API key's id, name and
scopes (base64-encoded JSON) to the route's own handler; see
[bearer/API-key routes](#bearerapi-key-routes).

### Request context: route env and request id

Every `ExtensionRequest` carries two more generic fields, whether it reaches an
extension's `handle()` on its own mount or its `authorize()`/`middleware()` on
a `policies.extensions` route:

- `requestId`: the id the response carries in `X-Request-Id` and the request
  log records. A route's own `function`/`middleware` receives the same value as
  `context.requestId`, trusted and `sandbox: true` alike, so extension events,
  hook events and function logs for one request correlate.
- `env`: the matched route's compiled `env` bindings, frozen, and empty when
  the route declares none. An `extension:` mount declares them with the same
  route `env:` block a function route uses, and they are resolved under the
  same revision-pinned operator grant, `permissions.routes["<mount>/*"].env`:

```yaml
routes:
  /mcp/*:
    extension: mcp
    methods: [POST, HEAD]
    env:
      SKILLS: {env: MCP_ENABLED_SKILLS}
      REGION: {env: AWS_REGION, default: us-east-1}
```

A reference with no grant and no `default` fails activation with the same
`binding-denied` error a function route gets, and `urlcode permissions` lists
it with every other requested binding. `secrets`, guest `middleware` and
`parameters` stay refused on an `extension:` route: an extension's own code
reads its credentials from the host, not from project YAML.

This is an injection convenience under the operator grant, not a restriction:
extensions and their hooks are trusted in-process code that can read
`process.env` directly. The grant governs only what URLCode hands them through
`ExtensionRequest.env` (see [granting selected bindings](FUNCTION-SECURITY.md#granting-selected-bindings)).
The request id and env reach project hooks through the hook context described
below.

Cloudflare refuses extensions until its artifact format supports their execution.
Node adapter conformance is not a live-provider deployment claim.

## Project-level lifecycle hooks

Extensions expose project customization points through the core hook primitive.
Each registration publishes `hooks`, a machine-readable list containing the
hook name, whether it is a value-transforming `filter` or side-effect `action`,
its description and its input/output JSON Schemas. The extension embeds
`extensionHooksSchema(contracts)` in its configuration schema and calls
`loadExtensionHooks(config.hooks, contracts, context)` during activation.
Core then enforces the common source/export shape, project-root confinement,
known names, eager module/export validation, input/output schemas and reload
cache busting. Every loaded hook is called as `hook(input, context)`: `input`
is the contract-validated value, and `context` is a frozen copy of the generic
`ExtensionHookContext`, `{requestId, env}`, which the extension builds from the
request with `extensionHookContext(request)`. A hook that does not run on
behalf of a request (the UI presentation filters) gets `requestId: null` and an
empty `env`. An extension may add its own fields; `mcp` adds `server`, `tool`
and `kind`. Hook entry bytes participate in the project revision, so editing
a hook invalidates the operator's extension pin.

Projects select those declared hooks in the extension's own configuration:

```yaml
extensions:
  auth:
    version: "1"
    config:
      hooks:
        beforeRegister:
          source: ./hooks/registration-rule.mjs
          export: default
        onSignUp:
          source: ./hooks/on-signup.mjs
```

with `beforeRegister` called before an account is created, given a typed
`{email, profile?}` input and returning a typed verdict (`{allow: true}`
or `{allow: false, reason}`), and `onSignUp` called after, for side effects
such as provisioning a workspace. Hook names and lifecycle timing remain the
extension's domain, while their declaration, loading and discovery are shared.

Hooks are first-party project code and run trusted in-process by default, with
full Node access, like trusted `function` and `middleware` routes. Contract v1
does not define an arbitrary-value sandbox hook protocol. A hook reference with
`sandbox: true` is rejected during activation rather than silently run trusted.
Only the entry module is refreshed during reactivation; its imported dependencies
remain in Node's module cache until restart.

The UI extension exposes `transformView`, a synchronous filter called before a
named kit template renders. It receives `{template, view}` and returns the view
model to render. Use copy, templates, theme and CSS for ordinary presentation
changes; use this hook for project-specific computed view data that those
declarative layers cannot express. It also exposes `transformPage`, called
before the shared layout renders. It receives the editable title, layout,
navigation, account menu and flash message and returns those page fields. This
lets a product join auth/admin screens to its own shell without replacing their
security or workflow behavior. Both filters are synchronous and trusted.

## Building an extension

Start a new extension package with
`npm run create-extension -- <name> [--from <existing-package>]`
(`scripts/create-extension.ts`). It scaffolds `packages/<name>` in the shape
every extension package follows: `package.json` (released with core at core's
version, exporting `.` and `./extension`), `README.md`/`SECURITY.md`/
`CHANGELOG.md`/`AGENTS.md`, a `RuntimeExtension` source module,
`src/extension.ts` (the `defineExtension` definition with `scaffold` and
`host`), a `urlcode.json` stub and a real integration test, all as placeholders
to replace. `--from <existing-package>` forks an existing package's file
*shape* (which optional docs it carries, which siblings it requires) as a
starting point -- never its source code. The tool only creates files; run
`npm install` and `npm run build:addons` afterwards so the workspace and its
`urlcode.json` exist.

An extension package default-exports a [definition](#the-extension-definition)
from `./extension`. The `RuntimeExtension` registration its `host()` returns:

1. Declares its logical name, contract version, supported targets, exact project
   revision pin and strict configuration/policy schemas.
2. Publishes every project hook through `hooks` and reuses
   `extensionHooksSchema` plus `loadExtensionHooks`; it does not implement its
   own path resolver or dynamic-import cache. If it admits an author-supplied
   regex (a field or route-like pattern in its own configuration), it reuses
   `assertSafePattern` and `maxPatternInputLength` from the same
   `@jimhoyd/urlcode/extensions` entry point rather than writing its own
   ReDoS admission check, so every pattern in a project is bound by the one
   reviewed cost model (`RIM-PATTERN-001` in
   [runtime implementation](RUNTIME-IMPLEMENTATION.md)).
3. Publishes an `authoring` contract listing its supported project-owned
   configuration, theme/copy, component/template, stylesheet and hook surfaces,
   plus focused `fastChecks`. Keep descriptions concrete enough that an agent
   can choose a supported surface instead of copying package behavior.
4. Activates all configuration, files, services and hooks before serving a
   request. Invalid or stale configuration fails activation.
5. Returns `handle` for mounts and optionally `authorize`/`middleware` for route
   policies. It closes resources it owns.
6. Keeps credentials, storage and provider setup in the operator host. Project
   YAML contains logical configuration and project-relative hook references.

Consumers add it with `urlcode extensions add <name>`, which declares its YAML
block and routes and registers it in `host.mjs`. They modify it through declared configuration,
presentation layers and hooks. A fork is reserved for changing behavior the
extension has not exposed; that is evidence for a new declarative field or hook.
See [Composing a site](COMPOSING-A-SITE.md) for the complete ui/auth/admin example.

## Discovering schemas

Each registration carries the JSON Schemas that validate its `config` block and
its per-route policy requirements, plus its hook and authoring contracts. `urlcode extensions` prints them together with
the project's own declarations so an author can see what a mount accepts:

```sh
urlcode extensions --project app --host-file host.mjs [--json]
```

For every registration in the host file it reports the name, contract version,
targets, credential headers, configuration schema, policy schema (if any),
declared hook names, kinds, descriptions and input/output schemas, supported
authoring surfaces and their fast checks,
whether the project declares it, whether its `projectSha256` matches the current
revision, the routes that mount it and the routes whose policies require it.
Declared names the host does not register are listed as unregistered. The command
executes the trusted host module exactly as `validate` does, including its
outside-project rule, and calls `close` afterwards; it never
activates an extension and grants nothing. Without `--host-file` it lists only
the names the project declares and notes that schemas need the host file; the
installed packages' `urlcode.json` descriptors carry the same schemas without
running any code.

The same report is available as `inspectExtensions({project, hostFile?})` from
the package root and, for assistants, as the MCP tool `get_extensions`, which the
server advertises only when the operator started `urlcode mcp` with
`--host-file`. No tool argument can name a host file. See [TOOLING.md](TOOLING.md).

## CLI host binding

Use an explicitly named operator ES module outside the application directory.
In a site this is `host.mjs` beside `app/`:

```sh
urlcode serve --project app --origin https://site.example --host-file host.mjs
```

The module default-exports `{extensions, plugins?, close?}`; a site's
`host.mjs` builds that object with `composeHost` from
`@jimhoyd/urlcode/host`. It may import installed operator packages, open their
stores and read operator secrets. `close` releases shared services when the CLI
command finishes or the server shuts down. A runtime reload closes extension
instances but does not close caller-owned services. Host modules are not
watched or automatically rediscovered. Restart to update them.

The same explicit option is supported by dev, validate, test, routes, audit,
benchmark, extensions and mcp. These commands execute trusted host activation and may access its
store; read-only project inspection commands never implicitly load a host file.
A host-file path is resolved against the working directory and must be a
`.mjs`/`.js` file whose real path lies outside the project, including after
symlink resolution. This is an operator-code trust boundary, not a JavaScript
sandbox or an independent security review.

## Add-ons: extensions and artifacts

URLCode ships two kinds of add-on with one shape:

| | Extension | Artifact |
| --- | --- | --- |
| Purpose | Executable operator code: routes, mounts, route policies, hooks | Inert JSON data for tooling: schemas, example configuration |
| Source | `packages/<name>` | `artifacts/<name>` |
| Package | `@jimhoyd/urlcode-<name>` | `@jimhoyd/urlcode-<name>` |
| Descriptor | `urlcode.json`, generated from the extension's code | `urlcode.json`, written by hand |
| Wired into `host.mjs` | Yes, one import and one list entry | Never; nothing imports it |
| Commands | `urlcode extensions …` | `urlcode artifacts …` |

Every add-on is an npm-packable workspace carrying a static `urlcode.json`
descriptor: `{kind, name, description, requires, schema?, policySchema?,
hooks?, authoring?}`. For an extension the descriptor is written from its
`defineExtension` definition by `npm run build:addons`, and CI fails when the
committed file differs, so tooling can read an extension's schemas and
contracts without running any of its code. An artifact descriptor carries only
`kind`, `name`, `description` and `requires`.

Add-ons are versioned in lockstep with core. Only core is published to npm;
each add-on is released as a tarball on the same GitHub Release as core. The
release build writes `addons.json` into core's own `dist/`: for every add-on its
name, kind, `requires`, download URL and sha512 integrity. That file is the
only catalog. Trust in core's npm provenance therefore extends to every add-on
it installs, and there is nothing else to verify, cache or lock: the site's
ordinary `package-lock.json` records each tarball, and the add-on commands
check it against core's pin.

The first-party add-ons are:

- Extensions: `ui`, `auth` (requires `ui`), `admin` (requires `auth` and `ui`),
  `forms` (requires `ui`), `store`, `mcp`.
- Artifacts: `store-schema`, the `store` extension's configuration schema and an
  example configuration. Its schema is generated from the store extension's
  definition by `npm run build:addons`, so the two cannot drift.

`urlcode extensions available` and `urlcode artifacts available` list what the
running core pins.

### The site layout

`urlcode init <directory>` always writes one layout:

```text
<directory>/
  app/                  route project: urlcode.yaml, routes/, functions, tests/
  host.mjs              trusted operator host (outside app/)
  package.json          exact core pin, add-on tarball URLs, npm scripts
  package-lock.json     after npm install
  AGENTS.md  .mcp.json  Makefile  .github/workflows/urlcode.yml
  data/                 operator data, secrets and keys (gitignored)
```

`host.mjs` starts with an empty list; each `extensions add` adds one import and
one entry:

```js
import { composeHost } from '@jimhoyd/urlcode/host';
import ui from '@jimhoyd/urlcode-ui/extension';
import auth from '@jimhoyd/urlcode-auth/extension';

export default await composeHost(import.meta.url, [
  ui(),
  auth(),
]);
```

Operator options go inside the call, for example `auth({sendEmailCode})`. The
generated npm scripts run from the site directory (`urlcode dev --project app
--host-file host.mjs`, and the same for `serve`, `validate`, `test`, `routes`
and `audit`). Run from a site root, CLI commands default `--project` to `app`,
and `--host-file` may be relative to the working directory.

### Commands

The same verbs serve both kinds; every command takes `--site <directory>`
(default: the working directory) and `--json`.

| Command | What it does |
| --- | --- |
| `urlcode extensions available` / `urlcode artifacts available` | Lists the add-ons of that kind the running core pins, with their requirements |
| `urlcode extensions add <name>…` / `urlcode artifacts add <name>…` | Adds each named add-on and everything it requires |
| `urlcode extensions remove <name>` / `urlcode artifacts remove <name>` | Removes one add-on |
| `urlcode extensions list [--strict]` / `urlcode artifacts list [--strict]` | Reports what is installed and whether it matches core's pins |

`add` resolves transitive `requires` from core's `addons.json` and adds each
add-on exactly once, at the top level of the site, with `npm install
--ignore-scripts`. It then checks every new `package-lock.json` entry's
integrity and URL against core's pin and refuses a nested copy. An artifact is
checked to be inert (see [Artifacts](#artifacts)); adding only artifacts to a
site that already has a `package-lock.json` also refuses if npm added any lock
entry other than the artifacts themselves. For an extension, `add` then calls
the extension's
`scaffold` and writes what it returns:

- its `config` as the `extensions.<name>` block of `app/urlcode.yaml`;
- its routes as `app/routes/<name>.yaml`, added to `includes` (a route the
  project already has refuses);
- its operator files, relative to the site and always outside `app/` (an
  existing file is kept, never overwritten);
- one import and one list line in `host.mjs`.

It prints the environment variables the host reads, next steps, and the new
project revision to review and set as `PROJECT_SHA256` where the host runs.
Any failure or refusal, by `add` or `remove`, rolls every change back:
`package.json`, the lock, `app/urlcode.yaml`, `host.mjs`, the files it
created, and `node_modules`. npm has already run by the time most checks
refuse, so a site that had a lock is reinstalled from the restored lock with
`npm ci --ignore-scripts`; a site without a lock loses every `node_modules`
entry the command created. If that reinstall itself fails, the command says so
and asks you to run `npm ci --ignore-scripts` before continuing. The refused
package was downloaded and extracted but never run: every npm call passes
`--ignore-scripts`.

Some scaffolds refuse until the operator acknowledges a named risk; for example
`store` without `auth` would expose public write on its collection. The refusal
states the risk and prints the exact re-run command with the qualified
acknowledgement, such as `--ack store:public-write`. Pass an acknowledgement
only when a refusal names it: an `--ack` that no scaffold consumes also refuses.

`remove` refuses while another installed add-on requires the one being removed,
or while the project still uses the extension outside its own
`routes/<name>.yaml` (a mount, a route policy, a project-level policy or a
profile). It removes the `extensions.<name>` block, the routes file and its
include, the `host.mjs` lines and the dependency. It never deletes `data/` or
the operator files the scaffold wrote; it lists them so you can delete them
yourself.

`list --strict` exits non-zero on a pin mismatch, a nested copy of any
`@jimhoyd/urlcode*` package, drift between `package.json`, `app/urlcode.yaml`
and `host.mjs` (an extension installed but not declared or not hosted, or
declared without an installed package), a missing requirement, or an artifact
that is not inert.

`urlcode init <directory> --with ui,auth [--ack extension:id]` is `init`
followed by `extensions add` for those names; a refusal undoes the whole init.

`urlcode upgrade` moves core and every installed add-on to one version
together: the latest stable release (npm's `latest` dist-tag, which only a
stable release moves) unless `--to X.Y.Z` names another, including a prerelease
or an older release. It installs core first, then points every add-on at the
pins in that core's own `addons.json` (refusing, before anything stays changed,
if the target does not release an installed add-on), checks the lock against
them, validates the project with the new runtime, and moves the site's workflow
to the same action release. Any failure restores `package.json`,
`package-lock.json` and the workflows and reinstalls. `urlcode upgrade --check`
reports the current and target versions and changes nothing. Configuration is
not migrated: if an extension's schema changed, validation names the field.

Add-on command-line tools are ordinary npm bins once installed in the site, for
example `npx urlcode-auth bootstrap --operator-file "$PWD/operator-service.mjs"`
or `npx urlcode-ui doctor --project app`.

### Nesting

`admin` requires `auth` and `ui`; `auth` and `forms` require `ui`. A sibling
add-on is an optional exact peer dependency, never a nested dependency, so
every add-on is installed once at the top level of the site. `composeHost`
orders the listed extensions by `requires` and activates each once. A dependant
receives the shared services of what it requires through `ctx.get('<name>')`,
and passes templates and copy catalogues to `ui` through `contributes.ui`,
which `ui` collects with `ctx.contributions('ui')`. Two copies of one extension
cannot exist in a site, so duplicate-instance bugs (such as a second `ui` kit
that never received another extension's templates) cannot happen.

### The extension definition

Each extension package's `./extension` entry default-exports one definition:

```ts
import { defineExtension } from '@jimhoyd/urlcode/extensions';

export default defineExtension<MyHostOptions>({
  name: 'store',
  description: 'One line shown by `urlcode extensions available`',
  requires: [],               // other extension names
  schema,                     // JSON Schema of extensions.<name>.config
  policySchema,               // optional: per-route policies.extensions.<name>
  hooks, authoring,           // optional project customization contracts
  contributes: {},            // optional static values for another extension, e.g. {ui: {...}}
  scaffold(request) { return { config, routes, files, env, notes }; },
  host(ctx, options) { return { registration, exports, close }; },
});
```

The static fields (`name` to `authoring`) are what `npm run build:addons` writes
into `urlcode.json`.

`scaffold({site, project, installed, acknowledgements})` writes nothing. It
returns `{config, routes, files?, env?, acknowledged?, routeNotes?, notes?}`,
and core writes it as described above. `installed` lists every extension in the
site after this add; `acknowledgements` holds the sorted `--ack` values. To
require an acknowledgement, a scaffold throws an `Error` carrying
`acknowledgement: '<name>:<id>'` whose message states the risk, and lists each
one it used in `acknowledged`. `routeNotes` are single-line comments written
above its routes. A scaffold may generate key material as `Uint8Array` file
contents; core zeroes it after writing or on failure.

`host(ctx, options)` builds the runtime registration from the operator's
`host.mjs`. `ctx` is `{projectSha256, site, get, contributions}`: the reviewed
revision pin, the site directory, the exports of a required extension and the
values other extensions contribute to this one. It returns `{registration,
exports?, close?}`; `registration` is the `RuntimeExtension` described above,
and `close` runs in reverse activation order. `composeHost` reads
`PROJECT_SHA256` once and refuses a host whose registration pins a different
revision or registers a schema that differs from the definition.

The types are exported from `@jimhoyd/urlcode/extensions`
(`packages/core/src/extensions.ts` is the authoritative definition) and
`composeHost` from `@jimhoyd/urlcode/host`. The runtime contract, the
host-file trust boundary and the `PROJECT_SHA256` pin are the same whether an
extension came from `extensions add` or was wired by hand; YAML never chooses
code.

### Artifacts

An artifact package may hold only `package.json`, `urlcode.json`, `README.md`,
`LICENSE`, `NOTICE`, `SECURITY.md`, `schemas/*.json` and `config/*.json`. Its
`package.json` may declare only `name`, `version`, `description`, `keywords`,
`homepage`, `bugs`, `license`, `author`, `contributors`, `repository`,
`private` and `files`: any other key, including `main`, `exports`, `bin`,
`scripts`, `dependencies` and `peerDependencies`, is refused, and so is a
`package-lock.json` entry for the artifact that declares dependencies, peers
or a binary. Anything else is refused when the artifact is installed and
whenever it is listed. Artifacts are never imported by `serve`, `validate`, `init` or the
runtime, and installing `store-schema` does not install or activate `store`.

Agent tooling reads installed artifacts from the site's `node_modules` without
gaining write or execution authority. MCP `get_extension_artifacts` lists each
installed artifact, whether it matches core's pin, and its files;
`get_extension_artifact {name, path}` returns one bounded JSON or Markdown file
from an installed, pinned artifact. Feature planning (`urlcode plan-feature`,
MCP `plan_feature`) also sees them. The CLI equivalent is `urlcode artifacts
list --json`.

### Validation and CI

`urlcode validate` without `--host-file`, on a project that declares
extensions, checks each `extensions.<name>.config` and each route's
`policies.extensions.<name>` statically against the installed packages'
`urlcode.json` schemas. No extension code runs. Pass `--host-file host.mjs` to
activate the extensions and validate the whole runtime.

The [GitHub Action](CI.md#github-action) installs the site with `npm ci
--ignore-scripts` (a committed `package-lock.json` is required), runs `urlcode
extensions list --strict` and `urlcode artifacts list --strict`, then validates
the project. Without a `host-file` input it validates declared extensions
statically and skips `test` and `audit` when the project declares extensions;
with one it computes `PROJECT_SHA256` for that CI run only.
