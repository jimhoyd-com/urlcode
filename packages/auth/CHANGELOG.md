# @jimhoyd/urlcode-auth

<!-- local-links: historical-file -->

## 0.4.0-alpha.3

- Carry forward deterministic SQLite worker termination on rejected initialization, preserving the original configuration error and avoiding Windows file-handle races.
- Refresh lifecycle hook entry modules on each activation; changes to imported hook dependencies still require a process restart.
- Align the release with core/UI/admin at `0.4.0-alpha.3` and require the coordinated core/UI peer floors.

## 0.1.0-alpha.6

### Patch Changes

- No change to the published package.
  
  `0.1.0-alpha.5` was tagged at a commit whose `prepare-extension-release.sh`
  never built core or ui before typechecking auth against them, so the release
  failed at preparation and published nothing. Release tags are immutable and
  GitHub runs a workflow from the commit its tag points at, so the fix needs a
  new tag on a new commit rather than a retag.
- 174319a: Fix backup and restore on Windows by flushing the snapshot through a writable handle. Preserve POSIX directory flushing and document the Windows directory-entry durability limitation.

## 0.1.0-alpha.5

### Patch Changes

- No change to the published package.
  
  `0.1.0-alpha.4` was versioned and tagged but never published. Its tag was
  created before the peer-floor gate was fixed, and GitHub runs a workflow from
  the commit the tag points at, so re-running that release would have re-executed
  the broken gate. Moving a tag onto a later commit is worse than spending a
  version number, so the version moves instead and the inert `0.1.0-alpha.4` tag
  is left pointing at a commit that never shipped.
  
  `@jimhoyd/urlcode-ui@0.1.0-alpha.6` and `@jimhoyd/urlcode-admin@0.1.0-alpha.4`
  published normally; this only affects auth.

## 0.1.0-alpha.4

### Patch Changes

- Move into the core repository as `packages/auth`.
  
  No API change. The package's source moved from `jimhoyd-com/urlcode-auth` into
  `jimhoyd-com/urlcode` as a workspace package, and its peer pinning went with
  it: `peers.json` and its test are gone, because a workspace package and its
  siblings are the same commit by construction and cannot drift apart.
  
  - Two stale trust-model paragraphs in `docs/SPIKE-AUTH.md` now carry the
    machine-readable `trust-model-prose: historical` marker. Both already had
    human-written corrections beside them; core's enforcing check could not see
    those, and now reaches this package's prose.
  - Ten lint errors fixed, since core's `eslint .` now covers this package.
    Three empty `catch` blocks say what they swallow; four redundant escapes were
    removed from an email local-part pattern and a hostname pattern, both
    verified behaviour-identical against 400k generated inputs plus an exhaustive
    sweep of every character below U+2000.
