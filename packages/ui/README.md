# URLCode UI

Shared presentation for URLCode extensions (auth, admin) and for operator builds beside core. Apache-2.0.
No production dependencies or auth/runtime imports.

## Install

Add the UI extension to a site with `urlcode extensions add ui`: core installs
this package, writes the `extensions.ui` block, the `/assets/ui/*` route and
the `ui/` override files, and adds `ui()` to `host.mjs`. The package's
`./extension` entry is that definition. Publication does not close the
integration and accessibility evidence gaps in
[IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md).

The primitives below (`renderDocument`, `createPresentation`, `escapeHtml`,
`table`, `field`, `button`, and the rest of the root `.` export) need none of
the host activation and can be imported directly from a trusted route.

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
layout patterns. See THIRD_PARTY_NOTICES.md for upstream source and MIT attribution.
The default entry point stays dependency-free; Tailwind is a build dependency.
Auth and admin screens remain in their own packages.
The kit's own stylesheet (`kitCss`, served through `kitAssets` and the `ui`
extension) compiles from `styles/kit.css` the same way, so both stylesheets
come from a Tailwind source of truth instead of one generated and one
hand-written (#617); its shadcn/ui tokens and class names are unchanged.

## Strict CSP and `renderDocument`

`renderDocument` inlines the shared stylesheet in a `<style>` block, which the default
`oshp` CSP (`default-src 'self'`) blocks. Do not switch the route to `oshp-no-csp` or add
`unsafe-inline`. Give the `<style>` a per-response nonce and return a matching CSP; a
response's own `content-security-policy` header wins over the profile's, so the project
profile stays `oshp`.

```ts
import {renderDocument,documentContentSecurityPolicy} from '@jimhoyd/urlcode-ui';
const nonce=Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64url');
return new Response(renderDocument({title:'Home',trustedContent,style:{nonce},theme:{nonce}}),{
  headers:{'content-type':'text/html; charset=utf-8','content-security-policy':documentContentSecurityPolicy(nonce)}});
```

The nonce must be fresh and unpredictable for every response. `theme` is only needed for the
appearance toggle. Pages from `createKit` (and so the `ui` extension, auth and admin) already
link a hashed stylesheet and send their own nonce CSP, so they need none of this.

## Data-bound screens

`crudScreen(kit, {collection, title})` renders a list with a create form, inline
edit and delete for one collection declared the way `@jimhoyd/urlcode-store`
declares it (`{mount, fields, readOnly?}`), so fields are written once. The page
carries only an escaped shell; the `crud` kit script (loaded with the page nonce,
CSP `connect-src 'self'`) fetches the records from `mount` and builds every node
with `textContent` and `value`, never markup. An in-progress edit is kept as a
per-record draft and restored, with focus and caret, whenever the list re-renders;
a checkbox toggle is applied first and rolled back with a message when the update
fails.

In a composed site the `ui` extension does this for you. Add
`extensions.ui.config.screens` (`/todos: {collection: todos, title: Todos}`) and a
route `/todos/*` with `extension: ui`; at activation the extension reads the
collection from `extensions.store` in the project, so nothing is declared twice.
`urlcode extensions add ui store` (or `urlcode init <site> --with ui,store`)
writes both. Field types map to controls: strings
to inputs (textarea above 200 characters or with no `maxLength`), `enum` to a
select, numbers to number inputs, booleans to checkboxes.

By default every declared field appears, labelled from its name. `columns` on a
screen (`columns: [title, {field: done, label: Finished}]`, or the `columns`
option of `crudScreen`) chooses which fields appear, in what order, and
optionally a label of 1 to 80 plain characters; the create form and the rows
follow it. Labels are written as text, never markup. A bad name, a repeated
field or a bad label fails at activation with a message naming the key, and so
does omitting a required field that has no default (a new record could not be
created) unless the collection is `readOnly`.

A collection that declares `sortable` and/or `filterable` fields (the same
lists [`@jimhoyd/urlcode-store`](../../docs/STORE.md#sorting-and-filtering)
checks at activation) gets a sort select and one control per filterable
field, added above the list. Only declared names are ever offered, and the
request the script sends is built with `URLSearchParams` from the controls'
current values (`sort=<field>` or `sort=-<field>`, plus one query parameter
per filter); "load more" repeats the sort and filters that were applied when
the page was last loaded, not whatever the controls hold at the moment the
button is pressed. A collection with neither list renders exactly the shell
it did before: no controls, no `data-query` attribute, byte-identical output.

A plain project (no host file) can still `import` this package from a trusted
function and render static, kit-styled markup, but the kit assets, nonce CSP and
data binding need the operator host, which `urlcode extensions add ui store`
wires.

## Appearance selection

Pass `theme: { nonce }` to `renderDocument` to enable the localized icon-only light/dark
toggle. The host must allow that unpredictable per-response nonce in its CSP
`script-src`; never enable unsafe inline scripts. The static bootstrap runs before
paint and saves only the appearance enum in local storage. Storage denial falls
back gracefully. Without the option or with scripts disabled, CSS follows the
system preference and all native forms/navigation still work.

## The kit: templates, partials, theme, translations, the `ui` extension

Beside the primitives above, the package ships the kit (the original design
spike is private maintainer material): a logic-free template language with enforced escaping, partials in
shadcn/ui markup (`layout`, `nav`, `menu`, `card`, `form`, `field`, `textarea`, `select`, `button`,
`alert`, `otp`, `table`, `tabs`, `empty`, `pagination`, `confirm`), a static
stylesheet on shadcn/ui variables with light and dark values, a theme block, and
project overrides of copy, templates and CSS. The `ui` runtime extension owns the
project's `extensions.ui` block and serves the kit's hashed assets; it lives in
the Node-only `./host` entry so the main entry stays dependency-free.
The shipped component anatomy also carries stable semantic `data-slot` hooks
(`card-*`, `field-*`, `button`, `alert-*`, `table-*`, `empty-*`, dropdown and
sidebar slots). Prefer those hooks and the existing theme variables when adding
project CSS; do not copy an auth/admin workflow merely to restyle it.

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
        transformPage: ./hooks/transform-ui-page.mjs
routes:
  /assets/ui/*:
    extension: ui
    methods: [GET, HEAD]
```

Hashed assets are served under `/assets/ui/static/` and declared as `immutableAssets`, so the runtime answers them with `Cache-Control: public, max-age=31536000, immutable`.

```js
// host.mjs (trusted operator code, outside app/)
import { composeHost } from '@jimhoyd/urlcode/host';
import ui from '@jimhoyd/urlcode-ui/extension';
import auth from '@jimhoyd/urlcode-auth/extension';

export default await composeHost(import.meta.url, [
  ui(),      // or ui({ theme, sources, extensions })
  auth(),
]);
```

`ui({...})` takes extra English catalogues (`sources`), extra extension
templates (`extensions`), both registered after what installed extensions
contribute, and `theme` values the host sets that the project may not.
Declare `ui` first under `extensions` in `app/urlcode.yaml`; `ui.kit` is
available once the runtime has activated it.
`urlcode extensions add ui` composes all of this: `host.mjs` lists `ui()`, whose
`host()` calls `createUiExtension` with `projectRoot` set to the site directory
and registers the copy and templates every installed extension contributes
through its definition's `contributes.ui` (`{sources, templates}`). The scaffold
writes the `extensions.ui` block with a starter theme named after the site, the
`/assets/ui/*` route and `ui/copy/`, `ui/templates/` and `ui/extra.css`
placeholders beside the host; core orders `ui` before the extensions that
require it. Auth and admin render through this kit and receive it from the host.
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
The package also ships `kitCatalogueFr`, a complete French translation of the
base catalogue (`nav.skip`, `action.*`, `message.empty`, `theme.*`) and the
kit's own `ui.*` copy: `createPresentation({ defaults: kitCatalogue,
catalogues: { fr: kitCatalogueFr } })` renders every kit partial in French, and
a starting point for a project's own `ui/copy/<locale>.json` translations
(#616). The translation-coverage report (`Presentation.coverage`,
`compareCatalogues`, `urlcode-ui doctor`) is how a project checks its own
catalogues stay complete as English copy changes; `kitCatalogueFr` is checked
against drift the same way, at both module load and in the package's own
tests.
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
those screens use. Adding `ui` together with `auth` and `admin` (for example
`urlcode init <site> --with ui,auth,admin`) prints the commands with the flag
already set, run from the site as `npx urlcode-ui …`. This package depends on neither peer: the operator names
them. A template cannot change which steps a flow has, what a form
validates, what gets escaped or what a page sends in headers, and cannot add a
script. See CONTRACT.md for the full list and SECURITY.md for the boundary.

`transformView` is the executable escape hatch after those declarative layers.
It receives `{template, view}` immediately before a template renders and must
synchronously return the view object to render. It can add computed project data
to auth/admin/UI views without forking a package. It runs as trusted project code
with full Node access; extension hook contract v1 rejects `sandbox: true`.

`transformPage` is the shell-level companion. It receives `{page}` immediately
before the shared layout renders and may synchronously return the page's
`title`, `layout`, `nav`, `menu` and `flash` fields. Use it to join account and
administration screens to product navigation without copying their templates or
security behavior. Headers, scripts, CSP, presentation context and rendered
content remain renderer-owned.

The registration publishes these choices and their focused checks in its
machine-readable `authoring` contract. `urlcode extensions --host-file ...
--json` and MCP `get_extensions` expose the same contract to people and agents.
Theme and copy edits need no framework build; use `urlcode-ui doctor` for UI
iteration and the full project checks before handoff.
