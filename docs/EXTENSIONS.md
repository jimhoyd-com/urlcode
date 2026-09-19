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
schema, optional policy schema and activation factory. Activation receives the
canonical operator origin, target, revision and mount bases. Its instance handles
bounded requests and, when used in policies, authorizes requests. Missing
registrations, stale grants, invalid configuration and unsupported targets fail
activation. Multiple mounts cannot overlap other declared routes.

For extension-protected routes, agents/throttle run before authorization and
cache access happens only after authorization. Extension routes and protected
routes reject cache strategies other than no-store; every resulting response is
forced to no-store after host response hooks. Compression is disabled on these
responses.

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
directory, from npm where the packages are published as `0.1.0-alpha.1`
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
