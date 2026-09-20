# @jimhoyd/urlcode-ui

## Unreleased

Add textarea and select variants to the `field` component (#288).

`field({control: 'textarea' | 'select', ...})` renders a multi-line or choice
control with the same escaping, label and description/error wiring as the
single-line field, and the kit gains `textarea@1` and `select@1` partials.
Existing `field` calls and the `field@1` partial are unchanged.

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
