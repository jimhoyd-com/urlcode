# Project direction

This page states the product boundary: what URLCode is, what it is not, how
application projects relate to the runtime, and the license it is released
under. It describes intent and
boundaries, not a delivery schedule; the [roadmap](../ROADMAP.md) owns sequence
and the [readiness register](RELEASE-READINESS.md) owns what is proven.

## Design principle: declarative-first

> Use URLCode's highest-level declarative features whenever possible. Generate custom code only when the framework cannot express the requirement.

This is the default for human authors, coding agents, examples and framework
changes. Before writing application code, check the installed version's declarative
primitives, YAML configuration, policies, supported extensions and reusable recipes
or templates. Prefer the highest-level supported abstraction that satisfies the
requirement; do not recreate framework behavior in a lower-level handler.

Custom functions or middleware remain valid for application-specific behavior the
framework cannot express. Keep that code focused, explain the missing capability,
and report reusable gaps to the owning repository. Never invent YAML fields or
bypass target limits, sandbox isolation or operator grants to avoid custom code.

## AI builds; humans retain understanding

AI can generate application code faster than a person can reliably absorb it.
The problem is not only whether that code works; it is whether someone can still
understand, review, change and safely operate the application afterward.

URLCode keeps the decisions a reviewer must understand — public URLs, inputs,
policies, access rules, declared capabilities and execution mode — in a small,
deterministic YAML contract. An AI should use that contract for repeated web
mechanics and write custom code only for the application-specific behavior the
runtime cannot express.

Humans remain the reviewers and operators. They choose the intended behavior,
review the declarative diff and focused custom code, decide whether code is
trusted or isolated, and approve credentials and external authority. AI
accelerates construction; it does not remove the human responsibility to
understand what will run and what it may access.

The goal is not YAML for its own sake. It is a reviewable source of truth: a
compact description that both people and agents can read, validate, test and
carry across supported deployment targets.

## Evolve the contract from application evidence

URLCode begins with the smallest contract that can support a real application,
then learns from repeatable application work. Representative tasks expose where
authors repeatedly generate plumbing, encounter an unclear authoring boundary,
or leave reviewers with too much generated code to understand.

Each observation has a deliberate outcome. Unique behavior remains application
code. Repeated behavior that reduces generated, debugged or maintained plumbing
may become a primitive, policy, recipe, extension surface or authoring
improvement. A capability that cannot be made safe, portable, reviewable and
testable within the contract is refused or remains outside the framework. A
single workaround or one successful run is not enough reason to expand the
public surface.

After an improvement, rerun the same representative work rather than assuming
it helped. Consider task completion, validation and test results, the amount of
application-specific code versus plumbing, the size of the review surface and
the number of correction cycles. These evaluations guide the roadmap; they do
not prove security, deployment readiness or operational fitness beyond the
evidence they actually supply.

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
  links are not a core handler; the `urlcode-dynamic-link` extension package
  that owned them has been retired and unpublished.
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

An application remains one product even when core, UI, auth, admin and other
extensions have separate package ownership. A product change should customize
the installed contracts and keep only its distinct behavior and presentation in
the project. It should not copy an authentication flow, administration console
or framework component merely to change its appearance.

Extensions publish their supported authoring surfaces for people and agents to
discover: configuration first, then theme/copy, component or template overrides,
project CSS and declared trusted hooks. A new extension is appropriate when the
missing behavior is a reusable application capability. Repeatedly ejecting or
rebuilding package-owned behavior is evidence that the public contract needs a
smaller customization surface.

Fast feedback is part of the contract. Project theme, copy and component changes
should not rebuild unrelated framework packages or restart durable services.
Each extension should publish focused checks for its surfaces; complete project
validation and tests remain the handoff evidence.

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
  auth: { role: admin }
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
and [the roadmap](../ROADMAP.md) puts the benchmark before the features.

## License

The runtime is free and open-source software under the
[Apache License 2.0](../LICENSE). Contribution terms follow from the same
license; see [contributing](../CONTRIBUTING.md).

The license covers the runtime source in this repository. It grants no rights in
any application's own routes, content or data, and it is not a warranty or a
production-readiness claim — those are set by the
[readiness register](RELEASE-READINESS.md) and [security policy](../SECURITY.md).
