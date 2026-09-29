# Operator-installed extensions

Extensions are trusted operator modules, separate from a project's own
`function`/`middleware` code. The first-party extensions (`audit`,
`auth`, `store`, `mcp`) are workspace packages in this repository
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

The `audit` extension serves no route and exists for other extensions to use
through its typed exports. It is the durable audit log: a producer (every store
collection with `audit: true`) writes each event into its own outbox in the
same transaction as the change it records, and audit drains the outboxes into
one bounded SQLite log ([audit log](#audit-log)).

No extension renders or processes forms. A form is an ordinary frontend that
posts JSON to a store mount, or to a route whose `request.body.POST.schema`
validates it before anything runs and whose `respond` answers it, with an
optional `signals` notification (the
[contact-form recipe](../recipes/contact-form/README.md)).
[`policies.throttle`](policies/throttle.md) limits its request rate. To email
a submission, a trusted function route calls the provider's own library
([sending mail from your own code](../recipes/contact-form/README.md#sending-mail-from-your-own-code-instead)).

The `mcp` extension declares an [MCP](https://modelcontextprotocol.io) tool
server: named tools with a description, a `request.body.<METHOD>.schema`-shaped input
schema (the same bounded JSON Schema 2020-12 profile, compiled by the same
`@jimhoyd/urlcode/body-schema` code, reused rather than reimplemented) and a trusted project handler loaded the same way as other
extension hooks. The official MCP SDK serves the protocol statelessly (JSON-RPC
over Streamable HTTP, version negotiation, request ids and error codes; #846),
and the extension refuses a foreign `Origin` (403; see [site origins](#site-origins-and-same-origin-checks))
before the SDK reads anything; project YAML never carries JSON-RPC mechanics.
Clients connect to the declared mount exactly (`/mcp`, not `/mcp/`). It may be
mounted behind a principal-providing extension. Streamed progress replies are an
operator opt-in, `mcp({ streaming: true })`, off by default; on, the registration
declares [`streams: true`](#streamed-responses), so aws refuses it. There are no
sessions. A tool's `inputSchema` or `outputSchema` may name one of the
project's [named schemas](HTTP.md#named-schemas) (`inputSchema: contact`), so a
POST route and a tool validate against one document and refuse the same input
at the same pointer; `tools/list` advertises the schema resolved. See the
[mcp package](../packages/mcp/README.md#named-schemas).

A project declares versioned configuration and exclusive route mounts:

```yaml
version: "1"
extensions:
  auth:
    version: "1"
    config: {}
routes:
  /api/auth/*:
    extension: auth
    methods: [GET, POST]
  /private:
    respond: {text: Private}
    policies:
      extensions:
        auth: {}
```

## Protecting a route: the `auth` short form

When the project declares an extension that provides the request principal, a
route may say `auth` instead of spelling out `policies.extensions.<name>` for
it. This is the preferred way to protect a route:

```yaml
routes:
  /account:
    respond: {text: Account}
    auth: true                    # any signed-in user
  /docs:
    respond: {text: Docs}
    auth: {required: false}       # documents intent; emits no requirement
```

The short form names a role, not an extension. It expands to the one declared
extension whose installed `urlcode.json` declares `providesPrincipal: true`
(see [request principal](#request-principal)), whatever that extension is
called: with the first-party `auth` package that is `auth`, and with an
independent sign-in package named, say, `authjs` it is `authjs`. The descriptor
is read from the site's dependencies, else the first-party install location,
else this core's release catalog; no host file is loaded. When no declared
extension provides a principal, or more than one does, `auth:` is refused and
the route names its extension with `policies.extensions.<name>` instead.

The compiler expands the short form before anything else reads the project:
`auth: true` becomes `policies.extensions.<provider>: {}` and an object becomes
the same object minus `required`. The long form stays the canonical
representation, so `routes`, `audit`, `explain` and the manifest show the
expansion with the provider's name.

The expansion stays reviewable because it is part of the reviewed revision.
The expanded long form is what the project revision (`projectSha256`, which
host registrations and binding grants pin) hashes, so a project whose short
form expands to `authjs` has the same revision as one that writes
`policies.extensions.authjs: {}` by hand. If a package change moves the target
(a reinstall makes a different declared extension the provider), the revision
changes and every pinned registration and grant refuses it until the operator
re-reviews it; the target never changes silently. With a host file, startup
also checks that the registrations agree: the one declared registration that
declares `providesPrincipal` must be the extension the descriptor named, or
activation is refused.

Core owns only that mapping and `required`. Every other key belongs to the
provider: the core schema accepts `true` or any object here, and the provider's
own `policySchema` decides which keys and values are valid. The first-party
`auth` policy is closed and empty, so `auth: true` is its only meaningful form
(`urlcode extensions --json` prints the authoritative shape). A new policy key
would ship with the provider package, not with core. Loading fails, naming the
route, when `auth` is neither `true` nor an object, when `required` is not a
boolean, when no declared extension (or more than one) provides a principal,
next to `policies.extensions.<provider>`, or next to
`policies.extensions: false`. Tools that read supplied YAML text with no
project directory (`suggestFixtures`, `summarizeYamlChange`) have no installed
descriptors and resolve the short form against the release catalog only.

A route protected this way answers `401 {"error":"authentication_required"}`
without a session Better Auth verifies from the request's cookie, and
`403 {"error":"cross_origin_refused"}` for a `POST`, `PUT`, `PATCH` or `DELETE`
that core's [same-origin rule](#site-origins-and-same-origin-checks) (with
`whenAbsent: 'refuse'`) does not admit. When the auth database cannot be read
or written in time it answers `503 {"error":"auth_unavailable"}` instead of a
`401`. There is no token mode and no
per-route CSRF option: a mount that accepts JSON only (a store collection)
uses the same `auth: true`. Identity is not permission: roles, ownership and approvals are
application data keyed by the user id (see the
[auth package](../packages/auth/README.md)).

The auth policy schema is applied at validate time as well as at startup:
`urlcode validate` checks it against the installed package's `urlcode.json`
(or the host file's registration with `--host-file`), `validateProject` against
the registrations passed as `extensions`, else the installed descriptor, and
`createRuntime` against the registration it activates. A failure is located at
the `auth` key the author wrote, not at the `policies.extensions.<provider>` it
expands to:

```text
Invalid extension policy at route /a, auth (additionalProperties): unknown key "role" (run urlcode extensions --json for its policy schema)
```

The error details carry the matching JSON pointer, under
`/routes/<escaped path>/auth`. Keys
written beside `required: false` emit no requirement but are still checked, so
a typo there does not wait until the route is switched back on.

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
in the revision. Changing them requires an explicit operator reapproval; the
one exception is `urlcode dev`'s hot reload, described under
[the revision pin](#the-revision-pin).

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
activation. An extension mount owns its path and every path below it; the
[mount ownership rule](ROUTING.md#extension-mounts-own-their-namespace) says
which other routes may sit beside or above it, and `urlcode validate` checks it
with or without a host file.

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
Invalid extension policy at route /private, policies.extensions.auth (additionalProperties): unknown key "role" (run urlcode extensions --json for its policy schema)
```

The policy checked is the route's effective one: project and profile
`policies.extensions` layers merged with the route's own, and the `auth:` short
form expanded. The failing key may therefore be written in one of those layers
rather than on the route. A route that names an extension declaring no
`policySchema` fails with `extension "<name>" declares no route policy`.

When a value can take more than one shape (a `oneOf`, such as a `true` or
object value), core and extension errors report the deepest failure in the
shape that was tried, not the first alternative. So `auth: {role: admin}`
names the unknown key `role`, reported by the auth extension's policy schema,
rather than saying `auth` must be `true`.

For extension-protected routes, agents/throttle run before authorization and
cache access happens only after authorization. Method admission sits between
them: a method the route does not declare is answered `405` with `Allow`, in
the route's [error format](HTTP.md#error-format), and neither `authorize()` nor
`middleware()` runs for it. That holds on an `extension:` mount and on a core
route an extension policy protects alike, so `auth: true` never turns an
undeclared method into a `401` or `403`. It reveals only which methods the route
declares, which an unprotected route's `405` and the
[OpenAPI export](TOOLING.md#openapi-export) already publish; the throttle and agents policies
still count and can refuse these requests first. This part is unconditional:
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
`auth`-style extensions gating real access must leave it at the
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
On a route that streams, the result may carry `stream` instead of `body`:
return it with the stream intact rather than reading it
([streamed responses](#streamed-responses)).

A route naming more than one extension in `policies.extensions` chains every
one that implements `middleware`, in the order the keys are declared, each
one's `next()` reaching the next one and the innermost `next()` reaching the
native pipeline — the first declared name is outermost. This is purely
additive at the `policies.extensions` layer and never touches the native
`middleware:` array, its schema, or its dispatch, all of which are unchanged.

`authorize` and `middleware` compose on the same route, from the same or
different extensions, without special-casing: once the method is admitted,
`authorize` always runs first, and any declared `middleware()` wraps everything after that
point, including the rest of the authorize-gated pipeline. A route naming an
extension via `policies.extensions` only requires that extension to
implement `authorize`, `middleware`, or both — never both unconditionally.

While any extension is active, the runtime withholds
Cookie and Authorization plus every extension's declared credential headers
from all application guest requests and mapped parameters, on every route,
including routes that never name an extension. A project with no active
extension (and no operator plugin declaring credential headers) withholds
nothing, so its own trusted middleware can read Authorization and Cookie (see
[the security policy](../SECURITY.md)). The projection keeps credentials away
from code that does not need them; it does not confine trusted Node code.
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
`request.headers.set('x-urlcode-context-<extension>-<name>', ...)` — and the
value carries forward into the guest-facing headers a route's own
`function`/`middleware` receives on its `Request` object. It stops there: a
`proxy` route can never opt this namespace into `requestHeaders`/
`responseHeaders` and have it forwarded to an external upstream — `validateProxy`
refuses a reserved-namespace name the same way it already refuses a
credential-shaped one. This is generic core infrastructure
(`extensionContextHeaderPrefix`, `stripReservedContextHeaders`,
`@jimhoyd/urlcode/extensions`); core never reads or interprets a value
written there. It is not a credential channel:
the withheld headers above (`cookie`, `authorization` and any declared
credential header, whenever an extension is active) are stripped from that guest-facing projection exactly as
before, and an extension must never write a raw session or bearer credential
into this namespace — only a derived, non-secret value. No first-party
extension writes it today: `auth` hands the verified user id to route code
through a [request-bound capability](#request-bound-capabilities) instead.

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
- **Declared once, read statically.** A package declares it in its
  `defineExtension` definition (`providesPrincipal: true`); `host()` must
  register the same value, and the build writes it into the package's
  `urlcode.json` and the release catalog. The
  [`auth` short form](#protecting-a-route-the-auth-short-form), the OpenAPI
  security scheme and `urlcode review`'s session hint follow this declaration,
  never the extension name `auth`, so an independent provider works with all
  three.
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
  channel above does not set it. A later `authorize()`, every `middleware()`
  and the mount's own `handle()` on the same route read `request.principal`.
  The principal object does not reach a route's own `function`/`middleware`
  guest code; auth separately hands that code the user id through its
  `identity` [capability](#request-bound-capabilities).
- **Knowing at startup.** The activation context carries `principalMounts`:
  the subset of `mounts` whose route names a principal-providing extension in
  its policies. An extension that needs a principal refuses to activate a mount
  missing from it (fail closed), and still refuses a request whose principal is
  `null`, because a provider may allow a request without setting one.

`auth` is the first-party provider (the id of the user Better Auth verified
for the request's session) and `store` the consumer. Auth
exports nothing else to other extensions: it has no roles or permissions, and
an application keeps those as its own data keyed by the user id. The core
fixture `test/extension-principal.test.ts` proves the seam with a synthetic,
non-auth provider. Extensions are trusted in-process code, so this contract
fails closed on mistakes and misconfiguration; it is not a sandbox between
extensions.

### Request-bound capabilities

Without this mechanism an ordinary `function`/`middleware` route's own guest
code can call very little: static imports of a package's pure types and
helpers, and any derived value an extension writes into the
[reserved header channel](#handing-data-forward-into-a-protected-routes-own-context).
Everything else an extension exports — a store collection
scoped to the caller or an audit log query — exists only as
a live object passed between extensions through `HostContext.get`, never
reachable from a route's own handler. **Request-bound capabilities**
(`RIM-EXT-CAPABILITY-001` in [runtime implementation](RUNTIME-IMPLEMENTATION.md))
close that gap with one generic mechanism, without adding new YAML: a route
that already names an extension in `policies.extensions` may receive a live,
per-invocation object from that extension, in `context.capabilities`.

- **Declaring what's offered.** A registration lists the capability names its
  active instance can provide: `capabilities: ['records']`. This is a pure
  availability signal, parallel to `providesPrincipal` and `streams`; it
  changes nothing about `policies.extensions` gating.
- **Providing it.** The instance implements
  `provide(capability, invocation)`, called once per declared name, per
  request, only for a route whose effective `policies.extensions` names this
  extension. `invocation` is a frozen `InvocationContext`: `requestId`,
  `route.pattern`, the same `principal` the request carries (`null` when
  unset) and, off the sandbox path, the request's `AbortSignal`. Returning
  `undefined` simply omits that entry for this one call — an anonymous
  request asking for a capability that needs a principal, for example — and
  is not an error.
- **Receiving it.** The route's own `context.capabilities` is
  `{[extensionName]: {[capability]: value}}`, present only for extensions the
  route names that both declared the capability and returned something other
  than `undefined` for this request. An extension named in `policies.extensions`
  with no declared capabilities, or whose `provide()` returns `undefined` for
  every declared name, leaves its key out entirely.
- **Never into the sandbox.** A live bound object cannot cross the sandbox
  worker's JSON boundary, the same reason a request's `AbortSignal` does not.
  A `sandbox: true` route naming an extension that declares any capability
  refuses activation before serving, exactly like `stream: true` combined with
  `sandbox: true`; a sandboxed route can still use the pure header-projection
  channel above.
- **Still gated.** Naming an extension in `policies.extensions` already
  requires it to implement `authorize()` or `middleware()`
  ([request principal](#request-principal)); a capability provider is no
  exception. Capability access rides on the same admission decision as
  everything else that extension already gates on this route — it is not a
  side door around it.

The header channel only carries a bounded, precomputed string written before
the handler runs; a capability is a live value bound to the actual
invocation. The first-party `auth` extension declares one capability,
`identity`: on a route with `auth: true` the handler reads the verified user
id as `context.capabilities.auth.identity.userId`, and a `sandbox: true` route
cannot name `auth`. The core fixture `test/extension-capability.test.ts` proves
the seam with a synthetic, non-first-party provider; naming the specific store
and audit operations an application can reach this way is a later, separate
decision for each package.

`urlcode explain` and `urlcode report` show the capabilities a registration
declares on every route that names it (`handler receives
context.capabilities.<name>: ...`). They do not enumerate what an extension
serves below its own mount: the mount's handler carries
`subpaths: provider-defined, not enumerated or inspected by URLCode`, so a
review never implies those endpoints were checked. The
[embedded Better Auth proof](../proofs/private-requests/README.md) (#843) is
an end-to-end application on this seam: the first-party `auth` extension
mounts Better Auth's own handler, turns its verified session into the request
principal, and the store scopes, gates and stamps its records with that
principal. The proof lists the provider's served endpoints with its own probe, outside URLCode's
review facts.

The same application runs with a second, independently owned provider behind
the same boundary: [Auth.js](../proofs/private-requests-authjs/README.md)
(`@auth/core`), connected by an independent package
(`@example/urlcode-authjs`, installed from a local tarball with
`urlcode extensions add`) that imports only Auth.js and
`@jimhoyd/urlcode/extensions`. Its `authorize()` sets the principal from Auth.js's
own session answer and it provides the same `identity` capability, so the store
declaration and every owner, reviewer, approval and cross-origin result are
unchanged, with no core edit. What differs is provider-specific and stays
visible: the client's sign-in calls, operator-owned password checking, the
mount's declared `throttle` in place of a provider limiter, and no server-side
revocation (Auth.js's Credentials sign-in forces JWT sessions, so a copied
token outlives sign-out until it expires). Its protected routes say
`auth: true` like the Better Auth proof's: the
[`auth` short form](#protecting-a-route-the-auth-short-form) follows
`providesPrincipal`, not the name, so it expands to
`policies.extensions.authjs`, and `urlcode openapi` and `urlcode review` treat
`authjs` as the sign-in gate. Capability names stay provider-specific: its
handlers read `context.capabilities.authjs.identity`. An independent package
still cannot name itself `auth`, a reserved first-party catalog name.

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
behalf of a request gets `requestId: null` and an empty `env`. An extension may add its own fields; `mcp` adds `server`, `tool`
and `kind`. Hook entry bytes participate in the project revision, so editing
a hook invalidates the operator's extension pin.

Projects select those declared hooks in the extension's own configuration:

```yaml
extensions:
  notifier:
    version: "1"
    config:
      hooks:
        transformMessage:
          source: ./hooks/transform-message.mjs
          export: default
```

with `transformMessage` a filter a hypothetical `notifier` extension declares
(`mcp` declares its tool, resource and prompt handlers the same way). Hook names and lifecycle timing remain the
extension's domain, while their declaration, loading and discovery are shared.

Hooks are first-party project code and run trusted in-process by default, with
full Node access, like trusted `function` and `middleware` routes. Contract v1
does not define an arbitrary-value sandbox hook protocol. A hook reference with
`sandbox: true` is rejected during activation rather than silently run trusted.
Only the entry module is refreshed during reactivation; its imported dependencies
remain in Node's module cache until restart.

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
*shape* (which siblings it requires, whether it carries a `.gitignore`) as a
starting point -- never its source code. The tool only creates files; run
`npm install` and `npm run build:addons` afterwards so the workspace and its
`urlcode.json` exist.

An extension package default-exports a [definition](#the-extension-definition)
from `./extension`. The `RuntimeExtension` registration its `host()` returns:

1. Declares its logical name, contract version, supported targets, exact project
   revision pin and strict configuration/policy schemas. Give every property a
   `description` saying what it does, including nested, map-value and hook
   input/output properties: `get_extensions`, `search_docs` and editors show
   it. For the first-party packages in this repository `npm run check` fails an
   undescribed property and renders each package README's
   [field reference](EXTENSION-REFERENCE.md) from the descriptor.
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
   configuration and hook surfaces, plus focused `fastChecks`. Keep descriptions concrete enough that an agent
   can choose a supported surface instead of copying package behavior. A surface
   may list `goals`: at most 32 lowercase words (a word or hyphenated word) that
   `plan-feature` matches against a feature goal to name that surface, so the
   extension, not core, owns its planning vocabulary
   ([feature planning](TOOLING.md#feature-planning)). The release catalog
   carries each extension's contract, so a goal plans it before it is installed.
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
9. Answers a long-lived or progressive response by declaring `streams: true`
   and returning a [streamed response](#streamed-responses), never by holding a
   buffered answer open or polling.
10. Describes the endpoints of its mount for `urlcode openapi` with an optional,
   pure [`describe()`](#openapi-description), and validates any JSON a project
   declares for it with core's [body-schema profile](HTTP.md#body-schema-and-input-patterns)
   (`@jimhoyd/urlcode/body-schema`) rather than a vocabulary of its own. Where
   its configuration takes a schema, it accepts the name of one of the
   project's [named schemas](HTTP.md#named-schemas) too and resolves it against
   `context.schemas` at activation (each already admitted and compiled by core,
   self-contained, `RIM-SCHEMA-001`), refusing a name the map does not hold.

### Request helpers

`@jimhoyd/urlcode/extensions` exports one bounded implementation of the request
chores every extension has (`RIM-EXT-HTTP-001` in
[runtime implementation](RUNTIME-IMPLEMENTATION.md)). Do not hand-roll body
parsing, JSON responses or origin checks; use these:

| Helper | What it does |
|---|---|
| `readBody(request, {maxBytes, maxDepth?})` | Reads a JSON body and returns the parsed value. Refuses a repeated `Content-Type` (400, checked first), then more than `maxBytes` (413), any media type but `application/json` (415), invalid UTF-8 (400), and nesting deeper than `maxDepth` (default 32) or a repeated key (400) before `JSON.parse`. |
| `jsonResponse(status, value, headers?)` | A JSON answer with `no-store`, `nosniff`, a deny-all CSP and a `strict-origin` referrer policy; a header you pass replaces the default of the same name. |
| `isSameOriginRequest(request, site, {whenAbsent})` | The [one same-origin rule](#site-origins-and-same-origin-checks). |
| `ExtensionHttpError` | What the readers throw: `status` 400, 413 or 415 and a `code`. Its message is fixed per code and never echoes request data, so it is safe to show. |
| `clientKey(request.client)` | A stable key for the client address (an IPv6 address becomes its /64 network), for budgets and logs. |

### OpenAPI description

A registration may implement `describe(request)` so the
[OpenAPI export](TOOLING.md#openapi-export) lists its mount's endpoints instead
of an opaque mount (`RIM-OPENAPI-001` in
[runtime implementation](RUNTIME-IMPLEMENTATION.md)). The export calls it only
when the operator's host file is loaded (`urlcode openapi --host-file`, or
`buildOpenApi(project, {extensions})`), once per mount of the extension, with
`{mount, methods, config, schemas}`: the mount path, the route's declared
methods, `extensions.<name>.config` as the project declares it and the
project's [named schemas](HTTP.md#named-schemas). It is never called while
serving and must be pure: no database, network, filesystem or clock.

It returns `undefined` to leave the mount opaque, or an `ExtensionOpenApi`,
JSON data only:

```ts
import type { ExtensionOpenApi, RuntimeExtension } from '@jimhoyd/urlcode/extensions';

const registration: RuntimeExtension = {
  // ...name, schema, activate...
  describe({ mount }): ExtensionOpenApi {
    const note = { type: 'object', properties: { title: { type: 'string' } } };
    const list = { get: { responses: { '200': { description: 'The notes.', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotesNote' } } } } } } };
    return { schemas: { NotesNote: note }, paths: Object.fromEntries([[mount, list]]) };
  },
};
```

Core checks the contribution and fails the export, naming the extension, when
it is outside this contract:

| Rule | Limit |
|---|---|
| Keys | `paths` and optional `schemas` only; JSON data (functions and `undefined` are dropped by serialization) of at most 256 KiB |
| Paths | at most 64, each the mount itself or a path below it (`{name}` templating), not described by another route; a path item holds only `summary`, `description`, `parameters` and operations, and each operation has `responses` |
| Schemas | at most 64 Schema Objects, each named with the extension's name in PascalCase as prefix (`store` → `StoreError`); two mounts of one extension may contribute the same schema only identically |
| References | every `$ref` is `#/components/schemas/<name>` naming one of its schemas, a core `Urlcode...` component (for example `UrlcodeBodyValidationIssue`) or a project named schema, or `#/components/schemas/<named schema>/properties/<property>` naming one of a named schema's root properties; core writes a referenced named schema once, as a route body naming it would; nothing is fetched |

Core then completes it: it drops each operation whose method the route does not
declare (the runtime answers that method itself), assigns every `operationId`,
adds `X-Request-Id`, `X-Content-Type-Options` and `Cache-Control: no-store` to
every response (the runtime adds them to every extension answer), adds a
sign-in gate's security requirement and its `401`/`403`/`503` (and an enforced
throttle's refusal), and marks the path item `x-urlcode.handler: extension`.
When the gate and the extension both declare a status, either may answer, so
the response keeps both descriptions and claims no body schema. A throw from
`describe()` fails the export as `Extension "<name>" could not describe its
mount for OpenAPI: <message>`.

The store describes each collection from its record schema
([store OpenAPI](STORE.md#openapi)); the other first-party extensions leave
their mounts opaque.

### Streamed responses

A mount's `handle()` may answer with a body sent as it is produced (server-sent
events, progress, logs) when the registration declares it (`RIM-STREAM-001` in
[runtime implementation](RUNTIME-IMPLEMENTATION.md)):

```ts
import type { RuntimeExtension, HandlerResult, ExtensionRequest } from '@jimhoyd/urlcode/extensions';

const registration: RuntimeExtension = {
  name: 'live', version: '1', projectSha256, targets: ['node', 'vercel'], schema: { type: 'object' },
  streams: true,
  activate: () => ({
    handle(request: ExtensionRequest): HandlerResult {
      async function* events() {
        yield ': open\n\n'; // commits the status and headers before the first event
        while (!request.signal?.aborted) { yield `data: ${Date.now()}\n\n`; await new Promise(r => setTimeout(r, 1000)); }
      }
      return { status: 200, headers: [['content-type', 'text/event-stream']], stream: events() };
    },
  }),
};
```

- `HandlerResult.stream` is an `AsyncIterable<StreamChunk>` (`StreamChunk` is
  `string | Uint8Array`; text is sent as UTF-8). It replaces `body`: a result
  with both, or with `contentLength`, is refused.
- `streams: true` on the registration is the declaration. Without it a
  streamed result from `handle()` is the generic 502 and a `stream_refused`
  log record; the producer is cancelled unread. An `authorize()` denial or a
  `middleware()` short-circuit never streams. A `middleware()` hook that calls
  `next()` on a route that streams receives the streamed result and must
  return it with `stream` intact (it may change headers); replacing it with
  another stream on a route that does not declare streaming is refused the
  same way.
- The runtime's floor still applies: `Cache-Control: no-store`, the header
  caps and no compression.
- `request.signal` aborts when the client disconnects, a stream limit ends
  the stream, or the server shuts down; its `reason` is the end reason. It
  also aborts, with reason `bodyless`, when the response carries no body
  (HEAD, 204, 205, 304) and the stream will never be read, and with reason
  `error` when the runtime refuses it (an undeclared or malformed stream,
  answered 502). The
  host also calls the iterator's `return()`, so an async generator's `finally`
  runs as soon as it resumes. Watch the signal while waiting on anything else.
- The first chunk commits the status and headers; an empty chunk (`''`)
  commits them without body bytes. An error before the first chunk is
  answered with the ordinary generic error; after it, the connection closes
  without the chunked terminator. HEAD never pulls the producer.
- Operator [stream limits](OPERATIONS.md#streamed-responses) bound every
  stream: concurrent streams, idle time, total duration and bytes. `close()`
  of the runtime (shutdown, or a retired dev reload) waits for open streams,
  so an extension's own `close()` runs only after its last stream ended.
- Targets: `prepareExtensions` refuses a declared registration with
  `streams: true` on any target but `node` and `vercel`, before activation.
  An extension that can also answer without streaming should expose an
  operator option that leaves `streams` unset for AWS. On Vercel delivery is
  `delegated`: the adapter writes each chunk, the provider's function
  streaming and duration limit decide the rest.

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

### Reload hand-off

An in-process reload (`app.reload()` on a `startServer` server, which the
`urlcode dev` watcher calls) builds and activates the replacement runtime while
the serving one keeps answering, then switches to it and closes the old one. If
anything in the replacement fails, the serving runtime keeps serving, unchanged
(issue #777). An extension that holds something exclusive per activation (a
directory lock, an exclusive database handle, an open file it alone may write)
would refuse the replacement's activation because the serving instance still
holds it. The optional hand-off lets the two activations share it instead
(`RIM-EXT-HANDOFF-001`):

```ts
interface ExtensionInstance {
  // Called only during an in-process reload, on the serving instance, just before
  // the same registration activates in the replacement runtime.
  handoff?(): unknown | Promise<unknown>;
  close?(): void | Promise<void>;
  // handle, authorize, middleware as before
}
interface ExtensionActivation {
  // Present only in that replacement activation, when handoff() returned a value.
  handoff?: ExtensionHandoff;
  // origin, mounts, root, warn ... as before
}
interface ExtensionHandoff { readonly value: unknown }
```

Core only carries the value: it passes exactly what `handoff()` returned, never
inspects, copies or freezes it, and offers it only to the activation of the
very same registration object under the same name. It never offers one on a
first activation, from a runtime that is closing, or on `serve` startup,
`validate`, `test` or the hosted adapters. A `handoff()` that throws rejects the
reload as `Extension "<name>" failed to hand off for a reload: <message>` and
the serving runtime keeps serving.

Ownership is reference counted, and the extension keeps the count (for example
a lease in its registration's closure, which lives as long as the host):

| Step | What happens | References |
|---|---|---|
| Serving | the instance holds the resource | 1 |
| Offer | `handoff()` returns a value naming it; nothing is released, the serving instance keeps using it | 1 |
| Accept | the replacement's `activate()` recognizes the value and takes its own reference | 2 |
| Replacement fails (its own activation, any extension after it, or anything later in the runtime's start) | core closes every instance it activated; each `close()` drops only its own reference; the serving instance is intact and usable | 1 |
| Replacement installed | the retired runtime closes once idle; its `close()` drops only its reference, so the resource stays open for the replacement | 1 |
| Last close | the resource is released | 0 |

So write `close()` to release the reference its own activation holds, never
the resource outright, and let only the last reference release it. While both
runtimes are live (the retiring one finishing in-flight requests) both
instances may use the resource: share one write path between them, never two
independent writers. An activation that cannot use the value (it did not issue
it, the lease is gone, an operator option such as a directory differs) ignores
it and opens fresh, which an exclusive resource then refuses exactly as it did
without a hand-off. The exclusion against other processes, other hosts and
other registrations of the same extension is unchanged: only a reload shares.

An extension that holds nothing exclusive leaves `handoff()` out and behaves as
before. The same overlap applies to any per-registration "current activation"
an extension keeps for its exports (a records export, a delivery context): make the newest live activation current and, when it
closes, fall back to the previous live one rather than to nothing, so a failed
reload's close cannot switch off the runtime that is still serving. No
first-party extension needs the hand-off today: the store shares one database
connection among its registration's live activations instead
([store reload](STORE.md#reload)), and the store's records export keeps its
current activation that way.

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
cookies: `auth` uses it for unsafe methods on a protected route. `whenAbsent: 'admit'` is only for
an endpoint that accepts JSON exclusively, which a cross-site browser cannot
send without a preflight the runtime never grants, while non-browser clients
(curl, MCP clients, API keys) send no provenance header: `store` and `mcp` use
it. The rule is admission only: Better Auth applies its own origin checks on its mount. On a loopback bind the server's
[host admission](OPERATIONS.md#host-admission-on-a-loopback-bind) admits each
alias authority too.

Every extension also follows the
[generic add-on authoring rules](#generic-add-on-authoring-rules).

Consumers add it with `urlcode extensions add <name>`, which declares its YAML
block and routes and registers it in `host.mjs`. Keep that `scaffold` to the
capability; put a demo in the definition's optional `example`, which core writes
only with `--example`. They modify it through declared configuration
and hooks. A fork is reserved for changing behavior the
extension has not exposed; that is evidence for a new declarative field or hook.

## Generic add-on authoring rules

These rules apply to every extension and artifact, first-party or not. They
keep add-ons composable without core, or any other add-on, learning one's
internals. An add-on **must** follow them:

1. **Own only your declared surface.** An extension owns its declared
   configuration, mounts, policies and exported contract, and
   nothing else. It must not read, parse or depend on another extension's
   private YAML or configuration layout. Pattern: an owned store collection
   reads only the generic request principal `auth` sets, never auth's
   configuration (see [nesting](#nesting)).
2. **Make every cross-extension dependency explicit.** Use `requires`, or a
   `uses` entry for an optional one, and a typed, versioned export read with
   `ctx.get`; see [the extension definition](#the-extension-definition). Core
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
5. **Prove every new seam twice.** A new export, hook or policy
   seam ships with a fixture for a second provider or consumer (not just the
   first-party pair that motivated it). External authors run their own package
   and consumer checks. In this repository, descriptor, build and add-on
   verification uses: `node scripts/build-addon-manifest.ts --check`,
   `npm run audit:packages` and `npm run test:addons`
   ([validation and CI](#validation-and-ci), [changing an add-on](../CONTRIBUTING.md#changing-an-add-on)).

### Author checklist

- [ ] Configuration, mounts, policies and exports are declared in the
      definition; nothing reads another extension's configuration.
- [ ] Every dependency is a `requires` or `uses` entry or a `ctx.get` export,
      with a versioned shape.
- [ ] JSON bodies, JSON answers and origin checks go through core's
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
5. Report compatibility and tests actually exercised. A package that carries a
   `urlcode.json` descriptor is managed by its npm spec
   ([independent extension packages](#independent-extension-packages)):
   `extensions add <spec>` installs, re-running it upgrades, and `remove` takes
   it out; core's release catalog and `upgrade` never move it. A private
   operator module without a descriptor is wired by hand and stays invisible to
   descriptor-only tooling. Do not override the development catalog to
   impersonate a managed release add-on.

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
  contract: 1, // the URLCode extension contract it is built for
  targets: ['node'],
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
Pass the host for a private operator module like this one: it has no
package and no `urlcode.json`, so validation without `--host-file` cannot see
its schemas. Descriptor-only discovery covers every direct dependency of the
site that carries a `urlcode.json` at its package root, whatever its name or
scope: a first-party add-on pinned by core, or an
[independent package](#independent-extension-packages) pinned by its npm lock
integrity. It reads only those top-level descriptors, never walks transitive
dependencies and never imports a package.

An external author should publish configuration/policy schemas, hook contracts,
`authoring` surfaces and fast checks in the registration, plus the
[extension contract](#the-extension-contract) it is built for, supported
targets and lifecycle cleanup instructions. Test the packed
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
| Purpose | Executable operator code: routes, mounts, route policies, hooks | Inert JSON, YAML and Markdown data for tooling: schemas, example configuration, OpenAPI documents |
| Source | `packages/<name>` | `artifacts/<name>` |
| Package | `@jimhoyd/urlcode-<name>` | `@jimhoyd/urlcode-<name>` |
| Descriptor | `urlcode.json`, generated from the extension's code | `urlcode.json`, written by hand |
| Wired into `host.mjs` | Yes, one import and one list entry | Never; nothing imports it |
| Commands | `urlcode extensions …` | `urlcode artifacts …` |

Every add-on is an npm-packable workspace carrying a static `urlcode.json`
descriptor: `{kind, name, description, contract, requires, uses?, targets,
schema?, policySchema?, hooks?, authoring?}`. `contract` is required for both
kinds: the [extension contract](#the-extension-contract) the package is built
for. For an extension the descriptor is written from its
`defineExtension` definition by `npm run build:addons`, and CI fails when the
committed file differs, so tooling can read an extension's schemas and
contracts without running any of its code. `targets` is required for an
extension: the deployment targets (`node`, `aws`, `vercel`, in that order) its
definition declares. `composeHost` refuses a `host()` whose registration
declares different targets, and the capability preflight reads the descriptor's
`targets` so a recipe or project that uses the extension on a target it does not
declare is `refused` there, before any host file is loaded (#859). An artifact descriptor carries only
`kind`, `name`, `description`, `contract`, `requires` and, optionally, `agent`
and the [`documents`](#artifact-documents) it ships. `npm run build:addons`
stamps a first-party artifact's hand-written descriptor with the contract core
implements.

Add-ons are versioned in lockstep with core. Only core is published to npm;
each add-on is released as a tarball on the same GitHub Release as core. The
release build writes `addons.json` into core's own `dist/`: for every add-on its
name, kind, `requires`, download URL and sha512 integrity. That file is the
only install catalog. Trust in core's npm provenance therefore extends to every add-on
it installs, and there is nothing else to verify, cache or lock: the site's
ordinary `package-lock.json` records each tarball, and the add-on commands
check it against core's pin.

The first-party add-ons are:

- Extensions: `audit`, `auth`, `store`, `mcp`.
- Artifacts: `store-schema`, the `store` extension's configuration schema and an
  example configuration. Its schema is generated from the store extension's
  definition by `npm run build:addons`, so the two cannot drift.

`urlcode extensions available` and `urlcode artifacts available` list what the
running core pins.

### The extension contract

Core implements one URLCode extension contract, an integer exported as
`extensionContract` from `@jimhoyd/urlcode/extensions` (#844). It covers
everything a package relies on from core: the `urlcode.json` descriptor format,
`defineExtension` and `composeHost`, the registration and activation interfaces
and the rest of the `@jimhoyd/urlcode/extensions` exports. It moves only when
that contract changes incompatibly, never with core's own semver: a core
release that only adds to the contract keeps the same integer, so a package
does not need a new release for every core release.

Every descriptor declares `contract`, and every `defineExtension` definition
declares the same value. There is no range. A contract version that changes
only on breaking changes has nothing in between to span, and a range such as
`>=1 <3` would claim compatibility with a contract nobody has tested. Core
refuses any package whose `contract` differs from its own, naming both:

```text
Refusing @example/urlcode-beyond: @example/urlcode-beyond@3.0.0 is built for
URLCode extension contract 2, but this core implements extension contract 1;
install a version of it built for contract 1, or a core that implements contract 2
```

The contract is checked at every point where a package enters the site or runs:

- `extensions add` and `artifacts add` read it from the installed descriptor
  before any extension entry is imported, and roll the install back.
- `extensions list --strict` and static `validate` report it for every
  installed or declared extension. The inert checks behind `artifacts list`,
  inspection and `upgrade` refuse an artifact with the wrong contract.
- `defineExtension` refuses a definition that omits it or declares another
  value. `composeHost` checks it again before any `host()` runs, so a
  definition made by another copy of core, or shaped by hand, cannot skip the
  check.

For first-party packages, `npm run build:addons` writes `contract` into each
extension's `urlcode.json` from its definition, and refuses to build one that
does not declare the contract core implements. Core's own catalog is one
release, so its entries carry no separate contract.

### The release-wide agent catalog

Beside `addons.json`, core's `dist/` carries `addon-catalog.json`: agent
discovery metadata for every extension and artifact of the same release, built
from each add-on's `urlcode.json` descriptor. Each entry has the add-on's
`name`, `kind`, `package`, `version`, `description`, `requires`, an
extension's `targets`, for an
artifact that lists them its [`documents`](#artifact-documents) (each `path`
and `mediaType` only, never contents, at most 32) and, when the descriptor
declares one, its `agent` block (a description and references whose `path` is
relative to that add-on's package) and an extension's `authoring` contract,
which `plan-feature` matches a goal against before the extension is installed:

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
      "documents": [{ "path": "schemas/config.json", "mediaType": "application/schema+json" }, "…"],
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
authoring service can present every add-on's agent metadata, and which standard
documents each artifact ships, from its pinned core without installing the
add-ons. Reading a document's contents still needs the installed artifact
(`urlcode artifacts inspect`).

The catalog is release-wide discovery. An add-on appearing in it is not
evidence that a project installed or activated it. What a project has installed
stays a local concern: MCP `get_addon_agent_tooling`, `get_extension_artifacts`
and, with the operator host, `get_extensions`. The descriptor does not record
whether an extension ships an `--example`; the catalog does not either.

Every first-party extension declares `agent` references, and at least one of
them is its `README.md`, which ends with the generated
[field reference](EXTENSION-REFERENCE.md). `npm run check` fails when an
extension has none, or names a file its package does not ship, so an installed
extension always appears in `get_addon_agent_tooling`.

### The site layout

`urlcode init <directory>` always writes one layout:

```text
<directory>/
  app/                  route project: urlcode.yaml, routes/, functions, tests/
  host.mjs              trusted operator host (outside app/)
  package.json          exact core pin, add-on tarball URLs, npm scripts
  package-lock.json     after npm install
  addon-files.lock.json sha256 of every installed add-on file, written by add (commit it)
  AGENTS.md  .mcp.json  Makefile  .github/workflows/urlcode.yml
  data/                 operator data, secrets and keys (gitignored)
```

`host.mjs` starts with an empty list; each `extensions add` adds one import and
one entry:

```js
import { composeHost } from '@jimhoyd/urlcode/host';
import auth from '@jimhoyd/urlcode-auth/extension';
import store from '@jimhoyd/urlcode-store/extension';

export default await composeHost(import.meta.url, [
  auth(),
  store(),
]);
```

That is the host after `urlcode extensions add auth store`. Operator options
go inside the call, for example `auth({signUp: true})`. The
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
| `urlcode extensions add <package spec or tarball>…` / `urlcode artifacts add <package spec or tarball>…` | Adds an [independent extension](#independent-extension-packages) or [artifact](#independent-artifact-packages) package the operator chose, outside core's catalog |
| `urlcode extensions remove <name>` / `urlcode artifacts remove <name>` | Removes one add-on |
| `urlcode extensions list [--strict]` / `urlcode artifacts list [--strict]` | Reports what is installed and whether it matches core's pins and its [installed file record](#the-installed-file-record) |
| `urlcode extensions verify [<name>] [--online]` / `urlcode artifacts verify [<name>] [--online]` | Compares the installed files with the [installed file record](#the-installed-file-record), offline; `--online` also re-downloads each locked tarball and compares file by file |
| `urlcode extensions outdated` / `urlcode artifacts outdated` | Reports, for each independent package, the newest registry version its spec resolves to; see [upgrading an independent package](#upgrading-an-independent-package) |
| `urlcode artifacts inspect <name> [--strict]` | Reports, offline, the standard documents an installed, pin-verified artifact lists; see [inspecting artifact documents](#inspecting-artifact-documents) |

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
on `/api/todos` (per-user `ownership: owner` when `auth` is installed); audit,
auth and mcp ship none.

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
requirement, installed files that differ from the
[installed file record](#the-installed-file-record), or an artifact that is not
inert.

An installed extension package that neither `app/urlcode.yaml` declares nor
`host.mjs` imports as `<package>/extension` is a library install: another
package or your own code depends on it, and it is not wired as an extension.
`list` shows it as `(library)` (`"mode": "library"` with `--json`; wired
extensions are `"extension"`, artifacts `"artifact"`). Its package.json URL,
lock integrity and resolved URL are still checked against core's pin, and
nested copies still fail, but the missing declaration and import are not drift.
As soon as either file names it, the other must agree.

`urlcode init <directory> --with auth,store [--example] [--ack extension:id]` is `init`
followed by `extensions add` for those names; a refusal undoes the whole init.
A failed npm run reports npm's own last lines, and a pin or integrity mismatch
names the add-on (`Refusing <name>: …`). When an installed extension's entry
cannot be imported, the error has code `addon-load`, quotes the import failure
and says whether the add-on catalog and the site's core come from different
builds: the usual cause is `URLCODE_ADDONS` pointing at add-on tarballs packed
from a newer checkout while the new site pins the registry release of the same
core version. Point the site's `@jimhoyd/urlcode` dependency at the core tarball
packed beside those add-ons, or unset `URLCODE_ADDONS`, then run
`urlcode init <directory>` and `urlcode extensions add <names>` separately.

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
`upgrade` records the moved add-ons' files again. It never moves an
independent package: the operator's npm spec, not core's catalog, pins it, and
[re-running its `add`](#upgrading-an-independent-package) is its upgrade.

Add-on command-line tools are ordinary npm bins once installed in the site, for
example `npx urlcode-auth migrate` or `npx urlcode-store members list ...`.

### The installed file record

npm keeps no tarball for a registry install, only the lock's sha512 and the
unpacked files, so nothing local could re-hash an installed package against
its pin. `extensions add` and `artifacts add` therefore write
`addon-files.lock.json` at the site root: for every add-on package they
install (released or independent), its add-on name and kind, the npm spec an
independent package was added with, the version, integrity and resolved URL
from `package-lock.json`, and the sha256 of every file in its
`node_modules/<package>` directory (its own nested `node_modules` excluded).
A linked directory (a development install or a `file:` directory) is recorded
as linked and not hashed, since its files change with its source. The file
lives beside `package-lock.json` and is committed and reviewed with it: it is
outside `node_modules`, which it describes, and outside `app/`, so it is not
part of the project revision. `remove` deletes the package's entry (and the
file once it is empty), `upgrade` records the moved add-ons again, and every
rollback restores it.

`list --strict`, `artifacts inspect` (and MCP `inspect_extension_artifact` and
`get_extension_artifacts`) and `verify` compare the installed files with the
record, offline, and report the added, removed and changed paths (up to 20 of
each, with counts). A package with no record, or whose `package-lock.json`
entry no longer has the recorded version and integrity (npm moved it outside
`urlcode … add`), is a problem too. Inspection of a modified artifact is
refused. To put the published files back, run `npm ci --ignore-scripts`.

```sh
urlcode artifacts verify                      # offline: files against addon-files.lock.json
urlcode artifacts verify petstore-docs --online
```

`verify` exits 1 on any difference. `verify --online` is a network operation
and runs only when asked: for each package it downloads the tarball from its
`package-lock.json` `resolved` URL (a `file:` tarball is read from disk),
refuses it unless its sha512 matches the lock's integrity, and then compares
it file by file with the installed files and with the record. A private
registry that needs credentials is not supported; the failure is reported.
The record is only as trustworthy as the moment it was written: it catches a
later edit, not a package that was already bad when it was installed. A
package installed some other way (for example by `npm install` from a committed
`package.json`) has no record until it is named to `add` again, which records
its files as they are then, so run `npm ci --ignore-scripts` first.

### Upgrading an independent package

Running `urlcode extensions add <spec>` or `urlcode artifacts add <spec>` again
for an independent package that is already installed upgrades it in place:
npm installs what the spec resolves to now (`--ignore-scripts --save-exact`),
and every check `add` makes runs again: a valid descriptor of the same kind,
no first-party name, a sha512 lock integrity, an artifact still inert (and on
a locked site, no other new lock entry). The descriptor may not change the
add-on's name; remove it and add the new one instead. An upgraded extension
keeps its `extensions.<name>` block, routes and `host.mjs` line: its new
`./extension` entry must still define it and its new descriptor must still
accept the project's declaration and route policies, or the upgrade is
refused. Its record in `addon-files.lock.json` is rewritten, and any refusal
rolls everything back exactly like a failed `add`. Re-adding a spec that
resolves to the version already installed changes nothing.

```sh
urlcode artifacts outdated                    # asks the registry; changes nothing
urlcode artifacts add @example/urlcode-petstore-docs@^1.4.0
```

`outdated` is informational and asks the registry (`npm view <spec> version`,
a network call this explicit command makes) for the newest version matching
each independent package's recorded spec, and prints the `add` command that
would move it. A path, URL or repository spec has no registry version to
compare, and a registry that cannot be reached is reported, never guessed.
`urlcode upgrade` never moves an independent package, so every change of what
the site trusts stays an explicit operator action.

### Independent extension packages

An extension does not have to be released with core (#844). Any npm package
that carries a valid `urlcode.json` extension descriptor at its root and a
`./extension` entry default-exporting `defineExtension(...)` can be added by
its npm spec or a local tarball:

```sh
urlcode extensions add ./example-urlcode-greeting-2.3.4.tgz
urlcode extensions add @example/urlcode-greeting@2.3.4
```

npm installs it with `--ignore-scripts --save-exact` and records its sha512
integrity in `package-lock.json`; that lock entry, not core's catalog, is its
pin. Core then reads the descriptor, never the package name, to learn which
extension it provides, and wires it exactly like a released one: the
`extensions.<name>` block, its scaffold's routes and files, and one
`import <name> from '<package>/extension'` line in `host.mjs`. `list`
reports it as independent (`locked by npm integrity`, or `linked, not
locked` for a `file:` directory), static `validate` checks its declaration
against its descriptor's schemas, and `remove` takes it out by name.

`add` refuses a package with no valid extension descriptor, a descriptor of
kind `artifact`, a descriptor or definition built for another
[extension contract](#the-extension-contract), a name that a first-party add-on of this core already has,
a `@jimhoyd/urlcode*` package (those install from core's pins), two installed
packages providing the same name, an independent extension whose
`requires` are not installed, and any package that brings a nested copy of
`@jimhoyd/urlcode` (bundled in its tarball or pinned to another version): a
site has one core, so every extension shares one `defineExtension` and one
contract. `list --strict` reports such a nested copy when it was installed some
other way. When two installed packages still provide one
name (for example after editing `package.json` by hand), the first by package
name is kept and the problem is reported once: by `extensions list` when the
package set aside is an extension, by `artifacts list` when it is an artifact.
An unreadable descriptor is reported by the list of the kind it claims, or by
`extensions list` when it claims none. Installing a
package runs no lifecycle script, but its `./extension` entry is trusted
operator code once `host.mjs` imports it: review it like any other code you
deploy.

### Nesting

Each extension declares what it needs:

| Extension | `requires` | `uses` (optional) | Contributes to |
|---|---|---|---|
| `audit`, `mcp` | none | none | |
| `auth` | none | none | |
| `store` | none | `audit` | |

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
requires or uses, and can read `active` on their exports. The order the extensions are declared in under `extensions` in YAML
does not matter. They close in reverse order.

Exports are typed and versioned (`version: 1`, plus `active`). `auth`
exports nothing to other extensions; it reaches them only through the
[request principal](#request-principal):

| Export | From | Read by |
|---|---|---|
| `AuditExports` | `audit` | producers (`attach` an outbox, `validate` an event; the store's audited collections) and readers (`query`, `record`) |
| `StoreExports` | `store` | no first-party reader: an ownership-honouring records API for an operator's own extension |

Two copies of one extension cannot exist in a site, so duplicate-instance bugs
cannot happen.

### Audit log

The `audit` extension keeps the one durable log of privileged actions. Its
guarantee: an event is written into the producer's own outbox in the same
transaction as the change it records (the `audit` array of an audited store
collection's data file), so a change and its
event are stored together or not at all. Audit drains every attached outbox
into `data/audit.sqlite` while the host runs, at least once and deduplicated by
event id, so nothing is lost across a crash. A producer fails closed: when its
outbox reaches its cap (`auditOutboxLimits`: 1000 per store collection) the
write answers 503 until audit catches up. The log keeps the newest `retention`
events (default 100000). Events carry names, ids and field names, never
submitted values or secrets. Operators read the log with `urlcode-audit list`.
See the [audit package](../packages/audit/README.md)
and its [security notes](../packages/audit/SECURITY.md).

### Rate limits

The core [`throttle` policy](policies/throttle.md) is YAML on any route,
including an extension mount: a fixed per-client budget on a bounded in-memory
table, the same on every target, reset on restart. Better Auth's own rate
limiter guards sign-in.

### The extension definition

Each extension package's `./extension` entry default-exports one definition:

```ts
import { defineExtension } from '@jimhoyd/urlcode/extensions';

export default defineExtension<MyHostOptions>({
  name: 'store',
  description: 'One line shown by `urlcode extensions available`',
  contract: 1,                // the URLCode extension contract it is built for
  requires: [],               // extension names that must be installed and declared
  uses: [],                   // optional: extension names read only when installed
  schema,                     // JSON Schema of extensions.<name>.config
  policySchema,               // optional: per-route policies.extensions.<name>
  hooks, authoring,           // optional project customization contracts
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
`host.mjs`. `ctx` is `{projectSha256, site, get}`: the reviewed
revision pin, the site directory and the exports of a required or used
extension (`undefined` for a used one that is not installed). It returns `{registration,
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
  registers an extension. Neither present refuses, naming both options and
  `urlcode permissions --project app`, which prints the revision.
- A read-only inspection command (`explain`, `plan-feature`, `context`,
  `review`, `report`, `studio`, `openapi`, `extensions`, `mcp`) with neither
  composes its registrations with an unpinned inspection revision instead
  (#910). They are reported as not pinned, and every activation refuses them
  (`revision-pin-required`), so an unpinned host can be read but never serve
  ([inspection without a revision pin](TOOLING.md#inspection-without-a-revision-pin)).
  The loader signals inspection through a second process-global slot,
  `Symbol.for('urlcode.host.inspection')`, set only while it imports the host file.

A `host()` hook reads the pin as `context.projectSha256` and registers it
unchanged, so the generated `host.mjs` needs no edit and existing host files
keep working. A hand-written host file that builds registrations without
`composeHost` still reads `PROJECT_SHA256` itself. The pin travels through a
process-global `Symbol.for('urlcode.host.operatorRevision')` slot that is set
only while the host file is imported, so a host file that imports another copy
of core still sees it.

The runtime checks the pin every time it builds a snapshot: a registration
whose `projectSha256` is not the project's live revision is refused with
`Extension revision pin mismatch: <name>`. `urlcode dev` has one narrow
exception so editing a project with `--host-file` does not end every hot
reload in that error (#777). The first `dev` start checks the pin strictly,
exactly like `serve`. After that, a hot reload accepts a registration pinned
to exactly the revision `dev` started from and activates it for the edited
revision (`context.projectSha256` is the new revision), logging one
`{"event":"extension_pin_followed","extensions":[...],"from":"<startup>","to":"<edited>"}`
record per reload ([observability](OBSERVABILITY.md#event-catalogue)). Every
other check still runs on each reload: the target, the contract version, the
configuration and policy schemas, origins and mounts. The registration object
is not changed, and no project YAML, environment variable, CLI flag or tool
argument can turn this on: `urlcode dev` alone enables it, through
`startServer`'s `followExtensionPinOnReload`. `serve`, `validate`, `test`,
`audit` and every other command, `app.reload()` on any other server, and the
hosted adapters keep the strict check. What `dev` ran is not reviewed: review
the edited project and pin its revision before `serve` runs it. `--policy`
grants are not followed; see
[local development](LOCAL-DEVELOPMENT.md#environment-and-troubleshooting).

The types are exported from `@jimhoyd/urlcode/extensions`
(`packages/core/src/extensions.ts` is the authoritative definition) and
`composeHost` from `@jimhoyd/urlcode/host`. The runtime contract, the
host-file trust boundary and the revision pin are the same whether an
extension came from `extensions add` or was wired by hand; YAML never chooses
code.

### Artifacts

An artifact package may hold only `package.json`, `urlcode.json`, notices at
its root (`LICENSE`, `LICENCE`, `NOTICE` or `COPYING`, optionally `.md` or
`.txt`), and JSON, YAML and Markdown files (`.json`, `.yaml`, `.yml`, `.md`)
under plain relative paths: no dotfiles, no symlinks, at most 128 files of
2 MiB each. Every JSON file must parse, and every YAML file must parse under
the inert-document YAML profile below. Its
`package.json` may declare only `name`, `version`, `description`, `keywords`,
`homepage`, `bugs`, `license`, `author`, `contributors`, `repository`,
`private` and `files`: any other key, including `main`, `exports`, `bin`,
`scripts`, `dependencies` and `peerDependencies`, is refused, and so is a
`package-lock.json` entry for the artifact that declares dependencies, peers,
a binary or an install script. Anything else is refused when the artifact is
installed and whenever it is listed. Artifacts are never imported by `serve`,
`validate`, `init` or the runtime, and installing `store-schema` does not
install or activate `store`.

Artifact YAML is third-party data, not project configuration, so it has its own
bounded profile, the same at install and at inspection; project YAML keeps
refusing anchors, aliases, merge keys and tags. The inert-document profile
allows anchors, aliases and `<<` merge keys, as shared OpenAPI fragments use
them, and refuses explicit tags and directives, more than 1,024 aliases, and an
alias to a collection that contains it. It measures the document as if every
alias were expanded, in one pass over the source and before building anything,
and refuses one that would expand to more than 10 times its own size or 16 MiB,
or nest deeper than 256 levels; a billion-laughs document is refused without
being expanded. Mapping keys may be strings, numbers or booleans (a status code
such as `200:` becomes the string `"200"`); duplicate keys, `__proto__` and
non-JSON or non-finite values are refused, and messages name a position, never
document content.

#### Artifact documents

An artifact's `urlcode.json` may list the standard documents it ships, so
tooling can find and verify them without a URLCode-specific layout:

```json
{
  "kind": "artifact",
  "name": "petstore-docs",
  "description": "Petstore API description and schemas",
  "requires": [],
  "documents": [
    { "path": "openapi/petstore.yaml", "mediaType": "application/vnd.oai.openapi" },
    { "path": "schemas/order.json", "mediaType": "application/schema+json" },
    { "path": "README.md", "mediaType": "text/markdown" }
  ]
}
```

`path` is relative to the package root (no `..`, no leading `/`, no hidden
segment) and must be a file the package contains. `mediaType` is one of a
closed set, each with the extensions it may carry:

| `mediaType` | Document | Extensions |
| --- | --- | --- |
| `application/vnd.oai.openapi` | OpenAPI, YAML | `.yaml`, `.yml` |
| `application/vnd.oai.openapi+json` | OpenAPI, JSON | `.json` |
| `application/schema+json` | JSON Schema | `.json` |
| `text/markdown` | Markdown | `.md` |
| `application/json` | JSON data | `.json` |
| `application/yaml` | YAML data | `.yaml`, `.yml` |

At most 32 documents are listed. The documents stay in their own standard
format; URLCode never repackages them into its own field syntax.
`store-schema` lists its JSON Schema, its example configuration and its README
this way.

#### Independent artifact packages

Like an [independent extension](#independent-extension-packages), an artifact
does not have to be released with core (#844). Any npm package carrying a
valid `urlcode.json` artifact descriptor at its root can be added by its npm
spec or a local tarball:

```sh
urlcode artifacts add ./example-urlcode-petstore-docs-1.4.0.tgz
```

npm installs it with `--ignore-scripts --save-exact`, so no lifecycle script
runs, and records its sha512 integrity in `package-lock.json`: that lock
entry is its pin. `add` then refuses it unless it is inert (the rules above),
declares the kind `artifact`, does not take the name of a first-party add-on
and is not a `@jimhoyd/urlcode*` package; adding artifacts to a site that has
a lock also refuses any other new lock entry. `list` reports it as
independent (`locked by npm integrity`, or `linked, not locked` for a `file:`
directory), and `remove` takes it out by name. When the package came from a
local tarball, `list --strict` and `inspect` also re-hash that tarball and
refuse when it no longer matches the recorded integrity (a replaced tarball or
a stale lock) or is missing. Like every add-on, its installed files are checked
against the [installed file record](#the-installed-file-record). `urlcode
upgrade` never moves an independent package; re-running `artifacts add
<spec>` is [its upgrade](#upgrading-an-independent-package).

#### Inspecting artifact documents

`urlcode artifacts inspect <name> [--json] [--strict]` (MCP
`inspect_extension_artifact {name}`, the same core function and the same
JSON) reads the documents an installed artifact lists, offline, and reports
for each one:

- `path`, the declared `mediaType`, the detected `kind` (`openapi`,
  `json-schema`, `markdown`, `json` or `yaml`) and `version`: the OpenAPI
  `openapi` (or `swagger`) value, or the JSON Schema `$schema` dialect, or
  `null` when the document declares none;
- `sha256` and `bytes` of the file as installed;
- `refs`: every `$ref` in an OpenAPI or JSON Schema document resolved inside
  the package, as `{at, ref, target}` with `at` the JSON pointer of the object
  carrying it and `target` `<package path>#<JSON pointer>`. A relative
  reference resolves against its base: the referring file's location in the
  package, or the `$id` of the nearest enclosing schema that declares one
  (JSON Schema documents and OpenAPI 3.1 Schema Objects; Swagger 2.0 and
  OpenAPI 3.0 schemas have no `$id`). A relative `$id` keeps the base inside
  the package, and one that would leave it makes every reference relative to
  it a `path-escape`; an absolute `$id` makes the references relative to it
  remote, so they are reported and never fetched. A reference to a schema
  resource the same file identifies (the file itself, or an embedded schema's
  `$id`) resolves to that subschema, and a same-document `#/…` pointer to the
  enclosing resource. A plain-name `$id` such as `#pet` is an anchor and sets no
  base. A package file reached only through a reference appears under
  `referencedFiles` with its own digest and references;
- only positions that can hold a reference are read: a `$ref` or `$id` inside
  instance data (JSON Schema `const`, `enum`, `default`, `example` and
  `examples`; an OpenAPI `example`, an Example Object's `value`, or a Swagger
  2.0 response's `examples`) is data, not a reference. A property, definition
  or component that is merely named like one of those keywords is still read;
- `diagnostics`, each with a `code`, `severity`, the `at` pointer and the
  `ref` as written: `remote-ref` (warning: a reference with a scheme or
  authority, listed and never fetched), `unsupported-ref` (warning: a
  plain-name `#anchor`), `ref-cycle` (warning: legal for a recursive schema,
  reported once and not expanded), and the errors `unresolved-ref`,
  `path-escape` (a reference leaving the package directory), `symlink`,
  `invalid-document` and `limit`.

The result also names the artifact's origin: package, version, whether it is
independent, the lock's `integrity` and `resolved` values and how they were
verified (`catalog-pin`, `development`, `local-tarball` or `lock-integrity`,
the last meaning npm's recorded integrity, not re-checked offline), and `files`,
the comparison with the [installed file record](#the-installed-file-record)
(`match`, or `linked` for a development link). Inspection is refused unless the
artifact is inert, pin-verified and unmodified; a `file:` directory link is not
pin-verified. `artifacts verify --online` is the explicit way to re-check a
registry install against its published tarball. `--strict` exits 1 when any document has an error diagnostic.

Inspection never imports package code, runs a lifecycle script, fetches a
reference, follows a symlink, leaves the package directory or creates a grant.
It is bounded: 1 MiB per document or referenced file, 64 files and 8 MiB read
in total, 1,024 references, reference chains of 32 and object nesting of 256;
anything beyond a limit is reported as a `limit` diagnostic, never silently
dropped. Document text, titles, descriptions and `$ref` values are
third-party data: the result carries a `notice` saying so, and an agent must
treat that content as untrusted, never as instructions. Inspection does not
validate data against a JSON Schema or export OpenAPI.

Agent tooling reads installed artifacts from the site's `node_modules` without
gaining write or execution authority. MCP `get_extension_artifacts` lists each
installed artifact, released or independent, whether it is pin-verified, its
files and its listed documents; `get_extension_artifact {name, path}` returns
one bounded JSON, YAML or Markdown file from an installed, pinned artifact,
labelled as untrusted data. Feature planning (`urlcode plan-feature`, MCP
`plan_feature`) also sees them. The CLI equivalents are `urlcode artifacts
list --json` and `urlcode artifacts inspect <name> --json`.

#### Staging source assets

Component and skill formats that already exist are not artifacts: a shadcn
registry item ships `.tsx`/`.ts` source, and an Agent Skill ships `SKILL.md`
agent instructions and often `scripts/`. `urlcode artifacts stage` reports
what such a source would put into a site, as data, and nothing more (#844). It
does not claim the source satisfies the inert-artifact contract above, and a
staged source cannot be added with `urlcode artifacts add`.

```sh
urlcode artifacts stage ./vendor/hello-card/registry-item.json [--into DIR] [--json]
urlcode artifacts stage ./vendor/pdf-notes --into ./vendor/skills
urlcode artifacts stage ./vendor/pdf-notes --materialize --into ./vendor/skills
```

The source is a local path, read offline:

- a shadcn [registry item](https://ui.shadcn.com/docs/registry/registry-item-json):
  a `.json` file, or a directory holding `registry-item.json`. Each
  `files[]` entry is read from its inline `content` or from its `path` beside
  the item file. Its target is its `target` (with `~/` meaning the
  materialization directory and `@components/`, `@ui/`, `@lib/`, `@hooks/`
  mapped to shadcn's default `components/`, `components/ui/`, `lib/` and
  `hooks/`), or else the default directory for its file type; no
  `components.json` is read;
- an [Agent Skill](https://agentskills.io/specification): a directory holding
  `SKILL.md`. Its frontmatter is parsed under the runtime YAML profile and
  checked against the specification (`name`, `description`, `license`,
  `compatibility`, `metadata`, `allowed-tools`); every file is staged under
  `<name>/`.

The report (the same JSON from MCP `stage_source_assets`) gives:

- `source`: the detected `format` (`shadcn-registry-item` or `agent-skill`),
  its `schema` (the item's `$schema` URL as declared; neither format has a
  version number, and the Agent Skills specification has no version field),
  the specification URL and the descriptor's sha256;
- `item`: the name, type, title, description and version (`meta.version` or
  `metadata.version`) as declared;
- `files`: every file it would write, with `source`, `target` (relative to the
  materialization directory), `sha256`, `bytes`, `mediaType` and `class`:
  `code` (by extension, including HTML, SVG and WebAssembly, anything under a
  skill's `scripts/`, a `#!` line or an execute bit), `data`, `docs` or
  `other`. `review` is true for code and unclassified files. A skill's
  `SKILL.md` has the role `agent-instructions`. With `--into`, each file's
  `status` is `create` or `exists`;
- `dependencies` (npm `dependencies` and `devDependencies`, each with what the
  site's `package.json` already declares) and `registryDependencies`
  (classified as a name, namespaced, GitHub, URL or local reference). They are
  listed, never installed, resolved or fetched, so a registry dependency's
  files are not in the report. `install` holds the `npm install
  --ignore-scripts` commands an operator could run after review, for plain
  `name[@version]` specs only;
- `styles`: a shadcn item's `cssVars`, `css`, the deprecated `tailwind`,
  `envVars` and `font`, as declared: data, never applied or written;
- `skill`: a skill's `license`, `compatibility`, `metadata` and
  `allowed-tools`, as declared; tools a skill asks to pre-approve are reported
  and never granted;
- `notice` and `inertNotice`: every source string, `SKILL.md` and all other
  prose included, is untrusted data, never instructions, and staging does not
  make code inert;
- `diagnostics`: the errors `path-escape` (any `..` segment), `absolute-path`,
  `hidden-path` (a dot segment in a target), `symlink`, `not-a-file`, `limit`,
  `remote-url` (a file path that is a URL), `missing-target`,
  `duplicate-target`, `invalid-field` and `invalid-source`, and warnings for
  unknown fields, remote dependency URLs (listed, never fetched), unresolved
  registry dependencies or `extends`, deprecated fields, hidden skill entries
  (not staged), a skill name that differs from its directory and pre-approved
  tools. The command exits 1 when there is an error.

Staging never imports or runs a file, runs a lifecycle script, fetches a URL,
follows a symlink or installs a package. It is bounded: 256 files, 1 MiB per
file, 8 MiB in total, 8 path segments, 512-character paths and 256
dependencies; a file past a limit is an error, never silently dropped.

`--materialize --into DIR` is the separate opt-in that writes the staged files.
It refuses a source with any error diagnostic, any target that already exists
(nothing is overwritten), an existing path segment that is a symlink or not a
directory, a directory that overlaps the source, and a directory that is or
contains the site's `app/` (whose files can be served or executed) unless
`--allow-app` places reviewed files there deliberately. It writes exactly the
staged bytes, without an execute bit, and is all or nothing: on any failure
every file and directory it created is removed. It never installs a
dependency; it prints the `install` commands instead. The MCP tool never
materializes.

### Validation and CI

`urlcode validate` without `--host-file`, on a project that declares
extensions, checks each `extensions.<name>.config` and each route's
`policies.extensions.<name>` statically against the installed packages'
`urlcode.json` schemas. No extension code runs. Pass `--host-file host.mjs` to
activate the extensions and validate the whole runtime.

The [GitHub Action](CI.md#what-it-runs) installs the site with `npm ci
--ignore-scripts` (a committed `package-lock.json` is required), runs `urlcode
extensions list --strict` and `urlcode artifacts list --strict`, then validates
the project. Without a `host-file` input it validates declared extensions
statically and skips `test` and `audit` when the project declares extensions;
with one it computes `PROJECT_SHA256` for that CI run only.
