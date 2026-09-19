# Spike: consolidating core, auth, admin, ui (and the two pending extractions) into one repo

Status: proposal, nothing implemented, no repo touched. Drafted at the requester's
explicit direction to produce a plan document only — see "What this is not"
below. Treat this the same way as the other `SPIKE-*.md` documents in this
directory: a recorded decision trail for the maintainer to accept, amend or
reject, not committed scope.

## What this is not

This is not a recommendation to touch any of `urlcode`, `urlcode-auth`,
`urlcode-admin` or `urlcode-ui` tonight. No git history has been merged, no
package has been moved, no CI has been reconfigured. Everything below is a
sequenced plan to review, not a changelog of what happened.

## The problem this is answering

Four repos (`urlcode`, `urlcode-auth`, `urlcode-admin`, `urlcode-ui`) already
coordinate tightly — `auth`/`admin`/`ui` each pin an exact core revision in
their own `peers.json`, and `docs/FRAMEWORK.md` describes them as one
composed product, not four independent ones. Concretely observed cost of that
coordination happening across four repos, from an evening spent reading all
four:

- `urlcode-auth`'s and `urlcode-admin`'s `peers.json` both pin core to
  `50790d3a` (`0.4.0-alpha.1`), which predates the trusted-by-default
  execution change (`b3bde4e`) landing on `urlcode` main. Nothing is broken
  today — the pin means they simply haven't picked up the change — but
  nothing *caught* that automatically either; it required manually diffing
  three `peers.json` files against `urlcode`'s log.
