---
"@jimhoyd/urlcode-ui": patch
---

Move into the core repository as `packages/ui`.

No API change. The package's source moved from `jimhoyd-com/urlcode-ui` into
`jimhoyd-com/urlcode` as a workspace package, with history preserved, and three
things changed to suit the new location:

- `scripts/build-styles.mjs` resolves the Tailwind CLI through its package
  manifest instead of a hardcoded package-local `node_modules` path, because
  npm hoists shared devDependencies to the workspace root.
- The cross-repository test now finds core at the repository root and so runs
  by default rather than skipping. There is no pinned peer revision left to go
  stale.
- Ten lint errors were fixed, since core's `eslint .` now reaches this package.
  Four were redundant escapes in the CSP source pattern (verified
  behavior-identical against 300k inputs); six were `Function` types in a test.
