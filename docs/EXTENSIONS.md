# Operator-installed extensions

Extensions are trusted operator modules, separate from application WASM. Auth
and admin implementations live in `urlcode-auth` and `urlcode-admin`; the runtime
supplies only the generic integration contract. No project file can import a host
extension or choose its npm package.

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
responses. The runtime withholds Cookie and Authorization plus any declared
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
