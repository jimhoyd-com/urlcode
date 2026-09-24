# Operator-installed extensions

Extensions are trusted operator modules, separate from a project's own
`function`/`middleware` code. Auth
and admin implementations live in `urlcode-auth` and `urlcode-admin`; the runtime
supplies only the generic integration contract. No project file can import a host
extension, choose a bundle release, or choose an npm package.

Stored short links moved out of core this way too. Core no longer has a native
`link` handler or a `dynamicLinks` project flag, and the separate
`urlcode-dynamic-link` package that briefly replaced them is retired. Stored
short links are now declared through the `store` extension's
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
`initialize`/`ping`/`tools/list`/`tools/call` dispatch and error codes;
project YAML never carries JSON-RPC mechanics. It may be mounted with
`auth: true`. See the [mcp package](../packages/mcp/README.md).

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
cache busting. Hook entry bytes participate in the project revision, so editing
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

Start a new operator-installed extension package with
`npm run create-extension -- <name> [--from <existing-package>]`
(`scripts/create-extension.ts`). It scaffolds `packages/<name>` matching the
minimal shape of `packages/mcp`, `packages/forms` and `packages/store`:
`package.json`, `README.md`/`SECURITY.md`/`CHANGELOG.md`/`AGENTS.md`, a
`RuntimeExtension` source module and a real integration test, all as
placeholders to replace. `--from <existing-package>` forks an existing
package's file *shape* (its workspace-sibling peers, which optional docs it
carries) as a starting point -- never its source code, which stays specific
to that package. The tool only creates files; it does not run `npm install`
or add the new package to root scripts like `verify:workspaces`, both of
which stay a deliberate maintainer decision.

An extension package should export a registration factory and, when it supports
`urlcode init --with`, a side-effect-free `scaffold` function. The registration:

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

Consumers install the package, declare its YAML block and mounts/policies, and
register it in `host.mjs`. They modify it through declared configuration,
presentation layers and hooks. A fork is reserved for changing behavior the
extension has not exposed; that is evidence for a new declarative field or hook.
See [Composing a site](COMPOSING-A-SITE.md) for the complete ui/auth/admin example.

## Discovering schemas

Each registration carries the JSON Schemas that validate its `config` block and
its per-route policy requirements, plus its hook and authoring contracts. `urlcode extensions` prints them together with
the project's own declarations so an author can see what a mount accepts:

```sh
urlcode extensions --project ./site --host-file /absolute/operator/host.mjs [--json]
```

For every registration in the host file it reports the name, contract version,
targets, credential headers, configuration schema, policy schema (if any),
declared hook names, kinds, descriptions and input/output schemas, supported
authoring surfaces and their fast checks,
whether the project declares it, whether its `projectSha256` matches the current
revision, the routes that mount it and the routes whose policies require it.
Declared names the host does not register are listed as unregistered. The command
executes the trusted host module exactly as `validate` does, including its
absolute-path and outside-project rules, and calls `close` afterwards; it never
activates an extension and grants nothing. Without `--host-file` it lists only
the names the project declares and notes that schemas need the host file.

The same report is available as `inspectExtensions({project, hostFile?})` from
the package root and, for assistants, as the MCP tool `get_extensions`, which the
server advertises only when the operator started `urlcode mcp` with
`--host-file`. No tool argument can name a host file. See [TOOLING.md](TOOLING.md).

## CLI host binding

Use an explicitly named operator ES module outside the application directory:

```sh
urlcode serve --project ./site --origin https://site.example \
  --host-file /absolute/operator/host.mjs
```

The module default-exports `{extensions, plugins?, close?}`. It may import installed
operator packages, open their stores and read operator secrets. `close` releases
shared services when the CLI command finishes or the server shuts down. A runtime
reload closes extension instances but does not close caller-owned services. Host
modules are not watched or automatically rediscovered. Restart to update them.

