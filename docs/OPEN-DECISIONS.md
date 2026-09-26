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
| Tested-image promotion ([#233](https://github.com/jimhoyd-com/urlcode/issues/233)) | Each release builds and pushes the image from the release commit in its publish job; decide whether to promote the exact image CI tested instead (see [container promotion](CONTAINER-PROMOTION.md)). |
| `renderDocument` under strict CSP ([#287](https://github.com/jimhoyd-com/urlcode/issues/287)) | Keep `oshp` strict; decide whether the nonce recipe is sufficient before changing the document API. |
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

## Accepted: add-ons ship on core's release

Core releases use `v*`. Extensions and artifacts are released as tarballs on
that same GitHub Release, at core's version, and core pins each one (URL and
sha512) in its `addons.json`; only core is published to npm. No add-on has its
own tag, catalog or publisher. Current package/version information belongs in
[version alignment](VERSION-ALIGNMENT.md), not here.

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
unchanged). See [`docs/CLOUDFLARE.md`](CLOUDFLARE.md#sitenotfound-is-inlined)
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
