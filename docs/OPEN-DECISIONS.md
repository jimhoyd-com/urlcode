# Decisions to align

Reviewed 2026-09-19 against core `db375bf` and the current public package sources.
This is the maintainer's decision list, not a second implementation backlog.
The [roadmap](../ROADMAP.md) gives sequence and the [archive](archive/README.md)
keeps earlier discussions. Recommendations below are not accepted decisions.

## Principles already settled, in plain language

- **Describe first, code only when needed.** Use a supported YAML feature or
  extension before writing plumbing. Custom application code is still welcome.
- **Your application code runs like normal Node code.** Functions and middleware
  are trusted by default. `sandbox: true` deliberately restricts a route's whole
  function/middleware chain. Request data still needs validation in either mode.
- **A grant controls what URLCode supplies, not what trusted code can access.**
  Trusted code can independently read the host environment, files and network.
  Opt-in sandboxing retains its existing isolation and revision-pinned grants.
- **Portable does not mean every host supports every feature.** Keep infrastructure
  out of route YAML and reject unsupported targets before activation.
- **Core works alone; optional packages add accounts, admin and presentation.**
  Core never imports those implementations. Shared UI belongs in `urlcode-ui`.
- **Documentation stays beside the owning code.** Core guides live here;
  extension contracts and implementation status live in their repositories.
  `urlcode-docs` is deleted. `urlcode-short` and `urlcode-dynamic-link` are retired.
- **Passing tests proves the tested behavior.** It does not prove deployment,
  accessibility, hostile tenant isolation or independent security assessment.
- **Keep the free runtime useful.** Apache-2.0 remains unchanged; no mandatory
  hosted account, paid capability gate or provider lock-in belongs in core.

## Decisions still needed

| Decision | What the code says today | Recommendation and consequence |
|---|---|---|
| Where does work status live? | Several old plans repeated issues and continued calling delivered work unfinished. | Issues for actionable status, this short roadmap for sequence, archive for completed proposals. Preserve evidence gaps when archiving. |
| Expand into business applications now? | No collection handler or proposed business suite is implemented; the model-backed benchmark evidence is missing. | Measure existing tasks and record repeated application plumbing before selecting a collection/CMS/forms project. Retired short-link products stay retired. [Proposal](SPIKE-BUSINESS-SUITE.md). |
| Retire the UI primitive fallback? | Auth and admin use the kit when supplied, and retain tested primitive rendering without it. | Keep both until an explicit compatibility/deprecation decision; adoption is already implemented. |

The broader [AI benchmark proposal](SPIKE-AI-FRAMEWORK-BENCHMARK.md) also needs a
chosen application, model-run budget and execution authorization. The existing
small-task harness can supply evidence without committing to that larger study.

## Closed questions removed from the active list

- Publishing convention is recorded in [version alignment](VERSION-ALIGNMENT.md):
  publishable manifests on main, releases through reviewed tags/workflows.
- Core `0.4.0-alpha.2` and current extension releases exist; publishing that
  already-shipped version is not a next step.
- Auth/admin kit adoption and shared form helpers are implemented in their code.
- The template pins `0.4.0-alpha.2`. Its skill differences were read against that
  pin: omitted handlers and advice about the removed management API are stale,
  not intentional older-version behavior.
- The guidance checks run through `npm run check` inside `verify`; a regex check
  is not a schema validator for every example. Extending its coverage is tracked
  separately, not a reason to weaken review or bypass required checks.

## Accepted: one Node deployment per project

**Decided 2026-09-19.** Projects that use `function` or `middleware` deploy as
**one trusted Node process** — a container or a VM running the project as it
runs locally. That is the supported execution model, and it needs no new work:
it is what the runtime already does.

**Per-route Lambda compilation is not pursued.** The alternative on the table
was a build step emitting one Lambda per `function` route
([the proposal](archive/2026-09-19/SPIKE-LAMBDA-COMPILE.md)). It is declined for now, on three
grounds the proposal itself states:

1. It would replace the sandbox guarantee rather than preserve it, and lose the
   fresh-per-invocation state that `sandbox: true` currently guarantees.
2. It would make this project the author of generated IAM roles — a
   security-critical output it has never owned.
3. It would trade an honest refusal for a larger claim nobody has deployed.

Against that, a single Node deployment supports every route type today with no
compiler, no generated infrastructure and no second isolation story to document.

**What follows from this decision:**

- AWS and Vercel continue to refuse `function` and `middleware` at activation,
  naming the route (`src/capabilities.ts`, `activateNativeOnly` in
  `src/adapters.ts`). That refusal is now a **deliberate position**, not a gap
  awaiting an adapter. Documentation should say so rather than implying the
  support is coming.
- Serverless targets remain first-class for the declarative route types they can
  actually serve; nothing about static or native-only deployment changes.
- [SPIKE-LAMBDA-COMPILE.md](archive/2026-09-19/SPIKE-LAMBDA-COMPILE.md) is kept as the analysis
  behind this decision, not as a plan. Reopen it only on evidence of real demand
  for URLCode `function` routes specifically on AWS serverless — the proposal's
  own §6 already scopes what a first attempt would be.

This decision is about the *execution model*, not about AWS. Deploying the Node
process to AWS (ECS, EC2, App Runner) is an operator choice this fully supports.

## Accepted: per-package release tags

**Decided 2026-09-19.** Workspace packages under `packages/` release on
Changesets' own `<package name>@<version>` form — for example
`@jimhoyd/urlcode-ui@0.1.0-alpha.6`. Core keeps bare `v*`.

