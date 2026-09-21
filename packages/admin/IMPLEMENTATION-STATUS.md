# Admin implementation status

Status: delivered as a signed member of the immutable
[`extension-bundles@v…` GitHub Release](../../docs/EXTENSIONS.md#signed-executable-extension-bundles)
through the dedicated bundle workflow. The current source version and peer ranges
are in `package.json`; [package and channel alignment](../../docs/VERSION-ALIGNMENT.md)
records the supported core and bundle release pair. Core, ui, auth and admin are
workspace packages in one repository, so a
single commit identifies all of them and development resolves peers through the
workspace links. `src/admin.ts` loads project hooks through
`ExtensionActivation.root`, which is the oldest core API this package needs. The
implemented admin workflows and reviewed shared-presentation work are merged to
main. Production release validation remains separate. Release acceptance is
tracked in [issue 58](https://github.com/jimhoyd-com/urlcode/issues/58), and core
extension integration PR #59 is merged. Auth owns identities, sessions and
transactional authority checks; this package owns the trusted administration
interface.

Implemented: scoped internal authorization; no impersonated admin access; fresh, reasoned mutations; account search, compound filters, sorting, stable live pagination, details, setup invitation and bounded export; audited full-email reveal; lock/unlock/role assignment; global and individual session revocation; role definitions; audit pagination; registration approval; dual-approval security cases with notes/closure; opt-in short-lived impersonation with required notice; shared safe presentation; auth/admin initialization with private operator storage.

## Additional implemented acceptance

- Complete filtered-user exports (5,000 records/4 MiB/5 seconds, all-or-nothing), full-range audit exports, staged bulk role/verification and individual verification/password-reset/email-change/deletion/method-removal workflows.
- Structured account detail sections for overview, methods, sessions, recovery, activity and consent/data; escaped administrator notes are audited. Method operations are a linked fresh-authentication view.
- Manual recovery evidence, two distinct authorized reviewers, private delivery to replacement address and warning to old address, browser redemption and mandatory factor reenrollment. This is not automated identity verification; recovery contacts/public intake remain later auth scope.
- Shared localized email copy, typed health adapter, host support-banner wrapper, and synthetic browser walkthrough of dashboard/search/detail.
- Embedded hosts can use `createAdministrationRuntime` to install the support banner and live runtime health together; an actual-runtime regression verifies cached application pages, impersonation, revocation and admin denial. Every request must use the returned runtime. The stock CLI still requires host integration; arbitrary frontend scripts remain outside the trusted UI guarantee.
- Session account/device/created-time filters, persisted passkey/provider added/last-used dates, and dashboard linked totals/SVG activity charts. Historic method timestamps remain unknown rather than being invented.
- Kit adoption (urlcode-admin issue #10, core plan §7.2) is implemented, and the kit is now the **only** render path: every console screen is an `admin/*` kit template with a declared view model and sample view (`adminTemplates`, `adminUiTemplates`), and `adminExtension` **requires** `ui`. The primitive fallback — the shared primitives inside a hand-built console shell — has been retired along with the `RenderPath` seam, the `activeKit()` helper and admin's own sidebar markup; the kit builds the shell from the navigation links and account menu admin supplies. Activation refuses, with a message naming the fix, when `ui` is absent, not yet active (declare `ui` before `admin` in `urlcode.yaml`), or built without `adminUiTemplates`. The HTTP suites now run once, through the kit; a doctor-style suite renders every template with its sample and with the view a real request computes, checks escaping of user-controlled values, the strict CSP, `no-store` and the immutable hashed stylesheet. The compact UI pass supplies the console shell, sidebar icons, metrics, tables, forms and theme toggle through the pinned shared UI stylesheet. The clean-project harness's admin phase now requires `--kit`.
- **Scaffolding follows:** `scaffold()`, `initAdministration` and core's `urlcode init --with ui,auth,admin` now compose the kit themselves. The scaffold refuses when `ui` is absent, or ordered after `admin`, before anything is written; `packages/ui`'s scaffold wires `authCatalogue`, `authUiTemplates` and `adminUiTemplates` into the `createUiExtension` call it writes, from the composed `names`. `ui` must be declared first in `urlcode.yaml`, because the runtime activates extensions in declaration order.
- The registration publishes machine-readable authoring surfaces and fast
  checks. Tools can direct a change through console copy, the smallest
  `admin/*` template override or supported lifecycle hook while permissions,
  fresh-authentication checks, auditing and mutations remain package-owned.

## Remaining first-release acceptance

- Connect live operator runtime/provider/sender observations to the health adapter. Activity data begins when the feature is activated.
- Full accessibility assessment and broader browser/device/deployment validation. The current walkthrough is not WCAG conformance evidence.
- Refresh package and CI evidence whenever code or dependency pins change. Core, ui and auth are siblings in this repository, so verification builds them from the same commit and no cross-repository read credential is involved; core #64/#69 are closed and hosted verification passes on Node 22/24/26. See ACCEPTANCE.md for the exact baseline.

Role definitions remain reviewed operator configuration. User role assignments are administrative transactions. This preserves the separation between changing authority definitions and assigning already-reviewed authority.

## Recorded acceptance

See [ACCEPTANCE.md](ACCEPTANCE.md) for exact merged revisions, automated coverage,
clean-install evidence and the remaining operational validation boundary.
