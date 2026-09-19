# Project direction

This page states the product boundary: what URLCode is, what it is not, how
application projects relate to the runtime, and the license it is released
under. It describes intent and
boundaries, not a delivery schedule; the [roadmap](../ROADMAP.md) owns sequence
and the [readiness register](RELEASE-READINESS.md) owns what is proven.

## What URLCode is

A portable runtime for programmable URL behavior. A project declares its public
URL surface in YAML, adds JavaScript only where declarative handlers are
not enough, and runs the same definition locally, in a container, or on operator
infrastructure. That JavaScript runs trusted, in the host process, like any
other project code, unless the project isolates a specific route with
`sandbox: true` (docs/SPIKE-DEFAULT-TRUST-MODEL.md) — a judgment call the
project makes per route, not a default the runtime imposes on all guest code.
The project format is deliberately bounded so a runtime can
validate it, inspect it, test it and eventually carry it across hosting providers.

Git owns route definitions and code. Operators own credentials, storage and
capability grants. Application data stays in the operator's systems.

## What URLCode is not

- **Not a URL shortener.** Core is redirects, validated responses, request
  functions, middleware, pages, static assets and downloads. Stored short
  links are moving to a future `urlcode-dynamic-link` extension package
  (mount-based, like `auth`/`admin`, not yet published), not a core handler.
- **Not a general Node web framework.** There is no framework code to write
  for routing, validation, middleware wiring or policies — those are declared
  in YAML and enforced by the runtime. Function/middleware code that needs
  isolation from the host (untrusted input, an unreviewed contribution, a
  particularly sensitive secret) opts into `sandbox: true`, which runs it
  inside WASM isolation with no ambient filesystem, network or Node APIs.
  Behavior that cannot be expressed in the bounded contract of a sandboxed
  route is rejected rather than emulated.
- **Not a hosting account system.** There is no end-user identity, billing or
  public account surface. Management is a private operator API.
- **Not a provider configuration format.** Provider infrastructure settings do
  not belong in route behavior YAML. A project must remain runnable on a laptop
  or in a single container wherever else it is deployed.

## Application projects

Applications built on URLCode are ordinary consumers of the public runtime.
They exist to prove the contract is sufficient in practice, and they get no
private fork or privileged capability. If an application needs something the
runtime cannot express, that is a gap in the public contract to close in the
open, not a reason for a special path. See the [roadmap](../ROADMAP.md).

## Why: your AI should build your application, not your framework

Coding agents are good at infrastructure, so they build it every time: routing,
sessions, validation, middleware, security headers, static serving, redirects,
webhooks, admin plumbing, deployment glue, tests. The application the person
asked for arrives last, and the person then owns twenty thousand lines instead
of two thousand. Cheap generation makes unnecessary code cheap to create and
expensive to keep.

URLCode's answer is the one databases gave a generation ago. Nobody asks a
model to write B-tree traversal; it writes `SELECT * FROM customers WHERE id = ?`
and the database owns the machinery. One level up, a route should read

```yaml
/admin:
  auth: { required: true, roles: [admin] }
  function: { source: functions/admin.mjs }
```

and the runtime should own how. The agent describes what; URLCode owns how.
YAML is not the innovation and neither is the runtime. The innovation is a
small, deterministic vocabulary that is optimized for two readers at once: the
person who opens `urlcode.yaml`, and the agent that writes it.

Three tests keep this from becoming a YAML replacement for every framework:

- **The boundary test.** Is an agent repeatedly generating this code across
  unrelated projects? If yes, it is a candidate primitive, policy, recipe or
  extension. If no, it stays application code.
- **The feature test.** Does this reduce what the agent has to know, generate,
  debug or maintain? If yes, it belongs on the roadmap. A feature that exists
  because other web frameworks have it does not.
- **The evidence test.** The framework grows from measured repetition, not
  from a list of things applications might need.

The metric that matters is the **application-specific code ratio**: of the
lines an agent generated, how many are the idea and how many are plumbing. A
traditional build might be 2,900 lines of business logic inside 18,400; the
same application on URLCode should be the same 2,900 inside a few thousand.
Until a reproducible benchmark shows that ratio, the thesis is a hypothesis,
and [next steps](NEXT-STEPS.md) puts the benchmark before the features.

## License

The runtime is free and open-source software under the
[Apache License 2.0](../LICENSE). Contribution terms follow from the same
license; see [contributing](../CONTRIBUTING.md).

The license covers the runtime source in this repository. It grants no rights in
any application's own routes, content or data, and it is not a warranty or a
production-readiness claim — those are set by the
[readiness register](RELEASE-READINESS.md) and [security policy](../SECURITY.md).
