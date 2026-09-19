# Spike: consolidating core, auth, admin and ui into one repo

> Maintainer update: monorepo work is starting now. The older proposal-only
> status and instruction to postpone repository changes below are superseded.
> Retired short-link packages and the deleted docs repository are historical
> entries, not migration scope.
>
> **Correction (2026-09-19, later the same day): middleware is no longer
> migration scope either.** The instruction this note used to carry —
> "middleware moves in as its own package with its existing behavior; folding
> it into core comes afterward" — was overtaken by events.
> `jimhoyd-com/urlcode-middleware` has been **deleted**, and
> `@jimhoyd/urlcode-middleware` unpublished from npm at `0.1.0-alpha.2`. There
> is no `packages/middleware` to create and nothing to fold into core
> afterward: per-route middleware was already native to core all along
> (`docs/MIDDLEWARE.md`), and the deleted package only ever offered the same
> behavior through the extension seam. Every "five repositories" count below
> is now **four**: core, `urlcode-auth`, `urlcode-admin`, `urlcode-ui`.

Status: migration direction accepted and work starting; completion is not claimed.
The updated analysis from main is retained below.

**Precondition re-surveyed 2026-09-19, after the cleanup PRs landed.** An
earlier revision of this header said the coordinated cleanup PRs were open
across core, auth, admin, UI and middleware, and told the reader to settle them
before each package moves. They have since settled — core merged `#175` and
`#176`, and a fresh survey reports **zero open pull requests across all four**
in-scope repositories. Core holds open issues; `auth`, `admin` and `ui` report
zero. Mechanics #0 is therefore satisfied again and mechanics #7 is again a
no-op. Treat that as perishable and re-run it per repository immediately before
that repository moves, exactly as mechanics #0 says. Trust by default and
explicit sandbox choices remain unchanged.

> **Update (2026-09-19) — reviewed against the live repositories, npm and the
> checks that have landed since. Four things changed; the recommendation did
> not.**
>
> 1. **Scope is five repositories, not six.** `urlcode-dynamic-link` was
>    deleted rather than migrated, along with `urlcode-short` and
>    `urlcode-docs` — all three unpublished from npm and their GitHub
>    repositories removed. In scope: core, `urlcode-auth`, `urlcode-admin`,
>    `urlcode-ui`, `urlcode-middleware`. **Superseded later the same day —
>    `urlcode-middleware` was deleted too, making it four. See the correction
>    at the top.**
> 2. **The hard precondition is currently met.** Zero open pull requests *and*
>    zero open issues across all five (surveyed 2026-09-19), so mechanics #0 is
>    satisfied and mechanics #7 is a no-op. This window closes on its own.
>    **Re-surveyed after the cleanup PRs landed: still zero open PRs, now
>    across four repositories; core has since accumulated open issues. See the
>    top of this document.**
> 3. **The drift this plan opened with has already recurred** — see "The
>    problem this is answering" below. It is now an observation, not a forecast.
> 4. **A second argument exists that this document does not make:** the
>    enforcing trust-model check cannot reach the four downstream repositories.
>    See "What consolidation would newly enforce".
>
> Sections below carry their own dated notes where the text they replace is
> kept for the record. Anything not marked still reads as originally written.

Treat this the same way as the other `SPIKE-*.md` documents in this
directory: a recorded decision trail for the maintainer to accept, amend or
reject. **Superseded in part — the maintainer has since accepted the
direction (see the top), so the plan below is committed scope, not a
proposal.**

## What this is not

> **Superseded, and now factually false.** The paragraph below is kept because
> it describes the state the plan was drafted in. It said "no git history has
> been merged"; that stopped being true when `urlcode-ui` was merged in as
> `packages/ui`. See "What has landed" immediately below for the current
> state.

This is not a recommendation to touch any of `urlcode`, `urlcode-auth`,
`urlcode-admin` or `urlcode-ui` tonight. No git history has been merged, no
package has been moved, no CI has been reconfigured. Everything below is a
sequenced plan to review, not a changelog of what happened.

## What has landed

> **Added 2026-09-19.** This section is a changelog, not a plan. Everything
> above it that reads as a proposal should be checked against this first.

