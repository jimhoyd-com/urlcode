# @jimhoyd/urlcode-ui

## Unreleased

- A ui template namespace now belongs to its contributor (#753). core's `ctx.contributions('ui')` hands each value as `{from, value}` with the contributing extension's name; at host composition ui refuses a `templates` entry whose `name` is not `from` (`ui template namespace "<name>" is contributed by extension "<from>": ...`) and any template or view model key outside `<from>/` (`ui template "<key>" is contributed by extension "<from>" outside its namespace: ...`). `urlcode-ui --extensions` applies the same check against each package definition's name. `createUiExtension({screens})` takes `UiScreenContribution` entries (`{from, source}`), and a screen path two extensions claim names both. Operator-supplied `ui({extensions})` in host.mjs is not checked.

- Extension scripts (`kit.wrap`/`kit.page` `scripts`) accept `async: true`, and an absolute `https:` URL whose origin the page lists in `csp.script`, so an extension passes a challenge widget to the kit instead of rewriting the page nonce. Any other off-site script is refused with `Extension script must be same-site or listed in csp.script`.
- `urlcode-ui --extensions <pkg>` reads each package's `./extension` definition (`contributes.ui`) instead of root exports; a package without that entry or without ui templates is skipped with a note (`no ./extension entry`, `no ui templates contributed`).

The `ui` extension no longer reads the store's configuration (#709). `extensions.ui.config.screens` is removed; a data screen now arrives through the owning extension's `contributes.ui.screens` (`UiContribution.screens`, a `UiScreenSource` that resolves `{<path>: {title, collection, columns?}}` once at activation), and `ui` renders it at its exact `extension: ui` mount. The scaffold no longer adds a `/todos` screen when `store` is installed; the store's scaffold does. To migrate, move each entry of `extensions.ui.config.screens` unchanged to `extensions.store.config.screens`; the `<path>/*` route with `extension: ui` stays as it is.

`field()` accepts `min` and `max` for `number`, `date` and `datetime-local` inputs and renders them as the HTML attributes; any other control or type, or a value that is not number- or date-shaped, throws (#528).

`transformView` and `transformPage` receive core's generic hook context as a second argument; these presentation filters do not run on behalf of one request, so it is `{requestId: null, env: {}}` (#678).

## 0.5.0

Align the coordinated stable release at `0.5.0` on npm’s `latest` channel. Internal peer minimums advance to this release.

## 0.4.9

Align the coordinated stable release at `0.4.9` on npm’s `latest` channel. Internal peer minimums advance to this release.

## 0.4.6

Align the coordinated stable release at `0.4.6` on npm’s `latest` channel. Internal peer minimums advance to this release.

Versions 0.4.3, 0.4.4 and 0.4.5 were prepared but never published, so npm went from 0.4.2 straight to this release. 0.4.3's candidate failed in the release container (two checks called `git ls-files` on a checkout owned by another user); 0.4.4's publisher stopped at its preflight (the peer-floor guard held core itself to a floor it cannot have); 0.4.5 stopped at the CI gate, where the slowest runner (Windows, Node 22) took over 500 ms for a pattern the guard accepts. The `v0.4.4` tag stays where it is. This release fixes all three, and lowers the input bound for schema `pattern` from 256 to 128 characters (a schema that sets `pattern` now needs `maxLength` of at most 128), which makes the worst accepted pattern about eight times cheaper. It carries every change prepared for 0.4.3, listed in `docs/RELEASE-0.4.3.md`. Highlights: `request.body.schema` validation and `shared` blocks, multi-step fixtures and a quiet `urlcode test`, an unordered `init --with` with a generic `--ack`, store collection sorting and filtering, the data-bound CRUD screen, and the first store release line.

## 0.4.5

Align the coordinated stable release at `0.4.5` on npm’s `latest` channel. Internal peer minimums advance to this release.

Versions 0.4.3 and 0.4.4 were prepared but never published. The 0.4.3 candidate failed in the release container because two checks called `git ls-files` on a checkout owned by another user. The 0.4.4 publisher then stopped at its preflight, which held core itself to a peer floor it cannot have. Nothing was published for either version (npm went from 0.4.2 straight to this release), and the `v0.4.4` tag stays where it is. This release fixes both and carries every change prepared for 0.4.3, listed in `docs/RELEASE-0.4.3.md`. Highlights: `request.body.schema` validation and `shared` blocks, multi-step fixtures and a quiet `urlcode test`, an unordered `init --with` with a generic `--ack`, store collection sorting and filtering, the data-bound CRUD screen, and the first store release line.

## 0.4.4

Align the coordinated stable release at `0.4.4` on npm’s `latest` channel. Internal peer minimums advance to this release.

Version 0.4.3 was prepared but never published: its candidate build failed in the release container because two checks called `git ls-files` on a checkout owned by another user, which git refuses as dubious ownership. Nothing was tagged or published for 0.4.3. This release fixes those checks and carries every change prepared for 0.4.3, listed in `docs/RELEASE-0.4.3.md`, on top of 0.4.2. Highlights: `request.body.schema` validation and `shared` blocks, multi-step fixtures and a quiet `urlcode test`, an unordered `init --with` with a generic `--ack`, the store collection sorting and filtering, the data-bound CRUD screen, and the first store extension release line.

## 0.4.3

Align the coordinated stable release at `0.4.3` on npm’s `latest` channel. Internal peer minimums advance to this release.

Keep published archives to built runtime files and required legal, security and usage material. Auth installations no longer pull the AWS SES SDK unless the operator selects the built-in SES sender.

`crudScreen` renders a data-bound list with create, inline edit and delete for a collection declared in `extensions.store`, configured with `screens` (per-field labels and column selection), served with a nonce'd, content-hashed client script and no inline script; an edit in progress survives re-render and a failed update rolls its optimistic change back. `field()` gains `textarea` and `select` controls with `textarea@1` and `select@1` kit partials. `renderDocument` takes an optional `style: {nonce}` and `documentContentSecurityPolicy(nonce)` returns the matching strict CSP, so those pages run under the default `oshp` profile. `init --with ui,store` composes the screen.

Add sort and filter controls to the data-bound screen (#330). A collection
that declares `sortable` and/or `filterable` fields (the same lists
`@jimhoyd/urlcode-store` checks at activation) gets a sort select and one
control per filterable field, added to the `crud` kit script; requests are
built with `URLSearchParams` from those declared names only, values are never
echoed unescaped, and "load more" repeats the sort and filters that were
applied when the list was last loaded rather than picking up an edited
control. A collection with no declarations renders the identical shell it did
before (`data-query` is omitted) and the script adds no controls. One new
copy key, `ui.crud.sort`. Shipping this required trimming the package back
under its unpacked-size budget: `kitCss`, `stylesheet` and `kitCssLimit` now
carry an explicit type annotation instead of an inferred string-literal type,
so their generated `.d.ts` declarations stop duplicating the full compiled
CSS as a type (about 68 KB saved, no change to the emitted JavaScript or the
runtime value). See [`docs/STORE.md`](../../docs/STORE.md#sorting-and-filtering)
and the byte accounting in [`docs/OPEN-DECISIONS.md`](../../docs/OPEN-DECISIONS.md).

Add data-bound list and form screens (#262). `crudScreen`, `crudMarkup` and
`crudFields` render a create form, inline edit and delete for a collection
declared the way `@jimhoyd/urlcode-store` declares it, driven by the new `crud`
kit script (nonce-loaded, escaped, edit drafts survive re-renders, failed
optimistic toggles roll back). The `ui` extension gains `screens` in its
configuration, reads the store's declaration at activation and serves each
screen at its own `/*` route, and `init --with ui,store` composes them at
`/todos`. `init` no longer writes a duplicate import line when two extensions
share one, and the store scaffold describes `PROJECT_SHA256` the way ui and auth
do so the three compose.

Add `columns` to data-bound screens (#330): choose, order and relabel the
fields a screen shows, in the `ui` config (`screens.<path>.columns`) or the
`crudScreen` option. Names and labels are validated with the offending key in
the error; the default output is unchanged and the crud script is unchanged.
Filtering and sorting wait for store support.

Add textarea and select variants to the `field` component (#288).

`field({control: 'textarea' | 'select', ...})` renders a multi-line or choice
control with the same escaping, label and description/error wiring as the
single-line field, and the kit gains `textarea@1` and `select@1` partials.
Existing `field` calls and the `field@1` partial are unchanged.

Let `renderDocument` pages run under the default `oshp` CSP (#287). New optional
`style: {nonce}` puts the nonce on the inline `<style>`, and the new
`documentContentSecurityPolicy(nonce)` returns the matching strict CSP. Without
`style` the output is unchanged.

## 0.4.2

Align the coordinated stable release at `0.4.2` on npm’s `latest` channel. Internal peer minimums advance to this release.

Compile Tailwind once per `npm run verify`.

No API change and no change to the generated stylesheet. `verify` used to run
`typecheck` then `build`, and each of those runs `styles`, so
`scripts/build-styles.mjs` compiled the same minified CSS twice per
verification. `verify` now runs `styles` once and then the compiler-only
`typecheck:tsc` and `build:tsc` scripts. `typecheck` and `build` are unchanged
from a caller's point of view: each still runs `styles` first, so either one
works on its own from a fresh checkout.

Nothing is cached and nothing is skipped because an output already exists; the
single run is unconditional, so a source change is still picked up.

## 0.4.1

Align the coordinated stable release at `0.4.1` on npm’s `latest` channel.

This coordinated release moves core, UI, auth and admin from `0.4.0-alpha.3` to stable `0.4.1`. It makes the reviewed monorepo release line available through npm `latest` and keeps the four packages' peer minimums aligned.

The runtime retains its existing trust model: project functions and middleware run trusted in Node by default; routes declaring `sandbox: true` retain QuickJS/WASM isolation. The stable label is a distribution decision, not an independent security assessment or hostile multi-tenant readiness claim.

Release preparation now supports an explicit exit from alpha. Publication promotes the exact signed candidate archives, pins their manifest digest in immutable tags, checks actual npm installability, and updates the standalone starter to the published core version. Historical alpha versions and tags remain unchanged.

The scaffold wires kit-rendering peers into the host it generates. `scaffold()` reads the composed `names` and emits `createUiExtension({..., sources: [authCatalogue], extensions: [authUiTemplates, adminUiTemplates]})`, importing each peer it needs, so `urlcode init --with ui,auth,admin` produces a project that activates. Previously it always wrote `sources: []` and no `extensions`, which left auth and admin without their copy and templates. `ui` alone still registers nothing and imports no peer.

Name `ui` first: the runtime activates extensions in the order `urlcode.yaml` declares them, core writes that file in `--with` order, and auth and admin both refuse to activate before the kit is active.

<!-- local-links: historical-file -->

## 0.4.0-alpha.3

- Align this release with core, auth and admin at `0.4.0-alpha.3`. The version jump identifies the coordinated monorepo release; no new UI API is implied by the shared number.
- Include current monorepo packaging, Windows portability and contributor guidance fixes.

## 0.1.0-alpha.6

### Patch Changes

- 2262eed: Move into the core repository as `packages/ui`.
  
  No API change. The package's source moved from `jimhoyd-com/urlcode-ui` into
  `jimhoyd-com/urlcode` as a workspace package. The move used `git subtree add`,
  but the pull request was squash-merged, so `git blame` on `main` resolves to
  the merge commit rather than the original authorship; the full history remains
  in the archived `jimhoyd-com/urlcode-ui`. Three things changed to suit the new
  location:
  
  - `scripts/build-styles.mjs` resolves the Tailwind CLI through its package
    manifest instead of a hardcoded package-local `node_modules` path, because
    npm hoists shared devDependencies to the workspace root.
  - The cross-repository test now finds core at the repository root and so runs
    by default rather than skipping. There is no pinned peer revision left to go
    stale.
  - Ten lint errors were fixed, since core's `eslint .` now reaches this package.
    Four were redundant escapes in the CSP source pattern (verified
    behavior-identical against 300k inputs); six were `Function` types in a test.
