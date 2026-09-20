# Historical record

Archived 2026-09-20 from [open decisions](../../OPEN-DECISIONS.md), which was
reconciled against its issues that day (#242). These sections record completed
work and dated observations exactly as they stood on 2026-09-19 (core `db375bf`
and the package sources of that date); they are not current instructions and
their version numbers, dist-tags, commits and pins are not current. Versions
and channels: [version alignment](../../VERSION-ALIGNMENT.md) and
`npm run release:status`. Archiving does not declare any security, deployment,
recovery or provider check performed. The live middleware decision remains in
open decisions.

<!-- trust-model-prose: historical-file -->
<!-- guidance-claims: ignore-file -->
<!-- local-links: historical-file -->

## Closed questions removed from the active list

- Publishing convention is recorded in [version alignment](../../VERSION-ALIGNMENT.md):
  publishable manifests on main, releases through reviewed tags/workflows.
- Core `0.4.0-alpha.2` and current extension releases exist; publishing that
  already-shipped version is not a next step.
- Auth/admin kit adoption and shared form helpers are implemented in their code.
- The UI primitive fallback is retired, which settles the question this table
  carried. Auth and admin now render every screen through the kit and refuse
  activation without it (`packages/auth/src/auth.ts`: "there is no
  shared-primitive fallback"), so "keep both" no longer describes the code.
- The template pins `0.4.0-alpha.2`. Its skill differences were read against that
  pin: omitted handlers and advice about the removed management API are stale,
  not intentional older-version behavior.
- The guidance checks run through `npm run check` inside `verify`; a regex check
  is not a schema validator for every example. Extending its coverage is tracked
  separately, not a reason to weaken review or bypass required checks.

## Done: the monorepo migration is complete

**Closed 2026-09-19.** `urlcode-ui`, `urlcode-auth` and `urlcode-admin` are
workspace packages under `packages/`, and all three have been released from
this repository — `@jimhoyd/urlcode-ui@0.1.0-alpha.6`,
`@jimhoyd/urlcode-auth@0.1.0-alpha.6`, `@jimhoyd/urlcode-admin@0.1.0-alpha.4`,
each on `alpha` with `latest` deliberately held behind. Core's dist-tags are
unchanged. The three source repositories are gone; their history survives only
as verified `git bundle`s, because the repository allows squash merges only and
the imported commits did not survive onto `main`.

The operational runbook is [DEVELOPMENT-PIPELINE.md](../../DEVELOPMENT-PIPELINE.md)
and [RELEASE-SECURITY.md](../../RELEASE-SECURITY.md). The plan itself is archived at
[archive/2026-09-19/SPIKE-MONOREPO.md](../2026-09-19/SPIKE-MONOREPO.md),
whose closing note records what the plan got wrong — chiefly that its
strongest argument, the reach of the enforcing checks, only became true after
both checkers were changed to discover workspace packages.

The section below is kept for the middleware decision it records, which is
still the reason there is no `packages/middleware`.

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
core** via the `middleware:` array ([MIDDLEWARE.md](../../MIDDLEWARE.md)), and the
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

The [archived monorepo plan](../2026-09-19/SPIKE-MONOREPO.md) records
migration context.
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
