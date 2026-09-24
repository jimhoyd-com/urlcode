# Shared UI contract, version 1

Core, auth and admin may consume the same dependency-free package. This package
must never depend on any of them. Its main exports use standard Web/Intl APIs,
with no Node imports, browser DOM requirement, network calls or client framework.

- `createPresentation`: bounded immutable catalogues, custom default messages,
  account/query/Accept-Language/default negotiation, English fallback, Intl plurals
  and numbers, RTL direction, constrained local assets and theme variables.
- `renderDocument`: shared HTML document, skip link, main landmark, title, responsive
  CSS and explicit nonce-bearing script tags. Caller owns HTTP/security headers.
- `field`, `button`, `alert`, `navigation`, `table`, `pagination`, `emptyState`:
  escaped values and semantic HTML. Fields associate hints/errors with controls.
  `field({control: 'textarea' | 'select'})` renders a `<textarea>` (`rows` 2-40,
  `maxLength` up to 65536, default 4096) or a `<select>` (`options`, at most 500,
  optional `placeholder`) with the same label, hint and error wiring; `type`
  applies to `input` only. The kit has matching `textarea` and `select` partials.
- `stylesheet`: shared CSS with logical properties, focus indicators and dark mode.
- `escapeHtml`: text/attribute escaping, not authorization or URL validation.

Only generic --ui-* theme variables live here. Legacy auth theme aliases are
adapted in urlcode-auth. Auth owns its catalogue IDs and composes them into the
shared factory; core can register its own defaults without importing auth. The auth
and admin workflows, notices, validation, secrets, CSP and CSRF policy never move
here; only the keyless HMAC token primitive in `./host` (below) is shared.

Tailwind CSS is compiled at build time and embedded by the shared document renderer.
The shadcn Button/Input/Card recipes are adapted to server HTML (see THIRD_PARTY_NOTICES.md).
Document layouts are generic default, compact and application variants. No claim
of full WCAG 2.2 AA conformance follows from semantic markup tests.

`renderDocument` optionally accepts `theme: { nonce }` for an appearance toggle.
The host owns the matching CSP nonce. Labels live in the generic `theme.*`
catalogue; remembered appearance is origin-local and independent of identity.

This is the agreed extraction from the working implementations. Version 1 adds,
beside it and without changing the exports above:

- `compileTemplate` and the kit template language: `{{path}}` always escaped,
  `#if`/`else`, `#each`, `{{> partial}}`, `{{t "key"}}`, `href`/`date`/`number`
  helpers, comments with a `viewModel: name@1` declaration. No expressions, no
  logic, no raw output; only renderer-produced `Markup` passes unescaped; bounded
  source, nesting, partial depth, iterations and output.
- `kitTemplates`: shipped partials in shadcn/ui markup with declared view models
  and sample views; `kitCss` and `kitAssets`: a static stylesheet on shadcn/ui
  variables with light and dark values, two nonce-bound enhancement scripts,
  content-hashed names. Shipped markup includes semantic `data-slot` hooks for
  card, field, button, alert, table, empty, dropdown and sidebar anatomy; these
  support durable project styling without transferring workflow ownership.
- `resolveTheme`: a project theme block (name, logo, favicon, back link, HSL or
  hex colours for light and dark, radius, font) validated against a narrow
  grammar, separate from the `--ui-*` theme variables above.
- `createKit`: override order project file, then extension template, then kit;
  extensions add templates only under their own namespace; complete pages with
  nonce-bound style and scripts, a strict CSP and `no-store`; a report of
  overrides, templates behind their view model and translation coverage.
- The host extension declares the core-discoverable `transformView` and
  `transformPage` project hooks. They run trusted and synchronously before
  public kit render/page calls; `transformPage` can change only title, layout,
  navigation, account menu and flash while renderer-owned security fields stay
  fixed,
  receives `{template, view}` and must return a view object. Declarative theme,
  copy, template and CSS layers remain the first customization path.
- `PresentationContext.has`, `formatDate`, `formatNumber` and
  `Presentation.english`, `defaultLocale`, `coverage`: additive.
- Catalogue bounds (`catalogueLimits`): an effective catalogue (the merged
  English defaults, or one language) holds at most 4096 keys and 512 KiB of
  message text; `mergeCatalogues` bounds each source at 1024 keys and at most
  16 sources, so the kit's, auth's and admin's English catalogues register
  side by side as `sources`. Every key and message stays bounded on its own.
- The kit catalogue is part of the kit: `createKit` completes a presentation
  that lacks `ui.*` keys from `kitCatalogue`, for `resolveContext`, `render`,
  `page` and a `context` the host resolved itself; a host key of the same name
  wins. `createUiExtension` registers `kitCatalogue` beside `sources`. A host
  no longer has to register `kitCatalogue` to hand both `presentation` and
  `ui` to an extension; `mergeCatalogues([kitCatalogue, ...])` stays valid.
- `PageOptions.scripts` takes kit script names (`otp`, `confirm`) and
  extension-owned scripts `{ src, integrity? }`: `src` is a same-site path the
  extension serves under its own mount (absolute, no scheme or host, unchanged
  by `safeHref`, at most 2048 characters), `integrity` an optional
  `sha256|sha384|sha512-` value. They render as `<script nonce src [integrity]
  defer>` with the page nonce, at most 8 scripts per page (`pageLimits`), the
  bounds `renderDocument` applies. The layout's `scripts` view entries are
  `{ src, integrity }` objects (`layout@3`).
