# URLCode 0.4.2

Core, UI, auth and admin share this explicitly selected stable version. Independent package versioning remains enabled.

```sh
npm install --save-exact @jimhoyd/urlcode@0.4.2 @jimhoyd/urlcode-ui@0.4.2 @jimhoyd/urlcode-auth@0.4.2 @jimhoyd/urlcode-admin@0.4.2
```

## Changes

<!-- github-release-notes:start -->
### admin-copy-project-override.md

Project translations of `adminUi.*` ids in `ui/copy/<locale>.json` now reach the admin console.

In a composed site the console copy source is built with `createAdminPresentation({ base: kit.presentation })`, and the admin ids were resolved only from the bundled English, so a project's `adminUi.*` entries were silently ignored. When a base presentation is given, an admin id the base resolves for the request's locale now wins; otherwise the bundled admin English still answers. Hosts that pass no `base` and hosts that supply their own presentation are unchanged.

### ui-styles-once-per-verify.md

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
<!-- github-release-notes:end -->

Publish to the npm `latest` channel only after exact-commit CI and candidate verification. Existing tags and the `alpha` channel stay unchanged. Update the standalone starter after core registry installability is verified. This preparation is not evidence of publication or an independent security assessment.
