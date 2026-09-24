# Security

Project `function`/`middleware` code is **trusted and unsandboxed by default**:
it runs directly in the host process, exactly like any other project code,
with full Node, filesystem and network access (docs/SPIKE-DEFAULT-TRUST-MODEL.md).
A route opts into isolation explicitly with `sandbox: true`, which dispatches
that route through the QuickJS/WebAssembly worker pool instead — unchanged
from the isolation this project has always provided, still the boundary to
reach for when a route's code specifically warrants it (input from a source
the project doesn't fully trust, a contribution nobody has reviewed, logic
handling an especially sensitive secret).

A `sandbox: true` guest has no Node, filesystem, shell, network or ambient
process-environment access. Each invocation gets fresh state and bounded
resources. Imports stay inside a snapshotted project module graph. Binding
grants — for a trusted route as much as a sandboxed one — come from operator
policy outside the project and are pinned to the configuration/code revision;
trusting a route's code by default does not grant it any `env`/`secrets` it
was not explicitly declared and pinned to receive. This is a claim about what
URLCode injects into `context.env`/`context.secrets` for a route, not an
access-control boundary on trusted code itself: a trusted (non-`sandbox`)
route runs with full Node access by design, so its own code can read
`process.env`, the filesystem or the network independently of anything the
binding grant declared or withheld. The grant only governs what URLCode hands
that code through `context`; it is not a restriction the code is confined to.
See the [security model and policy instructions](docs/FUNCTION-SECURITY.md).

The host/runtime and sandbox engine still require patching, independent review
and deployment-level resource limits. The stable self-hosted release is not a claim of an audited multi-tenant
execution platform. Authorized inputs/secrets can be exposed
by code receiving them; grant the minimum required authority. Do not deploy
older snapshots for untrusted functions; review and upgrade to the current revision.

A route's own `function`/`middleware` never receives the request's session
cookie or `Authorization` header, or any header an operator extension/plugin
declares as a credential (`credentialHeaders`): the runtime strips them from
the guest-facing projection before that code ever runs. An extension's
`authorize()`/`middleware()` gate can hand a *derived*, non-secret value
forward into that same guest-facing context — never the credential itself —
through the reserved `x-urlcode-context-*` request-header namespace, which
the runtime always strips from what a client actually sent before any
extension or guest code observes it, so a request can never inject or spoof
a value there (`packages/core/src/extensions.ts`:
`stripReservedContextHeaders`, docs/RUNTIME-IMPLEMENTATION.md
`RIM-EXT-CONTEXT-001`). `packages/auth`'s `bearer` gate uses it to expose a
verified API key's id/name/scopes, never the raw key, to the route it
protects. This is a generic core channel with no built-in size or shape
limit beyond ordinary HTTP header limits; an extension writing into it is
trusted operator code and is expected not to place a credential or unbounded
data there.

Declarative proxy and signal handlers run in a separate bounded host transport;
they do not grant guest networking. They require per-route, per-purpose HTTPS
origin grants pinned to the project revision. Every connection checks public
addresses and pins DNS, refuses redirects, filters headers and limits resources.
See [egress semantics and limitations](docs/EGRESS.md). Build-time TypeScript
transpilation and read-only MCP do not execute project code in the host.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/jimhoyd-com/urlcode/security/advisories/new).
Do not post exploit-sensitive details, credentials or customer data in public
issues. Include the affected commit, environment, minimal synthetic reproduction,
impact and any proposed fix. Avoid testing third-party or production systems.
There is no guaranteed response-time SLA or bug-bounty commitment.

## Supported security baseline

Only the current reviewed `main` revision receives fixes; historical commits,
starter branches and earlier releases are unsupported. Pin exact commits and
review updates rather than relying on the version label alone. There is no
LTS/backport promise yet. Changes ship through pull requests and automated checks;
confirmed issues use private coordination and a public advisory when appropriate.

Bind loopback by default; protect public deployments with HTTPS, rate limits,
network controls and restricted operational endpoints. See [operations](docs/OPERATIONS.md).

Use a current reviewed commit: a shared version label alone does not
identify which hardening patches are present. Internal source-review details are
maintainer material, not an independent assessment; the public security model,
reporting path and outstanding assessment gate are the authoritative claims on
this page and in [the sandbox review](docs/SANDBOX-REVIEW.md).
