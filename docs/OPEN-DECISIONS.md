# Decisions to align

This is the short public decision register, not a second implementation backlog.
The [roadmap](../ROADMAP.md) supplies sequence; GitHub issues own actionable
work; completed and superseded plans are retained privately.
Recommendations below are not implemented behavior.

## Principles already settled, in plain language

- Use the highest-level declarative feature before writing custom plumbing.
- Functions and middleware are trusted Node code by default; `sandbox: true`
  deliberately opts a route into isolation. Requests require validation either
  way, and binding grants do not confine trusted code.
- Keep infrastructure out of route YAML, reject unsupported targets and keep
  core portable without importing optional extension implementations.
- Tests prove the behavior tested; they do not prove deployment, accessibility,
  hostile multi-tenant isolation or independent security assessment.
- The free Apache-2.0 runtime remains useful without a mandatory hosted account
  or provider lock-in.

## Decisions still needed

| Decision | Current direction |
| --- | --- |
| Where work status lives | Issues own actionable status, the roadmap owns sequence and the archive keeps completed proposals. |
| Business-application expansion | Gather repeated real application friction before selecting a collection, CMS or forms capability. Internal exploration is not an implementation promise. |
| Extension schemas in bounded context ([#174](https://github.com/jimhoyd-com/urlcode/issues/174)) | Measure whether automatically including registered schemas improves authoring without exceeding a bounded context or loading a project-selected host file. |
| Tested-image promotion ([#233](https://github.com/jimhoyd-com/urlcode/issues/233)) | Keep publication off until an authorized GHCR inspection and candidate rehearsal establish the promotion evidence needed to ship tested bytes. |
| `renderDocument` under strict CSP ([#287](https://github.com/jimhoyd-com/urlcode/issues/287)) | Keep `oshp` strict; decide whether the nonce recipe is sufficient before changing the document API. |
| Filtering and sorting for store collections and screens ([#330](https://github.com/jimhoyd-com/urlcode/issues/330)) | Done. Store part: a collection declares `sortable` and `filterable` field lists; the list API takes one `sort=<field>` or `sort=-<field>` and equality filters on declared fields (at most three, values typed like the field) with an `id` tie-break and an opaque keyset cursor for sorted pages; undeclared or malformed names are 400s naming the key; no operators, text search, OR or nested paths. It applies to the whole collection, since per-record ownership ([#331](https://github.com/jimhoyd-com/urlcode/issues/331)) is undecided. Screen part: the first working slice (sort select, one filter control per declared field, one copy key `ui.crud.sort`, unchanged strict-CSP script) added about 3.7 KB unpacked to `@jimhoyd/urlcode-ui` (356,904 to 360,651 bytes) against the 358,400-byte budget and was reverted. Trimmed the option first, honestly: `kitCss`, `stylesheet` and `kitCssLimit` in `packages/ui/src/kit-styles.ts` and the generated `styles.generated.ts` were exported with an inferred string-literal type, so `tsc` wrote the entire compiled value a second time into the `.d.ts` declaration; adding an explicit `: string`/`: number` annotation widens the type and drops that duplication, saving about 68 KB unpacked (`dist/kit-styles.d.ts` 34,423 → 562 bytes, `dist/styles.generated.d.ts` 34,583 → 41 bytes) with no change to the emitted JavaScript, the runtime value, or any `.d.ts` consumer (nothing in the tree matched on the literal type). That freed enough room that the screen slice (now landed) brought the package to 292,044 bytes unpacked, about 66 KB under budget, without raising the cap. Ranges and text search only after real demand. |
| Browser test for the CRUD screen ([#332](https://github.com/jimhoyd-com/urlcode/issues/332)) | Implemented as one Linux Node 24 step in `workspaces` using the runner's preinstalled Chrome over the DevTools protocol (about 1.4 s locally, three tests, no new dependency or action). Keep it non-required-by-name (it rides an existing required job); decide whether to widen to macOS/Windows or Firefox only if a browser-specific defect appears. If it flakes, drop the step rather than retry it. Manual procedure: `npm run test:browser --workspace @jimhoyd/urlcode-ui`, or open a `crudScreen` page in a browser and repeat the three checks by hand. |
| `sandboxReason` advisory | Keep it advisory and frame it as recording a code-trust decision, never as a claim that untrusted request data alone requires sandboxing. |
| Optional host-environment default ([#258](https://github.com/jimhoyd-com/urlcode/issues/258)) | Defer until repeated evidence supports it; any future default remains an operator-resolved grant and fails closed when absent. |

## Accepted: evidence-driven authoring gaps

The initial benchmark evidence was limited. Its accepted directions remain
tracked by issue: constrained JSON/body validation ([#254](https://github.com/jimhoyd-com/urlcode/issues/254)); explicit long-form function bindings ([#255](https://github.com/jimhoyd-com/urlcode/issues/255)); named shared request/header blocks ([#257](https://github.com/jimhoyd-com/urlcode/issues/257)); ordered fixture steps ([#256](https://github.com/jimhoyd-com/urlcode/issues/256)); targeted audit waivers ([#264](https://github.com/jimhoyd-com/urlcode/issues/264)); and an operator-installed store extension with UI work following it ([#253](https://github.com/jimhoyd-com/urlcode/issues/253), [#262](https://github.com/jimhoyd-com/urlcode/issues/262)). The
[specification](SPECIFICATION.md), [store guide](STORE.md) and the recipe catalog
state what has actually shipped.

## Accepted: one Node deployment per project

Projects using `function` or `middleware` run as one trusted Node process, in a
container or VM, as they do locally. Per-route Lambda compilation is not
pursued: it would add generated IAM, weaken the existing sandbox story and make
an unproven provider claim. AWS and Vercel therefore refuse request-time guest
code while remaining available for their supported declarative route types.
Reopen this decision only with evidence of demand for URLCode functions on those
targets; the prior analysis is archived, not a plan.

## Accepted: per-package release tags

Core releases use `v*`; workspace packages use Changesets' native
`<package name>@<version>` tags. The filters cannot overlap, and
`scripts/check-release-tags.ts` enforces the rule. Current package/version
information belongs in [version alignment](VERSION-ALIGNMENT.md) and
`npm run release:status`, not here.

## Accepted: middleware withdrawn rather than consolidated

`@jimhoyd/urlcode-middleware` was unpublished and its repository deleted.
Per-route middleware is native through the `middleware:` array; there is no
workspace package to consolidate. Static targets continue to reject request-time
middleware. The generic extension wrapping hook remains part of core's contract
for other extensions, but is not exercised by a shipped middleware package.

Completed decision detail and the dated source-review baseline are archived.
The full historical decision record is maintained privately; neither replaces
the public contracts or the issues linked above.
