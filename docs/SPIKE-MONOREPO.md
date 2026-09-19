# Spike: consolidating core, auth, admin, ui (and the two pending extractions) into one repo

Status: proposal, nothing implemented, no repo touched. Drafted at the requester's
explicit direction to produce a plan document only — see "What this is not"
below. Revised after a verification pass against the nine checked-out repos,
npm and the GitHub API: the claims below about pins, dependency direction,
package counts, open PRs and open issues reflect what those sources actually
say, and where the first draft was wrong the correction is called out inline
rather than quietly overwritten. Treat this the same way as the other
`SPIKE-*.md` documents in this directory: a recorded decision trail for the
maintainer to accept, amend or reject, not committed scope.

## What this is not

This is not a recommendation to touch any of `urlcode`, `urlcode-auth`,
`urlcode-admin` or `urlcode-ui` tonight. No git history has been merged, no
package has been moved, no CI has been reconfigured. Everything below is a
sequenced plan to review, not a changelog of what happened.

## The problem this is answering

Four repos (`urlcode`, `urlcode-auth`, `urlcode-admin`, `urlcode-ui`) already
coordinate tightly, and `docs/FRAMEWORK.md` describes them as one composed
product, not four independent ones. How tightly each one is actually tied to
core differs, and the differences matter more than a single summary would
suggest — verified against the repos as they stand today:

- `urlcode-auth` and `urlcode-admin` each pin an exact core revision in their
  own `peers.json` (both currently `d5e86017`), plus a semver range in
  `package.json` `peerDependencies`.
