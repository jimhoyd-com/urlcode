# @jimhoyd/urlcode-auth

## Unreleased

Bearer routes accept a per-credential quota, `auth: {bearer: {scopes, quota: {requests, window}}}` (#572): each API key gets `requests` per `window` seconds, counted by key id in the auth SQLite store (fixed window, durable, shared by processes on one host). The request over budget is refused with 429, `Retry-After` and `RateLimit-Policy`/`RateLimit` under the policy name `credential`, before the handler runs. `AuthService.consumeApiKeyQuota` is the service method behind it.

Lifecycle hooks (`beforeRegister`, `onSignUp`, `onDelete`) receive core's generic hook context, `{requestId, env}`, as a second argument (#678).

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

The auth store worker reports the last startup stage it reached, and the readiness-timeout message names it, so a slow start shows where it stalled. The auth scaffold declares what it provides and requires, so `init --with` no longer depends on argument order.

Keep published archives to built runtime files and required legal, security and usage material. Auth installations no longer pull the AWS SES SDK unless the operator selects the built-in SES sender.

## 0.4.2

Align the coordinated stable release at `0.4.2` on npm’s `latest` channel. Internal peer minimums advance to this release.

## 0.4.1

Align the coordinated stable release at `0.4.1` on npm’s `latest` channel. Internal peer minimums advance to this release.

This coordinated release moves core, UI, auth and admin from `0.4.0-alpha.3` to stable `0.4.1`. It makes the reviewed monorepo release line available through npm `latest` and keeps the four packages' peer minimums aligned.

The runtime retains its existing trust model: project functions and middleware run trusted in Node by default; routes declaring `sandbox: true` retain QuickJS/WASM isolation. The stable label is a distribution decision, not an independent security assessment or hostile multi-tenant readiness claim.

Release preparation now supports an explicit exit from alpha. Publication promotes the exact signed candidate archives, pins their manifest digest in immutable tags, checks actual npm installability, and updates the standalone starter to the published core version. Historical alpha versions and tags remain unchanged.

Breaking: the `ui` extension is now required. Every account screen renders through the `urlcode-ui` kit; the shared-primitive fallback is gone. `authExtension({ui, ...})` refuses activation when `ui` is absent or when the runtime has not activated it, naming the missing piece instead of failing per request. Declare `ui` before `auth` in `urlcode.yaml` (with its asset route) and list `ui.registration` before `authExtension` in the host: the runtime activates extensions in the order `urlcode.yaml` declares them. `@jimhoyd/urlcode-ui` was already a required peer dependency, so nothing new needs installing; what changes is that the extension must be supplied and active. `ScreenOptions.ui` is no longer optional and `screenObserver` no longer reports a render path.

Scaffolding composes the kit for you: `urlcode init --with ui,auth` and the standalone `initAuthentication` now write a project whose `urlcode.yaml` declares `ui` first and whose host passes it to `authExtension`. The scaffold refuses when `ui` is missing, or ordered after `auth`, before anything is written.

Report which startup phase an auth store worker reached when its 15-second bound elapses, and reject at once when the worker fails or exits before reporting readiness instead of waiting the bound out. The status and code are unchanged; the detail is attached as the error's cause for operator logs and never reaches a response.

`urlcode-auth init` now writes a `package.json` that pins this package and each declared peer at the exact version installed beside it, instead of a manifest with no dependencies at all; `initAuthentication` returns those pins and names any peer it could not resolve. Nothing is installed: running `npm install` in the generated directory to produce a lockfile stays the operator's explicit step, and no upgrade command exists.

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
