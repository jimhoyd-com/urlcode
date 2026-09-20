# Auth implementation status

Status: `@jimhoyd/urlcode-auth` 0.1.0-alpha.3 is the current npm release. It supersedes 0.1.0-alpha.2, the first working one (core issue #78; 0.1.0-alpha.1 was published from an unbuilt checkout and never worked, see RELEASE-SECURITY.md in urlcode core), and carries the work merged since — the trusted project-level lifecycle hooks (`beforeRegister`, `onSignUp`, `onDelete`), the versioned JSON form-endpoint API contract, and the `ExtensionActivation.root` fixture fixes for core 0.4.0-alpha.2. It requires `@jimhoyd/urlcode` 0.4.0-alpha.2 or newer — `src/auth.ts` resolves project lifecycle hooks through `ExtensionActivation.root`, which does not exist in 0.4.0-alpha.1 — and `@jimhoyd/urlcode-ui` 0.1.x alphas. The implemented auth and shared-presentation work is merged to main. The source plan is URLCode PR #54; cross-repository release acceptance is tracked in https://github.com/jimhoyd-com/urlcode/issues/58. The generic core extension contract from PR #59 is merged. Implementation and synthetic acceptance do not establish production readiness.

Implemented and covered by automated tests: durable SQLite accounts; bounded scrypt and hash migration; email/password and numeric email codes; OIDC with explicit linking; Google/Apple adapters; WebAuthn registration, login and step-up; TOTP/recovery; opaque sessions and revocation; role ceilings; registration modes; terms and scoped metadata; email change cooldown/cancellation; deletion grace; exports; key rotation; backup/restore; operator CLI/scaffolding; SES/development senders; safe themes and locale catalogue; admin service operations including dual-approval cases and bounded impersonation. Device recognition supports notices; separate opt-in, revocable remembered-device authority can exempt ordinary MFA without granting fresh step-up. Explicit passkey second-factor enrollment requires an independent credential. Optional breach checking is an operator-selected external service.

Resumable verification-first password/passkey signup (including waitlist approval) and opt-in email-mediated factor recovery with a 24-hour cancellation window and recovery-session-only reenrollment are implemented.

Mandatory verification/TOTP enrollment, operator standard/hardened presets and explicit pinned configuration migration are implemented; hardened requires email and breach-screening adapters.

Kit adoption (urlcode-auth issue #9, core plan §7.2) is implemented: every account screen is an `auth/*` kit template with a declared view model and sample view (`authTemplates`, `authUiTemplates`, `authCatalogue`); `authExtension({ ui })` renders every screen through `ui.kit.page`. The `ui` extension is required: activation refuses when it is absent, or when the runtime has not activated it because `extensions.ui` is missing from `urlcode.yaml` or declared after `extensions.auth`. The shared-primitive fallback that earlier releases used without the kit has been removed, along with its compile-on-demand template cache and the `pageResponse` document helper that served it (no longer exported). The HTTP suites run once, on the kit path; a doctor-style suite renders every template with its sample and with the view a real request computes, checks escaping of user-controlled values and the nonce-bound CSP, and a separate test covers the activation refusal. A themed browser walkthrough of the account pages remains a manual acceptance step.

Project-level lifecycle hooks (urlcode-auth#35) are implemented: `beforeRegister`, `onSignUp` and `onDelete` in `extensions.auth.config.hooks` (README.md), run trusted and in-process — the same default as any `function`/`middleware` route, no special case. A configured hook's module is resolved and imported eagerly at activation, so a missing module or a broken/missing export fails activation rather than the first request; `sandbox: true` on a hook is refused explicitly at activation (core has no dispatch primitive yet to isolate a hook call, jimhoyd-com/urlcode#151) rather than silently ignored. `beforeRegister` covers the immediate `/register` endpoint and the resumable `/signup/begin` step; `onSignUp` fires after a genuinely new account is created (not an existing-account signup attempt that resolves to sign-in); `onDelete` fires when the account owner schedules their own deletion, not yet from an administrator-initiated deletion or the background purge.

## Additional implemented acceptance

- Bounded localized email copy, durable progressive password backoff, trusted-client and signup-domain velocity budgets, optional fixed-origin Turnstile verification/widget, and pinned disposable-domain data.
- Integrated maker/checker manual recovery, staged administrative account actions and audited identifier reveal/notes. Manual recovery is an operator process; public lost-everything intake and recovery contacts remain later scope.
- Offline `auth-baseline` runs 17 synthetic checks on a passing run (extra failure-only markers are recorded when a probe, deadline or cleanup fails); anonymous `verify-deployment` inspects headers/cookies without claiming provider readiness.
- Local browser walkthrough exercised identifier-first password login, account page, admin dashboard, filtered directory and masked detail. It found and corrected the no-referrer/Origin form failure. This is not a complete WCAG 2.2 AA assessment.

- The source-only [synthetic recovery drill](RECOVERY-DRILL.md) exercises online backup, isolated reopen, configuration/key refusal and explicit session revocation after snapshot restore. Its 18 checks do not establish production disaster recovery or RTO/RPO.

## Remaining first-release acceptance

- Complete accessibility assessment, browser/device WebAuthn coverage, deployment/soak/backup-recovery exercises and independent security review.
- Operator wiring of sender monitoring and lifecycle delivery policy. Hooks and security notices are best-effort after commit, without a durable retry queue (signed webhooks/retries are later scope).
- Refresh the recorded package and CI evidence whenever code or dependency pins change; the merged implementation baseline is recorded in ACCEPTANCE.md.

Live Google/Apple/SES testing is explicitly deferred by the project owner and is not a blocker for local implementation. It remains unverified. Synthetic signed protocol tests do not establish vendor configuration or delivery readiness.

## Agreed architecture corrections

Auth/admin live in independent repositories. The core owns generic revision-pinned extension contracts and never depends on auth. SQLite and privileged transactions belong to the trusted operator service. Project YAML cannot select host modules or credentials. Safe package renderers replace arbitrary project templates. The initial auth target is Node with operator-owned durable storage; runtime adapter availability does not make this SQLite service portable to every deployment target.

## Recorded acceptance

See [ACCEPTANCE.md](https://github.com/jimhoyd-com/urlcode-auth/blob/main/ACCEPTANCE.md) for exact merged revisions, automated coverage,
clean-install evidence and the remaining operational validation boundary.
