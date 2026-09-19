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
| Which provider execution model next? | AWS/Vercel still reject function/middleware despite the trusted default. | Decide demand first, then compare one Node deployment per project against one Lambda per route. Do not promise either today. [Proposal](SPIKE-LAMBDA-COMPILE.md). |
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

## Accepted: monorepo first, middleware consolidation afterward

The maintainer confirmed that monorepo work is starting now. Move middleware
into the monorepo as its own package first, preserving its existing API and
behavior. Folding it into core is a subsequent change, not a prerequisite for
moving the repositories. The earlier recommendation to keep repositories
separate for now is superseded.

Before the later core consolidation, map the extension request/context API and
per-entry sandbox behavior to supported core behavior. Trust remains the default;
preserve explicit sandbox choices without silently changing their meaning.
Do not unpublish or retire the middleware package as part of the initial move.
Preserve the generic extension wrapping hook for other extensions. Static targets
continue rejecting request-time middleware because there is no server to run it.

Main's review at `e4e7816` narrows migration scope to core, auth, admin, UI and
middleware. Template and the distribution tap stay outside that package move.
Its observed stale peer pins and checkout-limited guidance checks strengthen the
case for shared verification. Carry those checks across the new package paths;
merely moving files does not prove every generated skill is covered. The earlier
zero-open-PR survey is superseded by the cleanup PRs now open: settle or carry
those changes into the migration rather than losing them.

The [monorepo plan](SPIKE-MONOREPO.md) records migration context;
[issue 172](https://github.com/jimhoyd-com/urlcode/issues/172) tracks the subsequent
middleware consolidation. Migration starting is not a claim that it has landed.

## Source review baseline

| Repository | Reviewed commit | Code checked |
|---|---|---|
| core | `db375bf` | Runtime dispatch, schema normalization, capabilities, static compiler, prerender, MCP and resource generators |
| auth | `71957dd` | Lifecycle hooks, UI rendering and shared helper imports |
| admin | `f3b4882` | UI rendering, auth-service integration and shared helper imports |
| UI | `0e96f7f` | Shared forms, kit/host exports and copied core contract |
| middleware | `f201f4b` | Extension wrapping, per-entry sandbox dispatch and scaffolding |
| template | `4e09e50` | Exact core pin, generated guide and both vendored skills |

The Homebrew tap (`73eaaef`) still selects stable core `0.3.0`; its old trust
behavior belongs to that pin and must not be rewritten as alpha.2 behavior.
The other organization tap and Scoop bucket contain Gitroll, not URLCode.
The deleted documentation repository is historical context, not a second source
of current contracts; its former GitHub links no longer resolve. This review is targeted source inspection, not an audit of
every execution path or an independent security assessment.
