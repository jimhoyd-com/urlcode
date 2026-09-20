# @jimhoyd/urlcode-admin

<!-- local-links: historical-file -->

## 0.4.0-alpha.3

- Refresh lifecycle hook entry modules on each activation; changes to imported hook dependencies still require a process restart.
- Include deterministic resource cleanup and Windows portability corrections.
- Align the release with core/UI/auth at `0.4.0-alpha.3` and require their coordinated peer floors.

## 0.1.0-alpha.4

### Patch Changes

- Move into the core repository as `packages/admin`.
  
  No API change. The package's source moved from `jimhoyd-com/urlcode-admin` into
  `jimhoyd-com/urlcode` as a workspace package. Its `peers.json` pinned core,
  auth and ui separately, and those pins disagreed with auth's own; a workspace
  makes that drift structurally impossible, so the file and its test are gone.
  
  - Seven lint errors fixed, since core's `eslint .` now covers this package. A
    thrown symptom error was discarding the underlying failure and now attaches
    it as `cause`, so the stack still names the import that failed.
  - Trust-model prose was already correct and needed no changes.
