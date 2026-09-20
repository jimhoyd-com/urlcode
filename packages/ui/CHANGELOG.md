# @jimhoyd/urlcode-ui

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