The same explicit option is supported by dev, validate, test, routes, audit,
benchmark, extensions and mcp. These commands execute trusted host activation and may access its
store; read-only project inspection commands never implicitly load a host file.
Host-file paths must be absolute `.mjs`/`.js` files whose real path lies outside
the project, including after symlink resolution. This is an operator-code trust
boundary, not a JavaScript sandbox or an independent security review.

## Scaffolding with `init --with`

`urlcode init <directory> --with ui,auth,admin` produces the layered site the
[framework page](FRAMEWORK.md#the-composition-contract) describes in one
command: the starter under `<directory>/app/`, one `host.mjs`, one `README.md`,
and each extension's own operator files. Core never bundles or imports the
extension packages at build time. `--with` always requests **bundle
distribution**: no npm resolution happens, and no operator installs anything
before running the command. Core resolves and verifies a signed
`extension-bundles@v<tag>` GitHub Release for the requested names. Without
`--bundle-release`, it selects `extension-bundles@v<core-version>` directly.
That exact immutable tag is core's safe default; pass
`--bundle-release extension-bundles@vX.Y.Z` only to deliberately select a
different reviewed release. Core downloads each
verified `.tgz`, extracts it under `<directory>/.urlcode/extension-bundles/`,
then imports and calls its `scaffold` export with this request:

```ts
interface ScaffoldRequest {
  directory: string;        // absolute site directory; result file paths are relative to it
  project: string;          // absolute route project, <directory>/app (holds urlcode.yaml)
  hostFile: string;         // absolute combined host module, <directory>/host.mjs
  names: readonly string[]; // every name in --with order, including this one
  distribution?: 'npm' | 'bundle'; // --with always sends 'bundle'; 'npm' is reachable only from a package's own standalone quickstart CLI (urlcode-auth init, urlcode-admin init), never from --with
  acknowledgements: readonly string[]; // sorted, de-duplicated --ack <extension>:<id> values; always present, possibly empty
}
interface ScaffoldFile { path: string; content: string | Uint8Array; mode?: number }
interface ScaffoldResult {
  name: string;                            // must equal the requested name
  provides?: string[]; requires?: string[]; after?: string[]; conflicts?: string[]; // declarative composition, see below
  acknowledged?: string[];                 // the <name>:<id> acknowledgements this scaffold consumed
  routeNotes?: string[];                   // single-line comments written above this extension's routes
  extensions: Record<string, unknown>;     // merged into the project's top-level extensions
  routes: Record<string, unknown>;         // merged into app/routes/extensions.yaml
  hostImports: string[]; hostSetup: string[]; hostEntries: string[]; hostClose?: string[];
  hostBundleExports?: string[];            // named exports core binds from this extension's verified bundle; required for bundle distribution
  files: ScaffoldFile[];                   // written relative to directory with their modes
  readme: string; nextSteps: string[];     // README section and numbered steps
  env?: Record<string, string>;            // environment variables the host reads
}
```

`scaffold` writes nothing; it returns fragments and may generate key material
in memory (core zeroes `Uint8Array` contents after writing or on failure). The
types are exported from `@jimhoyd/urlcode` (`packages/core/src/extensions.ts`,
the authoritative definition) for packages that want to typecheck against
them.

### Extension and artifact CLI

Use the short, noun-first command groups for new automation and operator
instructions:

| Purpose | Executable extension bundles | Declarative artifacts |
| --- | --- | --- |
| Discover a catalog | `urlcode extensions available` | `urlcode artifacts available` |
| Install or change one | `urlcode extensions add <name>` | `urlcode artifacts add <name>` or `update <name> …` |
| Inspect the project's recorded installation | `urlcode extensions list` or `status` | `urlcode artifacts list` or `status` |
| Run a bundle's packaged CLI | `urlcode extensions run <name> -- <args>` | Not applicable: artifacts never execute code |

Both catalog releases are immutable. By default, `extensions available` and
`artifacts available` derive exact tags from the running core:
`extension-bundles@v<core>` and `extensions@v<core>`. This is URLCode's **safe
latest**: core is released only after those matching catalogs are available,
not by following a floating package-manager tag. The resolved project lock
still records exact catalog tags, source commits and archive hashes. Pass
`--bundle-release` or `--artifact-release` only when an operator deliberately
selects a different immutable catalog.

`urlcode extension-bundles list` remains the offline static list baked into
core for compatibility and typo suggestions. It is intentionally not an
authoritative versioned catalog and may differ from a newly published release.

`extensions add` verifies, caches and locks a bundle, but does not compose
or activate it in an existing project. For a new runnable composed site, use
`init --with`; it is the operation that also generates route declarations and
the trusted operator host. `artifacts install` and `update` only install inert
authoring data.

`extensions install` and `artifacts install` remain accepted compatibility
verbs. `extension-bundles` and `extension-artifacts` remain accepted compatibility
names for the corresponding lower-level commands (`extension-bundles list` is
the legacy spelling of the static bundle catalog; `inspect` is the legacy
spelling of `list`/`status`). They do not change the trust or locking model.
Without a subcommand, `urlcode extensions` still inspects registered runtime
contracts and schemas through the configured host; it is not this bundle
management interface.

### Discovering executable extensions

`urlcode extensions available` resolves `extension-bundles@v<core>` for the
running core, verifies that signed catalog, and prints every available bundle
with its actual version before you add it:

```sh
urlcode extensions available
```

The exact catalog is the authority `extensions add` and `init --with`
verify against. The legacy `extension-bundles list` command is static, baked
into core at release time from the same source that builds the signed bundles;
it answers instantly with no network call but can differ from the signed
catalog. Naming a bundle that is not in the live catalog refuses with the
valid names it did find, for example:

```
Extension bundle store is not in the signed catalog for extension-bundles@vX.Y.Z; valid names: admin, auth, ui
```

`--with` is an unordered set. Core sorts the requested names before calling
each `scaffold` (so `names` is the same for every spelling), then orders the
results from the optional declarative fields on `ScaffoldResult`:

- `provides`: capability names the extension offers (for example `ui.kit`);
  a capability must not equal an extension name.
- `requires`: extensions or capabilities that must be in the set and are
  placed before this extension. A missing one refuses, naming both.
- `after`: the same ordering, without requiring presence.
- `conflicts`: extensions or capabilities that must not be in the set.
- Risky-scaffold acknowledgements are one generic channel, not a flag per risk. The operator repeats `--ack <extension>:<id>` (both parts lowercase letters, digits and hyphens, for example `store:public-write`); core validates the syntax, de-duplicates and sorts the values and hands them to every scaffold as the opaque `ScaffoldRequest.acknowledgements` (always present, possibly empty). An extension reads only ids qualified with its own name. To require one it throws an `Error` whose message states the risk and that carries `acknowledgement: '<name>:<id>'`; core appends the exact re-run command (the same `--with`, `--pin` and `--no-manifest`, plus every `--ack` already given and the new one), so an agent meets the acknowledgement only when it reaches that risk and never needs it in advance. A scaffold that used one lists it in `ScaffoldResult.acknowledged`; core refuses any `--ack` that no scaffold listed (a typo, an extension not in `--with`, or an unneeded value), before anything is written, and refuses a scaffold that lists an id it was not given or that is not its own. Acknowledgements are never written to project YAML; they are visible in command history, and the extension should state the resulting model in its generated README. `routeNotes` (single-line strings) are written as comments above that extension's routes; core renders them and infers no policy. Core adds no per-extension flag or result field: a new risk needs only a new id in the extension that owns it. `--allow-public-write` was a store-specific predecessor of this channel; it was never in a published core release and is removed rather than aliased (see [store](STORE.md)).

Core topologically orders by these, taking the lexically smallest ready
extension first, so every permutation of the same set produces the same host,
`urlcode.yaml` activation order and README. A cycle or a missing requirement or
conflict refuses before anything is written, naming the extensions involved.
Core never adds an extension (auth or ui) and never infers security policy
from the set. Host setup should be self-contained (own identifiers, such as
`storeProjectSha256`) unless it declares `requires` for what it references.

Assembly rules, in the resolved order:

- Before any network call, every `--with` name (and the name given to
  `urlcode extensions add`) is checked against the bundles this core
  release builds, the legacy offline list `urlcode extension-bundles list`
  prints; a
  typo such as `auht` refuses locally with a `did you mean auth?` suggestion.
- Every requested bundle is resolved against the signed catalog and every
  `scaffold` is called before anything is written. A name that is not in the
  catalog for the resolved release refuses and lists the valid names found
  there (see [Discovering what's installable](#discovering-whats-installable)
  above); a bundle without a `scaffold` export refuses and names it; an error
  thrown by a `scaffold` (for example admin without auth in the same `--with`)
  is reported as that bundle's refusal. No directory is left behind.
- If the release fetch itself fails — the tag doesn't exist, or (for the
  auto-resolved default) hasn't published yet — the error names
  `--bundle-release <tag>` as the way to pin an explicit, already-published
  release instead, and notes that a core release's matching bundle release
  publishes on a separate workflow and can take a few minutes (commonly under
  ten) to appear after a brand-new core version ships. When GitHub cannot be
  reached at all, the error says so and names the release it was fetching.
- An attestation refusal quotes a short, sanitized excerpt of the `gh
  attestation verify` output together with the policy applied (signer
  workflow and `refs/tags/<release>` source ref), for example `expected
  SourceRepositoryRef to be refs/tags/…, got refs/heads/main`.
- `extensions` fragments are declared in `app/urlcode.yaml`; `routes`
  fragments are written to `app/routes/extensions.yaml`, appended to the
  starter's `includes`, so the starter's own routes load first. A route or
  extension key produced twice, or one the starter already declares, is refused
  naming both sources.
- `host.mjs` is all `hostImports`, then all `hostSetup` lines, then an
  `extensions` array of every `hostEntries` item, then `close()` running the
  `hostClose` statements in reverse resolved order so later entries release
  before what they built on. Setup lines share one module scope: admin's entry
  references the `service`, `csrfKey` and `projectSha256` identifiers that
  auth's setup defines, which is why `names` carries the full list.
- `files` are created exclusively (`wx`) with their `mode` (default `0644`),
  must stay inside the site directory and outside `app/`, and never pass
  through a symlink. Nothing generated is ever overwritten; an existing
  destination refuses like plain `init`.
- `README.md` holds the starter's README as a section, then each result's
  `readme` under `## Extension: <name>`, the merged numbered `nextSteps`, the
  merged `env` table and the project revision. The command prints that
  revision (`inspectExtensionRevision` of `app/`) with the instruction to
  review the project and pin it explicitly; the host is generated to require
  the pin, never to compute it.

### Recorded versions

`init --with` writes a private `<directory>/package.json` pinning the
running core, and `<directory>/urlcode.extension-bundles.lock.json` naming
the verified archives it resolved (by default from
`extension-bundles@v<core>`, or explicitly with `--bundle-release`). It does not add
extension npm dependencies. Before anything is written, the selected catalog
checks every required extension and core compatibility; a missing
requirement or incompatible bundle refuses and names it, leaving no
directory behind.

Nothing is installed. The generated site has no `node_modules` and no
`package-lock.json` until you run `npm install` in it yourself for core, which
the command and generated README both state as the next step. Bundle
reproducibility comes from the committed lockfile and frozen cache, not npm.

- `--no-manifest` generates the site without a `package.json`, for a site whose
  dependencies are managed elsewhere. Plain `urlcode init` is unchanged and
  still writes no manifest; add `--manifest` to pin the runtime for a
  route-only project too.
- `--pin <package>=<specifier>` is only for reviewed local source development.
  New first-party extension installs use the signed bundle release instead.

There is no upgrade command. Moving a generated project to newer versions today
means editing its `package.json` and re-running `npm install` yourself; nothing
in this runtime selects a newer tested set, shows the change, or updates a
lockfile for you.

Serving the result is the usual explicit host binding:

```sh
urlcode validate --project app --host-file "$PWD/host.mjs" --origin https://site.example
```

## Signed declarative artifacts

Core remains the npm-distributed runtime. The workspace extensions are not an
alternate npm channel. A release can additionally carry a small, **data-only**
extension artifact for tooling that understands its declared format. It is not
a Node module and cannot activate an extension, run a hook, replace a trusted
operator host, or grant a route any authority.

Install an artifact only from its immutable `extensions@v…` GitHub Release. The
published inert store configuration schema snapshot can be installed with:

```sh
urlcode artifacts available
urlcode artifacts add store-schema --project app
urlcode artifacts update store-schema --artifact-release extensions@v1.1.0 --project app
urlcode artifacts list --project app
```

The command downloads the signed `extensions-catalog.json`, verifies its
GitHub attestation against the dedicated artifact workflow in
`jimhoyd-com/urlcode`, the exact requested tag ref, and its own `commit` field
(bound to the attestation's cert-derived `--source-digest`, so a catalog whose
recorded commit disagrees with the commit that actually produced it fails
closed), then verifies the selected `.tgz` against that same bound commit.
Self-hosted-runner attestations are refused. The catalog pins its release tag,
source commit, filename and SHA-256; a catalog revocation refuses
installation. `gh` with support for attestation source-ref and source-digest
verification is therefore a required local dependency for this command.

The resulting `urlcode.extensions.lock.json` is the reproducibility boundary:
commit it with the project. Every locked artifact records its own catalog tag
and source commit, so updating one artifact cannot silently relabel another as
coming from a newer release. Extracted files live under
`app/.urlcode/extensions/<sha256>/` and are checked before extraction. Archives
are size- and file-count-bounded, reject links and traversal, and may contain
only `extension.json`, JSON configuration/schema data, and an optional README.
Any JavaScript, package manifest, install hook, native module, or unknown file
causes refusal. `inspect` re-hashes the cached archive and every extracted file,
reporting an entry as missing or invalid rather than trusting its directory
name. Updates are never automatic: review a newer immutable release and run
`update` explicitly.

Agent tooling can consume a committed lock without gaining write or execution
authority. MCP `get_extension_artifacts` validates the lock and cache and lists
the signed member paths; `get_extension_artifact {name, path}` returns one
verified, bounded JSON or Markdown member directly from the cached archive.
The CLI fallback is `urlcode artifacts list --project app --json`.
Neither MCP tool performs a network request, installs or updates an artifact,
loads a host file, or activates code. A missing or modified cache is reported
as missing/invalid and its contents are not returned.

This does not relax the existing host boundary. `--host-file` is still the only
way to load trusted operator extension code, and artifact files are never
imported by `serve`, `validate`, `init --with`, or the runtime.

Artifact versions are independent from npm package versions. The initial
`store-schema` artifact is a reviewed configuration-schema snapshot and example,
not the `@jimhoyd/urlcode-store` implementation. Installing it does not install
or activate that package. Its README names the separate executable and operator
requirements.

## Signed executable extension bundles

Official executable extensions are delivered through a separate, immutable
`extension-bundles@v…` GitHub Release namespace;
it is intentionally disjoint from the permanently data-only `extensions@v…`
artifact channel above. A bundle is a bounded, frozen Node module tree produced
from reviewed first-party source, not a general extension marketplace and not
a project dependency resolver.

An operator explicitly installs one named bundle from an immutable release:

```sh
urlcode extensions add store --project app
```

For a new composed site, `init --with` can perform that verified installation
before it writes the route project. This is the npm-free extension path: the
generated `package.json`, when requested, pins URLCode core only; the generated
host loads only the names recorded in the bundle lockfile.

```sh
urlcode init site --with ui,auth,admin  # defaults to extension-bundles@v<core>
```

`init` verifies each requested bundle in a temporary operator staging root,
obtains each scaffold from that verified module tree, then writes the cache and
`urlcode.extension-bundles.lock.json` into the new site. It never resolves an
extension package from npm in this mode. A failed verification or scaffold
refusal leaves no site directory behind. The release tag is still an explicit
operator choice; YAML cannot supply it.

The command verifies attestations for both the catalog and selected archive
against the requested tag and dedicated workflow, rejects self-hosted runners,
binds the catalog's own `commit` field to the catalog attestation's
cert-derived `--source-digest` (a mismatch fails closed before the field is
ever trusted), binds the selected archive's attestation to that same bound
commit, checks the filename and SHA-256, and extracts only regular files in
the signed module tree. It writes
`urlcode.extension-bundles.lock.json` and keeps the frozen bytes under
`app/.urlcode/extension-bundles/<sha256>/`. There is no automatic discovery or
update, and no fallback to npm. `inspect` reads the committed lock;
a modified cache or an incompatible core version refuses before import.

### Offline and local installation

`extensions add` first checks whether this exact bundle name and
`--bundle-release` tag are already recorded in the project's
`urlcode.extension-bundles.lock.json` and byte-for-byte identical to the
cache under `.urlcode/extension-bundles/<sha256>/` (the same re-hash `inspect`
and `loadExtensionBundle` perform). A match is reused with no network call at
all; a lock entry that names this release but whose cache was modified refuses
instead of silently reinstalling over it, since that would mask tampering.
This mainly helps re-running `install` (or `init --with`, in a project that
already vendors the same install) idempotently, not a fresh clone: a brand-new
site has no cache yet.

When there is no cache hit, pass `--bundle-release-path <local-directory>` to
both `extensions add` and `init --with` to read that exact
release's catalog and tarballs from a local directory instead of GitHub —
useful air-gapped, behind a restrictive proxy, or for a reproducible install
that does not depend on GitHub's availability at install time. `init --with`
must also receive its explicit `--bundle-release` so the directory name is an
intentional, reproducible override:

```sh
urlcode extensions add store \
  --bundle-release extension-bundles@vX.Y.Z \
  --bundle-release-path ./vendor/extension-bundles-vX.Y.Z --project app
```

The directory must hold flat files shaped like that GitHub release's own asset
list: `extension-bundles-catalog.json`, each bundle's `<name>-<version>.tgz`,
and — because verification must not be weaker offline than it is online — an
attestation bundle for every one of those files, downloaded ahead of time with
the GitHub CLI's own offline-verification support:

```sh
gh attestation download extension-bundles-catalog.json \
  --repo jimhoyd-com/urlcode -o ./vendor/extension-bundles-vX.Y.Z
gh attestation download store-X.Y.Z.tgz \
  --repo jimhoyd-com/urlcode -o ./vendor/extension-bundles-vX.Y.Z
```

`gh attestation download` names each bundle file after the artifact's digest
(`sha256-<hex>.jsonl`); the local transport looks up that exact name for the
catalog and for each tarball it downloads, and calls the identical `gh
attestation verify` policy the network path uses — same repository, signer
workflow, `refs/tags/<release>` source ref, self-hosted runners denied — just
pointed with `--bundle` at that file instead of letting `gh` reach the GitHub
API. Nothing is treated as pre-verified because it sits on local disk: a
missing attestation bundle, a tampered tarball, a catalog that does not match
the requested tag, or a revoked entry refuses exactly as it does over the
network, and names the `gh attestation download` command that produces the
missing file. `--bundle-release-path` and `--bundle-release` compose: the tag
still selects which release is being verified, the path only says where its
bytes and attestations come from.

### Running a locked bundle's own CLI

A bundle-only site has no npm dependency for a locked extension's own
command-line tool (`urlcode-ui doctor`, `urlcode-auth bootstrap`) --
`npx urlcode-ui` would fall through to the npm registry instead of this site's
verified bundle: the unscoped `urlcode-ui` name is unclaimed there (a 404),
and the scoped `@jimhoyd/urlcode-ui` package, while real, is a deprecated
migration artifact, not what the lockfile pins. `urlcode extensions run
<name> -- <args>` resolves that bundle's own packaged `bin` entry from its
locked, verified cache (the same integrity check `loadExtensionBundle` runs)
and spawns it with the given arguments and inherited stdio, so the tool that
ran only under npm distribution before now works from `--with` output too:

```sh
urlcode extensions run ui -- doctor --project app --copy ui/copy --templates ui/templates
urlcode extensions run auth -- bootstrap --operator-file "$PWD/operator-service.mjs"
```

Executable bundles are **trusted operator code**, exactly like a hand-written
operator host module. Project YAML cannot choose a bundle, name a release,
trigger a download, or grant a bundle authority. An operator host explicitly
loads a locked entry by name, then chooses which returned registration to pass
to `createRuntime`:

```js
import { loadExtensionBundle } from '@jimhoyd/urlcode/extension-bundles';

const { storeExtension } = await loadExtensionBundle('/absolute/site/app', 'store');
export default { extensions: [storeExtension({ directory: '/srv/site-data', projectSha256: process.env.PROJECT_SHA256 })] };
```

This does not make bundle code sandboxed and does not alter a route that
declares `sandbox: true`; those remain distinct execution modes. The signed
bundle path is the supported distribution for first-party executable
extensions. The legacy `@jimhoyd/urlcode-ui`, `@jimhoyd/urlcode-auth`,
`@jimhoyd/urlcode-admin`, and `@jimhoyd/urlcode-store` npm packages are
deprecated migration artifacts: existing projects may retain their locked
copies, but new projects must use a verified bundle release. Their npm
retention status is not a promise that they are available or supported for new
installs.

### Primitives-only entries, separate from host activation

A bundle name is not always a whole extension. Where a package has both a
host-activation entry (`createXExtension`, project-facing configuration
loaders, filesystem or store access) and a smaller surface of safe,
project-consumption primitives (escaping and rendering helpers, presentation
building blocks with no I/O), the extension can publish the primitives as
their **own separately named, signed catalog entry**, versioned and
integrity-locked independently from the host-activation entry. This never
exposes package internals and never makes the full package surface implicitly
public: only the names `scripts/prepare-extension-bundles.ts` explicitly
builds and `urlcode extensions available` prints are installable
(triage decision on [#522](https://github.com/jimhoyd-com/urlcode/issues/522)).

`ui-presentation` is the first such entry: it locks `packages/ui/dist/index.js`
(the root `.` export — `renderDocument`, `createPresentation`, `escapeHtml`,
`table`, `field`, `button`, `navigation`, `pagination`, `emptyState`, themes,
translations, and the rest of the Node-free presentation surface), never
`packages/ui/dist/host/index.js` (the `ui` bundle's host-activation entry:
`createUiExtension`, `loadProjectUi`, CSRF helpers). It ships through the
same signed `extension-bundles@v…` mechanism as `ui`, with its own asset,
SHA-256 and catalog row, so it can be installed and loaded without any of
`ui`'s host wiring:

```sh
urlcode extensions add ui-presentation \
  --bundle-release extension-bundles@vX.Y.Z --project app
```

```js
import { loadExtensionBundle } from '@jimhoyd/urlcode/extension-bundles';

const { renderDocument, table, escapeHtml } = await loadExtensionBundle('/absolute/site/app', 'ui-presentation');
```

The result loads straight into a plain trusted `function`/`middleware` route
(no `sandbox: true` needed for this, since it is ordinary trusted operator
code): no `host.mjs` entry, no `extensions.ui` configuration, no
`/assets/ui/*` mount. `ui-presentation` is a library entry, not a
scaffoldable extension: it is not meant for `init --with` (which resolves a
`scaffold` export named after the extension you asked for; `ui-presentation`
shares `ui`'s pure `scaffold` function, which still names itself `ui`, so
`--with ui-presentation` fails the "scaffold must return a result named
ui-presentation" check rather than doing something unexpected). Use `--with
ui` for the composed, host-activated extension, and `ui-presentation` only to
consume the primitives directly.

The triage decision applies this pattern across extensions wherever a
similar primitives-vs-host-activation split exists; only `ui-presentation` is
implemented today. Check `urlcode extensions available` for the current
set of names.
