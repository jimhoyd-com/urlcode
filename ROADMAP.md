# Roadmap

URLCode lets people and agents describe URL behavior in YAML and write application
code only where the framework cannot express it. The free Apache-2.0 runtime
stays useful on its own. [Project direction](docs/PROJECT-DIRECTION.md) owns the
principles; [the specification](docs/SPECIFICATION.md) owns implemented behavior.

## What works now

The current source provides declarative routing, responses, assets, policies,
conditions, proxy/signals, trusted Node functions and middleware, and opt-in
`sandbox: true` isolation. Target support differs: use `urlcode capabilities`
before promising a deployment. Stored short links have no dedicated package;
a project declares a collection through the `store` extension instead (see
[docs/STORE.md](docs/STORE.md)).

Auth, admin, UI, store and forms are optional packages, developed in this
repository under `packages/` and released independently. Middleware is not a
package: per-route `middleware:` is native to core. Auth/admin already
render through the shared UI kit when configured. Core includes scaffolding,
searchable recipes/examples, compact context, schema queries, a semantic manifest,
and MCP inspection with separately enabled authoring. These are implemented,
not future phases. See [the framework](docs/FRAMEWORK.md).

## Next work

Auth, admin and UI are workspace packages here, released from this repository;
the migration is complete and its historical plan is retained privately. The separate
middleware package was withdrawn rather than migrated
([the decision](docs/OPEN-DECISIONS.md#accepted-middleware-withdrawn-rather-than-consolidated)).
Versions and channels are in [version alignment](docs/VERSION-ALIGNMENT.md) and
`npm run release:status`, not in this page.

1. **Make the existing product coherent.** Keep docs, examples, generated LLM
   resources, installed skills and the standalone template consistent with their
   runtime version. Resolve the [open decisions](docs/OPEN-DECISIONS.md).
   Schema-invalid YAML examples in Markdown are now checked
   (`scripts/check-guidance-claims.ts`; issue 168 is closed).
   [Issue 174](https://github.com/jimhoyd-com/urlcode/issues/174) retains the
   extension-schema retrieval proposal.
2. **Measure the agent experience.** Framework
   comparisons, authoring evals and raw evidence are kept in a private
   maintainer repository. Use observed
   friction from reproducible runs to choose improvements in core.
3. **Close release evidence gaps.** Browser/device coverage, accessibility,
   independent security review, deployed recovery/soak tests and real provider
   verification remain distinct from source implementation and local tests.
   [Issue 58](https://github.com/jimhoyd-com/urlcode/issues/58) and
   [release readiness](docs/RELEASE-READINESS.md) retain those gates; a stable
   release or green CI does not close them. Live Google/Apple/SES checks remain
   explicitly deferred. [Issue 185](https://github.com/jimhoyd-com/urlcode/issues/185)
   (CI lane measurement and release-train validation) and
   [issue 202](https://github.com/jimhoyd-com/urlcode/issues/202) (Windows auth
   worker startup timeout) are also still open.
4. **Choose expansion from evidence.** Bounded collections (`store`) and form
   flows (`forms`) are implemented; a broader business application suite beyond
   them is still a proposal, not an available feature. Decide scope before
   implementing further. Per-route Lambda compilation is **decided against**: projects using
   `function` or `middleware` deploy as one trusted Node process, and serverless
   targets keep refusing those routes at activation
   ([the decision](docs/OPEN-DECISIONS.md#accepted-one-node-deployment-per-project)).

## Records and ownership

Track actionable defects and feature gaps in the owning repository's issues.
This page explains sequence; package contracts explain behavior; dated evidence
states what was actually tested. Completed and superseded plans are retained in
the private maintainer record. Archiving an implementation plan does not close its
remaining operational acceptance gates.
