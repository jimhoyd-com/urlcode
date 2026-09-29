# URLCode UI

Shared presentation for URLCode extensions (forms, form-records, the store's screens) and for operator builds beside core. Apache-2.0.
No production dependencies or runtime imports.

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

Shared form fragments live here too, so extensions render the same shape:

```ts
import {postForm,hiddenField,withDeadline} from '@jimhoyd/urlcode-ui';
const form=postForm({action:'/notes/delete',csrf,fields:hiddenField('noteId',id),label:'Delete this note',destructive:true});
const result=await withDeadline(signal=>notes.delete(id,{signal}),5000,'Deleting timed out');
```

The consuming application owns form actions, CSRF, validation and authorization.
Never pass untrusted HTML as trustedContent. See SECURITY.md and CONTRACT.md.

## Core without other extensions

An operator build can render a page with this package, write the resulting HTML to
`public/welcome.html`, then use an ordinary URLCode page route:

```yaml
version: '1'
routes:
  /welcome:
    page:
      file: public/welcome.html
```

This requires no extension import or extension registry. Rendering inside a trusted
operator extension is also possible; project code never gains host module loading.
Core's redirect-only runtime does not acquire a mandatory dependency on this package.

To review local changes, build from source as described under Install and
install that archive into a consumer before installing the extensions that
require it.

## Tailwind and shadcn styling

Run `npm run styles` after checkout before source-only typechecks. `npm run build`
and `npm run verify` compile Tailwind automatically, with no consumer CSS setup.
`verify` compiles it once and then runs the compiler-only `typecheck:tsc` and
`build:tsc` steps, so a full verification does not rebuild the same stylesheet
twice; `typecheck` and `build` still compile it themselves when run on their own.
The shipped stylesheet contains shadcn token/primitive adapters and responsive
layout patterns. See THIRD_PARTY_NOTICES.md for upstream source and MIT attribution.
The default entry point stays dependency-free; Tailwind is a build dependency.
An extension's screens remain in its own package.
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
appearance toggle. Pages from `createKit` (and so the `ui` extension and the extensions it renders for) already
link a hashed stylesheet and send their own nonce CSP, so they need none of this.

## Data-bound screens

`crudScreen(kit, {collection, title})` renders a list with a create form, inline
edit and delete for one collection API, described generically as `{mount,
fields, readOnly?, sortable?, filterable?, transitions?, idempotency?}`, so the extension that serves the
API can hand the same declaration to the screen and fields are written once. The page
carries only an escaped shell; the `crud` kit script (loaded with the page nonce,
CSP `connect-src 'self'`) fetches the records from `mount` and builds every node
with `textContent` and `value`, never markup. An in-progress edit is kept as a
per-record draft and restored, with focus and caret, whenever the list re-renders;
a checkbox toggle is applied first and rolled back with a message when the update
fails. Every write to an existing record (a saved edit, a checkbox toggle, a
delete, a transition) sends `If-Match` with the ETag the list returned for the
record in `etags`, or the `ETag` of the screen's own last write to it (none when
neither exists). A `412` means another write got there first: the page says so
(`ui.crud.stale`), the edit row keeps what was typed, a toggle is rolled back and
a delete leaves the row, so nothing changes until the viewer refreshes. After a
successful write the row carries the ETag the response returned.

