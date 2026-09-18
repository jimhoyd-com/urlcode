# Admin implementation status

The implemented admin workflows and reviewed shared-presentation work are merged to main. Production release validation remains separate. Cross-repository acceptance: https://github.com/jimhoyd-com/urlcode/issues/58. Core extension integration PR #59 is merged. Auth owns identities, sessions and transactional authority checks; this package owns the trusted administration interface.

Implemented: scoped internal authorization; no impersonated admin access; fresh, reasoned mutations; account search, compound filters, sorting, stable live pagination, details, setup invitation and bounded export; audited full-email reveal; lock/unlock/role assignment; global and individual session revocation; role definitions; audit pagination; registration approval; dual-approval security cases with notes/closure; opt-in short-lived impersonation with required notice; shared safe presentation; auth/admin initialization with private operator storage.

## Additional implemented acceptance

- Complete filtered-user exports (5,000 records/4 MiB/5 seconds, all-or-nothing), full-range audit exports, staged bulk role/verification and individual verification/password-reset/email-change/deletion/method-removal workflows.
- Structured account detail sections for overview, methods, sessions, recovery, activity and consent/data; escaped administrator notes are audited. Method operations are a linked fresh-authentication view.
- Manual recovery evidence, two distinct authorized reviewers, private delivery to replacement address and warning to old address, browser redemption and mandatory factor reenrollment. This is not automated identity verification; recovery contacts/public intake remain later auth scope.
- Shared localized email copy, typed health adapter, host support-banner wrapper, and synthetic browser walkthrough of dashboard/search/detail.
- Embedded hosts can use `createAdministrationRuntime` to install the support banner and live runtime health together; an actual-runtime regression verifies cached application pages, impersonation, revocation and admin denial. Every request must use the returned runtime. The stock CLI still requires host integration; arbitrary frontend scripts remain outside the trusted UI guarantee.
- Session account/device/created-time filters, persisted passkey/provider added/last-used dates, and dashboard linked totals/SVG activity charts. Historic method timestamps remain unknown rather than being invented.

## Remaining first-release acceptance

- Connect live operator runtime/provider/sender observations to the health adapter. Activity data begins when the feature is activated.
- Full accessibility assessment and broader browser/device/deployment validation. The current walkthrough is not WCAG conformance evidence.
- Refresh package and CI evidence whenever code or dependency pins change. The private auth/UI credentials are configured, core #64/#69 are closed, and hosted verification passes on Node 22/24/26. See ACCEPTANCE.md for the exact baseline.

Role definitions remain reviewed operator configuration. User role assignments are administrative transactions. This preserves the separation between changing authority definitions and assigning already-reviewed authority.

## Recorded acceptance

See [ACCEPTANCE.md](ACCEPTANCE.md) for exact merged revisions, automated coverage,
clean-install evidence and the remaining operational validation boundary.