**`urlcode-ui` is in, as `packages/ui`.** Sequencing steps 1-3 are done; steps
4-6 are not started. Specifically:

- `git subtree add --prefix=packages/ui` at `b7eadf2`, with the precondition
  re-verified immediately before the move (zero open PRs, zero open issues).
  Authorship history is preserved and `git blame` resolves through the move.
- The root `package.json` declares `"workspaces": ["packages/*"]`, and the root
  `verify` script now runs each workspace's own `verify` — without that, ui's
  57 tests silently stop running the moment it becomes a workspace.
- Changesets is configured in `.changeset/`, with `fixed` and `linked` empty so
  independent versioning is preserved. Core is not covered by it, because under
  layout A core is the repository root rather than a workspace member.
- **Mechanics #3 is done for ui: `peers.json` is gone**, along with
  `scripts/peer-revisions.mjs` and the workflow that read them. ui's
  cross-repository test resolves core from the repository root instead, so it
  runs by default rather than skipping. There is no pinned peer revision left
  to go stale -- a workspace package and its sibling are the same commit by
  construction. ui had no `peers.test.ts`; `auth` and `admin` do, and theirs
  will need deleting with the file.
- **Mechanics #4 and #5 are done for ui.** `packages/ui/.github/` has been
  removed rather than left inert: GitHub reads workflows, `CODEOWNERS`,
  `dependabot.yml` and issue templates only from the repository root, so every
  file in it was dead where it sat. Verification moved to core's `ci.yml`,
  which now covers ui through the root `verify` on a 3x3 OS/Node matrix --
  wider than the ubuntu-only workflow ui had of its own. Releases moved to
  [`.github/workflows/release-ui.yml`](../.github/workflows/release-ui.yml).
  Root `CODEOWNERS` already matched ui's (`* @jimhoyd`) so nothing was lost,
  and Dependabot's npm entry at `/` covers workspaces from the root. The
  cross-repository links in ui's docs are now relative, including
  `docs/SPIKE-UI.md`'s link to the extension model review, which had been a
  404 since `98b5659` archived its target -- independent of this migration.
  ui's `package.json` `repository`/`homepage`/`bugs` name this repository, with
  `repository.directory` set to `packages/ui`, since those ship to npm.

**Not done, and outward-facing -- all three are the maintainer's to do:**

