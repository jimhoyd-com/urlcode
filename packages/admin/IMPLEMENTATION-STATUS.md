# Admin implementation status

Status: released as a tarball on core's GitHub Release at core's version,
pinned by sha512 in core's `dist/addons.json` and installed with
`urlcode extensions add admin` ([add-ons](../../docs/EXTENSIONS.md#add-ons-extensions-and-artifacts)).
The current source version and exact peers are in `package.json`; [version
alignment](../../docs/VERSION-ALIGNMENT.md) records it. Core, ui, audit, mail, abuse, auth and admin are
workspace packages in one repository, so a
single commit identifies all of them and development resolves peers through the
workspace links. The
implemented admin workflows and reviewed shared-presentation work are merged to
main. Production release validation remains separate. Release acceptance is
tracked in [issue 58](https://github.com/jimhoyd-com/urlcode/issues/58), and core
extension integration PR #59 is merged. Auth owns identities, sessions,
transactional authority checks, lifecycle hooks and every email; this package
owns the trusted administration interface, built only on `AuthExports` v1 and
`AuditExports`.

Implemented: scoped internal authorization; no impersonated admin access; fresh, reasoned mutations; account search, compound filters, sorting, stable live pagination, details, setup invitation and bounded export; audited full-email reveal; lock/unlock/role assignment; global and individual session revocation; role definitions; audit pagination; registration approval; dual-approval security cases with notes/closure; opt-in short-lived impersonation with required notice; shared safe presentation; auth/admin initialization with private operator storage.

## Additional implemented acceptance

- Complete filtered-user exports (5,000 records/4 MiB/5 seconds, all-or-nothing), full-range audit exports, staged bulk role/verification and individual verification/password-reset/email-change/deletion/method-removal workflows.
- Structured account detail sections for overview, methods, sessions, recovery, activity and consent/data; escaped administrator notes are audited. Method operations are a linked fresh-authentication view.
- Manual recovery evidence, two distinct authorized reviewers, private delivery to replacement address and warning to old address, browser redemption and mandatory factor reenrollment. This is not automated identity verification; recovery contacts/public intake remain later auth scope.
- Typed health adapter and synthetic browser walkthrough of dashboard/search/detail. The support banner moved to auth's middleware, on every auth-protected route.
- The extension split: admin requires `auth`, `ui` and `audit`; the `/admin/*` mount must carry `auth: {onDeny: 404}`; audit screens read `AuditExports.query` newest first (#746) and need `audit.read`/`audit.export`; every account operation, email and hook is auth's. `createAdministrationRuntime`, `withSupportBanner`, the send callbacks, `authMount` and admin's own hooks are removed. Console copy is `admin.*` catalogue keys contributed to `ui`. A boundary test checks that admin imports only types from auth.
- Session account/device/created-time filters, persisted passkey/provider added/last-used dates, and dashboard linked totals/SVG activity charts. Historic method timestamps remain unknown rather than being invented.
- Kit adoption (urlcode-admin issue #10, core plan §7.2) is implemented, and the kit is now the **only** render path: every console screen is an `admin/*` kit template with a declared view model and sample view (`adminTemplates`, `adminUiTemplates`), and admin **requires** `ui`. There is no primitive fallback, `RenderPath` seam or admin-owned sidebar markup; the kit builds the shell from the navigation links and account menu admin supplies. Activation refuses, with a message naming the fix, when `ui` is absent, not active, or built without the `admin/*` templates. The HTTP suites now run once, through the kit; a doctor-style suite renders every template with its sample and with the view a real request computes, checks escaping of user-controlled values, the strict CSP, `no-store` and the immutable hashed stylesheet. The compact UI pass supplies the console shell, sidebar icons, metrics, tables, forms and theme toggle through the pinned shared UI stylesheet. The clean-project harness composes ui, audit, mail, auth and admin and takes `--core`, `--ui`, `--audit`, `--mail`, `--auth` and `--admin` tarballs.
- **Scaffolding:** `@jimhoyd/urlcode-admin/extension` is the admin definition. It requires `auth`, `ui` and `audit`, so `urlcode extensions add admin` adds them first; its scaffold writes an empty `extensions.admin` block and the `/admin/*` route with `auth: {onDeny: 404}`, and `admin()` in `host.mjs` receives AuthExports, the audit exports and the `ui` kit from `composeHost`, contributing its templates and catalogue to `ui` through `contributes.ui`. The YAML declaration order does not matter.
- The registration publishes machine-readable authoring surfaces and fast
  checks. Tools can direct a change through console copy, the smallest
  `admin/*` template override while permissions, fresh-authentication checks,
  auditing and mutations remain package-owned.

## Remaining first-release acceptance

- Connect live operator runtime/provider/mail observations to the health adapter. Activity data begins when the feature is activated.
- Full accessibility assessment and broader browser/device/deployment validation. The current walkthrough is not WCAG conformance evidence.
- Refresh package and CI evidence whenever code or dependency pins change. Every package is a sibling in this repository, so verification builds them from the same commit and no cross-repository read credential is involved; core #64/#69 are closed and hosted verification passes on Node 22/24/26. See ACCEPTANCE.md for the exact baseline.

Role definitions remain reviewed operator configuration. User role assignments are administrative transactions. This preserves the separation between changing authority definitions and assigning already-reviewed authority.

## Recorded acceptance

See [ACCEPTANCE.md](ACCEPTANCE.md) for exact merged revisions, automated coverage,
clean-install evidence and the remaining operational validation boundary.