- `PageOptions.layout`: `default` (header navigation), `compact` (a small
  centred card) or `application` (the kit renders the console shell itself:
  `ui-shell`, an `ui-sidebar` holding the brand, the `nav` navigation and the
  `menu` in an `ui-sidebar-footer`, and an `ui-content` region holding an
  `ui-page-header` with the page title, the flash and the content). The
  application layout renders no `ui-header` and no second copy of the
  navigation, so a console supplies data, not markup. All three render through
  `layout@3`, which sets `data-layout` on `body`, carries the theme toggle and
  points the skip link at `#main` — the element holding the content in every
  layout. `NavigationItem.icon` takes an `IconName`; the `nav` view entries
  carry the rendered icon markup or `null` (`nav@2`). An ejected `layout@2` or
  `nav@1` is reported behind by `doctor`; other ejected partials are
  unchanged.
- `kitCss` carries the console layout classes the admin screens use
  (`ui-shell`, `ui-sidebar`, `ui-metrics`, `ui-definition-grid`, `ui-badge`,
  `ui-list`, `ui-toolbar`, `ui-section-heading`, `ui-danger-zone`,
  `ui-form-grid`, `ui-actions`, `ui-activity`, `ui-chart`, `ui-filter`,
  `ui-icon`) on the shadcn/ui variables plus `--sidebar`,
  `--sidebar-foreground` and `--chart-1..3`, light and dark, and stays under
  `kitCssLimit` (64 KiB).
- The `./host` entry (Node only): `createUiExtension`, the `ui` runtime
  extension owning `extensions.ui`, reading bounded project copy, template and
  stylesheet files, and serving the kit assets under `<mount>/static/`, declared
  as `immutableAssets` so the runtime caches them publicly; `loadProjectUi`;
  and the `urlcode-ui` CLI (`list`, `eject`, `preview`, `doctor`, `copy`).
  The structural contract types `targets` and `ExtensionActivation.target` as
  the literal union core's `TargetName` declares (`'node' | 'vercel' | 'aws'
  | 'cloudflare'`), so `ui.registration` needs no cast in a host file.
- The `./host` HMAC-SHA256 token helpers auth and forms build CSRF on:
  `signHmac(secret, message, encoding?)` and `verifyHmac(secret, message,
  provided, encoding?)` (`'hex'`, the default, or `'base64url'`);
  `createSignedToken(secret, payload, ttlMs)` issues
  `<base64url JSON>.<base64url signature>` with `expires` and a random `nonce`,
  and `readSignedToken(secret, value, ttlMs)` returns that payload or
  `undefined`. `verifyHmac` accepts only the canonical encoding (64 lowercase
  hex or 43 unpadded base64url characters), compares in constant time, and
  both verifiers never throw on malformed input. The caller owns the secret,
  what the token binds and when it is checked.
- The `./extension` entry (Node only): the default-exported `ui` extension
  definition (`defineExtension` from core, the one peer) that host.mjs lists as
  `ui()` in `composeHost`. Its `scaffold` returns the `extensions.ui` block
  with a starter theme named after the site, the `/assets/ui/*` route (and a
  `/todos/*` screen route when `store` is installed), and `ui/copy`,
  `ui/templates` and `ui/extra.css` placeholders beside host.mjs; it writes
  nothing itself. Its `host()` calls `createUiExtension` with `projectRoot` set
  to the site and registers the catalogues and templates every other installed
  extension contributes through `contributes.ui` (`UiContribution`:
  `{sources, templates}`), then the operator's `ui({sources, extensions,
  theme})`. `requires` on auth, admin and forms makes `composeHost` activate
  `ui` before them and hand them the kit.

The main entry stays dependency-free and free of Node imports. The `./host`
entry uses `node:fs` and `node:path` and mirrors the runtime's extension
contract structurally; only the `./extension` entry imports core. Project
templates are data in the kit language, never evaluated code; the CSS is
served as an asset by the extension, or embedded by `renderDocument` for
callers that do not use the kit. No claim of full WCAG 2.2 AA conformance
follows from the structural tests.

`icon(name)` renders a fixed package-owned decorative SVG from the `IconName`
allowlist. It accepts no markup, URL or styling input. Keep visible labels; icons
are hidden from assistive technology and cannot receive focus. `button` accepts
an optional third icon argument, and navigation items accept `icon`.

Version 1 also adds the form and deadline helpers auth and admin used to keep
as private copies:

- `hiddenField(name, value)`: an escaped `<input type="hidden">`; the name follows the `field` grammar.
- `postForm({action, csrf, fields, label, destructive?, icon?, className?})`: a `method="post"` form with the CSRF hidden field, trusted field markup and one submit `button`; `action` must pass `safeHref` unchanged, `destructive` adds `ui-button-destructive`.
- `withDeadline(fn, ms, message)`: races `fn(signal)` against a timer, aborts the signal and rejects with `Error(message)` at the deadline, and always clears the timer. Web APIs only.

The default kit layout is now `layout@3`: it accepts generic `layout`, an
`application` flag, `themeToggle` and nonce-bound `themeBootstrap` markup. The
application branch renders the console shell (sidebar and content region) from
`nav`, `menu` and `title`; `default` and `compact` render the header and the
`ui-title` heading exactly as `layout@2` did. The `showTitle` flag is gone.
Existing project layout@1 and layout@2 overrides keep rendering and are
reported as behind by doctor. Theme choice follows the system until the icon toggle is used,
then remembers light/dark; no dropdown or visible appearance label is required.
