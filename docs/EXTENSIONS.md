# Operator-installed extensions

Extensions are trusted operator modules, separate from a project's own
`function`/`middleware` code. The first-party extensions (`ui`, `audit`,
`abuse`, `mail`, `auth`, `admin`, `store`, `forms`, `form-records`, `mcp`) are workspace packages in this repository
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

Three extensions serve no route and exist for other extensions to use through
their typed exports:

- `audit` is the durable audit log. A producer (auth, and every store
  collection with `audit: true`) writes each event into its own outbox in the
  same transaction as the change it records, and audit drains the outboxes
  into one bounded SQLite log ([audit log](#audit-log)).
- `abuse` holds keyed budgets, password-style backoff, an optional challenge
  provider and a honeypot helper over pseudonymous keys
  ([abuse protection](#abuse-protection)).
- `mail` sends plain-text transactional email from templates other
  extensions contribute, through one transport the operator chooses in
  `host.mjs` ([mail package](../packages/mail/README.md)).

The `forms` extension is the browser-flow counterpart: it renders bounded
declared fields through the `ui` kit, validates URL-encoded submissions with
its host-supplied CSRF secret, and redirects a successful submission to a
confirmation page that shows only the submitted fields the flow opts in to. It is a trusted operator extension, needs `ui`, and
may be mounted with `auth: {csrf: origin}`, never `auth: true`: it verifies its own token, and auth's default
token mode would refuse every form POST with 403 because a plain HTML form sends no `x-csrf-token` header. A flow may declare a
submission budget (`abuse`, when the abuse extension is installed) and a notification (`notify`, through mail). Its optional `onSubmit` hook is trusted
project code rather than a sandbox bridge. See the [forms package](../packages/forms/README.md).

The `form-records` extension composes the two: it requires `forms` and
`store`, and saves a declared form into an `ownership: owner` collection, with a
confirmation page that reads the saved record back and an edit page limited to
declared fields. It reaches both only through their typed exports
(`FormsExports` and `StoreExports`, read with `ctx.get`), never through their
configuration, and refuses a shared collection or a mount without a
principal-providing policy. See the [form-records package](../packages/form-records/README.md).

The `mcp` extension declares an [MCP](https://modelcontextprotocol.io) tool
server: named tools with a description, a `request.body.schema`-shaped input
schema (validated with the exact same bounded validator, reused rather than
reimplemented) and a trusted project handler loaded the same way as other
extension hooks. The extension owns JSON-RPC 2.0 framing, protocol version
negotiation, exact request-id round-tripping and
`initialize`/`ping`/`tools/list`/`tools/call` dispatch and error codes, and
it refuses a foreign `Origin` (403; see [site origins](#site-origins-and-same-origin-checks)) and an unsupported `MCP-Protocol-Version`
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
so `routes`, `audit` and `explain` show the expansion and the extension revision
hash covers it.

Core owns only that mapping and `required`. Every other key belongs to the auth
extension: the core schema accepts `true` or any object here, and the installed
extension's own `policySchema` decides which keys and values are valid (today
`role`, `permission`, `verified`, `freshWithinSeconds`, `onDeny`, `csrf` and
`bearer`; `urlcode extensions --json` prints the authoritative shape). A new auth policy
key therefore ships with the auth package, not with core. Loading fails, naming
the route, when `auth` is neither `true` nor an object, when `required` is not a
boolean, when `auth` appears without an `extensions.auth` declaration, next to
`policies.extensions.auth`, or next to `policies.extensions: false`.

The auth policy schema is applied at validate time as well as at startup:
`urlcode validate` checks it against the installed package's `urlcode.json`
(or the host file's registration with `--host-file`), `validateProject` against
the registrations passed as `extensions`, else the installed descriptor, and
`createRuntime` against the registration it activates. A failure is located at
the `auth` key the author wrote, not at the `policies.extensions.auth` it
expands to:

```text
Invalid extension policy at route /api/items, auth.bearer.quota.requests (minimum): must be >= 1
Invalid extension policy at route /a, auth (additionalProperties): unknown key "roles"; did you mean "role"? (run urlcode extensions --json for its policy schema)
```

The error details carry the matching pointer
(`/routes/~1api~1items/auth/bearer/quota/requests`). Keys written beside
`required: false` emit no requirement but are still checked, so a typo there
does not wait until the route is switched back on.

### CSRF on protected routes: `csrf: token | origin`

On a session-protected route auth verifies CSRF for every write (any method
other than `GET` and `HEAD`). The default, `csrf: token`, asks for auth's
session-bound token: the `x-csrf-token` header, or a `csrf` body field when
the header is absent, so a plain HTML form auth renders can post it.
`auth.csrf.token(request)` in `AuthExports` gives another extension the value to
embed.

`csrf: origin` drops the token and admits a write on same-origin provenance
alone: core's [same-origin rule](#site-origins-and-same-origin-checks) with
`whenAbsent: 'refuse'` (a repeated `Origin`, `Sec-Fetch-Site` or `Referer`,
or `Sec-Fetch-Site: cross-site`, refuses; then a site `Origin`; with no
`Origin`, `Sec-Fetch-Site: same-origin` or `none`; with neither, a `Referer`
whose origin is a site origin; no provenance at all refuses) plus the
`SameSite=Strict` `__Host-` session cookie.
Use it only on a mount that verifies its own token (forms, form-records) or
that accepts JSON only (a store collection):

```yaml
routes:
  /api/todos/*:
    extension: store
    methods: [GET, HEAD, POST, PUT, PATCH, DELETE]
    auth: {csrf: origin}
  /todo-form/*:
    extension: form-records
    methods: [GET, HEAD, POST]
    auth: {csrf: origin}
```

`csrf` is a session key: it cannot sit beside `bearer`.

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
context](#handing-data-forward-into-a-protected-routes-own-context). Auth also
sets the core [request principal](#request-principal), which is what an owned
store collection scopes records by: `apikey:<key id>` for a service key, the
user's id for a key the operator issued with `userId` (it acts for that user,
so records survive rotating the key, but only within its own scopes; locking
or deleting the user disables it), and the signed-in user's id for a
session-protected route. See
[keys that act for a user](../packages/auth/README.md#keys-that-act-for-a-user).

`bearer.quota: {requests, window}` adds a budget per credential: `requests`
per `window` seconds for each key, counted by key id in the auth store once
the key has authenticated and covers the route's scopes. The request that
would exceed it is a 429 with `Retry-After` and
`RateLimit-Policy`/`RateLimit` fields under the policy name `credential`,
before the handler runs. A key issued with its own `quota` is counted against
that budget instead of the route's, on every bearer route. An allowed response
reports the counted budget in the same `credential` fields, added by the
extension's `middleware()` hook; like every response of an auth-protected
route it is `Cache-Control: no-store`. On a route that also declares core
throttle, both the allowed response and the 429 carry the `credential` and
throttle's `default` policy in the same fields. Counting is a fixed window, durable across restarts
and shared by processes on one host (not across hosts); a store failure is a
503, never an uncounted pass. Core [throttle](policies/throttle.md), which runs
before auth and partitions by client, remains the guard against
unauthenticated floods — declare both. Details in
[packages/auth/README.md](../packages/auth/README.md#per-credential-quota).

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
canonical operator origin, the operator's full list of
[site origins](#site-origins-and-same-origin-checks), target, revision and mount
bases. Its instance handles
bounded requests and, when named in a route's policies, gates the request via
`authorize`, wraps the rest of the pipeline via `middleware`, or both (see
[Wrapping a route](#wrapping-a-route-extension-middleware) above). Missing
registrations, stale grants, invalid configuration and unsupported targets fail
activation. Multiple mounts cannot overlap other declared routes.

An invalid `config` block fails with the first violation of the registration's
schema, located by JSON pointer and named by the failed check, the same form
as a core schema error:

```text
Invalid extension configuration at /extensions/mcp/config/servers/docs/tools/search/annotations (additionalProperties): unknown key "cachedHint"; allowed keys: readOnlyHint, destructiveHint, idempotentHint, openWorldHint (run urlcode extensions --json for its configuration schema)
```

The message names keys and schema-declared bounds, never the rejected value,
because configuration can hold secrets.

A route policy that fails the registration's `policySchema` is reported the
same way, located at the route's `policies.extensions.<name>` (or at its `auth`
key when it was written with the [`auth` short form](#protecting-a-route-the-auth-short-form)):

```text
Invalid extension policy at route /private, policies.extensions.auth.role (type): must be string (run urlcode extensions --json for its policy schema)
```

The policy checked is the route's effective one: project and profile
`policies.extensions` layers merged with the route's own, and the `auth:` short
form expanded. The failing key may therefore be written in one of those layers
rather than on the route. A route that names an extension declaring no
`policySchema` fails with `extension "<name>" declares no route policy`.

When a value can take more than one shape (a `oneOf`, such as a `true` or
object value), core and extension errors report the deepest failure in the
shape that was tried, not the first alternative. So `auth: {freshWithinSeconds: 0}`
names `auth.freshWithinSeconds (minimum)`, reported by the auth extension's
policy schema, rather than saying `auth` must be `true`.

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

The refusal names the reason, so the declaration to change is obvious: a
cached `policies.extensions` route fails with, for example, `/api/items:
routes protected by extension "auth" cannot be cached; use cache: {strategy:
no-store} or remove cache`, and a cached mount with `routes served by
extension "<name>"`. A permissive `Cache-Control`-family header in
`response.headers` on such a route is refused the same way. Only `match` and
`conditional` routes report `conditional routing requires cache disabled or
no-store`.

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

### Request principal

Other extensions on a route sometimes need to know *who* the request is for,
not just that it was allowed: an [owned store collection](STORE.md#per-record-ownership)
scopes every record to its owner. Core carries that as an opaque **principal**
on the request (`RIM-EXT-PRINCIPAL-001` in
[runtime implementation](RUNTIME-IMPLEMENTATION.md)). Core is unaware of auth:
it only transports a bounded id that an operator-installed extension vouched
for.

- **Who may set it.** Only an extension whose registration declares
  `providesPrincipal: true`, only from its own `authorize()` on a route whose
  `policies.extensions` (or `auth:` short form) names it, and only through
  `request.setPrincipal({id})` while core is awaiting that `authorize()` call.
  It is committed only when that `authorize()` allows the request (returns
  `undefined`); a denial or a throw discards it. `setPrincipal` throws when
  called by an extension that does not declare `providesPrincipal`, from
  `middleware()` or `handle()`, after `authorize()` returned, or twice in one
  call. A registration that declares `providesPrincipal` and guards a route
  without an `authorize()` hook refuses activation.
- **One per request.** When one extension has set a principal, a second
  extension on the same route that tries to set one is refused: the request
  fails with a server error rather than letting either identity win silently.
- **What it is.** `{id}` only: a stable, opaque id of 1 to 128 characters,
  ASCII letters and digits first, then also `.`, `_`, `:` and `-` (`principalIdPattern`).
  Anything else (another key, an email address, a non-plain object) is
  refused. Core freezes it and stamps `provider`, the setting extension's
  name, so readers see `request.principal` as `{id, provider}` (read-only), or
  `null` when none was set. Use a stable account or credential id, never an
  email address, a name, a session token or any secret.
- **Where it comes from.** Never from the client: core never reads it from a
  header, cookie, query value, body or YAML, and the `x-urlcode-context-*`
  channel above is unrelated to it. A later `authorize()`, every `middleware()`
  and the mount's own `handle()` on the same route read `request.principal`.
  It does not reach a route's own `function`/`middleware` guest code.
- **Knowing at startup.** The activation context carries `principalMounts`:
  the subset of `mounts` whose route names a principal-providing extension in
  its policies. An extension that needs a principal refuses to activate a mount
  missing from it (fail closed), and still refuses a request whose principal is
  `null`, because a provider may allow a request without setting one.

`auth` is the first-party provider (the signed-in user's id for a session or
for a bearer key issued to act for a user, `apikey:<key id>` for any other
bearer key) and `store` the first consumer. An extension that needs more than
the id (roles, permissions, freshness, the verified email) asks auth itself:
`ctx.get<AuthExports>('auth').account(request)` returns the signed-in
account, with `has(permission)`, or `null`; admin reads it this way. The core
fixture `test/extension-principal.test.ts` proves the seam with a synthetic,
non-auth provider. Extensions are trusted in-process code, so this contract
fails closed on mistakes and misconfiguration; it is not a sandbox between
extensions.

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
        onAccountCreated:
          source: ./hooks/on-account-created.mjs
```

with `beforeRegister` called before any path creates an account, given a
typed `{email, method, profile?}` input and returning a typed verdict
(`{allow: true}` or `{allow: false, reason}`), and `onAccountCreated` called
after, for side effects such as provisioning a workspace. Auth's full set
(`beforeRegister`, `beforeRoleChange`, `onAccountCreated`,
`onAccountStatusChanged`, `onDeletionScheduled`, `onAccountDeleted`) is fired
by the auth service for every caller, including the administration console
and the operator CLI; see [composing a site](COMPOSING-A-SITE.md#project-functions-lifecycle-hooks). Hook names and lifecycle timing remain the
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
`host`), its `urlcode.json` descriptor (exactly what `build:addons` writes from
that definition, so the root install's prepare step accepts the new package)
and a real integration test, all as placeholders to replace. `--from <existing-package>` forks an existing package's file
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
   request. Invalid or stale configuration fails activation. Throw an `Error`
   whose message names the offending setting: `validate`, `test`, `dev` and
   `serve` startup print it as `Extension "<name>" failed to activate: <message>`
   (one line, bounded, no stack); request-time answers stay generic. For a
   condition the operator should act on that does not stop the site, call
   [`context.warn(message)`](#activation-warnings) during activation instead.
5. Returns `handle` for mounts and optionally `authorize`/`middleware` for route
   policies. It closes resources it owns. An extension that authenticates may
   declare `providesPrincipal` and set the [request principal](#request-principal);
   one that needs to know who a request is for reads `request.principal` and
   checks `principalMounts` at activation, and never parses another extension's
   cookie, header or tables.
6. Keeps credentials, storage and provider setup in the operator host. Project
   YAML contains logical configuration and project-relative hook references.
7. Decides whether a request is same-origin with `isSameOriginRequest`
   (or, for a single origin value, `isSiteOrigin(context, value)`) from
   `@jimhoyd/urlcode/extensions`, never by comparing against `context.origin`
   itself, so an operator's alias origins are honoured the same way everywhere
   ([site origins](#site-origins-and-same-origin-checks)).
8. Reads bodies, fields and cookies and writes JSON answers with core's
   [request helpers](#request-helpers), never with its own parser.

### Request helpers

`@jimhoyd/urlcode/extensions` exports one bounded implementation of the request
chores every extension has (`RIM-EXT-HTTP-001` in
[runtime implementation](RUNTIME-IMPLEMENTATION.md)). Do not hand-roll body
parsing, JSON responses, cookie parsing or origin checks; use these:

| Helper | What it does |
|---|---|
| `readBody(request, {accept, maxBytes, maxDepth?})` | Reads a JSON or `application/x-www-form-urlencoded` body. Refuses a repeated `Content-Type` (400, checked first), then more than `maxBytes` (413), another media type (415), invalid UTF-8 (400) and, for JSON, nesting deeper than `maxDepth` (default 32) or a repeated key (400) before `JSON.parse`. |
| `readFields(request, {fields, patterns?, accept?, maxBytes?, maxFields?, maxValueLength?, limits?})` | A flat set of string fields through `readBody`: only names in `fields` or matching an anchored `patterns` entry, each once, each a string within its length limit. List `csrf` and any challenge token field yourself. The result is frozen. |
| `jsonResponse(status, value, headers?)` | A JSON answer with `no-store`, `nosniff`, a deny-all CSP and a `strict-origin` referrer policy; a header you pass replaces the default of the same name. |
| `wantsJson(request)` | Whether `Accept` lists `application/json` or the body is JSON. |
| `readCookie(request, name, shape)` | One cookie value. Refuses (400) a repeated `Cookie` header, one over 8192 bytes, or the name twice; a value that does not match `shape` reads as absent. |
| `isSameOriginRequest(request, site, {whenAbsent})` | The [one same-origin rule](#site-origins-and-same-origin-checks). |
| `ExtensionHttpError` | What the readers throw: `status` 400, 413 or 415 and a `code`. Its message is fixed per code and never echoes request data, so it is safe to show. |
| `clientKey(request.client)` | A stable key for the client address (an IPv6 address becomes its /64 network), for budgets and logs. |

### Activation warnings

`context.warn(message)` on the activation context is the one generic,
operator-facing warning channel (issue #736). Use it during `activate()` for a
condition that should not refuse startup but that the operator has to act on,
such as stored data that no longer matches the operator's configuration. Core
names no extension and interprets no message.

- Each call is written to the operator's event log as one record,
  `{"event":"extension_warning","extension":"<name>","message":"..."}`: the
  log `validate`, `test` and `dev`/`serve` print startup lines to, and the `log`
  (and observers) given to `createRuntime`, `startServer` or `runProjectTests`.
  The AWS and Vercel adapters write it to the function log with `console.warn`.
  It never reaches an HTTP response.
- The message is cut to one line of at most 500 characters (control characters
  and runs of whitespace become one space), the same bound as
  [activation errors](LOCAL-DEVELOPMENT.md#environment-and-troubleshooting). It
  carries no stack.
- At most 20 warnings are recorded per extension per activation
  (`maxExtensionWarnings`); the next call records one
  `further warnings suppressed after 20 in this activation` line and later calls
  are dropped. A reload or restart activates again and may warn again.
- It is activation-only. A call after `activate()` has returned or thrown (from
  a request, a timer or a later promise) is ignored, so a request cannot flood
  the log. Report request-time problems through your own responses and logs.
- Write counts and configuration names only. A warning must not carry user
  ids, email addresses, credential ids, secrets or request data: it lands in a
  startup log that CI and hosting consoles keep.

`warn` is optional in the `ExtensionActivation` type only so an activation
built by hand in a test can leave it out; the runtime always sets it, so call
it as `context.warn?.(message)` if you also support such tests.

### Site origins and same-origin checks

A site can be served from more than one origin: an apex and a `www` host, or a
second domain in front of the same deployment. The operator sets that as one
site-wide list, never in project YAML (issue #717):

| Where | How |
|---|---|
| `urlcode dev`, `serve`, `validate`, `test`, `routes`, `audit`, `benchmark` | `--alias-origin https://www.site.example`, repeated once per origin, beside `--origin` |
| `createRuntime`, `startServer`, `runProjectTests` | `aliasOrigins: ['https://www.site.example']` beside `origin` |
| AWS and Vercel handlers | the `aliasOrigins` handler option, otherwise `URLCODE_ALIAS_ORIGINS` (comma-separated) beside `URLCODE_ORIGIN` |

Core validates the list before it loads the project, and refuses to start with a
`ConfigError` (code `invalid-alias-origin`) that names the bad entry. Each entry
must be an absolute `https:` origin (scheme, host and optional port, no path,
query, fragment, credentials or `*` wildcard); `http:` is accepted only for
`localhost`, `127.0.0.1` and `[::1]`. At most 16 entries are allowed, a
canonical `--origin` is required beside them, and entries are serialized
(scheme and host lower-cased, a default port dropped) and deduplicated. The
canonical origin is always a site origin; listing it again is harmless.

An extension's activation context carries both:

- `origin`: the canonical origin, the only one to build absolute URLs,
  redirects, email links and CSRF bindings from;
- `origins`: the canonical origin first, then the alias origins, frozen.
  (It is optional in the type only so a hand-built activation in a test still
  means the canonical origin alone; the runtime always sets it.)
- `passkeyRpId`: present only when the operator set a
  [shared passkey relying-party domain](#shared-passkey-relying-party-domain).
- `warn`: the [activation warning](#activation-warnings) channel.

`isSiteOrigin(context, value)` is the one match for a single origin value: the
value must be a bare origin and matches when its serialized form is one of
`context.origins`, so case and an explicit default port do not matter. `null`,
a missing value, a different scheme or port, and a sibling subdomain never
match.

Every extension decides whether a request is same-origin with one rule,
`isSameOriginRequest(request, context, {whenAbsent})`. The first step that
applies decides:

1. more than one `Origin`, `Sec-Fetch-Site` or `Referer` header: refuse;
2. `Sec-Fetch-Site: cross-site`: refuse;
3. an `Origin` header: admit only a site origin;
4. a `Sec-Fetch-Site` header: admit only `same-origin` or `none`;
5. a `Referer` header: admit only when its origin is a site origin;
6. none of them: `whenAbsent`.

`whenAbsent: 'refuse'` is for an endpoint that takes a form post or relies on
cookies: `auth`, `admin` and `forms` use it. `whenAbsent: 'admit'` is only for
an endpoint that accepts JSON exclusively, which a cross-site browser cannot
send without a preflight the runtime never grants, while non-browser clients
(curl, MCP clients, API keys) send no provenance header: `store` and `mcp` use
it. The rule is admission only: a cookie-bound write still needs its CSRF
token, unless the route opts into [`csrf: origin`](#csrf-on-protected-routes-csrf-token--origin).
Auth's CSRF check additionally requires a single `x-csrf-token` (or a body
`csrf` field) bound to the session. On a loopback bind the server's
[host admission](OPERATIONS.md#host-admission-on-a-loopback-bind) admits each
alias authority too.

#### Shared passkey relying-party domain

A passkey (WebAuthn credential) is bound to one relying-party ID, a domain.
By default an extension that runs passkey ceremonies uses the canonical host as
the RP ID and accepts a ceremony only from the canonical origin, so alias
origins do not get passkeys. An operator whose origins share a registrable
domain (`app.site.example` and `www.site.example` under `site.example`) can opt
in to one shared RP ID (issue #729). It is operator configuration, never project
YAML:

| Where | How |
|---|---|
| `urlcode dev`, `serve`, `validate`, `test`, `routes`, `audit`, `benchmark` | `--passkey-rp-id site.example` beside `--origin` and `--alias-origin` |
| `createRuntime`, `startServer`, `runProjectTests` | `passkeyRpId: 'site.example'` |
| AWS and Vercel handlers | the `passkeyRpId` handler option, otherwise `URLCODE_PASSKEY_RP_ID` |

Core validates it together with the origins and refuses to start with a
`ConfigError` (code `invalid-passkey-rp-id`) unless it is:

- a lowercase ASCII DNS name (punycode for an international name) with no
  scheme, port, path, wildcard or trailing dot, and at most 253 characters;
- not an IP address, and not a single label: `localhost` is accepted only when
  the canonical origin's host is `localhost`;
- not one of the common public suffixes core lists (`co.uk`, `com.au`,
  `github.io`, `vercel.app` and similar; `passkeyPublicSuffixes` in
  `packages/core/src/site-origins.ts`);
- the host of the canonical origin and of every alias origin, or a parent domain
  of each at a label boundary (`site.example` covers `www.site.example`, never
  `mysite.example` or `site.example.evil.example`). An alias on another domain,
  or on `127.0.0.1`, cannot share an RP ID, so it is refused rather than left
  without passkeys.

Node carries no Public Suffix List and core does not ship one, so the public
suffix check is deliberately short. Browsers enforce the full list themselves
and refuse a ceremony whose RP ID is a public suffix, so a suffix missing from
core's list fails closed in the browser, not open.

The activation context then carries `passkeyRpId`. An extension that runs
ceremonies uses it as the RP ID and may accept any entry of `origins` as the
ceremony's client origin; without it, it keeps its default. First-party `auth`
does exactly that ([auth README](../packages/auth/README.md#passkeys-and-the-relying-party-domain)).

> **Changing the RP ID invalidates existing passkeys.** A credential registered
> under `app.site.example` cannot be used under `site.example`, or the other
> way round. Setting, changing or removing `--passkey-rp-id` makes every passkey
> registered under the previous RP ID stop working; users must sign in another
> way and register a new passkey. Decide on the RP ID before users enrol.
> First-party `auth` records each new passkey's RP ID and reports stranded
> passkeys at startup as an [activation warning](#activation-warnings), with
> counts only ([auth README](../packages/auth/README.md#passkeys-and-the-relying-party-domain)).

Every extension also follows the
[generic add-on authoring rules](#generic-add-on-authoring-rules).

Consumers add it with `urlcode extensions add <name>`, which declares its YAML
block and routes and registers it in `host.mjs`. Keep that `scaffold` to the
capability; put a demo in the definition's optional `example`, which core writes
only with `--example`. They modify it through declared configuration,
presentation layers and hooks. A fork is reserved for changing behavior the
extension has not exposed; that is evidence for a new declarative field or hook.
See [Composing a site](COMPOSING-A-SITE.md) for the complete ui/auth/admin example.

## Generic add-on authoring rules

These rules apply to every extension and artifact, first-party or not. They
keep add-ons composable without core, or any other add-on, learning one's
internals. An add-on **must** follow them:

1. **Own only your declared surface.** An extension owns its declared
   configuration, mounts, policies and exported or contributed contract, and
   nothing else. It must not read, parse or depend on another extension's
   private YAML or configuration layout. Pattern: `store` contributes generic
   descriptions of its CRUD screens to `ui`, and `ui` never reads
   `extensions.store.config` (#709; see [nesting](#nesting)).
2. **Make every cross-extension dependency explicit.** Use `requires`, or a
   `uses` entry for an optional one, a typed, versioned export read with `ctx.get`, or a typed, versioned
   contribution (`contributes` on the giver, `ctx.contributions` on the
   receiver, which checks any name-keyed claim against the core-stamped
   `from`; see [contributions](#contributions)); see [the extension definition](#the-extension-definition). Core
   stays unaware of first-party extension names and policy vocabulary: for the
   `auth:` shorthand core only maps the key, and auth's `policySchema` owns its
   shape (#710; see [the `auth` short form](#protecting-a-route-the-auth-short-form)).
3. **Scaffold the capability, not an application.** `scaffold` adds only the
   integration prerequisites the extension needs to function. Runnable demo
   endpoints, pages and data belong in the optional `example()` hook, written
   only with `--example` (#711; see [commands](#commands)).
4. **Keep artifacts inert.** An artifact carries reusable schemas, examples or
   documentation only: never executable code, provider wiring, credentials,
   customer data or application-specific configuration. The enforced file and
   manifest limits are in [artifacts](#artifacts).
5. **Prove every new seam twice.** A new export, contribution, hook or policy
   seam ships with a fixture for a second provider or consumer (not just the
   first-party pair that motivated it). External authors run their own package
   and consumer checks. In this repository, descriptor, build and add-on
   verification uses: `node scripts/build-addon-manifest.ts --check`,
   `npm run audit:packages` and `npm run test:addons`
   ([validation and CI](#validation-and-ci), [changing an add-on](../CONTRIBUTING.md#changing-an-add-on)).

### Author checklist

- [ ] Configuration, mounts, policies and exports are declared in the
      definition; nothing reads another extension's configuration.
- [ ] Every dependency is a `requires` or `uses` entry, a `ctx.get` export or a
      `contributes`/`ctx.contributions` value, with a versioned shape.
- [ ] Bodies, fields, cookies, JSON answers and origin checks go through core's
      [request helpers](#request-helpers).
- [ ] Core needs no change naming this extension or its policy keys.
- [ ] `scaffold` writes only prerequisites; any demo is in `example()`.
- [ ] Artifacts pass `urlcode artifacts list --strict` and hold no code,
      provider wiring, credentials, customer data or app-specific config.
- [ ] Each new seam has a second-provider or consumer fixture.
- [ ] For first-party add-ons, `npm run build:addons` output is committed; `build-addon-manifest --check`,
      `npm run audit:packages` and `npm run test:addons` pass.

## External extensions and AI tooling

External and private extensions are supported. Prefer a first-party extension
when it satisfies the requirement: those add-ons are tested with the runtime
and pinned together by its release catalog. This is a preference, not a ban on
external code or a claim of independent security assessment. Use an external
extension for a missing capability or an explicit project requirement, following
the same generic authoring rules and trusted operator boundary.

For an AI assistant integrating an extension:

1. Inspect the installed first-party capabilities and customization surfaces.
   Reuse a suitable tested extension before introducing another dependency.
2. For an external extension, read its compatibility, configuration, lifecycle
   and testing instructions. Install the selected package at an exact reviewed
   version using the site's package manager and retain its lockfile. A private
   local operator module is also supported. Package names and imports belong
   outside `app/`, never in route YAML.
3. Import its definition in `host.mjs` and add its entry to `composeHost` alongside
   existing entries. Declare its logical name, configuration and mounts in YAML.
   Supply every declared dependency explicitly. Host modules run trusted code;
   `sandbox: true` on a project route does not sandbox an extension.
4. Supply the reviewed revision pin, inspect the registered schemas and authoring
   surfaces, then validate and run HTTP fixtures through that host. Use
   `get_extensions` when the operator has configured the local MCP server with
   the host file; otherwise use the CLI below. Hosted release catalogs describe
   first-party releases, not an external package's installed behavior.
5. Report compatibility and tests actually exercised. Keep external package
   upgrades explicit; core's `extensions add/remove`, release catalog and
   `upgrade` do not manage arbitrary third-party packages. Do not override the
   development catalog to impersonate a managed release add-on.

### Minimal external operator module

In an initialized site, save this as `greeting.mjs` beside `host.mjs`, outside
`app/`. A separate package can export this same definition; its consumer would
replace the local import below with that package's documented export.

```js
import { defineExtension } from '@jimhoyd/urlcode/extensions';

const schema = {
  type: 'object', additionalProperties: false, required: ['message'],
  properties: { message: { type: 'string', minLength: 1, maxLength: 120 } },
};
const authoring = {
  description: 'Configure the greeting without replacing its handler.',
  surfaces: [{ kind: 'configuration', name: 'message',
    description: 'Plain text returned by the greeting mount.' }],
};
export default defineExtension({
  name: 'greeting', description: 'A minimal external greeting extension.',
  schema, authoring,
  host({ projectSha256 }) {
    return { registration: {
      name: 'greeting', version: '1', projectSha256,
      targets: ['node'], schema, authoring,
      activate(config) {
        return { handle() {
          return { status: 200,
            headers: [['content-type', 'text/plain; charset=utf-8']],
            body: config.message };
        } };
      },
    } };
  },
});
```

For a bare site, `host.mjs` is:

```js
import { composeHost } from '@jimhoyd/urlcode/host';
import greeting from './greeting.mjs';
export default await composeHost(import.meta.url, [greeting()]);
```

The route project, `app/urlcode.yaml`:

```yaml
version: "1"
extensions:
  greeting:
    version: "1"
    config: { message: Hello from an external extension }
routes:
  /greeting/*:
    extension: greeting
    methods: [GET, HEAD]
```

Add `app/tests/requests.json`:

```json
[
  { "path": "/greeting/hello", "status": 200, "expectBody": "Hello from an external extension" },
  { "path": "/greeting/hello", "method": "HEAD", "status": 200, "expectBody": "" },
  { "path": "/greeting/hello", "method": "POST", "status": 405 }
]
```

From the site, run `urlcode explain --project app --json` and review the project
before setting `PROJECT_SHA256` to its reported `projectSha256`. Do not compute
and approve a fresh pin inside `host.mjs` on each startup. Then run:

```sh
urlcode extensions --project app --host-file host.mjs --json
urlcode validate --project app --host-file host.mjs --origin http://localhost:3000
urlcode test --project app --host-file host.mjs --origin http://localhost:3000
```

Use the site's installed CLI (or prefix with `npx --no --package @jimhoyd/urlcode`).
For commands accepting `--policy`, an external reviewed operator policy can
supply the revision instead; see [the revision pin](#the-revision-pin).
Always pass the host for external schemas: descriptor-only discovery assumes
managed package conventions and is not a general third-party package resolver.

An external author should publish configuration/policy schemas, hook contracts,
`authoring` surfaces and fast checks in the registration, plus compatible core
versions, supported targets and lifecycle cleanup instructions. Test the packed
package in a separate consumer, including invalid configuration, unsupported
targets, revision mismatch and relevant authorization failures. The generic
rules apply; this repository's `build:addons`, descriptor and release scripts
are first-party maintenance commands, not prerequisites for an external package.
Core's catalog does not automatically distribute external agent references or
invoke its scaffold; provide package-owned instructions and examples.

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
descriptor: `{kind, name, description, requires, contributes?, schema?,
policySchema?, hooks?, authoring?}`. For an extension the descriptor is written from its
`defineExtension` definition by `npm run build:addons` (including
`contributes`, the sorted names of the extensions it hands a value to), and CI fails when the
committed file differs, so tooling can read an extension's schemas and
contracts without running any of its code. An artifact descriptor carries only
`kind`, `name`, `description` and `requires`.

Add-ons are versioned in lockstep with core. Only core is published to npm;
each add-on is released as a tarball on the same GitHub Release as core. The
release build writes `addons.json` into core's own `dist/`: for every add-on its
name, kind, `requires`, download URL and sha512 integrity. That file is the
only install catalog. Trust in core's npm provenance therefore extends to every add-on
it installs, and there is nothing else to verify, cache or lock: the site's
ordinary `package-lock.json` records each tarball, and the add-on commands
check it against core's pin.

The first-party add-ons are:

- Extensions: `ui`, `auth` (requires `ui`), `admin` (requires `auth` and `ui`),
  `forms` (requires `ui`), `store`, `form-records` (requires `forms` and
  `store`), `mcp`.
- Artifacts: `store-schema`, the `store` extension's configuration schema and an
  example configuration. Its schema is generated from the store extension's
  definition by `npm run build:addons`, so the two cannot drift.

`urlcode extensions available` and `urlcode artifacts available` list what the
running core pins.

### The release-wide agent catalog

Beside `addons.json`, core's `dist/` carries `addon-catalog.json`: agent
discovery metadata for every extension and artifact of the same release, built
from each add-on's `urlcode.json` descriptor. Each entry has the add-on's
`name`, `kind`, `package`, `version`, `description`, `requires` and, when the
descriptor declares one, its `agent` block (a description and references whose
`path` is relative to that add-on's package):

```json
{
  "format": 1,
  "scope": "release",
  "version": "<core version>",
  "addons": [
    {
      "name": "store-schema",
      "kind": "artifact",
      "package": "@jimhoyd/urlcode-store-schema",
      "version": "<core version>",
      "description": "…",
      "requires": [],
      "agent": { "description": "…", "references": [{ "name": "configuration schema", "description": "…", "path": "schemas/config.json" }] }
    }
  ]
}
```

It is metadata only: no URL, integrity, schema or code. `npm run build` writes
it, `npm run build:addons` refreshes it with the descriptors, and
`node scripts/build-addon-manifest.ts --check` (part of `npm run verify`) fails
when it differs from what the add-ons' code and descriptors say. The release
build refuses a core tarball whose catalog differs from the descriptors inside
the add-on tarballs it pins. `readAddonCatalog()` (`@jimhoyd/urlcode` and
`@jimhoyd/urlcode/agent-context`) and MCP `get_release_addon_catalog` return it;
reading it imports, downloads, installs and activates nothing, so a hosted
authoring service can present every add-on's agent metadata from its pinned
core without installing the add-ons.

The catalog is release-wide discovery. An add-on appearing in it is not
evidence that a project installed or activated it. What a project has installed
stays a local concern: MCP `get_addon_agent_tooling`, `get_extension_artifacts`
and, with the operator host, `get_extensions`. The descriptor does not record
whether an extension ships an `--example`; the catalog does not either.

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
import audit from '@jimhoyd/urlcode-audit/extension';
import mail from '@jimhoyd/urlcode-mail/extension';
import ui from '@jimhoyd/urlcode-ui/extension';
import auth from '@jimhoyd/urlcode-auth/extension';

export default await composeHost(import.meta.url, [
  audit(),
  mail(),
  ui(),
  auth(),
]);
```

That is the host after `urlcode extensions add ui auth`, which also installs
`audit` and `mail` because auth requires them. Operator options go inside the
call, for example `mail({transport: sesTransport({region}), from})`. The
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
| `urlcode extensions add <name>… [--example]` / `urlcode artifacts add <name>…` | Adds each named add-on and everything it requires; for extensions, the capability only unless `--example` also writes each one's demo |
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
`scaffold` (the capability: what the extension needs to function, with no
sample application endpoints) and, only when `--example` is passed, its
optional `example` (demo collections, pages and flows) merged on top, and
writes what they return:

- its `config` as the `extensions.<name>` block of `app/urlcode.yaml`;
- its routes as `app/routes/<name>.yaml`, added to `includes` (a route the
  project already has refuses);
- its operator files, relative to the site and always outside `app/` (an
  existing file is kept, never overwritten);
- one import and one list line in `host.mjs`.

`add` and `remove` edit `app/urlcode.yaml` in place: they insert or delete only
the `extensions.<name>` entry and the `includes` item, and every other line,
including flow collections, long scalars, comments and spacing, stays byte for
byte as you wrote it. A layout they cannot edit that way (for example an
`includes:` that is not a list) refuses and prints the block to write yourself;
it is never reformatted.

It prints the environment variables the host reads, next steps, and the new
project revision to review and pin: as the `projectSha256` of the operator
policy passed with `--policy` (see [the revision pin](#the-revision-pin)), or
as `PROJECT_SHA256` where the host runs.
Any failure or refusal, by `add` or `remove`, rolls every change back:
`package.json`, the lock, `app/urlcode.yaml`, `host.mjs`, the files it
created, and `node_modules`. npm has already run by the time most checks
refuse, so a site that had a lock is reinstalled from the restored lock with
`npm ci --ignore-scripts`; a site without a lock loses every `node_modules`
entry the command created. If that reinstall itself fails, the command says so
and asks you to run `npm ci --ignore-scripts` before continuing. The refused
package was downloaded and extracted but never run: every npm call passes
`--ignore-scripts`.

`--example` is one flag for every extension: it applies to each extension the
command adds (including requirements it pulls in), refuses when none of them
ships an example or when nothing is added, and never changes an extension that
is already installed. The first-party examples are store's `todos` collection
on `/api/todos` (and, with `ui`, its `/todos` screen; per-user `ownership: owner`
when `auth` is installed), forms' `/contact` flow,
auth's signed-in `/private` page and form-records' signed-in `/todo-form`
(which needs `auth` and saves into the store example's `todos`); ui, admin and
mcp ship none.

Some scaffolds or examples refuse until the operator acknowledges a named risk; for example
the `store` example without `auth` would expose public write on its collection. The refusal
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
and `host.mjs` (an extension declared but not imported by `host.mjs`, imported
but not declared, or declared without an installed package), a missing
requirement, or an artifact that is not inert.

An installed extension package that neither `app/urlcode.yaml` declares nor
`host.mjs` imports as `<package>/extension` is a library install: another
package or your own code depends on it, and it is not wired as an extension.
`list` shows it as `(library)` (`"mode": "library"` with `--json`; wired
extensions are `"extension"`, artifacts `"artifact"`). Its package.json URL,
lock integrity and resolved URL are still checked against core's pin, and
nested copies still fail, but the missing declaration and import are not drift.
As soon as either file names it, the other must agree.

`urlcode init <directory> --with ui,auth [--example] [--ack extension:id]` is `init`
followed by `extensions add` for those names; a refusal undoes the whole init.

`urlcode upgrade` moves core and every installed add-on to one version
together: the latest stable release (npm's `latest` dist-tag, which only a
stable release moves) unless `--to X.Y.Z` names another, including a prerelease
or an older release. It installs core first, then points every add-on at the
pins in that core's own `addons.json` (refusing, before anything stays changed,
if the target does not release an installed add-on), checks the lock against
them, refuses any installed artifact that is not inert at its new pin (the same
checks `artifacts add` makes), validates the project with the new runtime, and
moves the site's workflow to the same action release. Every npm run uses
`--ignore-scripts`. Any failure restores `package.json`, `package-lock.json`
and the workflows, then reinstalls `node_modules` from the restored lock with
`npm ci --ignore-scripts`. If that reinstall itself fails, the error says so
after the original failure and tells you to run `npm ci --ignore-scripts` in
the site before continuing; it is never silently ignored. The upgrade needs a
`package-lock.json` to roll back exactly, so a site without one is refused
before anything changes: run `npm install --ignore-scripts` first. `urlcode upgrade --check`
reports the current and target versions and changes nothing. Configuration is
not migrated: if an extension's schema changed, validation names the field.

Add-on command-line tools are ordinary npm bins once installed in the site, for
example `npx urlcode-auth bootstrap --operator-file "$PWD/operator-service.mjs"`
or `npx urlcode-ui doctor --project app`.

### Nesting

Each extension declares what it needs:

| Extension | `requires` | `uses` (optional) | Contributes to |
|---|---|---|---|
| `ui`, `audit`, `abuse`, `mail`, `mcp` | none | none | |
| `auth` | `ui`, `audit`, `mail` | `abuse` | `ui`, `mail` |
| `admin` | `auth`, `ui`, `audit` | | `ui` |
| `store` | none | `audit` | `ui` |
| `forms` | `ui` | `abuse`, `mail` | `mail` |
| `form-records` | `forms`, `store`, `ui` | | |

A sibling add-on is an optional exact peer dependency, never a nested
dependency, so every add-on is installed once at the top level of the site;
`urlcode extensions add` installs every `requires` entry with the extension
that names it. `composeHost` orders the listed extensions by `requires` and by
each installed `uses` entry (ties keep a stable lexical order) and runs each
`host()` once. A dependant receives the exports of what it requires or uses
through `ctx.get('<name>')`: a `requires` entry is always there, a `uses`
entry is `undefined` when that extension is not installed, and any other name
throws.

The runtime then activates the declared extensions in that registration order,
so an extension's activation always runs after the activation of everything it
requires or uses, and can read `active` (or mail's `available`) on their
exports. The order the extensions are declared in under `extensions` in YAML
does not matter. They close in reverse order.

A contribution is an optional edge too: an extension may contribute to one it
does not require, and the value is simply unused when the target is not
installed. Auth and admin pass templates and copy catalogues to `ui` through
`contributes.ui`, which `ui` collects with `ctx.contributions('ui')`; auth and
forms pass message templates to `mail` the same way. The store does not
require `ui`, but contributes `screens`, a source ui calls at activation to
receive generic descriptions of the CRUD screens declared under
`extensions.store.config.screens`, so ui never reads the store's
configuration. Its descriptor records the edge (`contributes: ["ui"]`) and its
`package.json` declares `ui` an optional peer.

#### Contributions

`ctx.contributions('<name>')` returns every installed extension's
`contributes['<name>']` value, in host.mjs order, as `{from, value}`:

- `from` is the contributing definition's registered `name`, **stamped by
  core**. The contributor supplies only `value`, so a value that carries its
  own `from` (or any other field) cannot change it: no contribution can claim
  to come from another extension. This is the contribution analogue of the
  principal's core-stamped `provider` ([request principal](#request-principal)).
- Each entry is frozen, and each call returns a new frozen list. Core never
  inspects, copies or freezes `value`; its shape and version belong to the
  receiver.
- A receiver that keys anything by extension name (a namespace, an owned
  prefix) checks it against `from` and refuses a mismatch in `host()`, which
  `composeHost` reports as a `ConfigError` for the receiving extension. `ui`
  accepts a `templates` entry only when its `name` is `from` and every
  template or view-model key is `<from>/…`; `mail` accepts a contribution only
  when its `namespace` is `from`. Both errors name the claimed namespace and
  the contributing extension, for example `Mail namespace "auth" is
  contributed by extension "notifier": an extension contributes mail templates
  only under its own name`. ui's contributed screens are keyed by route path,
  not by extension name, so ui uses `from` only to name both contributors when
  two claim one path.

Exports are typed and versioned (`version: 1`, plus `active`):

| Export | From | Read by |
|---|---|---|
| `AuthExports` | `auth` | `admin`: the signed-in account and its permissions (`account(request)`), a CSRF token, account URLs and the administration API. Never a key, a database handle or a raw token. |
| `AuditExports` | `audit` | producers (`attach` an outbox, `validate` an event) and readers (`query`, `record`); admin's audit screens |
| `AbuseExports` | `abuse` | auth and forms: `namespace(name)` for budgets, backoff, the challenge and the honeypot |
| `MailExports` | `mail` | auth and forms: `send()` a contributed template; `available` says whether a transport is set |
| `FormsExports`, `StoreExports` | `forms`, `store` | `form-records`: a flow renderer and validator, and an ownership-honouring records API |

Two copies of one extension cannot exist in a site, so duplicate-instance bugs
(such as a second `ui` kit that never received another extension's templates)
cannot happen.

### Audit log

The `audit` extension keeps the one durable log of privileged actions. Its
guarantee: an event is written into the producer's own outbox in the same
transaction as the change it records (auth's SQLite `auth_audit_outbox`, the
`audit` array of an audited store collection's data file), so a change and its
event are stored together or not at all. Audit drains every attached outbox
into `data/audit.sqlite` while the host runs, at least once and deduplicated by
event id, so nothing is lost across a crash. A producer fails closed: when its
outbox reaches its cap (10000 for auth, 1000 per store collection) the write
answers 503 until audit catches up. The log keeps the newest `retention`
events (default 100000). Events carry names, ids and field names, never
submitted values or secrets. See the [audit package](../packages/audit/README.md)
and its [security notes](../packages/audit/SECURITY.md).

### Abuse protection

Two different tools limit request rates, and they are not interchangeable:

- The core [`throttle` policy](policies/throttle.md) is YAML on any route: a
  fixed per-client budget on a bounded in-memory table, the same on every
  target, reset on restart.
- The `abuse` extension is for other extensions' own flows: sign-in and
  sign-up budgets and password backoff in auth
  (`extensions.auth.config.abuse`), submission budgets in forms
  (`flows.<name>.abuse`). Its counters are keyed by an HMAC of the client
  address or account (`data/abuse.key`), persist in `data/abuse.sqlite`, are
  bounded by `maxKeys` (503 when full) and can escalate to a challenge
  provider. It is Node-only.

Losing `data/abuse.key` only resets the counters. See the
[abuse package](../packages/abuse/README.md).

### The extension definition

Each extension package's `./extension` entry default-exports one definition:

```ts
import { defineExtension } from '@jimhoyd/urlcode/extensions';

export default defineExtension<MyHostOptions>({
  name: 'store',
  description: 'One line shown by `urlcode extensions available`',
  requires: [],               // extension names that must be installed and declared
  uses: [],                   // optional: extension names read only when installed
  schema,                     // JSON Schema of extensions.<name>.config
  policySchema,               // optional: per-route policies.extensions.<name>
  hooks, authoring,           // optional project customization contracts
  contributes: {},            // optional static values for another extension, e.g. {ui: {...}}
  scaffold(request) { return { config, routes, files, env, notes }; },  // the capability
  example(request) { return { config, routes, notes }; },               // optional demo, only with --example
  host(ctx, options) { return { registration, exports, close }; },
});
```

The static fields (`name` to `authoring`) are what `npm run build:addons` writes
into `urlcode.json`.

`scaffold({site, project, installed, acknowledgements})` writes nothing. It
returns `{config, routes, files?, env?, acknowledged?, routeNotes?, notes?}`,
and core writes it as described above. `example` takes the same request and
returns the same shape; with `--example` core merges it into the scaffold's
result before writing: `config` deep-merges (plain objects key by key, any
other example value replaces), a route both return refuses, and the lists and
`env` are appended. `installed` lists every extension in the
site after this add; `acknowledgements` holds the sorted `--ack` values. To
require an acknowledgement, a scaffold throws an `Error` carrying
`acknowledgement: '<name>:<id>'` whose message states the risk, and lists each
one it used in `acknowledged`. `routeNotes` are single-line comments written
above its routes. A scaffold may generate key material as `Uint8Array` file
contents; core zeroes it after writing or on failure.

`host(ctx, options)` builds the runtime registration from the operator's
`host.mjs`. `ctx` is `{projectSha256, site, get, contributions}`: the reviewed
revision pin, the site directory, the exports of a required or used extension
(`undefined` for a used one that is not installed) and the values other
extensions contribute to this one, each as a frozen `{from, value}` whose
`from` core stamps ([contributions](#contributions)). It returns `{registration,
exports?, close?}`; `registration` is the `RuntimeExtension` described above,
and `close` runs in reverse activation order. `composeHost` reads the
revision pin once and refuses a host whose registration pins a different
revision or registers a schema that differs from the definition.

#### The revision pin

`composeHost` takes the pin from the operator, never from the project:

- When a CLI command (`serve`, `dev`, `validate`, `test`, `routes`, `audit`,
  `benchmark`) receives both `--policy` and `--host-file`, core validates the
  policy and passes its `projectSha256` to `composeHost` while it imports the
  host file. Nothing else in the policy reaches the host.
- Otherwise `composeHost` reads `PROJECT_SHA256`, as before.
- Both present and different refuses (`code` `revision-pin-mismatch`), and so
  does a policy whose revision is not the project's current one once the host
  registers an extension. Neither present refuses, naming both options.

A `host()` hook reads the pin as `context.projectSha256` and registers it
unchanged, so the generated `host.mjs` needs no edit and existing host files
keep working. A hand-written host file that builds registrations without
`composeHost` still reads `PROJECT_SHA256` itself. The pin travels through a
process-global `Symbol.for('urlcode.host.operatorRevision')` slot that is set
only while the host file is imported, so a host file that imports another copy
of core still sees it.

The types are exported from `@jimhoyd/urlcode/extensions`
(`packages/core/src/extensions.ts` is the authoritative definition) and
`composeHost` from `@jimhoyd/urlcode/host`. The runtime contract, the
host-file trust boundary and the revision pin are the same whether an
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
