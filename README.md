# URLCode UI

Shared presentation for URLCode extensions (auth, admin) and for operator builds beside core. Apache-2.0, private/unpublished
while integration is reviewed. No production dependencies or auth/runtime imports.

```ts
import {createPresentation,renderDocument,field,button} from '@jimhoyd/urlcode-ui';
const presentation=createPresentation({
  defaults:{'page.home':'Welcome'},
  theme:{'--ui-accent':'#0645ad'},
}).resolve();
const html=renderDocument({
  title:presentation.text('page.home'),presentation,
  trustedContent:field({name:'email',label:'Email',type:'email'})+button('Continue'),
});
```

The consuming application owns form actions, CSRF, validation and authorization.
Never pass untrusted HTML as trustedContent. See SECURITY.md and CONTRACT.md.

## Core without auth or admin

An operator build can render a page with this package, write the resulting HTML to
`public/welcome.html`, then use an ordinary URLCode page route:

```yaml
version: '1'
routes:
  /welcome:
    page:
      file: public/welcome.html
```

This requires no auth/admin import or extension registry. Rendering inside a trusted
operator extension is also possible; project code never gains host module loading.
Core's redirect-only runtime does not acquire a mandatory private-package dependency.

For local review, run `npm ci`, `npm run verify`, then `npm pack --ignore-scripts`.
Install the resulting archive into a consumer before installing auth and admin.
Do not publish a package as a workaround for local peer resolution.

## Tailwind and shadcn styling

Run `npm run styles` after checkout before source-only typechecks. `npm run build`
and `npm run verify` compile Tailwind automatically, with no consumer CSS setup.
The shipped stylesheet contains shadcn token/primitive adapters and responsive
layout patterns. See THIRD-PARTY-NOTICES.md for upstream source and MIT attribution.
The default entry point stays dependency-free; Tailwind is a build dependency.
Auth and admin screens remain in their own packages.

## Appearance selection

Pass `theme: { nonce }` to `renderDocument` to enable the localized System/Light/Dark
selector. The host must allow that unpredictable per-response nonce in its CSP
`script-src`; never enable unsafe inline scripts. The static bootstrap runs before
paint and saves only the appearance enum in local storage. Storage denial falls
back gracefully. Without the option or with scripts disabled, CSS follows the
system preference and all native forms/navigation still work.

## The kit: templates, partials, theme, translations, the `ui` extension

Beside the primitives above, the package ships the kit the [UI kit spike](docs/SPIKE-UI.md)
describes: a logic-free template language with enforced escaping, partials in
shadcn/ui markup (`layout`, `nav`, `menu`, `card`, `form`, `field`, `button`,
`alert`, `otp`, `table`, `tabs`, `empty`, `pagination`, `confirm`), a static
stylesheet on shadcn/ui variables with light and dark values, a theme block, and
project overrides of copy, templates and CSS. The `ui` runtime extension owns the
project's `extensions.ui` block and serves the kit's hashed assets; it lives in
the Node-only `./host` entry so the main entry stays dependency-free.

```yaml
extensions:
  ui:
    version: "1"
    config:
      theme: { name: Acme, logo: /public/logo.svg, backTo: /, colors: { primary: "24 95% 53%", dark: { primary: "24 95% 60%" } }, radius: 0.75rem }
      languages: [en, fr]
      copy: ui/copy            # ui/copy/fr.json, only the ids to change
      templates: ui/templates  # any <name>.html here shadows a kit or extension template
      stylesheet: ui/extra.css # appended after the kit stylesheet
routes:
  /assets/ui/*:
    extension: ui
    methods: [GET, HEAD]
```

```js
import { createUiExtension } from '@jimhoyd/urlcode-ui/host';
import { englishCatalogue } from '@jimhoyd/urlcode-auth';
const ui = createUiExtension({ projectSha256, projectRoot: '/absolute/site', sources: [englishCatalogue] });
export default { extensions: [ui.registration, authExtension({ /* service, csrfKey, projectSha256, presentation */ })] };
```

Declare `ui` first; `ui.kit` is available once the runtime has activated it.
Auth and admin do not yet take the kit; they render through the primitives
above and a `presentation` (see [implementation status](IMPLEMENTATION-STATUS.md)).
An extension that adopts the kit renders with `ui.kit.render(name, view, context)` and returns
`ui.kit.page(name, view, { title, context })` or `ui.kit.wrap(markup, options)`.
Override order is project file, then the extension's template, then the kit.
`urlcode-ui eject layout --out ui/templates` copies a shipped template;
`urlcode-ui doctor` lists overrides, templates behind their view model and
translation coverage; `urlcode-ui copy --missing fr` prints the keys a language
lacks with the English text as a skeleton; `urlcode-ui preview card` renders a
sample page. A template cannot change which steps a flow has, what a form
validates, what gets escaped or what a page sends in headers, and cannot add a
script. See CONTRACT.md for the full list and SECURITY.md for the boundary.
