---
"@jimhoyd/urlcode-ui": patch
---

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
