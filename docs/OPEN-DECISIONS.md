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
| Wildcard-suffix redirect ([#383](https://github.com/jimhoyd-com/urlcode/issues/383)) | Not implemented; confirmed by running `urlcode validate` against `/legacy/*` and `{rest...}` on `redirect` (both refused — a terminal `/*` is only accepted on `static`/`extension`, and `{rest...}` is not a valid parameter name). Proposed shape if taken up: a route key ending `/**` accepted only under `redirect`, matching one or more remaining segments as a single named capture (for example `/legacy/**`) usable once in the destination path as `{**}`, encoded as its captured segments joined by `/` (not re-decoded, so a `%2F` in the input stays literal in the placeholder and cannot introduce an extra segment on redirect). Effects: `validate`/`explain`/`routes`/`audit` show it like any parameterized redirect; ordering must place a `/**` route after every literal and single-placeholder route at the same prefix so nothing overshadows a longer, more specific match; the destination is still checked as a literal absolute HTTP(S) host, so this only relaxes the source path shape. Security: `redirect.url` already forbids control characters and requires an absolute host, so a capture only ever lands in the destination path (never the host or scheme), keeping this closed to open-redirect abuse from the captured value; still reject a capture equal to `.`/`..` segments and cap total captured length. Needs a maintainer decision because it is the first path-shape exception to "exact or `{param}`, no general-purpose wildcard" in [ROUTING.md](ROUTING.md); until then, report the gap and use one fixed-depth route per depth, or `urlcode bulk-import` for a known finite set of paths. |
| Host-based, scheme-based or relative-URL redirect ([#383](https://github.com/jimhoyd-com/urlcode/issues/383)) | Not implemented; confirmed by running `urlcode validate` against `redirect.url: /relative`, `//host/path` and a `{param}` inside the host or query (all refused with "Redirect URL must be absolute HTTP(S)" or "Redirect placeholders are allowed only in path segments"). No proposed YAML: a relative or client-controlled host in a redirect destination is an open-redirect and header-injection risk (the current literal-absolute-URL rule is a deliberate guard, not a gap in encoding); routes also never match on incoming `Host`, so a scheme/host redirect would need a new selection axis, not just a relaxed destination. Report as a gap; the tested alternative is a literal `https://` destination per route, one per required host/scheme. |

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
`<package name>@<version>` tags; data-only extension artifacts use the reserved
`extensions@v*` namespace; executable first-party bundles use the separate
`extension-bundles@v*` namespace. The filters cannot overlap, and
`scripts/check-release-tags.ts` enforces the rule. Current package/version
information belongs in [version alignment](VERSION-ALIGNMENT.md) and
`npm run release:status`, not here.

## Accepted: `site.notFound` is inlined on Cloudflare, not a static-asset binding

[#309](https://github.com/jimhoyd-com/urlcode/issues/309) asked for a
supported Cloudflare path for `site.notFound`, which `build --target
cloudflare` refused outright because that target has no static-asset binding.
Three options were weighed: inline the one page into the Worker bundle as a
string; add a Workers Static Assets binding (`assets` in the wrangler
configuration) so the build could emit and validate a bucket of files; or keep
refusing it and document the `respond`/function-route alternative. The static
Assets binding would touch build output shape, deployment instructions and
validation for a whole class of files, for a decision this issue does not
need; inlining serves the one bounded, singular, static page `site.notFound`
already is. `build --target cloudflare` now reads that file (64 KiB cap, must
decode as UTF-8) and carries it inline in the artifact as a `respond` route at
`/404.html`, answering the same status, headers and method rules as the other
targets; `favicon`, `llms` and any other `page`/`static`/`download` route stay
refused, since those are open-ended, not one bounded page. Verified on real
workerd via `wrangler dev --local` (status 404, content type, `no-store`,
security headers, HEAD's body length, and POST's plain-text `Not found`
unchanged). See [`docs/CLOUDFLARE.md`](CLOUDFLARE.md#site-notfound-is-inlined)
and [`docs/SITE.md`](SITE.md#notfound--404html). Revisit the assets-binding
design only if a future site convention or route type needs to serve more than
one small file on this target.

## Accepted: middleware withdrawn rather than consolidated

`@jimhoyd/urlcode-middleware` was unpublished and its repository deleted.
Per-route middleware is native through the `middleware:` array; there is no
workspace package to consolidate. Static targets continue to reject request-time
middleware. The generic extension wrapping hook remains part of core's contract
for other extensions, but is not exercised by a shipped middleware package.

Completed decision detail and the dated source-review baseline are archived.
The full historical decision record is maintained privately; neither replaces
the public contracts or the issues linked above.
