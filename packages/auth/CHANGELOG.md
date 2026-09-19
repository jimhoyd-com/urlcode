# @jimhoyd/urlcode-auth

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
