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

Which request headers a route's own `function`/`middleware` receives depends
on what the operator activated. Each active operator extension (declared in
the project and provided by the host) withholds `Cookie` and `Authorization`
plus every header it declares in `credentialHeaders`; an operator plugin withholds the headers it declares. The
runtime strips those names from the guest-facing projection (headers, header
inputs and arguments) of every route before that code runs. Without such an
extension or plugin nothing is withheld: your own trusted middleware or
function reads `Authorization` and `Cookie` like any other header, which is how
the [middleware recipe](recipes/middleware/README.md)'s bearer and Basic
examples work. The projection keeps a credential away from code that does not
need it; it is not confinement of trusted Node code, which runs with full
process access. An extension's
`authorize()`/`middleware()` gate can hand a *derived*, non-secret value
forward into that same guest-facing context — never the credential itself —
through the reserved `x-urlcode-context-*` request-header namespace, which
the runtime always strips from what a client actually sent before any
extension or guest code observes it, so a request can never inject or spoof
a value there (`packages/core/src/extensions.ts`:
`stripReservedContextHeaders`, docs/RUNTIME-IMPLEMENTATION.md
`RIM-EXT-CONTEXT-001`). This is a generic core channel with no built-in size or shape
limit beyond ordinary HTTP header limits; an extension writing into it is
trusted operator code and is expected not to place a credential or unbounded
data there.

The first-party `auth` extension, a thin adapter over Better Auth, does not
use that header channel. On a route with `auth: true` it lets the request
through only after Better Auth verifies the session from the request's cookie
(and, for `POST`, `PUT`, `PATCH` and `DELETE`, after core's same-origin rule
admits it), then hands the route's code only the verified user id, through
the request-bound `identity` capability
(`context.capabilities.auth.identity.userId`; `RIM-EXT-CAPABILITY-001`). The
route still never receives the `Cookie` or `Authorization` header, no session
token or role is included, and a `sandbox: true` route cannot name `auth`.
Identity is not permission: authorization stays in the application. See the
[auth package's security model][packages/auth/SECURITY.md] and
[request-bound capabilities][docs/EXTENSIONS.md#request-bound-capabilities].

Declarative proxy and signal handlers run in a separate bounded host transport;
they do not grant guest networking. They require per-route, per-purpose HTTPS
origin grants pinned to the project revision. Every connection checks public
addresses and pins DNS, refuses redirects, filters headers and limits resources.
See [egress semantics and limitations][docs/EGRESS.md]. Build-time TypeScript
transpilation and read-only MCP do not execute project code in the host. The
MCP `run_tests` tool does execute it (trusted functions, middleware and
extensions, with full Node access), so it exists only when the operator starts
`urlcode mcp --allow-authoring`.

Add-on packages are trusted by pin, not by review. A released add-on is pinned
by the sha512 in core's own `addons.json`; an independent package the operator
adds by npm spec or tarball is pinned by its `package-lock.json` sha512. Every
install passes `--ignore-scripts`, an extension's `./extension` entry is
trusted operator code once `host.mjs` imports it, and an artifact must stay
inert data (its YAML parsed under a bounded profile that refuses tags and
alias-expansion bombs). `add` records the sha256 of every installed file in
`addon-files.lock.json`, and `list --strict`, `artifacts inspect` and `verify`
check the installed files against it offline: that catches a later edit, not a
package that was already malicious when it was installed. `verify --online`
re-downloads the locked tarball and compares it only when explicitly asked,
and an independent package moves only when the operator re-runs its `add`
(`urlcode upgrade` never moves it). See
[the installed file record][docs/EXTENSIONS.md#the-installed-file-record].

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
network controls and restricted operational endpoints. See [operations][docs/OPERATIONS.md].
A server bound to loopback refuses, with 421 and before routing, any request
whose `Host` is not a loopback name on its bound port, the `--origin`
authority or an operator `--alias-origin` authority, so a DNS-rebinding page cannot reach it as same-origin. A
non-loopback bind (including the container image's `0.0.0.0`) and the
platform-fronted AWS, Vercel and Cloudflare targets are not checked, and a
runtime embedded in another framework is checked only when its host passes
`loopbackHost`; see
[host admission][docs/OPERATIONS.md#host-admission-on-a-loopback-bind].

Use a current reviewed commit: a shared version label alone does not
identify which hardening patches are present. Internal source-review details are
maintainer material, not an independent assessment; the public security model,
reporting path and outstanding assessment gate are the authoritative claims on
this page and in [the sandbox review][docs/SANDBOX-REVIEW.md].

<!-- urlcode-current-version:start -->
[packages/auth/SECURITY.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/packages/auth/SECURITY.md
[docs/EXTENSIONS.md#request-bound-capabilities]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/EXTENSIONS.md#request-bound-capabilities
[docs/EGRESS.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/EGRESS.md
[docs/EXTENSIONS.md#the-installed-file-record]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/EXTENSIONS.md#the-installed-file-record
[docs/OPERATIONS.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/OPERATIONS.md
[docs/OPERATIONS.md#host-admission-on-a-loopback-bind]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/OPERATIONS.md#host-admission-on-a-loopback-bind
[docs/SANDBOX-REVIEW.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/SANDBOX-REVIEW.md
<!-- urlcode-current-version:end -->
