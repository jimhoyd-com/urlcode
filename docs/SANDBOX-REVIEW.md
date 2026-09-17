# Independent sandbox review gate

Status: **external assessment not performed**. Internal source review, CI, CodeQL
and adversarial regressions are useful evidence, not an independent sign-off.
Do not host anonymous hostile multi-tenant code before this gate is closed.
No unrestricted Node execution fallback is permitted.

## Review package

Freeze an exact runtime commit, lockfile, container digest, app/policy examples
with synthetic credentials, Node/SQLite/QuickJS/WASM versions and deployment
resource settings. Give a reviewer independent of the implementation access to:

- `src/functions.ts`, worker/guest implementation and `src/policy.ts`: VM creation,
  module graph, import denial, export validation, binding grants and message bridge.
- `src/config.ts`, `src/config-worker.ts`, router and assets: parser/schema limits,
  file containment, activation, memory amplification and host-side compilation.
- HTTP server, management API/policy and link-store worker: request smuggling,
  admission, body/response framing, authorization, revocation and atomic audit.
- `test/sandbox.test.js`, middleware/config/links/logging/reload tests, Dockerfile,
  protected workflows and `docs/FUNCTION-SECURITY.md`.

Run `npm ci --ignore-scripts`, `npm run verify`, `npm run test:package`, and
`node scripts/operational-drills.ts`. Record the exact commands and result files.
CI adds constrained-container and real disposable-volume exhaustion tests.
Use only disposable local/staging systems with synthetic data.

## Threat model and required probes

An attacker controls project YAML, included files, function/module source, public
requests, request bodies, exported values and static content. The operator controls
the host, deployment, external policy, credentials, database and project activation.
Guests receive only explicitly granted values; granted secrets can be returned by
that guest. QuickJS/WASM is the code boundary; worker threads alone are not.

Probe module cycles and loader escapes, malformed bridge messages, huge strings,
arrays and ArrayBuffers, deep prototypes, exceptions/getters, asynchronous jobs,
infinite loops, repeated worker replacement, capability confusion, cross-route
and cross-invocation leakage, parser/schema amplification, filesystem races,
slow peers, reload overlap and process/container exhaustion. Test unauthorized
management reads/writes, stale credentials, expiry boundaries, malformed policy,
CAS races, audit failures, poisoned databases and full disks. Verify native routes
and health/recovery remain useful after each bounded guest failure.

Trusted computing base includes Node/V8, QuickJS/WASM, bindings, dependencies,
OS/kernel, container runtime, secrets/policy administration and build infrastructure.
Current containment does not provide tenant CPU fairness, per-tenant process RSS,
networked microVM isolation, or a proof against engine vulnerabilities. Worker heap
limits exclude external buffers and do not replace a process/container memory cap.

## Closure criteria and deliverable

The maintainer records reviewer identity/independence, scope, dates, tested commit
and environment, methodology, findings with reproductions, severity, remediations
and retest evidence. All critical/high boundary findings must be fixed and retested;
residual risks require explicit owner acceptance. Publish a sanitized assessment
summary and retain exploit details privately through GitHub security advisories.
Reopen review for new capabilities, engine/bridge changes or major isolation changes.
An external review is necessary here, but still does not certify production capacity.
