---
"@jimhoyd/urlcode-admin": patch
---

Move into the core repository as `packages/admin`.

No API change. The package's source moved from `jimhoyd-com/urlcode-admin` into
`jimhoyd-com/urlcode` as a workspace package. Its `peers.json` pinned core,
auth and ui separately, and those pins disagreed with auth's own; a workspace
makes that drift structurally impossible, so the file and its test are gone.

- Seven lint errors fixed, since core's `eslint .` now covers this package. A
  thrown symptom error was discarding the underlying failure and now attaches
  it as `cause`, so the stack still names the import that failed.
- Trust-model prose was already correct and needed no changes.
