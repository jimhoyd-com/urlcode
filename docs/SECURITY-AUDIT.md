# Security review — 2026-09-16

Scope: source review of HTTP serving/management, log handling, filesystem and
configuration loading, sandbox/module/binding boundaries, stored-link pooling,
scaffolding, package/container configuration and current dependency advisories.
Local adversarial regression tests accompany fixes. This is an internal review,
not an independent penetration test or certification. No production systems,
third-party targets or external accounts were attacked.

## Findings fixed in this revision

| Finding | Impact and evidence | Fix / regression |
|---|---|---|
| Asynchronous log sink errors escaped request error handling | Availability: a local Writable reporting an async error terminated the process with an unhandled error event | Shared sink error handling suppresses further writes to a failed sink; synchronous failures also contained. Regression covers both failure modes and listener reuse |
| Management lacked bounded in-flight HTTP admission and socket inactivity enforcement | Resource exposure: connection limits alone did not bound active pipelined work or stalled output; public listener protections were absent here | Default 32 admitted requests through finish/disconnect, 10-second socket inactivity timeout, overload 503 and idempotent shutdown. Regression stalls an authenticated upload, checks overload, waits for disconnect, then verifies recovery |
| Development watcher read entire unrelated JSON/JS/YAML files | Local availability: a repository file outside the validated dependency graph could cause excessive allocations or fail watching solely because its contents were unreadable | Watch fingerprints use file metadata; actual configuration/source loading retains validation. Regression starts dev with an unreadable unrelated JSON file |
| Management had no request-level audit events | Operational visibility: mutations, authentication failures and aborted requests lacked structured records | Redacted events include timestamp, request ID, collection, action, authentication result, status and finish/abort outcome. Tests prove tokens, short codes and destinations are absent |
| Management accepted normalized dot-segment path aliases | Defense-in-depth: URL normalization admitted alternative endpoint spellings that could disagree with upstream path policies; no authorization bypass was demonstrated | Reject raw path normalization before endpoint dispatch; authentication still precedes path handling |

Management event status 0 means no response headers were sent before disconnect.
An aborted request may have committed a mutation: reconcile record/version before
retrying. These logs are best effort, may be dropped under pressure, identify a
shared collection credential rather than a human actor, and are not a durable,
tamper-evident audit journal. A failed sink needs collector/operator recovery;
URLCode cannot report failures reliably through the same broken output stream.

## Boundaries checked

- Guest code stays inside QuickJS/WASM, with fresh invocation state, denied host
  APIs, bounded modules/memory/deadlines and no unrestricted fallback. Import
  allowlists and external revision-pinned binding grants remain in force.
- Public serving cannot mutate the native link store. Management is a separate
  token-protected listener with conditional writes, scoped collection and bounded
  bodies. YAML requires explicit live-link opt-in; it cannot grant guest storage.
- SQL uses bound parameters; read/write pools have independent bounded admission,
  patched-SQLite checks, read-only serving and commit/version tests.
- Asset/scaffold paths reject traversal and unsafe filesystem references. Static
  publication is explicit; sensitive-name filtering is not a secret detector.
- Log output excludes request URLs, bodies, headers, tokens and user exceptions.
  Management adds safe operational context without logging stored destinations.
- `npm audit` reported zero known advisories on this date. This does not cover
  every Node, SQLite, WASM engine, operating-system or container vulnerability.

Existing and new automated tests cover these contracts; they do not constitute a
proof that the sandbox engine or complete application is vulnerability-free.

## Remaining gaps, prioritized

**Before exposing hostile multi-tenant workloads:** obtain independent review of
WASM/host boundaries, module loading and resource exhaustion. Configuration parsing,
route compilation and development loading still run on the host event loop. There
are per-file and route-count limits but no aggregate configuration-memory budget
or compilation CPU deadline. Keep operator-reviewed immutable projects, separate
process/container resource budgets and controlled activation. Do not expose an
anonymous code/config upload service on this alpha.

**Before production management exposure:** keep the listener private behind TLS
and ingress controls. There is no per-user identity/RBAC, token expiry/revocation
service, durable audit journal, built-in rate limiter or abuse detection. Rotate
by replacing credentials/restarting; shared-token audit events cannot attribute
individual operators. Short links themselves are not access controls.

**Before claiming operational readiness:** execute sustained mixed-workload soak,
backup restoration, disk-full, process-kill, proxy timeout and rollback drills on
the real deployment. Monitor disk/WAL growth, pool failures/rejections, RSS,
readiness, missing logs and restarts. SQLite is single-host; there is no automatic
multi-host failover or server-database adapter. Logging retention/rotation is owned
by the external collector and still needs deployment recipes and verification.

**Before a stable release:** establish a private vulnerability reporting/support
policy and patch response ownership. Release artifacts need immutable image and
dependency identities, upstream vulnerability monitoring and a reviewed update
process. At the audit cutoff, CI actions/base images used mutable version tags. The
repository-governance follow-up pins them and enables dependency maintenance,
secret protection, CodeQL and private reporting; see [governance](../GOVERNANCE.md).
No signed release/SBOM publication pipeline exists yet.

**Application responsibility:** HTML/JS assets are active browser content; choose
appropriate CSP, cookie flags, authorization and cache policy. Granted secrets
can intentionally be returned by code receiving them. Filename filters cannot
identify secrets stored under innocent names. Operator directories/volumes must
remain protected from other host processes; filesystem checks do not protect
against a privileged host attacker racing mutations.

See [release gates](RELEASE-READINESS.md), [function security](FUNCTION-SECURITY.md),
[operations](OPERATIONS.md) and [resilience](RESILIENCE.md). Free-product and
license boundaries are unchanged; no production readiness declaration is made.
