# Operator-installed extensions

Extensions are trusted operator modules, separate from application WASM. Auth
and admin implementations live in `urlcode-auth` and `urlcode-admin`; the runtime
supplies only the generic integration contract. No project file can import a host
extension or choose its npm package.

Stored short links are moving out of core this way too: a future
`urlcode-dynamic-link` package (mount-based, like `auth`/`admin`, not yet
published) will own the durable link store, its CLI and management API. Core
no longer has a native `link` handler or a `dynamicLinks` project flag.

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
`freshWithinSeconds`, `onDeny`); the runtime adds nothing of its own. Loading
fails, naming the route, when `auth` appears without an `extensions.auth`
declaration, next to `policies.extensions.auth`, or next to
`policies.extensions: false`.

The same shape is reserved for the cache policy: a future `cache: {strategy,
maxAge}` route key may expand to `policies.cache` in the same pass. It is not
implemented; declare `policies.cache` today (see [policies](POLICIES.md)).

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

Cloudflare refuses extensions until its artifact format supports their execution.
Node adapter conformance is not a live-provider deployment claim.

## Discovering schemas

Each registration carries the JSON Schemas that validate its `config` block and
its per-route policy requirements. `urlcode extensions` prints them together with
the project's own declarations so an author can see what a mount accepts:

```sh
urlcode extensions --project ./site --host-file /absolute/operator/host.mjs [--json]
```

For every registration in the host file it reports the name, contract version,
targets, credential headers, configuration schema, policy schema (if any),
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

`urlcode init <directory> --with auth,admin` produces the layered site the
[framework page](FRAMEWORK.md#the-composition-contract) describes in one
command: the starter under `<directory>/app/`, one `host.mjs`, one `README.md`,
and each extension's own operator files. Core never bundles or imports the
extension packages at build time; at run time it resolves
`@jimhoyd/urlcode-<name>` for each name with Node's package resolution from
the invoking directory (so `npm install @jimhoyd/urlcode-auth` in that
directory, from npm where the packages are published as `0.1.0-alpha.x`
prereleases, is the normal path and what makes `--with auth` work), imports
the package and calls its
`scaffold` export with this request:

```ts
interface ScaffoldRequest {
  directory: string;        // absolute site directory; result file paths are relative to it
  project: string;          // absolute route project, <directory>/app (holds urlcode.yaml)
  hostFile: string;         // absolute combined host module, <directory>/host.mjs
  names: readonly string[]; // every name in --with order, including this one
}
interface ScaffoldFile { path: string; content: string | Uint8Array; mode?: number }
interface ScaffoldResult {
  name: string;                            // must equal the requested name
  extensions: Record<string, unknown>;     // merged into the project's top-level extensions
  routes: Record<string, unknown>;         // merged into app/routes/extensions.yaml
  hostImports: string[]; hostSetup: string[]; hostEntries: string[]; hostClose?: string[];
  files: ScaffoldFile[];                   // written relative to directory with their modes
  readme: string; nextSteps: string[];     // README section and numbered steps
  env?: Record<string, string>;            // environment variables the host reads
}
```

`scaffold` writes nothing; it returns fragments and may generate key material
in memory (core zeroes `Uint8Array` contents after writing or on failure). The
types are exported from `@jimhoyd/urlcode` for packages that want to typecheck
against them.

Assembly rules, in `--with` order:

- Every package is resolved and every `scaffold` is called before anything is
  written. A name that is not installed refuses with the `npm install` command;
  a package without a `scaffold` export refuses and names the package; an error
  thrown by a `scaffold` (for example admin without auth in the same `--with`)
  is reported as that package's refusal. No directory is left behind.
- `extensions` fragments are declared in `app/urlcode.yaml`; `routes`
  fragments are written to `app/routes/extensions.yaml`, appended to the
  starter's `includes`, so the starter's own routes load first. A route or
  extension key produced twice, or one the starter already declares, is refused
  naming both sources.
- `host.mjs` is all `hostImports`, then all `hostSetup` lines, then an
  `extensions` array of every `hostEntries` item, then `close()` running the
  `hostClose` statements in reverse `--with` order so later entries release
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

Serving the result is the usual explicit host binding:

```sh
urlcode validate --project app --host-file "$PWD/host.mjs" --origin https://site.example
```
