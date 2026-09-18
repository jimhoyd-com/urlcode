# Merged implementation acceptance

This record distinguishes implemented and tested behavior from deployment approval.
The source plan and remaining release work are tracked in
[core #58](https://github.com/jimhoyd-com/urlcode/issues/58).

## Exact merged baseline

The peer revisions this checkout is verified against live in one place,
[`peers.json`](peers.json); CI and `scripts/pack-sources.mjs` read it. The table
below records the revisions of the last full acceptance run.

| Repository | Main revision tested |
| --- | --- |
| core | `ed1db4cb42d3d25dfef241259375cfcfac0f3f6e` |
| UI | `97139bd2aa54ab7eb667b3d34adc9a280343c6ca` |
| auth | `faeb58a3b68a11a4b7a1e615155eb53cbe02c381` |
| admin | `edb6de85d2d3e12f664a7bbb1c05aab36cdf3f3c` |

The peer revisions pinned in `.github/workflows/verify.yml` are the authoritative
currently-verified core/auth/UI commits; this table records the acceptance run as
it stood at that time and is not updated when the workflow pins move.

The cross-package harness builds isolated source checkouts, packs compiled exports,
installs core into a fresh project, adds UI/auth, then adds admin. It exercises
account/session continuity, ordinary-user denial, administrator access and
revocation without source symlinks. The reproducible tools are
`urlcode-admin/scripts/pack-sources.mjs` and `scripts/clean-project-acceptance.mjs`.
Use exact reviewed commits and local archives; publishing is not required.

The merged-main v19 run passed all four package typechecks/builds and all 30
sequential clean-project checks (core 1, auth 8, admin 21). Temporary test hosts
closed successfully; existing review previews were preserved. The source manifest
records tarball integrity alongside these revisions.

## UI and browser evidence

The reviewed shared primitives use compiled Tailwind and server-HTML adaptations
of shadcn recipes. Auth/admin own their screens and domain copy. The separately
merged UI kit/template API is preserved; these screens currently use the shared
primitive renderer, not project template overrides.

Browser review covered separate identifier/password screens, safe error retries,
policy-aware signup steps, selected-email context, password guidance, conditional
authenticator controls, account/admin navigation, consistent headings, aligned
forms and actions, keyboard skip targets and 390px phone layouts without page
horizontal overflow. Inputs use 16px text. Light/dark/system preferences were
checked across navigation and reload. Registration completion is covered by HTTP
fixtures; the browser review stopped before entering a new credential.

## Remaining release validation

- Live Google/Apple/SES configuration and delivery: explicitly deferred by the
  project owner, not a local implementation blocker.
- Real browser/device WebAuthn coverage and full screen-reader/forced-colors/
  accessibility assessment; the browser walkthrough is not WCAG certification.
- Deployment load/soak, operational backup/restore and incident recovery drills.
  Synthetic backup tests are not evidence of a production recovery-time target.
- Operator sender monitoring and live health observations. Post-commit lifecycle
  callbacks remain best-effort, without a durable retry queue.
- Independent security assessment and native-language review of translations.

Do not interpret passing CI as independent review or hostile multi-tenant
readiness. Historical method timestamps remain unknown where they were never
recorded. Public lost-everything intake, recovery contacts and durable webhook
retries remain later scope. Credentials and test databases are never evidence
artifacts to commit.

## Automated implementation coverage

36 admin tests cover permission/target ceilings, fresh reasoned mutations,
account search/filter/detail, bounded all-or-nothing exports, sessions/audit,
registration, dual-review recovery, cases, impersonation/support banners,
runtime health integration, localization, layout structure and generated hosts.
See `test/admin-ux.test.ts`, `admin-user-filters.test.ts`,
`admin-user-export.test.ts`, `admin-recovery.test.ts`, `admin-runtime.test.ts`
and the other focused regressions under `test/`.

[Admin CI](https://github.com/jimhoyd-com/urlcode-admin/actions/runs/35295649183)
passed verification on Node 22, 24 and 26 after both narrow read credentials
were configured. Core #64/#69 are resolved. That baseline run was manually dispatched. The workflow now also runs on pull
requests and pushes to main; required-check enforcement remains repository policy.
