# Decisions to align

Last reconciled 2026-09-20 against open and closed issues (#242); the source
review it began from is dated 2026-09-19 (core `db375bf`, now archived).
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
| Fold extension schemas into retrieved context? ([#174](https://github.com/jimhoyd-com/urlcode/issues/174), open) | `urlcode extensions` and the MCP `get_extensions` query return the registered configuration and policy schemas, but `src/context.ts:113` reports `extensions` as names only, so an author writing `extensions.<name>.config` or `policies.extensions.<name>` must run the separate operator-authorized query first. | Decide from retrieval and task evidence, not preference: the existing small-task harness can measure whether folding schemas into bounded context improves authoring. Keep the token budget bounded and never auto-load a project-selected host file. This is a discovery improvement, not a defect in the existing query. |
| Keep the POST-plus-`request.body` sandbox advisory? | `src/readiness.ts` nudges any code-running route that accepts POST with a declared `request.body` and declares neither `sandbox: true` nor `sandboxReason`. It is advisory only: never fails `audit`, never changes `ready`. | The nudge keys on request *shape* while [AI authoring](AI-AUTHORING.md) tells authors to decide on *code* trust, so it can read as "untrusted input implies sandbox" -- the reasoning that guidance explicitly rejects. It still has value as a prompt to record a decision. Recommendation: keep the trigger, restate the message as a request to record the trust decision (`sandbox: true` or `sandboxReason`) rather than as a suggestion that this route may need isolation. Not changed here; #196 was a docs/tooling alignment pass. |

The broader [AI benchmark proposal](SPIKE-AI-FRAMEWORK-BENCHMARK.md) also needs a
chosen application, model-run budget and execution authorization. The existing
small-task harness can supply evidence without committing to that larger study.

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

## Completed work (archived)

Closed questions, the completed monorepo migration (ui, auth and admin are
workspace packages; released from this repository) and the 2026-09-19 source
review baseline live in
[archive/2026-09-20/OPEN-DECISIONS-COMPLETED.md](archive/2026-09-20/OPEN-DECISIONS-COMPLETED.md).
The migration plan is [archived](archive/2026-09-19/SPIKE-MONOREPO.md). Versions
and channels are in [version alignment](VERSION-ALIGNMENT.md) and
`npm run release:status`, not here.

## Accepted: middleware withdrawn rather than consolidated

**Decided 2026-09-19.** `@jimhoyd/urlcode-middleware` was unpublished and its
repository deleted; there is no `packages/middleware` and nothing to fold into
core afterward (#172, closed as moot). Per-route middleware is native to core
via the `middleware:` array ([MIDDLEWARE.md](MIDDLEWARE.md)). The generic
extension wrapping hook (`ExtensionInstance.middleware`,
`RuntimeExtension.cacheSensitive`) stays in core's contract for other extensions
but is no longer exercised by any shipped package, so do not assume it is
covered. Static targets keep rejecting request-time middleware. The earlier
instruction to move middleware into the monorepo first was overtaken; its full
text is retained in the archived record.

