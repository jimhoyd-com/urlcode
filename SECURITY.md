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
and deployment-level resource limits. This is an early alpha, not a claim of an
audited multi-tenant execution platform. Authorized inputs/secrets can be exposed
by code receiving them; grant the minimum required authority. Do not deploy
alpha.1 for untrusted functions; upgrade to alpha.2.

A supported-version and private vulnerability reporting policy still needs to
be established before a stable release. Do not put credentials or exploit-sensitive
reports in public issues. Bind loopback by default; protect public deployments
with HTTPS, rate limits, network controls and restricted operational endpoints.
See [operations](docs/OPERATIONS.md).

See the [internal security reviews](docs/SECURITY-AUDIT.md) — most recently
2026-09-17 — for fixed findings and remaining gates. Use a current reviewed commit: the shared alpha.8
version label alone does not identify which hardening patches are present.
