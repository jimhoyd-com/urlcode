# Security

Application functions are **untrusted by default**. Alpha.2 replaces direct Node
execution with QuickJS/WebAssembly isolation. Worker threads alone are not the
security boundary. There is no unrestricted host-execution fallback.

Guests have no Node, filesystem, shell, network or ambient process-environment
access. Each invocation gets fresh state and bounded resources. Imports stay
inside a snapshotted project module graph. Binding grants come from operator
policy outside the project and are pinned to the configuration/code revision.
See the [security model and policy instructions](docs/FUNCTION-SECURITY.md).

The host/runtime and sandbox engine still require patching, independent review
and deployment-level resource limits. The stable self-hosted release is not a claim of an audited multi-tenant
execution platform. Authorized inputs/secrets can be exposed
by code receiving them; grant the minimum required authority. Do not deploy
older snapshots for untrusted functions; review and upgrade to the current revision.

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

See the [internal security reviews](docs/SECURITY-AUDIT.md) — most recently
2026-09-17 — for fixed findings and remaining gates. Use a current reviewed commit: the shared 0.3.0
version label alone does not identify which hardening patches are present.
