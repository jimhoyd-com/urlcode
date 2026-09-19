# UI kit implementation status

Status: `0.1.0-alpha.5`, published to npm as an alpha. It supersedes `0.1.0-alpha.4`, which carried none of the work merged since it was tagged — the hand-copied `ExtensionActivation`/`ExtensionInstance` sync with core among it. The source is complete; the private integration review with core, auth and admin is pending, and the items below remain.

Source plan: the [UI kit spike](docs/SPIKE-UI.md)
and section 12 of the auth spike. Cross-repository acceptance:
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

Adoption follow-ups from auth (#11) and admin (#12): extension-owned scripts
in `PageOptions.scripts` with the page nonce; `targets` typed as core's
literal `TargetName` union; the kit catalogue completed by default in
`createKit`; per-source catalogue bounds (1024 per source, 4096 in all) so
auth's and admin's catalogues register together; the console layout classes
in `kitCss`; navigation icons (`nav@2`) and the `compact` and `application`
layouts rendered through `layout@3`, whose application branch renders the
console shell (sidebar, content region, page header) from `nav`, `menu` and
`title` instead of hiding a duplicate header with CSS.

## Remaining first-release acceptance

- Adopt the kit in `urlcode-auth` and `urlcode-admin`: register their
  catalogues and templates, render through `kit.page`, and retire
  `renderDocument`-based shells where the kit fits. `renderDocument` and
  the components stay for callers that do not use the kit.
- Done: the `ui` registration declares `immutableAssets: { prefix: '/static' }`
  (core PR #93), so the runtime serves the kit's hashed assets under
  `<mount>/static/` with `public, max-age=31536000, immutable`; the handler
  emits one strong ETag and never sets cookies or `Vary`.
- Accessibility: the automated checks cover structure (labels, landmarks,
  roles, skip link). Keyboard, screen-reader and contrast verification and
  a WCAG 2.2 AA assessment remain manual.
- Translations: the mechanism is complete; no non-English catalogue ships.
- Tailwind: the `stylesheet` export is compiled from Tailwind at build time
  (`npm run styles`) and embedded by `renderDocument`. The kit's `kitCss`
  (served through `kitAssets` and the `ui` extension) is hand-written against
  shadcn/ui tokens rather than compiled. A project can append to or replace
  `kitCss` through `extensions.ui.stylesheet`. Compiling the kit stylesheet
  from Tailwind is a later change that does not affect the template or theme
  contract.
- `create-urlcode-extension` and the `--from` fork scaffold are not built.
