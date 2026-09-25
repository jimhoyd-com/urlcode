# Merged implementation acceptance

This record distinguishes implemented and tested behavior from deployment approval.
The source plan and remaining release work are tracked in
[core #58](https://github.com/jimhoyd-com/urlcode/issues/58).

## Exact merged baseline

There are no peer revisions to keep any more: core and ui are siblings in this
repository, so one commit identifies all of them and `peers.json` has been
deleted. The table below records the baseline this acceptance run was performed
on, made when they were separate repositories.

| Repository | Main revision tested |
| --- | --- |
| core | `ed1db4cb42d3d25dfef241259375cfcfac0f3f6e` |
| UI | `97139bd2aa54ab7eb667b3d34adc9a280343c6ca` |
| auth | `faeb58a3b68a11a4b7a1e615155eb53cbe02c381` |
| admin | `edb6de85d2d3e12f664a7bbb1c05aab36cdf3f3c` |

This table records the acceptance run at the time it was performed. The peer
revisions currently verified by CI are the core/UI checkout pins in
`.github/workflows/verify.yml`, which are authoritative and may be newer than the
rows above.

The cross-package harness builds isolated source checkouts, packs compiled exports,
installs core into a fresh project, adds UI/auth, then adds admin. It exercises
account/session continuity, ordinary-user denial, administrator access and
revocation without source symlinks. The reproducible tools are
`scripts/pack-addons.ts` at the repository root and
`packages/admin/scripts/clean-project-acceptance.mjs`. Both are in this
repository now. Use one exact reviewed commit and local archives; publishing is
not required.

The merged-main v19 run passed all four package typechecks/builds and all 30
sequential clean-project checks (core 1, auth 8, admin 21). Temporary test hosts
closed successfully; existing review previews were preserved. The source manifest
records tarball integrity alongside these revisions.

## UI and browser evidence

The reviewed shared primitives use compiled Tailwind and server-HTML adaptations
of shadcn recipes. Auth/admin own their screens and domain copy. This record
describes the run as it was made, when these screens used the shared primitive
renderer rather than project template overrides. That render path has since been
removed: auth now renders only through the `ui` kit (see IMPLEMENTATION-STATUS.md),
so the evidence above predates the current single render path and a re-run is owed.

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
- Operator mail delivery monitoring and live health observations. Post-commit lifecycle
  callbacks remain best-effort, without a durable retry queue.
- Independent security assessment and native-language review of translations.

Do not interpret passing CI as independent review or hostile multi-tenant
readiness. Historical method timestamps remain unknown where they were never
recorded. Public lost-everything intake, recovery contacts and durable webhook
retries remain later scope. Credentials and test databases are never evidence
artifacts to commit.

## Automated implementation coverage

The auth test suite covers durable accounts/sessions, concurrent single-use authority,
registration/invitations/waitlist/consent, abuse bounds, signed provider fixtures,
passkey/MFA/recovery flows, account lifecycle, configuration migration and stale
workers, key rotation, backup/CLI, localization and HTTP settings responses.
See the focused files under `test/`, especially `auth-core.test.ts`,
`registration.test.ts`, `protocols.test.ts`, `signup-http.test.ts`,
`second-factor-flows.test.ts`, `backup.test.ts` and `scaffold.test.ts`.

<!-- local-links: historical -->
Historical evidence, recorded before the monorepo migration and kept as the run
that actually gated this baseline: [combined auth integration CI in the retired
`jimhoyd-com/urlcode-auth` repository](https://github.com/jimhoyd-com/urlcode-auth/actions/runs/35296669750)
passed verification on Node 22, 24 and 26 before merge; core #69 is resolved.
Auth is built and verified by this repository's workflows now, and the private
UI read access that run needed no longer exists — ui is a sibling package.
