# Independent sandbox review gate

Status: **external assessment not performed**. This gate covers only routes that
declare `sandbox: true`. Function and middleware routes are otherwise trusted
Node code by design; this review does not make unreviewed code safe to run in
that path. A declared sandbox route must never fall back to trusted execution.

Do not offer the sandbox as a hostile multi-tenant code-execution boundary until
this gate is closed. Internal review, CI, CodeQL and adversarial regression
tests are useful evidence, but not independent sign-off.

## Review scope

Freeze an exact runtime commit, lockfile, container digest, deployment limits and
synthetic app/policy examples. An independent reviewer needs the implementation,
tests and public contracts for sandbox dispatch, QuickJS/WASM guest creation,
module containment, host/guest message bridging, external grants, parsing and
activation limits, HTTP framing, reload, policies and recovery. Run `npm ci
--ignore-scripts`, `npm run verify`, `npm run test:package` and the operational
drill against disposable local or staging infrastructure.

The threat model includes hostile project YAML, modules, public requests,
responses and static content. Review loader escapes, bridge and prototype
confusion, resource amplification, infinite work, worker replacement,
cross-route/invocation leakage, filesystem races, slow peers, reload overlap and
container exhaustion. The trusted computing base includes Node/V8, QuickJS/WASM,
dependencies, OS/container, policy/secrets administration and build
infrastructure. The sandbox does not promise tenant CPU fairness, per-tenant
process RSS, microVM isolation or immunity from engine vulnerabilities.

## Closure

Record reviewer independence, scope, dates, commit, environment, methodology,
findings, remediation and retest evidence. Fix and retest all critical/high
boundary findings; name an owner for every accepted residual risk. Publish a
sanitized summary and keep exploit detail in private vulnerability reporting.
Reopen the review for meaningful engine, bridge or isolation changes. See
[function security](FUNCTION-SECURITY.md) for the implemented contract and
[operational proof](OPERATIONAL-PROOF.md) for deployment acceptance.
