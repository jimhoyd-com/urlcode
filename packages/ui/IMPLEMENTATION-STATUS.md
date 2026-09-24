# UI kit implementation status

Status: delivered as a signed member of the immutable
[`extension-bundles@v…` GitHub Release](../../docs/EXTENSIONS.md#signed-executable-extension-bundles).
The current source version is in `package.json`; [package and channel
alignment](../../docs/VERSION-ALIGNMENT.md) records the supported core and
bundle release pair. The source is complete; integration review with core, auth and
admin — now siblings in this repository — is pending, and the items below remain.

The original design spike is private maintainer material; this page is the
contract for what shipped. Cross-repository acceptance:
https://github.com/jimhoyd-com/urlcode/issues/58. Runtime contract: core
PR #59 (`@jimhoyd/urlcode/extensions`).

Implemented on top of the merged shared primitives (`createPresentation`, `renderDocument`, the components and `stylesheet`, which are unchanged): the template language with enforced escaping and bounded
rendering; fourteen shipped partials in shadcn/ui markup with declared view
models and sample views; the stylesheet with shadcn/ui variables, light and
dark, and two nonce-bound scripts; theme validation; presentation with
registered extension catalogues, per-language project catalogues, locale
negotiation, plurals, number and date formatting and direction; the kit with
project, extension and kit override order, complete pages with CSP and
security headers, and a report of overrides, templates behind their view
model and translation coverage; the `ui` runtime extension owning
`extensions.ui`, reading bounded project files and serving hashed assets, in
the Node-only `./host` entry with structural copies of the runtime contract so
the package keeps no dependency; the CLI (`list`, `eject`, `preview`,
`doctor`, `copy --missing`); the existing closure test extended to the new
modules.

The registration now publishes machine-readable authoring surfaces and fast
checks. Project hooks cover both per-template view transformation and the shared
page shell (`title`, `layout`, navigation, account menu and flash), while the kit
continues to own CSP, headers, scripts and rendering. This lets people and
agents customize one application without forking the UI, auth or admin package.

Adoption follow-ups from auth (#11) and admin (#12): extension-owned scripts
in `PageOptions.scripts` with the page nonce; `targets` typed as core's
literal `TargetName` union; the kit catalogue completed by default in
`createKit`; per-source catalogue bounds (1024 per source, 4096 in all) so
auth's and admin's catalogues register together; the console layout classes
in `kitCss`; navigation icons (`nav@2`) and the `compact` and `application`
layouts rendered through `layout@3`, whose application branch renders the
console shell (sidebar, content region, page header) from `nav`, `menu` and
`title` instead of hiding a duplicate header with CSS.

## Remaining release acceptance

Kit adoption is implemented in auth (`71957dd`, `src/auth-ui.ts`) and admin
(`f3b4882`, `src/admin-ui.ts`): both render package templates through the kit
when the host supplies it. Shared primitives remain supported without the kit.
Shared form/deadline helpers live in `src/forms.ts`. The `ui` registration
declares `immutableAssets: { prefix: '/static' }` (core PR #93), so the
runtime serves the kit's hashed assets under `<mount>/static/` with `public,
max-age=31536000, immutable`; the handler emits one strong ETag and never
sets cookies or `Vary`. Accessibility: the automated checks cover structure
(labels, landmarks, roles, skip link); keyboard, screen-reader and contrast
verification and a WCAG 2.2 AA assessment remain manual.

A non-English catalogue ([issue
616](https://github.com/jimhoyd-com/urlcode/issues/616)) and compiling
`kitCss` from Tailwind ([issue
617](https://github.com/jimhoyd-com/urlcode/issues/617)) are done: the package
ships `kitCatalogueFr`, a complete French translation of the base and kit
catalogues checked against drift at module load and by test, and `kitCss`
compiles from `styles/kit.css` through `npm run styles` beside the shared
`stylesheet` export, so both come from one Tailwind source of truth.

Actionable remaining work is tracked on GitHub rather than duplicated here:
[create-urlcode-extension](https://github.com/jimhoyd-com/urlcode/issues/614) and
[the `--from` fork scaffold](https://github.com/jimhoyd-com/urlcode/issues/615).
