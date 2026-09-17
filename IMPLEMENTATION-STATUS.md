# Auth implementation status

This is an implementation branch, not a claim that every first-release row in the spike is complete. The source plan is URLCode PR #54; cross-repository acceptance is tracked in https://github.com/jimhoyd-com/urlcode/issues/58. Core integration requires PR #59.

Implemented and covered by automated tests: durable SQLite accounts; bounded scrypt and hash migration; email/password and numeric email codes; OIDC with explicit linking; Google/Apple adapters; WebAuthn registration, login and step-up; TOTP/recovery; opaque sessions and revocation; role ceilings; registration modes; terms and scoped metadata; email change cooldown/cancellation; deletion grace; exports; key rotation; backup/restore; operator CLI/scaffolding; SES/development senders; safe themes and locale catalogue; admin service operations including dual-approval cases and bounded impersonation. Device recognition supports notices; separate opt-in, revocable remembered-device authority can exempt ordinary MFA without granting fresh step-up. Explicit passkey second-factor enrollment requires an independent credential. Optional breach checking is an operator-selected external service.

Resumable verification-first password/passkey signup (including waitlist approval) and opt-in email-mediated factor recovery with a 24-hour cancellation window and recovery-session-only reenrollment are implemented.

Mandatory verification/TOTP enrollment, operator standard/hardened presets and explicit pinned configuration migration are implemented; hardened requires email and breach-screening adapters.

## Additional implemented acceptance

- Bounded localized email copy, durable progressive password backoff, trusted-client and signup-domain velocity budgets, optional fixed-origin Turnstile verification/widget, and pinned disposable-domain data.
- Integrated maker/checker manual recovery, staged administrative account actions and audited identifier reveal/notes. Manual recovery is an operator process; public lost-everything intake and recovery contacts remain later scope.
- Offline `auth-baseline` runs 17 synthetic checks; anonymous `verify-deployment` inspects headers/cookies without claiming provider readiness.
- Local browser walkthrough exercised identifier-first password login, account page, admin dashboard, filtered directory and masked detail. It found and corrected the no-referrer/Origin form failure. This is not a complete WCAG 2.2 AA assessment.

## Remaining first-release acceptance

- Complete accessibility assessment, browser/device WebAuthn coverage, deployment/soak/backup-recovery exercises and independent security review.
- Operator wiring of sender monitoring and lifecycle delivery policy. Hooks and security notices are best-effort after commit, without a durable retry queue (signed webhooks/retries are later scope).
- Final cross-package packed-install and CI evidence at the reviewed commits.

Live Google/Apple/SES testing is explicitly deferred by the project owner and is not a blocker for local implementation. It remains unverified. Synthetic signed protocol tests do not establish vendor configuration or delivery readiness.

## Agreed architecture corrections

Auth/admin live in independent repositories. The core owns generic revision-pinned extension contracts and never depends on auth. SQLite and privileged transactions belong to the trusted operator service. Project YAML cannot select host modules or credentials. Safe package renderers replace arbitrary project templates. The initial auth target is Node with operator-owned durable storage; runtime adapter availability does not make this SQLite service portable to every deployment target.
