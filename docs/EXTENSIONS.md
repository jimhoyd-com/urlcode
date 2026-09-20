# Operator-installed extensions

Extensions are trusted operator modules, separate from a project's own
`function`/`middleware` code. Auth
and admin implementations live in `urlcode-auth` and `urlcode-admin`; the runtime
supplies only the generic integration contract. No project file can import a host
extension or choose its npm package.

Stored short links moved out of core this way too: a `urlcode-dynamic-link`
package (mount-based, like `auth`/`admin`) owned the durable link store, its CLI
and management API. That package has since been retired and unpublished, so no
supported stored-link extension ships today. Core no longer has a native `link`
handler or a `dynamicLinks` project flag.

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

Cloudflare refuses extensions until its artifact format supports their execution.
Node adapter conformance is not a live-provider deployment claim.

## Project-level lifecycle hooks

`authorize` and `middleware` let core call *into* an extension. They do not
let a project hand its own code *to* an extension to run at a defined point.
That gap matters once an extension has meaningful lifecycle events —
registration, deletion, an administrative action, a link resolution, and so
on. Presentation already has a standard layering mechanism for this: a
project customizes an extension's *look* through `urlcode-ui`'s
`copy`/`extra.css`/`templates` without forking it. Behavior needs the same
standard, or every extension author (and every project depending on one)
either reinvents it or forks the extension. `urlcode-auth` and
`urlcode-admin` independently hit this gap (auth/#35, admin/#32); auth's own
[SPIKE-AUTH.md](../packages/auth/docs/SPIKE-AUTH.md)
already scoped a shape for `onSignUp`/`beforeRegister`/`onDelete`.

**The pattern.** An extension with lifecycle events an author judges worth
exposing should let the project name its own function in the extension's own
`config`, using the same source shape `function`/`middleware` routes already
use (a string path, or `{source, export, args}` — `schemas/urlcode.schema.json`),
and add its own `sandbox` boolean next to it (below). The extension's own
`activate()` reads that config, and its own runtime dispatch — not a new core
primitive, an ordinary call the extension package makes with the request
context it already has — invokes the named function at the lifecycle point
it defines, with a typed input and a typed verdict the extension's own
schema documents. For example, an auth-style extension might declare:

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
`{email, traits}`-shaped input and returning a typed verdict (`{allow: true}`
or `{allow: false, reason}`), and `onSignUp` called after, for side effects
such as provisioning a workspace. The exact hook names, input/verdict shapes
and invocation points are the extension's own design — `hooks` is not a core
schema key — but the source/export/sandbox shape, and the fact that this is
project code the extension calls rather than an operator callback in
`host.mjs`, should be consistent across extensions so an author who has
learned one has learned the pattern.

**Trust and execution mode.** Project-level lifecycle hooks are first-party
project code, the same category as any `function`/`middleware` route, and
follow the same trusted-by-default rule with no special case
(docs/SPIKE-DEFAULT-TRUST-MODEL.md, [FUNCTION-SECURITY.md](FUNCTION-SECURITY.md)):
trusted, in-process execution by default; a project sets `sandbox: true` on
a given hook to opt that hook into isolated QuickJS/WASM execution, exactly
the mechanism `function`/`middleware` routes already use and for the same
reason — the hook's own code, not the trustworthiness of whatever triggered
it, is what calls for isolation (docs/AI-AUTHORING.md's "Deciding when a
route needs `sandbox: true`"). This was raised as an open question — whether
a lifecycle hook should always run sandboxed because it makes a
security-relevant decision — and settled the other way: uniformity with the
rest of the trust model was chosen over hardwiring isolation for lifecycle
hooks specifically, the same "no special case" call already made between
`function` and `middleware` trust. A `beforeRegister` hook enforcing "only
`@acme.com` may register" is the project's own governance rule over its own
signup flow; it is not more dangerous than any other route the project
wrote, and does not get a different default.

Core's own trusted/sandboxed dispatch (`TrustedFunctions`/`FunctionPool`,
`src/runtime.ts`) is wired to route dispatch, not exposed to extensions — but
each half of a hook's `sandbox: true` opt-in has its own answer:

- **Trusted (the default, no `sandbox: true`).** No core primitive is needed
  or provided: this is ordinary first-party project code, and the
  extension's own `activate()` already has `ExtensionActivation.root` to
  resolve the hook's `source` against and can `import()` it directly, the
  same way any trusted `function`/`middleware` route does. Do that import
  with a per-activation cache-busting query, the way core's own trusted
  route activation does (`src/trusted-functions.ts`): Node's ESM loader
  caches a resolved module forever by URL, so a plain `import()` of the
  unchanged file URL makes a second activation in the same process keep
  serving the hook code that was on disk at the first one
  (jimhoyd-com/urlcode#198). Only the hook's **entry** module is refreshed
  this way — modules the hook itself imports stay on Node's module cache,
  the same limitation the trusted route path has, so a change to a hook's
  own dependency still needs a process restart.
- **Sandboxed (`sandbox: true`).** `@jimhoyd/urlcode/sandbox` exports
  `SandboxPool`, the same QuickJS/worker-thread engine that backs a
  sandboxed `function`/`middleware` route — the identical module-allowlist
  walk, memory/stack limits, two-layer deadline enforcement, `maxBytes` and
  response-shape validation, with no separate or weaker engine for
  extensions. It takes an explicit list of `{source, export}` entries
  (resolve a hook's `source` string with the re-exported `functionFile()`,
  the same resolution/validation a native route's `source` gets) instead of
  anything route/YAML-shaped, and `execute({entry, chain}, request, context)`
  in place of a `FunctionRoute`. There is no "trusted" mode exported
  alongside it — `SandboxPool` is only ever the isolated path; see
  [FUNCTION-SECURITY.md](FUNCTION-SECURITY.md) and
  [TYPESCRIPT.md](TYPESCRIPT.md) for the full contract.

An extension honoring a hook's `sandbox: true` is expected to actually
isolate that invocation through `SandboxPool` now that the primitive exists
(or document plainly that it does not yet, rather than accepting the field
and silently running it trusted) — say which, in the extension's own docs,
so an author reading them is not misled about what opt-in exists.

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

`urlcode init <directory> --with ui,auth,admin` produces the layered site the
[framework page](FRAMEWORK.md#the-composition-contract) describes in one
command: the starter under `<directory>/app/`, one `host.mjs`, one `README.md`,
and each extension's own operator files. Core never bundles or imports the
extension packages at build time; at run time it resolves
`@jimhoyd/urlcode-<name>` for each name with Node's package resolution from
the invoking directory (so `npm install @jimhoyd/urlcode-auth` in that
directory, from npm where the packages are published as `0.1.0-alpha.x`
prereleases, is the normal path and what makes `--with ui,auth` work), imports
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

### Recorded versions

`init --with` also writes `<directory>/package.json`: a private manifest that
pins, at exactly the version that was resolved, the running runtime, every
extension named in `--with`, and every package those extensions declare in
`peerDependencies` (so `@jimhoyd/urlcode-ui` is pinned for an `auth,admin` site
although nobody named it). Before anything is written, the whole set is checked
against every declared peer range; an incompatible combination or a missing
required peer refuses and names it, leaving no directory behind.

Nothing is installed. The generated site has no `node_modules` and no
`package-lock.json` until you run `npm install` in it yourself, which the
command and the generated README both state as the next step. Reproducibility
comes from that install, not from generation.

- `--no-manifest` generates the site without a `package.json`, for a site whose
  dependencies are managed elsewhere. Plain `urlcode init` is unchanged and
  still writes no manifest; add `--manifest` to pin the runtime for a
  route-only project too.
- `--pin <package>=<specifier>` records a specifier instead of the resolved
  version, for local tarball or offline development
  (`--pin @jimhoyd/urlcode-auth=file:/abs/urlcode-auth-0.1.0-alpha.6.tgz`). A
  package installed from a local path or tarball is detected from npm's own
  install record and pinned by that path without any flag; the README says so,
  because such a pin only reproduces where that path exists.

There is no upgrade command. Moving a generated project to newer versions today
means editing its `package.json` and re-running `npm install` yourself; nothing
in this runtime selects a newer tested set, shows the change, or updates a
lockfile for you.

Serving the result is the usual explicit host binding:

```sh
urlcode validate --project app --host-file "$PWD/host.mjs" --origin https://site.example
```
