# Concepts

The vocabulary URLCode's other pages assume. Read this once before the YAML
guide or the framework page; it does not introduce new behavior, only the
words the rest of the docs use for behavior described in full elsewhere.

## Route, handler, middleware, policy, extension

A **route** is one key under `routes:` in `urlcode.yaml`: a path plus exactly
one **handler** that decides what the route does — `redirect`, `respond`,
`page`, `static`, `download`, `function`, `proxy`, `conditional`, or an
`extension` mount. There is no "no handler" route and no route with two
handlers.

**Middleware** is code that runs before and, if it calls `await next()`,
after a route's handler — logging, headers, short-circuiting a request. It is
declared per route in an ordered `middleware:` array, not registered globally.
See [middleware](MIDDLEWARE.md).

A **policy** is host-level, opt-in behavior around a route: `throttle`,
`agents`, `security`, `compression`, `cache`. Policies are declared under
top-level `policies` (project defaults), `profiles.<name>` (a reusable named
set), or a route's own `policies` (an override). Every policy is off until
declared. See [policies](POLICIES.md).

An **extension** is a trusted, operator-installed module — `auth`, `admin`,
`store`, `forms`, `ui` — that a project *references* by logical name under
`extensions:` and either mounts directly (`extension: auth`) or requires on
its own route with the `auth` short form. The project YAML never names an
npm package, a database, or a file path for an extension; the operator's host
file supplies the implementation. See [extensions](EXTENSIONS.md).

These compose in the order above: a request matches a route, its middleware
runs around its handler, policies wrap the whole thing at the host level, and
an extension either owns the route outright or is required by a policy the
`auth` short form expands to.

## Project vs operator

A **project** is `urlcode.yaml` plus the code and assets it references —
everything one author controls and commits. It declares *what it needs*:
which extensions, which bindings, which policies. It cannot grant itself any
of that.

The **operator** is whoever runs the project: they hold the host file
(`urlcode serve --host-file`) that wires real extension implementations to
the logical names a project declares, and the external, revision-pinned
policy (`--policy`) that grants a project's declared `env`/`secrets`/proxy
bindings. A project cannot read an environment variable, call an external
host, or activate an extension it declares just by asking in YAML — an
operator has to grant it, outside the project, pinned to the exact reviewed
project revision. This split is what makes a project portable: the same
`urlcode.yaml` runs unmodified against a different operator's grants. See
[function security](FUNCTION-SECURITY.md) for the binding-grant model in
full and [extensions](EXTENSIONS.md) for host-file wiring.

## Trusted vs sandbox

`function` and `middleware` route code runs **trusted** by default: in the
same Node process as the runtime, with full filesystem, network (`fetch`),
npm and Node builtin access — the same as any other code in that host. A
route opts into isolation with `sandbox: true`, which runs it in a separate
QuickJS/WebAssembly worker with a fresh heap per call, a text/JSON
`Request`/`Response` subset, and no Node, filesystem or network access of its
own.

Either way, the `env`/`secrets` a route's code is *handed* are exactly what
the route declares and an operator has granted — trust changes **where** code
runs, not **what context it receives**. Sandboxing is a per-route opt-in for
isolating code you do not fully trust, not a blanket guarantee the runtime
applies to all guest code, and there is no fallback from sandboxed to
trusted execution. See
[docs/SPIKE-DEFAULT-TRUST-MODEL.md](SPIKE-DEFAULT-TRUST-MODEL.md) and
[function security](FUNCTION-SECURITY.md).

## Bundle vs artifact

These are two disjoint, unrelated distribution channels under the same
`extension-bundles@v…`/`extensions@v…` naming pattern — do not conflate them:

- A signed **declarative artifact** (`extensions@v…`) is inert, read-only
  *data*: a configuration-schema snapshot and example an agent can fetch over
  the read-only MCP tools to see what an extension accepts, without that
  extension being installed or active. See
  [signed declarative artifacts](EXTENSIONS.md#signed-declarative-artifacts).
- A signed executable extension **bundle** (`extension-bundles@v…`) is a
  bounded, frozen Node module tree an operator explicitly installs
  (`urlcode extensions install …`) before a trusted host can load its code.
  Installing only verifies, caches and locks bytes; `urlcode init --with …`
  is the new-site composition path that also generates host activation. See
  [signed executable extension bundles](EXTENSIONS.md#signed-executable-extension-bundles).

An artifact never runs code and installing one does not install or activate
the corresponding bundle.
