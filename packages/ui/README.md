# URLCode UI

Shared presentation for URLCode extensions (auth, admin) and for operator builds beside core. Apache-2.0.
No production dependencies or auth/runtime imports.

## Install

```sh
npm install @jimhoyd/urlcode-ui
```

The npm `latest` tag identifies the stable package version; `alpha` is the
separate prerelease channel. Pin the resolved version in applications and use
the exact tested stack shown on its GitHub release. Stable publication does not
close the integration and accessibility evidence gaps in
[IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md).

To build from source instead, run `npm ci`, `npm run verify`, then
`npm pack --ignore-scripts`, and install the resulting archive into a consumer.
That order matters: `dist/` is generated and `files` ships it, so packing
without building first produces an archive whose every export resolves to a
missing file, with no error from npm. `npm run verify` builds before it tests,
and one of those tests asserts the packed tarball actually contains what the
exports map names.

[![CI](https://github.com/jimhoyd-com/urlcode/actions/workflows/ci.yml/badge.svg)](https://github.com/jimhoyd-com/urlcode/actions/workflows/ci.yml)

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

Shared form fragments live here too, so auth and admin render the same shape:

```ts
import {postForm,hiddenField,withDeadline} from '@jimhoyd/urlcode-ui';
const form=postForm({action:'/auth/revoke-session',csrf,fields:hiddenField('sessionId',id),label:'Revoke this session',destructive:true});
const result=await withDeadline(signal=>store.revoke(id,{signal}),5000,'Revoking timed out');
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
Core's redirect-only runtime does not acquire a mandatory dependency on this package.

For local review of unreleased changes, build from source as described under
Install and install the archive into a consumer before installing auth and admin.

## Tailwind and shadcn styling

Run `npm run styles` after checkout before source-only typechecks. `npm run build`
and `npm run verify` compile Tailwind automatically, with no consumer CSS setup.
`verify` compiles it once and then runs the compiler-only `typecheck:tsc` and
`build:tsc` steps, so a full verification does not rebuild the same stylesheet
twice; `typecheck` and `build` still compile it themselves when run on their own.
The shipped stylesheet contains shadcn token/primitive adapters and responsive
layout patterns. See THIRD-PARTY-NOTICES.md for upstream source and MIT attribution.
The default entry point stays dependency-free; Tailwind is a build dependency.
Auth and admin screens remain in their own packages.

## Appearance selection

Pass `theme: { nonce }` to `renderDocument` to enable the localized icon-only light/dark
toggle. The host must allow that unpredictable per-response nonce in its CSP
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
      hooks:
        transformView: ./hooks/transform-ui-view.mjs
routes:
  /assets/ui/*:
    extension: ui
    methods: [GET, HEAD]
```

Hashed assets are served under `/assets/ui/static/` and declared as `immutableAssets`, so the runtime answers them with `Cache-Control: public, max-age=31536000, immutable`.

```js
import { createUiExtension } from '@jimhoyd/urlcode-ui/host';
import { englishCatalogue } from '@jimhoyd/urlcode-auth';
const ui = createUiExtension({ projectSha256, projectRoot: '/absolute/site', sources: [englishCatalogue] });
export default { extensions: [ui.registration, authExtension({ /* service, csrfKey, projectSha256, presentation */ })] };
```

Declare `ui` first; `ui.kit` is available once the runtime has activated it.
`urlcode init <directory> --with ui,auth,admin` composes all of this: core
resolves the package's `scaffold` export, which returns the `extensions.ui`
block with a starter theme named after the directory, the `/assets/ui/*` mount,
the host fragment above with `projectRoot` resolved from the host file's own
location, `ui/copy/`, `ui/templates/` and `ui/extra.css` placeholders beside
the host, a README section and the `doctor` and `eject` next steps. Core lists
the host entries in `--with` order and the contract carries no ordering field,
so name `ui` first. `scaffold` writes nothing.
Auth and admin render through this kit when the composed scaffold supplies it.
An extension that adopts the kit renders with `ui.kit.render(name, view, context)` and returns
`ui.kit.page(name, view, { title, context })` or `ui.kit.wrap(markup, options)`.
`options.layout: 'application'` makes the kit render the console shell itself
(`ui-shell`, `ui-sidebar`, `ui-content`, `ui-page-header`) from the page
`title`, `nav` and `menu`, so a console passes data rather than markup and the
navigation appears exactly once,
`nav` items may carry an `icon`, and `scripts` takes kit script names beside
the extension's own `{ src: '/account/static/passkeys.js', integrity? }`
served under its mount; every script carries the page nonce. A host that
builds its own `presentation` need not register `kitCatalogue`: the kit
completes the `ui.*` copy itself, and the host's keys win.
Override order is project file, then the extension's template, then the kit.
`urlcode-ui eject layout --out ui/templates` copies a shipped template;
`urlcode-ui doctor` lists overrides, templates behind their view model and
translation coverage; `urlcode-ui copy --missing fr` prints the keys a language
lacks with the English text as a skeleton; `urlcode-ui preview card` renders a
sample page.
The CLI is this kit alone until it is told which packages ship the other
namespaces: `--extensions @jimhoyd/urlcode-auth,@jimhoyd/urlcode-admin` adds
them, on every command. Each package is resolved from `--project` with Node
package resolution and imported for the namespace it exports
(`ExtensionTemplates`, which carries the templates, their view model versions,
the English catalogue the host registers in `sources` and a sample per
template); one that is not installed there is skipped with a note, so a command
still runs. The site's `host.mjs` is never imported: it builds services and
reads secrets at its top level, and a read-only `list` or `doctor` must not run
it. With the packages named, `list` and `doctor` cover `auth/*` and `admin/*`
too, a project override of an extension template is checked against the shipped
view model it has to keep up with, `eject auth/sign-in` copies one, `preview`
renders the extension's own sample, and `copy --missing` offers the copy ids
those screens use. `urlcode init --with ui,auth,admin` writes the commands with
the flag already set. This package depends on neither peer: the operator names
them. A template cannot change which steps a flow has, what a form
validates, what gets escaped or what a page sends in headers, and cannot add a
script. See CONTRACT.md for the full list and SECURITY.md for the boundary.

`transformView` is the executable escape hatch after those declarative layers.
It receives `{template, view}` immediately before a template renders and must
synchronously return the view object to render. It can add computed project data
to auth/admin/UI views without forking a package. It runs as trusted project code
with full Node access; extension hook contract v1 rejects `sandbox: true`.
