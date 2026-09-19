# Auth threat model

## Scope and assets

This package is a trusted Node host service. Under the core runtime's current
capability model, application `function`/`middleware` routes run trusted and
in-process with full Node access by default; a route opts into isolated
QuickJS/WASM execution only by declaring `sandbox: true`. The auth service protects
account ownership, verified identifiers, credential material, sessions, factor and
recovery proofs, operator role grants, audit history and private profile data.
SQLite files and backups contain sensitive account data: file permissions are a
boundary, not whole-database encryption. TOTP secrets and protocol state are sealed;
passwords are hashed, and reusable browser capabilities are stored as hashes.

## Entry points and trust boundaries

| Entry point | Untrusted input | Authority boundary |
| --- | --- | --- |
| Mounted auth HTTP routes | Query, form/JSON, cookies, origin, provider responses | Bounded parsing, browser binding, CSRF, maintained protocol verification, final SQLite transaction |
| Public signup | Identifier, credential, profile and consent | Verification-first state machine; unique identifiers and reviewed default role; no metadata grants |
| OIDC/WebAuthn completion | State, claims, signed assertions | Issuer/subject binding or RP/origin/UV checks; current account and credential versions rechecked at issuance |
| Self-service security changes | Password/factor proof and session | Fresh non-impersonated authority; current version; atomic proof use and session revocation |
| Email/manual recovery | Mailbox capabilities or reviewed case evidence | Explicit operator opt-in; cancellation/cooldown or two current administrators; restricted reenrollment |
| Operator modules and CLI | Configuration, keys, import data, callbacks | Trusted operator installation outside the project; bounded imports; explicit configuration migration |
| Auth service API called by admin | Actor token, target and reason | Worker rechecks current permissions, delegation ceiling, freshness and target state |

A same-origin frontend can exercise browser authority even without reading an
HttpOnly cookie. Do not host adversarial frontend scripts on this origin. A hostile
host process, operator module, dependency or OS user able to read the key material
is outside the WASM boundary. This release does not claim hostile multi-tenant
readiness or independent assessment.

## Required invariants

- Guests cannot select host modules or receive session, provider or recovery secrets.
- Required signup verification precedes stored credentials. Existing accounts are
  never overwritten by a duplicate signup, linked by email alone, or upgraded from
  untrusted metadata.
- Proof verification and authority issuance must share account/credential version
  checks; retries, parallel workers and A→B→A configuration changes cannot revive
  consumed or stale authority.
- A passkey cannot serve as both primary and second factor in the same sign-in.
  Remembered-device authority never grants fresh admin/credential authority.
- Recovery replacement-factor enrollment belongs to the restoration session.
  Another party possessing an old password cannot win an enrollment race.
- Administrative restoration is a human evidence procedure. Software enforces
  two-person approval and delivery gates; it does not establish legal identity.
- Limits fail closed, cleanup is bounded, and expiry is checked during use rather
  than relying on a sweep. Network callbacks cannot authorize incomplete state.
- Diagnostic output, public responses, browser JavaScript, tests and repository
  artifacts must not contain real passwords, reusable credentials or customer data.

## Review and evidence

For an auth change, trace the final transaction, not just the form or preflight.
Check replay, concurrency, expiry, browser/account binding, privilege changes,
configuration migration, fallback methods, last usable access and secret handling.
Run `npm run verify`; for exports/build/CLI changes also exercise the installed
local tarballs across core/auth/admin. Protocol fixtures must use synthetic keys.

Tests cover these mechanisms but are not a penetration test, real-provider setup,
load/soak result or disaster-recovery exercise. Live Google/Apple/SES verification
is separately deferred. Operator callbacks and policy data require their own
review, monitoring, incident handling and periodically tested backups.