**The problem.** Core and all three extensions arrived here triggering on
`tags: ['v*']`, and their alpha tags overlap outright: ui shipped
`v0.1.0-alpha.2` through `-alpha.5`, admin `v0.1.0-alpha.1` and `-alpha.3`,
auth `v0.1.0-alpha.1` through `-alpha.3`. Across four repositories that was
fine. In one repository a single bare tag push starts more than one release
workflow. Each one fails closed on its own tag-matches-manifest check, so
nothing can mis-publish — but "two workflows race and one errors on every
release" is not a release process, and the failure is confusing rather than
informative.

**Why Changesets' form rather than a prefix like `ui-v0.1.0-alpha.6`.** Both
work and both are valid ref names. The deciding factor is that Changesets is
already the chosen release flow, and `changeset tag` emits the
`<name>@<version>` form natively. Picking anything else means writing and
maintaining a translation layer between the tool that computes the version and
the tag that triggers the publish — new code whose only job is to disagree
with a default. The spike chose Changesets partly because it is "cheap and
low-risk for an agent or a human to generate correctly"; hand-rolling the tag
shape undercuts exactly that.

**Why the two schemes cannot collide.** A scoped package name begins with `@`,
and GitHub's `v*` filter requires a leading `v`, so no tag can match both.
Verified rather than assumed, including that `*` does not match `/` in a filter
pattern, so `@jimhoyd/urlcode-ui@*` matches the version segment only.

**Core's asymmetry is forced, not preferred.** Under layout A core is the
repository root rather than a workspace member, so Changesets does not manage
it and `changeset version` will not bump it. Core therefore keeps the tag
scheme and release workflow it already had.

[`scripts/check-release-tags.ts`](../scripts/check-release-tags.ts) enforces
this in `npm run check`: it rejects a workspace package workflow that does not
trigger on its own `<name>@*`, rejects any workflow other than core's claiming
`v*`, and independently asserts that no two filters can match the same tag. The
reasoning above is the kind of prose that rots as soon as `auth` and `admin`
arrive, which is the whole argument this repository makes for enforcing checks
over documented intent.

## Accepted: monorepo first — middleware withdrawn rather than consolidated

The maintainer confirmed that monorepo work is starting now. The earlier
recommendation to keep repositories separate for now is superseded.

**Reversed 2026-09-19: the middleware half of this decision no longer applies.**
This section used to say "move middleware into the monorepo as its own package
first, preserving its existing API and behavior," and explicitly: "do not
unpublish or retire the middleware package as part of the initial move."
That instruction was overtaken. `@jimhoyd/urlcode-middleware` has been
**unpublished** from npm at `0.1.0-alpha.2` and `jimhoyd-com/urlcode-middleware`
**deleted** — the package was withdrawn outright instead of migrated, so there
is no `packages/middleware` to create and no subsequent fold-into-core step.
The reversal is recorded here rather than deleted because the instruction it
replaces was explicit, and a reader who remembers it should be able to see that
it was changed deliberately and not simply forgotten.

Nothing was lost in capability terms: per-route middleware is **native to
core** via the `middleware:` array ([MIDDLEWARE.md](MIDDLEWARE.md)), and the
deleted package only ever offered the same behavior through the extension
seam. Trust remains the default and explicit sandbox choices keep their
meaning. The generic extension wrapping hook (`ExtensionInstance.middleware`,
`RuntimeExtension.cacheSensitive`) stays in core's contract for other
extensions — it is no longer exercised by any shipped package, which is worth
knowing before it is assumed to be covered. Static targets continue rejecting
request-time middleware because there is no server to run it.

Migration scope is therefore **core, auth, admin and UI**. Template and the
distribution tap stay outside that package move. The observed stale peer pins
and checkout-limited guidance checks strengthen the case for shared
verification: carry those checks across the new package paths, since merely
moving files does not prove every generated skill is covered. The cleanup PRs
that superseded the earlier zero-open-PR survey have since merged, and a fresh
survey again reports zero open pull requests across all four in-scope
repositories — re-run it per repository immediately before that repository
moves rather than trusting this line.

The [monorepo plan](SPIKE-MONOREPO.md) records migration context.
[Issue 172](https://github.com/jimhoyd-com/urlcode/issues/172), which tracked
"consolidate middleware into core after moving it into the monorepo," was
**closed on 2026-09-19** as moot — there was nothing left to consolidate.
Migration starting is not a claim that it has landed.

## Source review baseline

| Repository | Reviewed commit | Code checked |
|---|---|---|
| core | `db375bf` | Runtime dispatch, schema normalization, capabilities, static compiler, prerender, MCP and resource generators |
| auth | `71957dd` | Lifecycle hooks, UI rendering and shared helper imports |
| admin | `f3b4882` | UI rendering, auth-service integration and shared helper imports |
| UI | `0e96f7f` | Shared forms, kit/host exports and copied core contract |
| ~~middleware~~ | `f201f4b` | Extension wrapping, per-entry sandbox dispatch and scaffolding — **repository deleted 2026-09-19; this baseline is unreachable except through the local `urlcode-middleware.bundle`** |
| template | `4e09e50` | Exact core pin, generated guide and both vendored skills |

The Homebrew tap (`73eaaef`) still selects stable core `0.3.0`; its old trust
behavior belongs to that pin and must not be rewritten as alpha.2 behavior.
The other organization tap and Scoop bucket contain Gitroll, not URLCode.
The deleted documentation repository is historical context, not a second source
of current contracts; its former GitHub links no longer resolve. This review is targeted source inspection, not an audit of
every execution path or an independent security assessment.