- `urlcode-ui` pins nothing. It has no `peers.json`, no `peerDependencies` and
  no dependency on core at all — it carries **hand-copied structural copies**
  of core's extension contract (`src/host/extension.ts`), resynced by hand
  (most recently `c2a2d86`, "Sync hand-copied ExtensionActivation/
  ExtensionInstance with core"). This is a stronger version of the problem
  this spike is answering, not an exception to it: there is no pin to go
  stale, so nothing can even be checked.

Concretely observed cost of that coordination happening across four repos,
from an evening spent reading all four:

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
- **And it has already recurred, which settles the argument above.** As of
  this review, `auth` and `admin` both pin core at `d5e86017` — **eight
  merged core commits behind `origin/main`**, among them #143 (trusted-
  execution body buffering and timer leaks), #145 (extensions opting out of
  forced `no-store`) and #150 (sandboxed `HEAD` `Content-Length`): behavioral
  changes, not documentation. The sentence above ("both have since been
  corrected") was accurate when it was written and was stale again within the
  same week, with no one having done anything wrong. That is the whole case
  for consolidation in one observation — the manual pass does not converge,
  because core keeps moving while the pass is being written up.
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

**In scope — six existing repos, all with real history, folded into one
repo as workspace packages:**

| Repo today | Becomes |
|---|---|
| `urlcode` (core) | `packages/core` (or repo root stays core-shaped, TBD in "Layout options" below) |
| `urlcode-auth` | `packages/auth` |
| `urlcode-admin` | `packages/admin` |
| `urlcode-ui` | `packages/ui` |
| `urlcode-dynamic-link` (real repo, `v0.1.0-alpha.1` released) | `packages/dynamic-link` |
| `urlcode-middleware` (real repo, `v0.1.0-alpha.1` released) | `packages/middleware` |

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

## Why six, and not four

`link` and `middleware` were extracted *out* of core specifically so core
stays "the smallest thing that is still a complete product on its own"
(`docs/SPIKE-CORE-LAYERING.md`). Both are now real, shipped repos: they
already paid the coordination cost this spike is trying to remove — their own
core version constraints, their own CI, their own docs that can drift the same
way `urlcode-auth/SECURITY.md` already did. Neither uses `peers.json`; both
express the constraint as a `peerDependencies` range, and `middleware`'s is
where that approach has already failed visibly: it requires
`">=0.4.0-alpha.2"`, **which no published core version satisfies** (npm has
`0.3.0` and `0.4.0-alpha.1` only), so the repo vendors
`vendor/jimhoyd-urlcode-0.4.0-alpha.2.tgz` and carries
[`#3`](https://github.com/jimhoyd-com/urlcode-middleware/issues/3) to undo
that once core publishes. A workspace sibling dependency resolves exactly
this case by construction — it is the clearest single thing consolidation
would fix today. Folding them into this consolidation
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
    dynamic-link/
    middleware/
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
this evening's own `peer-camera`/`peer-eyes` citations — note that neither of
those names appears anywhere in any of the nine URLCode repos, so treat them
as an unverified external reference until the maintainer confirms what they
point at) would need updating.
Decided against for exactly that reason.

**Decided: (A).** Core's repo and history stay exactly where they are; the
six packages move to it (five extensions plus core itself now living in the
same repo as a `packages/*` sibling). The one open item this still leaves,
worth a short naming discussion rather than blocking anything: "core" and
"the consolidated repo" now share a name, which could read as core absorbing
the extensions rather than the two coexisting as independent packages
(`AGENTS.md`'s "Core never imports them" framing still holds in code either
way — this is a naming-perception question, not a contract question).

## Migration mechanics, per repo

For each of `urlcode-auth`, `urlcode-admin`, `urlcode-ui`,
`urlcode-dynamic-link` and `urlcode-middleware` — the five repos that move
under option A (core stays where it is), all five with real history:

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
   `"workspaces": ["packages/*"]` (drafted here as "the same shape
   `peer-camera` already uses" — that precedent could not be verified from
   any repo in this org, so it is cited as the maintainer's own external
   reference, not as evidence); each `packages/<name>/package.json` keeps
   its own name/version,
   independently publishable — this is what preserves "independently
   versioned packages" as a property, not something this migration gives up.
   **Decided: [Changesets](https://github.com/changesets/changesets) for the
   release flow, not Nx or Turborepo.** A changeset is a small, bounded,
   git-diffable markdown file (package name + semver bump + description) —
   cheap and low-risk for an agent or a human to generate correctly, easy
   for CI to verify mechanically ("does every touched package have one"),
   and it's the deliberate checkpoint that stops local workspace-linked
   development (testing against a sibling package's unreleased state, which
   is now the default once auth/admin/ui/dynamic-link/middleware sit next to
   core) from silently becoming a real release. Nx/Turborepo were considered
   and set aside: both add a much larger, more inference-heavy configuration
   surface (task graphs, remote caching semantics) that's a bigger, more
   opaque thing to get wrong than this repo's six packages currently need —
   plain `npm test -w packages/auth`-style workspace scoping already covers
   what this size of repo actually requires. Revisit only if the package
   count grows enough that rebuild/retest time becomes a real problem.
3. **`peers.json` becomes unnecessary for the five that moved** — a
   workspace package can depend on a sibling workspace package directly,
   which is inherently always in sync: no separate pin file, no drift
   possible by construction. Note the exact spelling matters — the
   `workspace:*` protocol is pnpm/yarn, **not npm**; under npm the sibling is
   declared with an ordinary range (`"*"`, or the real semver range for what
   gets published) and npm links the local package when it satisfies it.
   `peers.json`-the-mechanism might still matter if any *external* consumer
   needs a reviewed-revision pin story — worth deciding explicitly rather
   than silently dropping the safeguard.
4. **CI consolidation**: one `verify.yml` (or similar) with
   path-filtered jobs per package, replacing ten separate workflow files
   across the five moving repos (`verify.yml` + `release.yml` in each of
   `auth`/`admin`/`ui`, `ci.yml` + `release.yml` in each of `dynamic-link`/
   `middleware`), alongside core's own four.
   `CODEOWNERS` can still express per-package ownership within one repo
   (path-scoped rules), so "who reviews auth changes" doesn't have to
   become "everyone reviews everything."
5. **Docs cross-references**: every `[EXTENSIONS.md](../urlcode/docs/...)`-
   style cross-repo link in `auth`/`admin`/`ui`'s current docs becomes a
   same-repo relative link once consolidated — this is a real cleanup
   opportunity, not just migration overhead, since it directly targets the
   "docs silently drifted apart" problem this spike opened with.
6. **Re-register npm Trusted Publishing per package.** All five moving repos'
   release workflows publish via OIDC trusted publishing, no long-lived npm
   token (`docs/SPIKE-CORE-LAYERING.md`'s governance section, confirmed by
   `urlcode-dynamic-link`'s and `urlcode-middleware`'s own "Add
   trusted-publishing release workflow" commits). That trust is registered
   on npmjs.com per package, pinned to an exact GitHub repo + workflow
   filename (+ optional environment) — it does not follow the code when the
   repo path changes. Each of `@jimhoyd/urlcode-auth`, `-admin`, `-ui`,
   `-dynamic-link`, `-middleware` needs its npmjs.com trusted-publisher entry
   updated to the new repo and new workflow path *before* that package's
   first release from the consolidated location, or the publish step fails
   closed (correctly — not a security gap, just an ordering dependency this
   plan needs to carry explicitly rather than discover at release time).
7. **Issue migration — decided: recreate open issues in the consolidated
   repo, not leave-and-link.** GitHub doesn't move issues across repos
   natively, so this means bulk-recreating each open issue at the new
   location with a back-link to the original (closed with a pointer) rather
   than leaving it where it is. Concrete scope as of this doc: `auth`,
   `admin` and `ui`'s own open-issue counts weren't re-audited here, but
   `urlcode-dynamic-link` and `urlcode-middleware` were, since they're the
   two repos whose "does this even apply" status changed mid-conversation:
   - `urlcode-dynamic-link`: 0 open issues — nothing to migrate.
   - `urlcode-middleware`: 2 open issues to recreate —
     [`#1`](https://github.com/jimhoyd-com/urlcode-middleware/issues/1)
     ("`sandbox: true` is not supported — needs its own QuickJS/WASM worker
     pool") and
     [`#3`](https://github.com/jimhoyd-com/urlcode-middleware/issues/3)
     ("Remove vendored core tarball once `@jimhoyd/urlcode` 0.4.0-alpha.2+ is
     published to npm"). Both should move to the consolidated repo's tracker
     when the merge actually happens, each closed in its original location
     with a link to the new issue.

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

- **Pre-release *source* privacy, but not the publish gate — an earlier
  draft of this bullet conflated the two, and the distinction changes the
  conclusion.** The "`private: true` until reviewed" pattern
  `docs/SPIKE-CORE-LAYERING.md` records is a field in `package.json`, which
  is per-package and survives consolidation untouched: a `packages/<new>`
  folder can carry `"private": true` and simply never publish, exactly as it
  does in its own repo today. (Both `urlcode-dynamic-link` and
  `urlcode-middleware` in fact still carry `"private": true` in
  `package.json` while being published public on npm at `0.1.0-alpha.1` —
  worth reconciling on its own terms, separately from this spike.) What a
  monorepo genuinely gives up is narrower: keeping the *source* of an
  unreleased extension out of public view, since GitHub repo visibility is
  all-or-nothing. For work that must not be readable before announcement,
  that still means a separate private repo merged in later. For the far more
  common "not ready to publish yet," nothing is lost.
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
  misconfigured job can, in principle, block merges across all six
  packages at once, where today a broken `urlcode-ui` pipeline can't stop an
  unrelated `urlcode-auth` merge. Path-filtered jobs mitigate this but don't
  eliminate it the way full repo separation does.

## Sequencing, if this is accepted

1. Decide layout (A vs. B above) and confirm the out-of-scope list.
2. **Check open pull requests across all five moving repos before starting,
   and again per repo immediately before its own migration** (mechanics #0). A repo with
   anything open is not ready to move. Doing this as a survey first also sizes
   the whole migration honestly: the number of in-flight PRs is the real
   scheduling constraint, not the git mechanics. **As of this review that
   survey comes back clean**: zero open PRs across all five moving repos
   (`auth`, `admin`, `ui`, `dynamic-link`, `middleware`), with only core
   itself carrying one. The quiet window this step asks for is open now, and
   re-checking immediately before each repo moves still applies.
3. Migrate `urlcode-admin` first, then `urlcode-auth`, then `urlcode-ui` —
   fewest inbound dependents first. An earlier draft had this order exactly
   reversed, on a misreading of the graph; the actual edges are
   `admin` → `auth` → `ui` (`urlcode-admin`'s `peerDependencies` name both
   `@jimhoyd/urlcode-auth` and `@jimhoyd/urlcode-ui`, `urlcode-auth`'s name
   `@jimhoyd/urlcode-ui`), so **nothing depends on `admin`, and `ui` is the
   most depended-upon of the three, not the least**. Migrating `admin` first
   proves the subtree + workspace mechanics on the package whose move can
   break the fewest others. Re-register each package's npm trusted publisher
   (mechanics #6) before cutting its first release from the new location —
   treat this as part of "done," not a follow-up.
4. If you would rather still lead with `urlcode-ui` — it is the smallest
   package, it has no core dependency to reconcile, and it is therefore the
   cheapest trusted-publishing rehearsal — that is a defensible call, but
   make it on those grounds explicitly. It is not the low-inbound-dependents
   choice.
5. Migrate `urlcode-dynamic-link`, then `urlcode-middleware` — same
   subtree/filter-repo mechanics and trusted-publisher re-registration as
   the other three, now that both are real repos with real history rather
   than something created fresh in place. Recreate their open issues (see
   "Migration mechanics" #7 above: 0 from `dynamic-link`, `#1` and `#3` from
   `middleware`) in the consolidated tracker as part of each repo's
   migration step, not as a separate pass.
6. Retire (archive, don't delete) all five now-empty source repos, with their
   READMEs pointing at the new location. Note what archiving does and does
   not do: it makes the repo read-only at its existing URL, so old clone
   URLs and issue links keep resolving — it does **not** create a redirect
   to the new location (that is what *renaming* does). Anyone following an
   old link lands on the frozen repo and needs the README pointer to find
   its way onward, which is why that pointer is part of this step rather
   than a nicety.

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
