# Auth implementation status

Status: auth is released as a tarball on core's GitHub Release at core's
version, pinned by sha512 in core's `dist/addons.json` and installed with
`urlcode extensions add auth` ([add-ons](../../docs/EXTENSIONS.md#add-ons-extensions-and-artifacts)).
The current source version and exact peers are in `package.json`; [version
alignment](../../docs/VERSION-ALIGNMENT.md) records it. Core, ui, auth and admin are workspace packages in one repository, so a
single commit identifies all of them and development resolves peers through the
workspace links rather than published versions. `src/auth.ts` resolves project
lifecycle hooks through `ExtensionActivation.root`, which is the oldest core API
this package needs. The implemented auth and shared-presentation work is merged
to main. The source plan is URLCode PR #54; release acceptance is tracked in
[issue 58](https://github.com/jimhoyd-com/urlcode/issues/58), and the generic
core extension contract from PR #59 is merged. Implementation and synthetic
acceptance do not establish production readiness.

Implemented and covered by automated tests: durable SQLite accounts; bounded scrypt and hash migration; email/password and numeric email codes; OIDC with explicit linking; Google/Apple adapters; WebAuthn registration, login and step-up; TOTP/recovery; opaque sessions and revocation; role ceilings; registration modes; terms and scoped metadata; email change cooldown/cancellation; deletion grace; exports; key rotation; backup/restore; operator CLI/scaffolding; every message sent through the mail extension; safe themes and locale catalogue; the administration API (`AuthExports.administration`) including dual-approval cases and bounded impersonation; every privileged action written to a transactional audit outbox that the audit extension drains. Device recognition supports notices; separate opt-in, revocable remembered-device authority can exempt ordinary MFA without granting fresh step-up. Explicit passkey second-factor enrollment requires an independent credential. Optional breach checking is an operator-selected external service.

Bearer/API-key authentication (urlcode#571) is implemented: `AuthService.issueApiKey`/`listApiKeys`/`revokeApiKey`/`authenticateApiKey`, scrypt-hashed at rest (same derivation as passwords, looked up by a public id rather than a hash of the secret), the `urlcode-auth api-key-issue`/`api-key-list`/`api-key-revoke` CLI, and the `auth: {bearer: {scopes: [...]}}` route short form with RFC 6750-shaped 401/403 gating. The verified key's id/name/scopes are exposed to the protected route's own `function`/`middleware` context as base64-encoded JSON on the reserved `x-urlcode-context-auth-principal` request header, using core's generic extension-context-header channel (urlcode#618).

User-linked API keys (urlcode#732) are implemented: `issueApiKey({..., userId})` and `api-key-issue` JSON `userId` link a key to an active account, checked in the insert's transaction (`invalid_api_key_user` otherwise), stored in a nullable `auth_api_keys.user_id` column added in place. Such a key's request principal is the user id rather than `apikey:<key id>`; its authority stays its own scopes. Lookup requires the linked account to be `active`, so a lock or deletion disables it on the next request, and `purgeDeleted` revokes a purged account's keys. `listApiKeys` reports `userId` and `userDisabled`.

Per-credential quota (urlcode#572) is implemented: `auth: {bearer: {scopes, quota: {requests, window}}}` counts each authenticated, in-scope request by key id (hashed) in the auth store's `auth_attempts` table with the attempt counter's fixed window, and refuses the request over budget with 429, `Retry-After` and `RateLimit-Policy`/`RateLimit` (policy `credential`) before the handler. Durable across restart and shared by processes on one host through the SQLite file (a test runs a second OS process against the same file); not shared across hosts. Fails closed (503) when the store is unavailable or the table is at capacity. A key issued with its own `quota` (`issueApiKey`/`api-key-issue`, stored in `auth_api_keys`, added to existing databases in place with no quota for existing keys) is counted against that budget instead of the route's, on every bearer route (urlcode#703). Allowed, counted responses carry `RateLimit-Policy`/`RateLimit` under `credential` through the extension's `middleware()` hook, ahead of core throttle's `default` member; core keeps these routes `Cache-Control: no-store` and refuses a non-`no-store` cache strategy on them.

Resumable verification-first password/passkey signup (including waitlist approval) and opt-in email-mediated factor recovery with a 24-hour cancellation window and recovery-session-only reenrollment are implemented.

Mandatory verification/TOTP enrollment, operator standard/hardened presets and explicit pinned configuration migration are implemented; hardened requires a breach-screening adapter, and activation requires a mail transport when email verification is mandatory.

The extension split is implemented: auth requires `ui`, `audit` and `mail` and uses `abuse`. `AuthExports` v1 (`account(request)`, `csrf`, `urls`, `administration`) is the only surface another extension reads; admin consumes it and holds no auth secret. The `auth: {csrf: token | origin}` policy key is implemented, and auth verifies its session-bound token from the `x-csrf-token` header or a body `csrf` field (#745). Auth records the relying-party ID of every passkey and warns at activation about passkeys registered for another ID (#736). Budgets, challenge and password backoff moved to `extensions.auth.config.abuse` through the abuse extension; audit retention and listing moved to the audit extension.

Kit adoption (urlcode-auth issue #9, core plan §7.2) is implemented: every account screen is an `auth/*` kit template with a declared view model and sample view, contributed to `ui` through the definition; every screen renders through `ui.kit.page`. The `ui` extension is required: activation refuses when it is absent or not active (the runtime activates it first whatever the YAML order). There is no shared-primitive fallback path. The HTTP suites run once, on the kit path; a doctor-style suite renders every template with its sample and with the view a real request computes, checks escaping of user-controlled values and the nonce-bound CSP, and a separate test covers the activation refusal. A themed browser walkthrough of the account pages remains a manual acceptance step.

Project-level lifecycle hooks are implemented: `beforeRegister`, `beforeRoleChange`, `onAccountCreated`, `onAccountStatusChanged`, `onDeletionScheduled` and `onAccountDeleted` in `extensions.auth.config.hooks` (README.md), run trusted and in-process — the same default as any `function`/`middleware` route, no special case. The auth service fires them for every path: its own pages, the administration API and the operator CLI (`--project`, `--no-project-hooks`). Filters can only narrow and time out after 5 s; actions run after commit, bounded to 4 in flight, and never change the result. Core's extension-hook primitive resolves and imports them eagerly, exposes their typed contracts through extension inspection, and rejects `sandbox: true` under the trusted-only v1 hook contract.

The auth registration also publishes machine-readable authoring surfaces and
fast checks. They direct tools to registration configuration, UI copy, the
smallest `auth/*` template override and supported lifecycle hooks while keeping
identity, session, CSRF and recovery behavior package-owned.

## Additional implemented acceptance

- Translatable email copy (through mail), durable progressive password backoff, trusted-client and signup-domain velocity budgets and an optional challenge provider (through abuse), and pinned disposable-domain data.
- Integrated maker/checker manual recovery, staged administrative account actions and audited identifier reveal/notes. Manual recovery is an operator process; public lost-everything intake and recovery contacts remain later scope.
- Offline `auth-baseline` runs 17 synthetic checks on a passing run (extra failure-only markers are recorded when a probe, deadline or cleanup fails); anonymous `verify-deployment` inspects headers/cookies without claiming provider readiness.
- Local browser walkthrough exercised identifier-first password login, account page, admin dashboard, filtered directory and masked detail. It found and corrected the no-referrer/Origin form failure. This is not a complete WCAG 2.2 AA assessment.

- The source-only [synthetic recovery drill](RECOVERY-DRILL.md) exercises online backup, isolated reopen, configuration/key refusal and explicit session revocation after snapshot restore. Its 18 checks do not establish production disaster recovery or RTO/RPO.

## Remaining first-release acceptance

- Complete accessibility assessment, browser/device WebAuthn coverage, deployment/soak/backup-recovery exercises and independent security review.
- Operator monitoring of mail delivery and lifecycle delivery policy. Hooks and security notices are best-effort after commit, without a durable retry queue (signed webhooks/retries are later scope).
- Refresh the recorded package and CI evidence whenever code or dependency pins change; the merged implementation baseline is recorded in ACCEPTANCE.md.

Live Google/Apple testing, and live testing of mail's SES transport, is explicitly deferred by the project owner and is not a blocker for local implementation. It remains unverified. Synthetic signed protocol tests do not establish vendor configuration or delivery readiness.

## Agreed architecture corrections

Auth and admin are separate packages with their own contracts; core owns the generic extension contract and never depends on auth. SQLite and privileged transactions belong to the trusted operator service. Project YAML cannot select host modules or credentials. Safe package renderers replace arbitrary project templates. The initial auth target is Node with operator-owned durable storage; runtime adapter availability does not make this SQLite service portable to every deployment target.

## Recorded acceptance

See [ACCEPTANCE.md](ACCEPTANCE.md) for exact merged revisions, automated coverage,
clean-install evidence and the remaining operational validation boundary.