- `urlcode-auth/SECURITY.md` already contains a sentence ("sandboxed guest
  code") that quietly assumes the pre-trusted-default model. Nobody wrote it
  wrong — it was correct when written — but there is no mechanism today that
  flags prose in a downstream repo as stale when an upstream contract
  changes underneath it.
- Two new repos are already planned and *not yet created*
  (`urlcode-dynamic-link`, `urlcode-middleware` — `docs/SPIKE-CORE-LAYERING.md`),
  which would raise the actively-coordinated repo count from four to six
  before this plan even accounts for `urlcode-template`, `urlcode-short`,
  `urlcode-docs`, `urlcode-cloud` and `homebrew-urlcode`.

None of this is a defect in any one repo. It's the accumulating tax of
coordinating tightly-coupled, independently-versioned packages across
separate git histories, issue trackers and CI pipelines by hand.

## Scope: what moves, what doesn't

Decided (see conversation this spike is drafted from):

**In scope — four existing repos, plus the two not-yet-created ones, as
workspace packages in one repo:**

| Repo today | Becomes |
|---|---|
| `urlcode` (core) | `packages/core` (or repo root stays core-shaped, TBD in "Layout options" below) |
| `urlcode-auth` | `packages/auth` |
| `urlcode-admin` | `packages/admin` |
| `urlcode-ui` | `packages/ui` |
| `urlcode-dynamic-link` (planned, not created) | `packages/dynamic-link`, created directly in the monorepo instead of as its own repo |
| `urlcode-middleware` (planned, not created) | `packages/middleware`, same |

**Explicitly out of scope, each for a distinct, real reason — not just "left
for later":**

- **`homebrew-urlcode`** — cannot move. Homebrew tap conventions require a
  repo literally named `homebrew-<name>`; this is an external platform
  constraint, not a project choice.
- **`urlcode-docs`** — `AGENTS.md` is explicit that public documentation is
  "authored there directly," deliberately separate from code, "no longer
  generated from this repository." Folding it in would reverse a stated,
  recent decision, not follow one.
- **`urlcode-cloud`** — a separately-lifecycled hosted product (private
  repo); its release cadence and access model have no reason to match a
  library monorepo's.
- **`urlcode-template` / `urlcode-short`** — these are example/starter
  projects, not library packages. Mixing "things you `npm install`" with
  "things you `git clone` as a starting point" in one workspace is a
  different kind of repo than what this spike is solving for.

## Why the four-plus-two, and not fewer

`link` and `middleware` are being extracted *out* of core specifically so
core stays "the smallest thing that is still a complete product on its own"
(`docs/SPIKE-CORE-LAYERING.md`). Spinning them up as two *more* freestanding
repos would be solving one problem (core's scope) while creating the exact
problem this spike exists to fix (repo-coordination overhead) — two brand-new
`peers.json` pins and two more places for docs to drift, on day one. Building
them directly as workspace packages in the consolidated repo avoids ever
paying that cost, rather than paying it and then trying to undo it later.

## Layout options

Two shapes are viable; this spike doesn't pick one, because it changes
migration mechanics materially:

**A. Root repo is core, extensions live under `packages/`.**
```
urlcode/
  src/            # core, unchanged in place
  packages/
    auth/
    admin/
    ui/
    dynamic-link/
    middleware/
```
Lowest-friction for core's own history (nothing moves), but makes "core" and
"the monorepo" the same name, which may read as core absorbing the
extensions rather than the extensions and core coexisting as peers — worth a
naming discussion given `AGENTS.md`'s "Core never imports them" independence
framing.

**B. Everything moves under `packages/`, including core.**
```
urlcode-monorepo/           # new repo name, TBD
  packages/
    core/
    auth/
    admin/
    ui/
    dynamic-link/
    middleware/
```
Symmetric, avoids the naming question above, costs more: core's history has
to move too (not just the three extension repos), and every existing
external reference to `urlcode`'s repo path (`docs/`, READMEs elsewhere,
the `@jimhoyd/urlcode` package's repository field, CI badges, this very
`peer-camera`/`peer-eyes` conversation's citations) needs updating, not just
the three joining repos'.

**Recommendation, not a decision:** (A). Core stays where it is, least
history-rewriting, least external-link breakage; the extensions move to it
rather than everything moving to a new home.

## Migration mechanics, per repo

For each of `urlcode-auth`, `urlcode-admin`, `urlcode-ui` (and, trivially,
for the two repos that don't exist yet — they just get created directly at
their target path instead):

1. **Preserve history with `git subtree add` or `git filter-repo` +
   merge**, not a fresh copy — so `git log`/`git blame` on
   `packages/auth/src/auth.ts` still resolves to the real authorship history
   from `urlcode-auth`, and so a future "actually, let's give this its own
   repo back" is a clean `git filter-repo` extraction, not archaeology.
   `git subtree` is the lower-risk default (reversible, no force-push
   required on the source repos); `git filter-repo` gives cleaner resulting
   history at the cost of being a one-way rewrite of the joining repo's
   local copy (the original `urlcode-auth` GitHub repo is untouched either
   way — this only rewrites what gets pulled in).
2. **npm workspace restructuring**: `package.json` at the monorepo root gets
   `"workspaces": ["packages/*"]` (the same shape `peer-camera` already
   uses); each `packages/<name>/package.json` keeps its own name/version,
   independently publishable via workspace-aware `npm publish` or a
   changesets-style release flow — this is what preserves "independently
   versioned packages" as a property, not something this migration gives up.
3. **`peers.json` becomes unnecessary for the four/six that moved** — a
   workspace package can depend on a sibling workspace package directly
   (`"@jimhoyd/urlcode": "workspace:*"` or npm's equivalent), which is
   inherently always in sync, no separate pin file, no drift possible by
   construction. `peers.json`-the-mechanism might still matter if any
   *external* consumer needs a reviewed-revision pin story — worth deciding
   explicitly rather than silently dropping the safeguard.
4. **CI consolidation**: one `verify.yml` (or similar) with
   path-filtered jobs per package, replacing four separate workflow files.
   `CODEOWNERS` can still express per-package ownership within one repo
   (path-scoped rules), so "who reviews auth changes" doesn't have to
   become "everyone reviews everything."
5. **Docs cross-references**: every `[EXTENSIONS.md](../urlcode/docs/...)`-
   style cross-repo link in `auth`/`admin`/`ui`'s current docs becomes a
   same-repo relative link once consolidated — this is a real cleanup
   opportunity, not just migration overhead, since it directly targets the
   "docs silently drifted apart" problem this spike opened with.
6. **Issue migration**: GitHub doesn't move issues across repos cleanly;
   realistic options are (a) leave existing open issues where they are and
   close/link them once resolved, letting old-repo issue history stay as
   historical record, or (b) bulk-recreate open issues in the new location
   with a back-link. (a) is less work and loses nothing real.

## What this preserves, unchanged

- **The trust/extension model itself.** `packages/auth` published from the
  monorepo is exactly as separate a package, with exactly the same
  `RuntimeExtension` contract, revision-pinning and operator-registration
  requirements, as `urlcode-auth` published from its own repo today. This
  spike changes where the source lives, not what the extension mechanism
  guarantees.
- **Independent versioning and release cadence per package** — a monorepo
  with workspaces is not "one version number for everything."

## What this gives up, honestly

- **Per-repo maturity gating.** `docs/SPIKE-CORE-LAYERING.md` records that
  `auth`/`admin`/`ui` used a "`private: true` until reviewed" pattern before
  their first public release, and that the two new repos are deliberately
  *not* following that pattern ("published public from the start"). A
  monorepo can't easily make one folder private and another public — the
  repo-level visibility setting is all-or-nothing on GitHub. Once
  consolidated, "private until reviewed" stops being available as a pattern
  for whatever the next extension after `middleware`/`dynamic-link` turns
  out to be, unless it's built in yet another separate private repo first
  and merged in later — which reintroduces a version of the coordination
  cost this spike is trying to remove, just for pre-release work instead of
  ongoing maintenance.
- **"Fork just one piece" stops being a plain `git clone`.** `SPIKE-AUTH.md`
  names forkability as a deliberate design goal specifically for `auth`.
  Post-consolidation, forking just the auth package means a `git
  filter-repo`-style history extraction instead of `git clone
  jimhoyd-com/urlcode-auth` — solvable, but a real step up in friction for
  that specific, previously-easy use case.
- **Blast radius of a bad CI run.** One consolidated CI means a
  misconfigured job can, in principle, block merges across all four/six
  packages at once, where today a broken `urlcode-ui` pipeline can't stop an
  unrelated `urlcode-auth` merge. Path-filtered jobs mitigate this but don't
  eliminate it the way full repo separation does.

## Sequencing, if this is accepted

1. Decide layout (A vs. B above) and confirm the out-of-scope list.
2. Land `urlcode-dynamic-link`'s Phase 1 (core-side removal, already
   scoped in `docs/SPIKE-CORE-LAYERING.md`) and the `middleware` extraction's
   capability-analysis prerequisite *before* touching repo structure — these
   are core changes that should happen on `main` regardless of whether this
   consolidation ever happens, and doing them first means the monorepo
   starts from a clean state rather than migrating mid-refactor.
3. Migrate `urlcode-ui` first (fewest inbound dependents — `auth`/`admin`
   both depend on it, nothing depends on them), proving the subtree +
   workspace mechanics on the lowest-risk package.
4. Migrate `urlcode-auth`, then `urlcode-admin`.
5. Create `packages/dynamic-link` and `packages/middleware` directly in the
   consolidated repo — never as standalone repos at all.
6. Retire (archive, don't delete — GitHub redirects an archived repo's clone
   URL) the four/two now-empty source repos, with their READMEs pointing at
   the new location.

## Open questions for the maintainer, not answered here

- Layout A vs. B.
- Does `peers.json`'s reviewed-pin discipline need an equivalent for any
  external (non-workspace) consumer, or does workspace-linking fully replace
  its purpose?
- `git subtree` vs. `git filter-repo` for history preservation — a real
  tradeoff between migration safety and final history cleanliness, worth a
  deliberate call rather than defaulting.
- Timing relative to shipping `dynamic-link`/`middleware` at all — this
  spike assumes both proceed, just landing in a new location; if either is
  reconsidered independently, this plan's "four-plus-two" scope shrinks
  accordingly.
