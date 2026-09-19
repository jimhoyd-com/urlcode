# Roadmap

URLCode lets people and agents describe URL behavior in YAML and write application
code only where the framework cannot express it. The free Apache-2.0 runtime
stays useful on its own. [Project direction](docs/PROJECT-DIRECTION.md) owns the
principles; [the specification](docs/SPECIFICATION.md) owns implemented behavior.

## What works now

The source at `db375bf` provides declarative routing, responses, assets, policies,
conditions, proxy/signals, trusted Node functions and middleware, and opt-in
`sandbox: true` isolation. Target support differs: use `urlcode capabilities`
before promising a deployment. Stored short links have no supported package.

Auth, admin, UI and middleware are separate optional packages. Auth/admin already
render through the shared UI kit when configured. Core includes scaffolding,
searchable recipes/examples, compact context, schema queries, a semantic manifest,
and MCP inspection with separately enabled authoring. These are implemented,
not future phases. See [the framework](docs/FRAMEWORK.md).

## Next work, in order

1. **Make the existing product coherent.** Keep docs, examples, generated LLM
   resources, installed skills and the standalone template consistent with their
   runtime version. Resolve the [open decisions](docs/OPEN-DECISIONS.md).
   [Issue 168](https://github.com/jimhoyd-com/urlcode/issues/168) tracks checking
   schema-invalid documentation examples beyond the existing prose checks.
   [Issue 174](https://github.com/jimhoyd-com/urlcode/issues/174) retains the
   extension-schema retrieval proposal.
2. **Measure the agent experience.** The benchmark harness and authoring evals
   exist, but the committed baseline is a stub, not a real-model measurement.
   [Issue 173](https://github.com/jimhoyd-com/urlcode/issues/173) tracks the
   measurement. Run the existing tasks, retain the raw results and use observed friction to
   choose improvements. See [the benchmark](benchmarks/agent/README.md) and
   [the broader experiment proposal](docs/SPIKE-AI-FRAMEWORK-BENCHMARK.md).
3. **Close release evidence gaps.** Browser/device coverage, accessibility,
   independent security review, deployed recovery/soak tests and real provider
   verification remain distinct from source implementation and local tests.
   [Issue 58](https://github.com/jimhoyd-com/urlcode/issues/58) and
   [release readiness](docs/RELEASE-READINESS.md) retain those gates. Live
   Google/Apple/SES checks remain explicitly deferred.
4. **Consolidate middleware into core.** The maintainer accepted this direction;
   [issue 172](https://github.com/jimhoyd-com/urlcode/issues/172) tracks migration
   and eventual extension retirement. Static targets continue rejecting
   request-time middleware.
5. **Choose expansion from evidence.** Collections, a business application suite,
   and per-route Lambda compilation are proposals,
   not available features. Decide scope before implementing them.

## Records and ownership

Track actionable defects and feature gaps in the owning repository's issues.
This page explains sequence; package contracts explain behavior; dated evidence
states what was actually tested. Completed and superseded plans live in the
[archive](docs/archive/README.md), including the previous release chronology
and detailed phase plan. Archiving an implementation plan does not close its
remaining operational acceptance gates.