1. **Re-register `@jimhoyd/urlcode-ui`'s npm trusted publisher** against
   `jimhoyd-com/urlcode` and `.github/workflows/release-ui.yml` (mechanics #6).
   The entry is pinned to a repository *and a workflow filename*, and the
   filename had to change because core already owns `release.yml`. Until this
   is done the publish step fails closed, which is correct behavior rather
   than a bug: **ui cannot be released from here yet.**
2. **Archive `jimhoyd-com/urlcode-ui`** (step 6) -- but only after a release
   from the new location has actually worked. Archive, do not delete: unlike
   the September retirements, this code continues to live at a new path, so
   the clone-URL redirect is the entire point.
3. **Retag.** `git subtree add` did not carry ui's four `v0.1.0-alpha.*` tags,
   and they are not re-creatable under the scheme decided above anyway. They
   remain in the source repository until it is archived.

### Corrections this migration forced on the plan

Four claims above did not survive contact, and one of them was the document's
strongest argument.

1. **"What consolidation would newly enforce" was substantially overstated, and
   is now true only because the checks were changed to make it true.** As
   written, `check-trust-model-prose.ts` matched `PROJECT_ROOTS` against
   root-relative prefixes, so `packages/ui/src/*.ts` comments were **not**
   scanned; its `EXTRA_FILES` was root-only, so `packages/ui/llms.txt` -- the
   most agent-facing file the package ships -- was scanned by neither check;
   and `check-guidance-claims.ts` used a hardcoded ten-path `TARGETS` list that
   could never reach a package at all. Consolidation on its own would have
   bought Markdown coverage and nothing else. Both scripts now discover
   workspace packages from disk, which was verified by planting violations in
   `packages/ui/src/kit.ts` and `packages/ui/llms.txt` and confirming a
   non-zero exit. File counts went 417 -> 467 and targets 10 -> 12.
2. **"21 commits behind" was 24** by the time the move happened, and would have
   kept drifting. Figures in this document go stale within a day; re-measure
   rather than cite.
3. **`git log <new path>` does not show pre-move history**, contrary to
   mechanics #1. `git blame` does, and nothing is lost, but `git log
   packages/ui/src/kit.ts` returns only the subtree-add commit because the
   original 47 commits record the path as `src/kit.ts`. Use
   `git log <old-sha> -- src/kit.ts`.
4. **Two day-one breakages the plan did not anticipate.** Core's `eslint .`
   reaches `packages/` immediately, and ui had never been linted: 10 errors on
   the merge commit, plus more from generated `dist/` output once built,
   because the root eslint ignores were root-anchored rather than `**/`-
   anchored. Separately, `scripts/build-styles.mjs` hardcoded a package-local
   `node_modules` path that does not exist once npm hoists devDependencies to
   the workspace root. Both are fixed. Expect the same class of breakage from
   `auth` and `admin`, which have 41 and 7 lint errors respectively and have
   also never been linted.

**A collision this document does not mention at all -- now settled.** Core and
every extension trigger releases on `tags: ['v*']`, and their alpha tags
literally overlap: ui carries `v0.1.0-alpha.2` through `-alpha.5`, admin
`v0.1.0-alpha.1` and `-alpha.3`, auth `v0.1.0-alpha.1` through `-alpha.3`. In
one repository, pushing a bare `v*` tag fires more than one release workflow.

Decided: workspace packages release on Changesets' `<package name>@<version>`
form, core keeps `v*`, and the two cannot collide because a scoped name starts
with `@`. See [open decisions, "Accepted: per-package release
tags"](OPEN-DECISIONS.md) for the reasoning and
[`scripts/check-release-tags.ts`](../scripts/check-release-tags.ts), which
fails `npm run check` if a future package workflow breaks the scheme. `ui`'s
workflow has been moved onto it already, including the tag-to-version parsing
that depended on the old `v` prefix.

`git subtree add` does not carry tags, so none of ui's four came across. They
would not be re-creatable under the old scheme anyway.

## The problem this is answering

Four repos (`urlcode`, `urlcode-auth`, `urlcode-admin`, `urlcode-ui`) already
coordinate tightly — `auth`/`admin`/`ui` each pin an exact core revision in
their own `peers.json`, and `docs/FRAMEWORK.md` describes them as one
composed product, not four independent ones. Concretely observed cost of that
coordination happening across four repos, from an evening spent reading all
four:

- **Observed and since fixed, which is the point rather than a counterpoint.**
  When core landed trusted-by-default execution (`b3bde4e`), `urlcode-auth`
  and `urlcode-admin` were both still pinning core at `50790d3a`
  (`0.4.0-alpha.1`), predating it, and `urlcode-auth/SECURITY.md` still
  carried a sentence ("sandboxed guest code") that assumed the old model.
  Both have since been corrected — both repos now pin `d5e86017`, and that
  sentence is gone. Nothing was ever broken in production by either.
  The cost this plan is describing is not "drift goes unnoticed forever"; it
  is that catching and fixing it took a manual pass across three separate
  repositories, with nothing structural to catch it automatically — no
  mechanism flags a downstream repo's prose or pin as stale when an upstream
  contract changes underneath it. That pass has to be repeated by hand on
  every future contract change, for every downstream repo, indefinitely.
  Consolidation removes the class of work, not just this instance of it.

  > **Update (2026-09-19): it recurred, which settles the argument.** The
  > correction recorded above held for roughly one day. `urlcode-auth`,
  > `urlcode-admin` and `urlcode-ui` all still pin core at `d5e86017`
  > (2026-09-18), now **21 commits behind core's `main`** — a span that
  > includes the trusted-by-default propagation in `db375bf` and the
  > retirements in `10c2439`. Nothing is broken in production again, and that
  > is again beside the point: the manual pass this document described as
  > repeating indefinitely repeated within twenty-four hours of being
  > performed. This is no longer a predicted cost.
- Two more repos, planned in `docs/SPIKE-CORE-LAYERING.md` and originally
  drafted here as "not yet created," turned out to already exist by the time
  this doc was reviewed: `urlcode-dynamic-link` (7 commits, Phase 2 already
  implemented, `v0.1.0-alpha.1` released) and `urlcode-middleware` (5 commits,
  implemented, `v0.1.0-alpha.1` released), each with its own real commit
  history, release workflow and open issues. That raises the
  actively-coordinated repo count from four to six today, not hypothetically
  — before this plan even accounts for `urlcode-template`, `urlcode-short`,
  `urlcode-docs`, `urlcode-cloud` and `homebrew-urlcode`. It also means
  "create them directly in the monorepo" (this doc's original framing) is no
  longer available for these two — they now need the same history-preserving
  migration as `auth`/`admin`/`ui`, covered in "Migration mechanics" below.

None of this is a defect in any one repo. It's the accumulating tax of
coordinating tightly-coupled, independently-versioned packages across
separate git histories, issue trackers and CI pipelines by hand.

## Scope: what moves, what doesn't

Decided (see conversation this spike is drafted from):

**In scope — originally six existing repos, all with real history, folded
into one repo as workspace packages. Two of the six were deleted instead of
migrated, leaving four:**

| Repo today | Becomes |
|---|---|
| `urlcode` (core) | `packages/core` (or repo root stays core-shaped, TBD in "Layout options" below) |
| `urlcode-auth` | `packages/auth` |
| `urlcode-admin` | `packages/admin` |
| `urlcode-ui` | `packages/ui` |
| ~~`urlcode-dynamic-link`~~ | **No longer applicable — repository deleted 2026-09-19, not migrated.** See the note below. |
| ~~`urlcode-middleware`~~ | **No longer applicable — repository deleted 2026-09-19 at `0.1.0-alpha.2`, not migrated.** Per-route middleware is native to core; see the correction at the top. |

> **Update (2026-09-19): five, not six.** `urlcode-dynamic-link` was created,
> released `v0.1.0-alpha.1`, and deleted within days. Read as evidence rather
> than as a lost migration target, it is the sharpest data point this document
> has: standing up a repository per extension was costly enough that one of
> them was unwound outright rather than maintained. The section "Why six, and
> not four" below should be read as "why five, and not four"; its argument
> about `middleware` having already paid the coordination cost was unaffected
> at the time — though `middleware` was itself deleted later the same day, so
> the pattern this note reads as a one-off turned out to repeat.

**Explicitly out of scope — three live repositories, each for a distinct, real
reason, not just "left for later":**

> **Update (2026-09-19):** this list was four. Two of its entries no longer
> exist: `urlcode-short` and `urlcode-docs` were both deleted, so neither is a
> candidate for anything. The three that remain — `homebrew-urlcode`,
> `urlcode-cloud`, `urlcode-template` — are unaffected, and their reasons hold
> exactly as written.

- **`homebrew-urlcode`** — cannot move. Homebrew tap conventions require a
  repo literally named `homebrew-<name>`; this is an external platform
  constraint, not a project choice.
- **`urlcode-docs`** — `AGENTS.md` is explicit that public documentation is
  "authored there directly," deliberately separate from code, "no longer
  generated from this repository." Folding it in would reverse a stated,
  recent decision, not follow one.

  > **Update (2026-09-19): resolved — the repository is deleted.** The decision
  > quoted above was reversed, and then `urlcode-docs` was unpublished and
  > **removed from GitHub**, not merely archived. Documentation is authored in
  > this repository's `docs/`, and `AGENTS.md` no longer sends pages anywhere
  > else — see [open decisions, item 6](OPEN-DECISIONS.md). This entry is kept
  > only so the reversal is legible; there is nothing left to include or
  > exclude.
- **`urlcode-cloud`** — a separately-lifecycled hosted product (private
  repo); its release cadence and access model have no reason to match a
  library monorepo's.
- **`urlcode-template`** (and, when it existed, `urlcode-short`) — an
  example/starter project, not a library package. Mixing "things you
  `npm install`" with "things you `git clone` as a starting point" in one
  workspace is a different kind of repo than what this spike is solving for.
  `urlcode-short` was deleted on 2026-09-19; the reasoning survives it and
  still governs `urlcode-template`, which remains out of scope.

## Why five, and not four — resolved: it is four

> **Update (2026-09-19):** written as "why six", then narrowed to five when
> `dynamic-link` was deleted. `middleware` has since been deleted as well, so
> the answer is **four**, and this section is now entirely historical. It is
> kept because the reasoning is what the outcome refutes: the argument below
> was that `link` and `middleware` had already paid the coordination cost and
> should therefore be folded in rather than left outside the fix. Both were
> instead withdrawn altogether. That is a third possible response to the
> coordination cost this document is about — not "consolidate it" and not
> "keep paying it", but "stop shipping the thing" — and it is the one that
> actually happened, twice. Worth weighing before the next extension gets its
> own repository.

`link` and `middleware` were extracted *out* of core specifically so core
stays "the smallest thing that is still a complete product on its own"
(`docs/SPIKE-CORE-LAYERING.md`). Both are now real, shipped repos: they
already paid the coordination cost this spike is trying to remove —
`urlcode-dynamic-link`'s and `urlcode-middleware`'s own `peers.json`-style
pins against core, their own CI, their own docs that can drift the same way
`urlcode-auth/SECURITY.md` already did. Folding them into this consolidation
alongside `auth`/`admin`/`ui` stops that from compounding further, rather
than leaving two more repos outside the fix.

## Layout: decided — option A

**A. Root repo is core, extensions live under `packages/`.**
```
urlcode/
  src/            # core, unchanged in place
  packages/
    auth/
    admin/
    ui/
```
Lowest-friction for core's own history (nothing moves), but makes "core" and
"the monorepo" the same name, which may read as core absorbing the
extensions rather than the extensions and core coexisting as peers — worth a
naming discussion given `AGENTS.md`'s "Core never imports them" independence
framing.

**B. Everything moves under `packages/`, including core — considered, not
chosen.** Would have been symmetric and avoided the naming overlap noted
above, at real cost: core's own history would need to move too, and every
external reference to `urlcode`'s current repo path (`docs/`, READMEs
elsewhere, the `@jimhoyd/urlcode` package's repository field, CI badges,
this evening's own `peer-camera`/`peer-eyes` citations) would need updating.
Decided against for exactly that reason.

**Decided: (A).** Core's repo and history stay exactly where they are; the
extension packages move to it — three of them, `auth`, `admin` and `ui`,
after the `dynamic-link` and `middleware` deletions. The one open item this
still leaves,
worth a short naming discussion rather than blocking anything: "core" and
"the consolidated repo" now share a name, which could read as core absorbing
the extensions rather than the two coexisting as independent packages
(`AGENTS.md`'s "Core never imports them" framing still holds in code either
way — this is a naming-perception question, not a contract question).

## Migration mechanics, per repo

For each of `urlcode-auth`, `urlcode-admin` and `urlcode-ui` — three repos
with real history, joining core, which stays in place (as of 2026-09-19;
drafted as five, before `urlcode-dynamic-link` and then `urlcode-middleware`
were deleted):

0. **Drain open pull requests first — a hard precondition, not a courtesy.**
   Before a repo is migrated, it must have zero open PRs (and no unmerged
   release branch). A PR open against the source repo at the moment its code
   moves is stranded: its branch targets a `main` that no longer receives
   code, its diff is written against paths (`src/…`) that no longer exist at
   that location, and re-creating it against the consolidated repo means
   rebasing onto a different repository and a new path prefix
   (`packages/<name>/src/…`) by hand. GitHub cannot retarget a PR across
   repositories. So for each repo, in order: stop merging new work, merge or
   close what is open, confirm `gh pr list`/the API reports none, then
   migrate. Any PR that cannot be merged in time should be closed with its
   branch preserved and re-opened against the consolidated repo afterwards —
   a deliberate choice recorded on the PR, not an accident discovered later.
   This is also the real reason to pick a quiet window for the migration
   rather than a busy one: the cost of this step scales with how much is
   in flight.

   > **Update (2026-09-19): this precondition is met right now.** Surveyed
   > across all five in-scope repositories: `urlcode`, `urlcode-auth`,
   > `urlcode-admin`, `urlcode-ui` and `urlcode-middleware` each report **zero
   > open pull requests**, and all but core report zero open issues (core holds
   > `#168` and `#58`, neither of which is a migration blocker). Nothing is in
   > flight anywhere. This is the quiet window this step asks for, and it is not
   > a stable state — it closes the moment work resumes on any of the five.
   >
   > **Re-surveyed later the same day, after the cleanup PRs opened and
   > merged:** four in-scope repositories now (`urlcode-middleware` is
   > deleted), still **zero open pull requests across all four**. `auth`,
   > `admin` and `ui` report zero open issues; core's open-issue count has
   > grown past the two named above and none of them block migration either.
   > The window described as closing on its own has so far reopened each time
   > — which is an argument for re-running the survey, not for trusting any
   > recorded figure in this document.
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
   independently publishable — this is what preserves "independently
   versioned packages" as a property, not something this migration gives up.
   **Decided: [Changesets](https://github.com/changesets/changesets) for the
   release flow, not Nx or Turborepo.** A changeset is a small, bounded,
   git-diffable markdown file (package name + semver bump + description) —
   cheap and low-risk for an agent or a human to generate correctly, easy
   for CI to verify mechanically ("does every touched package have one"),
   and it's the deliberate checkpoint that stops local workspace-linked
   development (testing against a sibling package's unreleased state, which
   is now the default once auth/admin/ui sit next to
   core) from silently becoming a real release. Nx/Turborepo were considered
   and set aside: both add a much larger, more inference-heavy configuration
   surface (task graphs, remote caching semantics) that's a bigger, more
   opaque thing to get wrong than this repo's four packages currently need —
   plain `npm test -w packages/auth`-style workspace scoping already covers
   what this size of repo actually requires. Revisit only if the package
   count grows enough that rebuild/retest time becomes a real problem.
3. **`peers.json` becomes unnecessary for the three that moved** — a
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
5. **Docs cross-references**: every `EXTENSIONS.md` links into another repository-
   style cross-repo link in `auth`/`admin`/`ui`'s current docs becomes a
   same-repo relative link once consolidated — this is a real cleanup
   opportunity, not just migration overhead, since it directly targets the
   "docs silently drifted apart" problem this spike opened with.
6. **Re-register npm Trusted Publishing per package.** Every repo's
   release workflow publishes via OIDC trusted publishing, no long-lived npm
   token (`docs/SPIKE-CORE-LAYERING.md`'s governance section, confirmed by
   `urlcode-middleware`'s own "Add trusted-publishing release workflow"
   commit). That trust is registered on npmjs.com per package, pinned to an
   exact GitHub repo + workflow filename (+ optional environment) — it does
   not follow the code when the repo path changes. Each of
   `@jimhoyd/urlcode-auth`, `-admin` and `-ui` needs its
   npmjs.com trusted-publisher entry updated to the new repo and new workflow
   path *before* that package's first release from the consolidated location,
   or the publish step fails closed (correctly — not a security gap, just an
   ordering dependency this plan needs to carry explicitly rather than
   discover at release time).
7. **Issue migration — decided: recreate open issues in the consolidated
   repo, not leave-and-link.** GitHub doesn't move issues across repos
   natively, so this means bulk-recreating each open issue at the new
   location with a back-link to the original (closed with a pointer) rather
   than leaving it where it is.

   > **Update (2026-09-19): currently a no-op — there is nothing to
   > recreate.** `urlcode-auth`, `urlcode-admin` and `urlcode-ui` all report
   > **zero open issues**. Middleware's two, which this step was written
   > around, were both closed before its repository was deleted (`#1`,
   > `sandbox: true` unsupported, and `#3`, the vendored core tarball), along
   > with a later `#4`. Those issue links no longer resolve — the deletion
   > took the tracker with it — but the issue bodies were captured to
   > `urlcode-middleware-issues.json` alongside the code bundle, so the
   > content survives even though the URLs do not. `urlcode-dynamic-link`'s
   > tally is equally moot: that repository is gone too. The decision above
   > stands as policy for whatever is open at migration time; the concrete
   > scope it enumerated has emptied out. Re-survey immediately before
   > migrating rather than trusting this line.

   The original scope, for the record:

   > `auth`, `admin` and `ui`'s own open-issue counts weren't re-audited here,
   > but `urlcode-dynamic-link` and `urlcode-middleware` were, since they're
   > the two repos whose "does this even apply" status changed mid-conversation:
   > `urlcode-dynamic-link` had 0 open issues — nothing to migrate.
   > `urlcode-middleware` had 2 open issues to recreate, `#1`
   > ("`sandbox: true` is not supported — needs its own QuickJS/WASM worker
   > pool") and `#3` ("Remove vendored core tarball once `@jimhoyd/urlcode`
   > 0.4.0-alpha.2+ is published to npm"). Both were to move to the
   > consolidated repo's tracker when the merge actually happened, each closed
   > in its original location with a link to the new issue.

## What consolidation would newly enforce

> **Added 2026-09-19.** This section did not exist when the spike was drafted,
> because the checks it describes did not exist either. It is the strongest
> argument in the document.

Since this plan was written, two checks landed in `npm run check`, and both
**fail CI** rather than reporting:

- [`scripts/check-trust-model-prose.ts`](../scripts/check-trust-model-prose.ts)
  rejects prose describing the pre-`0.4.0-alpha.2` trust model as current.
  Since `db375bf` it reaches well past Markdown: comments in `src/`,
  `scripts/`, `examples/`, `starters/`, `recipes/` and `benchmarks/`, plus
  `llms.txt`/`llms-full.txt`, and it cross-checks that a project whose prose
  claims isolation actually declares `sandbox: true` somewhere in its YAML.
- [`scripts/check-guidance-claims.ts`](../scripts/check-guidance-claims.ts)
  rejects agent-facing guidance that contradicts
  `schemas/urlcode.schema.json` — including the inverse case, guidance calling
  a field invented when the schema defines it
  ([historical decisions, item 7](archive/2026-09-19/OPEN-DECISIONS.md)).

**Both stop at this checkout.** The specific failure this document opens with —
`urlcode-auth/SECURITY.md` asserting "sandboxed guest code" after core inverted
the default — sits in a file that neither check can see, and cannot see while
`auth` lives in its own repository. The same is true of `admin` and `ui`.
It was also true of `middleware`, whose repository was deleted before the
question could be settled either way.

That reframes what consolidation buys. The original case was that it removes a
class of manual coordination work. The stronger case, available only now, is
that it places three packages' prose under an **existing, working, enforcing
correctness gate** for the contract most likely to be misdescribed downstream —
trusted-by-default execution, which is precisely where the observed drift
happened. No other proposal on the table extends that check's reach; writing a
cross-repository variant of it would mean building and maintaining a CI job that
clones three repositories on every core change, which is the coordination cost
again wearing a different hat.

One related gap, unchanged: `npm run check:downstream-skills` is advisory and
sits outside both `check` and `verify`, consistent with
[historical decisions, item 9](archive/2026-09-19/OPEN-DECISIONS.md).
The cleanup review has since adjudicated the template's skill drift and prepared
aligned copies in its draft PR; the report itself remains advisory.

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
- **"Fork just one piece" stops being a plain `git clone` — but scoped to a
  narrow audience, not every auth user.** `SPIKE-AUTH.md` names forkability
  as a deliberate design goal specifically for `auth`. It's important not to
  overstate who this actually affects: a developer customizing auth's look
  or copy (theme, relabeling, `extra.css`, a shadowed template) works
  entirely inside *their own* project repo via the `ui` extension's layering
  system (`ui/copy`, `ui/extra.css`, `ui/templates`) — they never clone or
  fork `urlcode-auth` at all, install it from npm like any dependency, and
  this migration changes nothing for them. The friction increase applies
  only to the much narrower case of someone changing auth's actual *logic*
  (a new sign-in method, different session semantics) — something the
  layering system can't express because it's behavior, not presentation.
  For that persona, forking just the auth package post-consolidation means a
  `git filter-repo`-style history extraction instead of `git clone
  jimhoyd-com/urlcode-auth` — solvable, but a real step up in friction, for
  a small population, not the common path.
- **Blast radius of a bad CI run.** One consolidated CI means a
  misconfigured job can, in principle, block merges across all four
  packages at once, where today a broken `urlcode-ui` pipeline can't stop an
  unrelated `urlcode-auth` merge. Path-filtered jobs mitigate this but don't
  eliminate it the way full repo separation does.

## Sequencing, if this is accepted

1. Decide layout (A vs. B above) and confirm the out-of-scope list.
2. **Check open pull requests across all three joining repos before starting,
   and again per repo immediately before its own migration** (mechanics #0). A
   repo with anything open is not ready to move. Doing this as a survey first
   also sizes the whole migration honestly: the number of in-flight PRs is the
   real scheduling constraint, not the git mechanics.

   > **Update (2026-09-19):** surveyed — zero open pull requests across all
   > five repositories including core, and zero open issues outside core. The
   > survey this step asks for has been done once and came back clean. Re-run
   > it rather than relying on that, since it goes stale the moment work
   > resumes. **It did go stale, twice over, within the same day:** the cleanup
   > PRs opened and merged, and `urlcode-middleware` stopped existing. The
   > current figure is zero open PRs across four repositories — see the top
   > of this document, and re-run it again anyway.
3. Migrate `urlcode-ui` first (fewest inbound dependents — `auth`/`admin`
   both depend on it, nothing depends on them), proving the subtree +
   workspace mechanics on the lowest-risk package. Re-register its npm
   trusted publisher (mechanics #6) before cutting its first release from
   the new location — treat this as part of "done," not a follow-up.
4. Migrate `urlcode-auth`, then `urlcode-admin` — same re-registration step
   each time.
5. ~~Migrate `urlcode-middleware`.~~ **Void — nothing to migrate.**

   > **Update (2026-09-19):** this step read "migrate `urlcode-dynamic-link`,
   > then `urlcode-middleware`," and carried their issue tallies. Both halves
   > are now void: each repository was deleted rather than migrated. The
   > migration therefore ends at step 4, with `ui`, `auth` and `admin` moved
   > and core in place. No `packages/middleware` is created, and no
   > trusted-publisher entry is re-registered for `@jimhoyd/urlcode-middleware`
   > — that package is unpublished.
6. Retire (archive, don't delete — GitHub redirects an archived repo's clone
   URL) the three now-empty source repos, with their READMEs pointing at the
   new location.

   > **Update (2026-09-19): "archive, don't delete" now has a counter-example
   > in this project's own history, and it is worth weighing rather than
   > restating.** `urlcode-dynamic-link`, `urlcode-short` and `urlcode-docs`
   > were all **deleted outright**, so their clone URLs and every inbound link
   > to them 404 with no redirect; the only surviving copies are verified
   > `git bundle`s held locally (`fd9dc84`), which preserve the code but not
   > the issues, the pull request history or any inbound URL. That was
   > defensible for repositories whose code was being withdrawn entirely — and
   > it still cost a citation: `urlcode-docs#17` is quoted as evidence in
   > [historical decisions, item 7](archive/2026-09-19/OPEN-DECISIONS.md) and no longer resolves. It is a different case from a
   > repository whose code continues to live at a new path, which is what this
   > step covers and where the redirect is the entire point. Keep the
   > archive-don't-delete rule here, and note explicitly that it diverges from
   > what was done during the September 2026 retirements — the two situations
   > are not the same and the precedent should not be read across.

## Open questions for the maintainer, not answered here

- Does `peers.json`'s reviewed-pin discipline need an equivalent for any
  external (non-workspace) consumer, or does workspace-linking fully replace
  its purpose?
- `git subtree` vs. `git filter-repo` for history preservation — a real
  tradeoff between migration safety and final history cleanliness, worth a
  deliberate call rather than defaulting.
- The naming-perception question from "Layout: decided — option A" above
  (core's repo and the consolidated repo sharing a name) — worth a short
  discussion, not blocking.
