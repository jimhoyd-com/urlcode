# Security review — 2026-09-17

Scope: follow-up source review of worker/connection replacement, probe admission,
request correlation, operational logging, dependency/release supply chain and the
live-link Node requirement. Regression tests accompany the fixes. Internal review,
not an independent penetration test.

## Findings fixed in this revision

| Finding | Impact and evidence | Fix / regression |
|---|---|---|
| Function workers latched off permanently after bounded churn | Availability: replacement stopped after three exits in a minute and was never retried, so eight deadline-exceeded requests — reachable from ordinary request input to any function whose runtime depends on its input — disabled every function route for the life of the process. Reproduced against `serve`, which never reloads: `/fast` and readiness stayed 503 indefinitely | Replacement now backs off (250 ms doubling to a 30-second ceiling) and keeps retrying; a completed invocation clears the backoff. Load is shed while a slot is down, and `function_worker` events record each attempt. Regression drives eight deadlines, then asserts the pool serves and readiness returns to 200 |
| Link-store connections were never replaced | Availability: one operation reaching the five-second deadline, or any abrupt worker exit, terminated the connection with no replacement path, permanently failing that pool while the records themselves were intact on disk | Connections share the same backed-off replacement and emit `link_store_worker` events. Activation still fails closed and is never retried behind the caller. Covered by the existing 22-test live-link suite; the post-activation failure branch has no automated test because the worker could not be crashed deterministically from a test |
| Health probes bypassed admission control | Resource exposure: probes were answered outside the in-flight budget, an unmetered path on a public listener, and report the configuration digest and route count without authentication | Probes keep a separate bounded budget (16 by default) so they stay available under application saturation without being unmetered. Operations documents keeping them internal |
| Request correlation broke at the ingress, and logs could not attribute anything | Operability: `x-request-id` was always regenerated, so traces did not survive a proxy hop, and request records carried no method or route, leaving per-route error rates and abuse (including the exhaustion above) undetectable | Opt-in `--trust-request-id` accepts a single safe upstream value; `--request-log detailed` adds the method and the matched route pattern. Pattern and method come from reviewed configuration, never from request text. Regression asserts a spoofed ID is ignored by default and that path, parameter and query text never reach the log |
| Deployment capacity controls were unreachable from the supported deployment | Availability: workers, deadlines and byte limits existed only in the embedding JS API while the container entrypoint is the CLI, so the supported target was fixed at two function workers with no way to tune | `serve`/`dev` accept `--workers`, `--function-timeout-ms`, `--max-response-bytes`, `--max-body-bytes`, `--max-in-flight` and `--max-in-flight-health`, validated before the listener starts |
| Live-link tests failed rather than skipped on an unpatched Node build | Signal loss: a current Node 22 release bundling SQLite 3.51.2 turned 21 tests red for an environmental reason, hiding real regressions behind expected noise | The suite skips with the detected version named, one CI job asserts the suite actually runs somewhere, `doctor` reports `liveLinks`, and activation names the detected version |
| Release artifacts and dependencies were not gated | Supply chain: advisories were checked by hand on a date, and Actions and the container base image floated on mutable tags | `npm audit --omit=dev` fails CI on runtime advisories, Actions and the base image are pinned by SHA/digest, and Dependabot proposes npm, Actions and image updates weekly |

Replacement backs off but does not stop. A cause that keeps recurring keeps the
instance shedding load with readiness at 503 rather than recovering silently;
that is an operator signal, not self-healing. Alert on sustained
`function_worker` and `link_store_worker` restart events.

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
retrying. These logs are best effort, may be dropped under pressure, identify a configured credential ID (or a legacy shared token), and are not a
tamper-evident journal. Successful store mutations now have separate transactional
audit records; see [management security](MANAGEMENT-SECURITY.md). A failed sink needs collector/operator recovery;
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
WASM/host boundaries, module loading and resource exhaustion. The
[independent-review package](SANDBOX-REVIEW.md) defines scope and closure evidence.
YAML parsing now has an aggregate source cap and a bounded worker with a hard
wall deadline. Route compilation has a cooperative deadline; process-wide RSS,
individual host operations and overlapping snapshots still require deployment
limits. No anonymous code/config upload service is approved by these changes.

**Management remains private:** literal loopback binding, external per-credential
collection/action scopes, expiry and hot revocation, plus atomic SQLite mutation
audits are implemented. Legacy shared tokens remain for compatibility. There is
no public user-account system, MFA/SSO, built-in rate limiter, credential issuance
service or external tamper-evident archive. See [management security](MANAGEMENT-SECURITY.md).

**Before claiming operational readiness:** execute sustained mixed-workload soak,
backup restoration, disk-full, process-kill, proxy timeout and rollback drills on
the real deployment. Monitor disk/WAL growth, pool failures/rejections, RSS,
readiness, missing logs and restarts. SQLite is single-host; there is no automatic
multi-host failover or server-database adapter. Logging retention/rotation is owned
by the external collector and still needs deployment recipes and verification.

**Post-0.1 release hardening:** establish a private vulnerability reporting/support
policy and patch response ownership before managed or hostile multi-tenant use.
Release artifacts need immutable image and
dependency identities, upstream vulnerability monitoring and a reviewed update
process. At the audit cutoff, CI actions/base images used mutable version tags. The
repository-governance follow-up pins them and enables dependency maintenance,
secret protection, CodeQL and private reporting; see [governance](../GOVERNANCE.md).
CI now also gates runtime advisories with `npm audit --omit=dev`. A manual main-only
signed candidate/SBOM workflow is now defined; see
[release security](RELEASE-SECURITY.md). It does not publish to registries. The 0.1.0 release is licensed under
Apache-2.0; the license does not close the independent-review gates.

**Application responsibility:** HTML/JS assets are active browser content; choose
appropriate CSP, cookie flags, authorization and cache policy. Granted secrets
can intentionally be returned by code receiving them. Filename filters cannot
identify secrets stored under innocent names. Operator directories/volumes must
remain protected from other host processes; filesystem checks do not protect
against a privileged host attacker racing mutations.

See [release gates](RELEASE-READINESS.md), [function security](FUNCTION-SECURITY.md),
[operations](OPERATIONS.md) and [resilience](RESILIENCE.md). Free-product and
portability boundaries remain unchanged; this audit is not deployment readiness proof.

Repeatable local/CI drills now cover mixed HTTP load, quiesced backup restoration,
configuration rollback and disposable volume exhaustion/recovery. Real deployment
acceptance remains open; see [operational proof](OPERATIONAL-PROOF.md).

The hardening CI pass also exposed a failed-store initialization cleanup race on
Windows: rejection could precede worker termination and leave the DB file briefly
locked. Initialization now closes the DB and awaits worker termination before
returning failure. The missing-metadata regression exercises this cleanup path.