In a composed site the `ui` extension serves these screens for the extensions
that contribute them; it never reads another extension's configuration. An
extension that owns collections passes a screen source through its
definition's `contributes.ui.screens` (see `UiContribution` in the
[contract](CONTRACT.md)). At activation `ui` calls each source once with the
route project root and receives `{<path>: {title, collection, columns?}}`; each
path must have a route `<path>/*` with `extension: ui`, a path claimed twice
refuses naming both contributing extensions, and a bad collection, column or title fails activation naming the
screen. The store extension is one such contributor: its screens are declared
under `extensions.store.config.screens`, next to the collections they show
(see [store screens](../../docs/STORE.md#a-screen-for-the-collection)).
Field types map to controls: strings
to inputs (textarea above 200 characters or with no `maxLength`), `enum` to a
select, numbers to number inputs, booleans to checkboxes.

By default every declared field appears, labelled from its name. `columns` on a
screen (a contributed screen's `columns`, or the `columns` option of
`crudScreen`) chooses which fields appear, in what order, and
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

A collection may describe named state changes as `transitions: [{name, from,
mount?}]` (the store contributes its
[declared transitions](../../docs/STORE.md#transitions-on-a-screen)), with
`idempotency: true` when the API retains `Idempotency-Key`. A field marked
`transitionOnly` is shown read-only: it is never a control in the create form
or an edit row and never part of a request body (a boolean one is a disabled
checkbox). Each transition is a button, labelled from its name, on the rows
that hold every `from` value, including on a `readOnly` screen. A click sends
`POST <mount>/<id>` when the transition has a `mount`, else `POST <collection
mount>/<id>/<name>`, with no body, `credentials: 'same-origin'`, `If-Match`
set to the ETag the list returned for the record in `etags` (or the `ETag` of
the screen's own last write to it; none when neither exists) and, with
`idempotency`, a fresh random `Idempotency-Key`. The row then shows the
returned record. A refusal becomes a page message and leaves the row as it
was: `409` (`ui.crud.transitionConflict`), `412`
(`ui.crud.stale`, as for any write), `403` (`ui.crud.transitionForbidden`) and
anything else (`ui.crud.transitionFailed`). The declaration is validated at
activation (at most 16 transitions, names `^[a-z][a-z0-9_-]{0,63}$`, 1 to 8
declared `from` fields with scalar values, a mount path); it reaches the page
as an escaped data attribute and the script writes names, labels and values
only as text. A screen without transitions renders the same shell as before.
The screen cannot know who may run a transition beyond the declaration and the
record's values; the API decides, and its `403` is the message.

A plain project (no host file) can still `import` this package from a trusted
function and render static, kit-styled markup, but the kit assets, nonce CSP and
data binding need the operator host, which `urlcode extensions add ui` (plus
the extension that contributes the screen) wires.

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
project CSS; do not copy an extension's workflow merely to restyle it.

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

A fixture cannot know those hashed names, so `ui` declares `/assets/ui/*` an
asset mount (`assetMounts`). `urlcode audit` then requests an unknown name
under `/assets/ui/static/`, expects `404` with no cookie, and lists the mount's
`GET` and `HEAD` under `extensionAssetRouteMethods` rather than `uncovered`
([extension asset mounts](../../docs/READINESS.md#extension-asset-mounts)).
Screen mounts are not asset mounts and still need fixtures.

The `ui` extension needs exactly one such asset mount, besides any screen
mounts; with none it refuses to activate (`ui extension needs exactly one route
mount`), because every page it renders links the stylesheet and scripts under
it. So a site that only serves JSON still declares the route once it installs an
extension that requires `ui`, such as forms or form-records: those extensions
render their own pages
([#812](https://github.com/jimhoyd-com/urlcode/issues/812)).
The mount is harmless: it answers `GET` and `HEAD` for the kit's hashed files
only, `404` for any other path, and sets no cookie and keeps no state.

```js
// host.mjs (trusted operator code, outside app/)
import { composeHost } from '@jimhoyd/urlcode/host';
import ui from '@jimhoyd/urlcode-ui/extension';
import forms from '@jimhoyd/urlcode-forms/extension';

export default await composeHost(import.meta.url, [
  ui(),      // or ui({ theme, sources, extensions })
  forms(),   // requires ui
]);
```

`ui({...})` takes extra English catalogues (`sources`), extra extension
templates (`extensions`), both registered after what installed extensions
contribute, and `theme` values the host sets that the project may not.
The order of `extensions` in `app/urlcode.yaml` does not matter: the runtime
activates `ui` before every extension that requires it, and `ui.kit` is
available once it has.
`urlcode extensions add ui` composes all of this: `host.mjs` lists `ui()`, whose
`host()` calls `createUiExtension` with `projectRoot` set to the site directory
and registers the copy and templates every installed extension contributes
through its definition's `contributes.ui` (`{sources, templates}`). A template
namespace belongs to the extension that contributes it: core stamps every
contribution with its contributor's name, and ui refuses at host composition a
namespace whose `name` is another extension's (`ui template namespace "notes" is
contributed by extension "demo": an extension contributes ui templates only
under its own name`) or a template outside `<name>/` (`ui template "layout" is
contributed by extension "demo" outside its namespace: name it demo/<template>`).
Templates passed in `ui({extensions})` are the operator's own and are not
checked. The scaffold
writes the `extensions.ui` block with a starter theme named after the site, the
`/assets/ui/*` route and `ui/copy/`, `ui/templates/` and `ui/extra.css`
placeholders beside the host; core orders `ui` before the extensions that
require it. Its `urlcode-ui doctor` and `eject` hints pass `--extensions` for
every installed extension package whose definition contributes ui templates. No first-party extension contributes templates today; an
extension that does renders through this kit and receives it from the host.
An extension that adopts the kit renders with `ui.kit.render(name, view, context)` and returns
`ui.kit.page(name, view, { title, context })` or `ui.kit.wrap(markup, options)`.
`options.layout: 'application'` makes the kit render the console shell itself
(`ui-shell`, `ui-sidebar`, `ui-content`, `ui-page-header`) from the page
`title`, `nav` and `menu`, so a console passes data rather than markup and the
navigation appears exactly once,
`nav` items may carry an `icon`, and `scripts` takes kit script names beside
the extension's own `{ src: '/notes/static/editor.js', integrity?, async? }`
served under its mount; every script carries the page nonce and loads with
`defer`, or `async` when the entry says so. An extension script may also be an
absolute `https:` URL whose origin the same page lists in `csp.script` (a
challenge widget, for example), and nothing else off-site: the kit refuses
`Extension script must be same-site or listed in csp.script`. A host that
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
namespaces: `--extensions <package>,<package>` adds
them, on every command. Each package's `./extension` entry is resolved from
`--project` with Node package resolution, and the CLI reads the namespace from
its definition's `contributes.ui` (the templates, their view model versions,
the English catalogue and a sample per template); a package that is not
installed there, has no `./extension` entry or contributes no ui templates is
skipped with a note, so a command still runs. The site's `host.mjs` is never imported: it builds services and
reads secrets at its top level, and a read-only `list` or `doctor` must not run
it. With the packages named, `list` and `doctor` cover their `<name>/*`
templates too, a project override of an extension template is checked against
the shipped view model it has to keep up with, `eject <name>/<template>` copies
one, `preview` renders the extension's own sample, and `copy --missing` offers
the copy ids those screens use. Adding `ui` together with such an extension
prints the commands with the flag already set, run from the site as
`npx urlcode-ui …`. This package depends on none of them: the operator names
them. A template cannot change which steps a flow has, what a form
validates, what gets escaped or what a page sends in headers, and cannot add a
script. See CONTRACT.md for the full list and SECURITY.md for the boundary.

`transformView` is the executable escape hatch after those declarative layers.
It receives `{template, view}` immediately before a template renders and must
synchronously return the view object to render. It can add computed project data
to extension and UI views without forking a package. It runs as trusted project code
with full Node access; extension hook contract v1 rejects `sandbox: true`.

`transformPage` is the shell-level companion. It receives `{page}` immediately
before the shared layout renders and may synchronously return the page's
`title`, `layout`, `nav`, `menu` and `flash` fields. Use it to join an extension's
screens to product navigation without copying their templates or
security behavior. Headers, scripts, CSP, presentation context and rendered
content remain renderer-owned.

The registration publishes these choices and their focused checks in its
machine-readable `authoring` contract. `urlcode extensions --host-file ...
--json` and MCP `get_extensions` expose the same contract to people and agents.
Theme and copy edits need no framework build; use `urlcode-ui doctor` for UI
iteration and the full project checks before handoff.

<!-- extension-reference:start -->
<!-- Generated from urlcode.json by scripts/generate-extension-reference.ts (npm run docs:extensions). Do not edit between these markers; change the extension's schema descriptions instead. -->

## Field reference

Every key `ui` accepts, rendered from this package's `urlcode.json` (the schema the runtime validates against). Required means required within its containing object; `*` is a key you choose and `[]` an array item.

**Schema-valid is not activatable.** JSON Schema checks shape only. Activation also checks what a schema cannot express: the route for each declared mount exists, referenced fields and collections are declared, peers are installed and active, and the cross-field rules the descriptions state. A project that validates can still refuse to start; run `urlcode validate --project . --host-file <host.mjs> --origin <origin>`, which activates it.

**Peers.** none.

### Configuration: `extensions.ui.config`

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `extensions.ui.config.theme` | object | no | unknown keys rejected | Brand and design tokens for every page the kit renders. Values are checked against a narrow grammar at activation, so a theme never carries CSS syntax, URLs or markup. |
| `extensions.ui.config.theme.name` | string | no | maxLength: 80 | Brand name shown in the page header; plain text. |
| `extensions.ui.config.theme.logo` | string | no | maxLength: 512 | Local absolute path of the header logo image, for example /public/logo.svg; no scheme, query or traversal. |
| `extensions.ui.config.theme.favicon` | string | no | maxLength: 512 | Local absolute path of the favicon; same rules as logo. |
| `extensions.ui.config.theme.backTo` | string | no | maxLength: 1024 | Same-site path (optional query) the header links back to, for example /; never a scheme or protocol-relative URL. |
| `extensions.ui.config.theme.colors` | object | no | unknown keys rejected | Light-scheme colour overrides by semantic shadcn/ui token; unset tokens keep the kit defaults. |
| `extensions.ui.config.theme.colors.background` | string | no | maxLength: 32 | Semantic colour --background: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.foreground` | string | no | maxLength: 32 | Semantic colour --foreground: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.card` | string | no | maxLength: 32 | Semantic colour --card: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.cardForeground` | string | no | maxLength: 32 | Semantic colour --card-foreground: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.popover` | string | no | maxLength: 32 | Semantic colour --popover: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.popoverForeground` | string | no | maxLength: 32 | Semantic colour --popover-foreground: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.primary` | string | no | maxLength: 32 | Semantic colour --primary: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.primaryForeground` | string | no | maxLength: 32 | Semantic colour --primary-foreground: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.secondary` | string | no | maxLength: 32 | Semantic colour --secondary: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.secondaryForeground` | string | no | maxLength: 32 | Semantic colour --secondary-foreground: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.muted` | string | no | maxLength: 32 | Semantic colour --muted: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.mutedForeground` | string | no | maxLength: 32 | Semantic colour --muted-foreground: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.accent` | string | no | maxLength: 32 | Semantic colour --accent: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.accentForeground` | string | no | maxLength: 32 | Semantic colour --accent-foreground: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.destructive` | string | no | maxLength: 32 | Semantic colour --destructive: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.destructiveForeground` | string | no | maxLength: 32 | Semantic colour --destructive-foreground: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.border` | string | no | maxLength: 32 | Semantic colour --border: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.input` | string | no | maxLength: 32 | Semantic colour --input: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.ring` | string | no | maxLength: 32 | Semantic colour --ring: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.dark` | object | no | unknown keys rejected | Dark-scheme colour overrides, applied by media query and by the dark class. |
| `extensions.ui.config.theme.colors.dark.background` | string | no | maxLength: 32 | Semantic colour --background in the dark scheme: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.dark.foreground` | string | no | maxLength: 32 | Semantic colour --foreground in the dark scheme: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.dark.card` | string | no | maxLength: 32 | Semantic colour --card in the dark scheme: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.dark.cardForeground` | string | no | maxLength: 32 | Semantic colour --card-foreground in the dark scheme: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.dark.popover` | string | no | maxLength: 32 | Semantic colour --popover in the dark scheme: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.dark.popoverForeground` | string | no | maxLength: 32 | Semantic colour --popover-foreground in the dark scheme: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.dark.primary` | string | no | maxLength: 32 | Semantic colour --primary in the dark scheme: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.dark.primaryForeground` | string | no | maxLength: 32 | Semantic colour --primary-foreground in the dark scheme: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.dark.secondary` | string | no | maxLength: 32 | Semantic colour --secondary in the dark scheme: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.dark.secondaryForeground` | string | no | maxLength: 32 | Semantic colour --secondary-foreground in the dark scheme: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.dark.muted` | string | no | maxLength: 32 | Semantic colour --muted in the dark scheme: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.dark.mutedForeground` | string | no | maxLength: 32 | Semantic colour --muted-foreground in the dark scheme: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.dark.accent` | string | no | maxLength: 32 | Semantic colour --accent in the dark scheme: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.dark.accentForeground` | string | no | maxLength: 32 | Semantic colour --accent-foreground in the dark scheme: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.dark.destructive` | string | no | maxLength: 32 | Semantic colour --destructive in the dark scheme: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.dark.destructiveForeground` | string | no | maxLength: 32 | Semantic colour --destructive-foreground in the dark scheme: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.dark.border` | string | no | maxLength: 32 | Semantic colour --border in the dark scheme: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.dark.input` | string | no | maxLength: 32 | Semantic colour --input in the dark scheme: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.colors.dark.ring` | string | no | maxLength: 32 | Semantic colour --ring in the dark scheme: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation. |
| `extensions.ui.config.theme.radius` | string | no | maxLength: 16 | Corner radius --radius: 0 to 2rem or 0 to 32px. |
| `extensions.ui.config.theme.font` | string | no | maxLength: 128 | Plain font-family list, for example Inter, sans-serif; no url() or escapes. |
| `extensions.ui.config.languages` | array | no | minItems: 1; maxItems: 32; uniqueItems: true; items: string (maxLength: 35) | Language tags the site offers (default [en]); any other than en needs a copy directory with `<copy>/<tag>.json`. |
| `extensions.ui.config.copy` | string | no | maxLength: 256 | Relative directory under ui/ holding `<locale>.json` catalogues that override or translate catalogue entries by id, for example ui/copy. |
| `extensions.ui.config.templates` | string | no | maxLength: 256 | Relative directory under ui/ whose `<name>.html` files shadow a kit or extension template of that name, for example ui/templates. |
| `extensions.ui.config.stylesheet` | string / object | no | one of: string (maxLength: 256); object (fields below) | Project CSS under ui/: a path is appended after the kit stylesheet; {file, replace: true} replaces it. Script, javascript:, expression() and @import are refused. |
| `extensions.ui.config.stylesheet.file` | string | yes | maxLength: 256 | Relative path of the CSS file under ui/ (at most 512 KiB). |
| `extensions.ui.config.stylesheet.replace` | boolean | no | — | true: serve this file instead of the kit stylesheet; default false (append). |

### Project hooks: `extensions.ui.config.hooks`

Trusted project filter hooks by name ({source, export} or a bare module path) that adjust a view model or the page shell before rendering; sandbox: true is refused.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `extensions.ui.config.hooks.transformView` | string / object | no | one of: string (minLength: 1; maxLength: 1024); object (fields below) | Filter hook: Runs before a named kit template renders and returns the view model to render. |
| `extensions.ui.config.hooks.transformView.source` | string | yes | minLength: 1; maxLength: 1024 | Project-relative path of the trusted hook module, resolved like a function route source and re-imported on each activation. |
| `extensions.ui.config.hooks.transformView.export` | string | no | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" | Named export to call (default: the module default export). |
| `extensions.ui.config.hooks.transformView.sandbox` | boolean | no | — | Schema-valid but refused at activation when true: extension hooks run trusted, in-process, and are never sandboxed. |
| `extensions.ui.config.hooks.transformView.sandboxReason` | string | no | minLength: 1; maxLength: 512 | Reviewer note recorded with a sandbox choice; it grants nothing. |
| `extensions.ui.config.hooks.transformPage` | string / object | no | one of: string (minLength: 1; maxLength: 1024); object (fields below) | Filter hook: Runs before the shared page layout renders and may change its title, layout, navigation, account menu or flash message. |
| `extensions.ui.config.hooks.transformPage.source` | string | yes | minLength: 1; maxLength: 1024 | Project-relative path of the trusted hook module, resolved like a function route source and re-imported on each activation. |
| `extensions.ui.config.hooks.transformPage.export` | string | no | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" | Named export to call (default: the module default export). |
| `extensions.ui.config.hooks.transformPage.sandbox` | boolean | no | — | Schema-valid but refused at activation when true: extension hooks run trusted, in-process, and are never sandboxed. |
| `extensions.ui.config.hooks.transformPage.sandboxReason` | string | no | minLength: 1; maxLength: 512 | Reviewer note recorded with a sandbox choice; it grants nothing. |

#### `transformView` (filter)

Runs before a named kit template renders and returns the view model to render.

Called as `transformView(input, context)`; `context` carries `requestId` and the mount route's granted `env`, frozen.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `input.template` | string | yes | — | Name of the template about to render, for example layout. |
| `input.view` | object | yes | — | The view model; return it, changed or not, as the model to render. |

Returns an object, validated before use.

#### `transformPage` (filter)

Runs before the shared page layout renders and may change its title, layout, navigation, account menu or flash message.

Called as `transformPage(input, context)`; `context` carries `requestId` and the mount route's granted `env`, frozen.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `input.page` | object | yes | — | The page options (title, layout, navigation, account menu, flash); return the options to render. |

Returns an object, validated before use.

### Authoring surfaces and limits

Keep the site as one application: customize the installed UI in the project and keep each extension's behavior in its package. Use a new extension only for a capability the installed extensions do not provide.

- **theme** (theme, `urlcode.yaml#extensions.ui.config.theme`): Set brand name, local assets, semantic light/dark colours, radius and font in extensions.ui.config.theme.
- **copy** (copy, `ui/copy/<locale>.json`): Override or translate catalogue entries without copying a screen.
- **templates** (template, `ui/templates/<name>.html`): Override only the screen or shared partial whose structure must change; doctor reports view-model drift.
- **stylesheet** (stylesheet, `ui/extra.css`): Append project CSS after the shared stylesheet; use semantic shadcn tokens and existing ui-* component classes.
- **transformView** (hook, `extensions.ui.config.hooks.transformView`): Add computed project data to a named view immediately before its template renders.
- **transformPage** (hook, `extensions.ui.config.hooks.transformPage`): Customize the shared page shell, navigation, account menu and flash immediately before layout rendering.

Fast checks: `urlcode-ui doctor --project . --copy ui/copy --templates ui/templates --stylesheet ui/extra.css`, `urlcode validate --local`.
<!-- extension-reference:end -->
