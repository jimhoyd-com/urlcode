# Deploying to static hosting (S3 + CloudFront)

The `static` target is the bottom rung of the [capability
ladder](FRAMEWORK.md#the-ladder):
the same `urlcode.yaml` a self-hosted server or a serverless adapter runs, with
no server process at all. `urlcode build --target static` compiles a project
ahead of time into plain files and two small JSON manifests meant for an S3
bucket served through CloudFront — nothing here executes a request.

```sh
urlcode build --target static --project . --out dist --origin https://links.example
```

## Declarative routes only, and less than that

This target serves **redirects**, **declared responses** (`respond:`) and
static files (`page`, `static`, `download`) — no path parameters, no query
passthrough or mapping, both GET and HEAD required, `respond.status: 200` only, and no `enabled: false` or `expires`
(there is no server to answer a disabled or expired route with 404/410, so the
build refuses one instead of silently serving it forever). Everything else is
refused **at build time**, with the route pattern and the reason named:

| Handler / feature | Why it is refused |
| --- | --- |
| `function`, `middleware` | no server, so no dynamic or sandboxed execution |
| `extension`, `policies.extensions` | no server, so no operator extension registry |
| `proxy`, `signals` | no server, so no bounded or fire-and-forget egress |
| `conditional`, `match` (`conditions`) | no server, so no request-time condition matching |
| `parameters`, `request.body` | no server, so no request-time validation |
| `response.headers` | no server, so no per-request headers; set them as S3 object metadata or a CloudFront response headers policy instead |
| `env`, `secrets` (`bindings`) | no server, so no per-request binding resolution |
| every `policies.*` | no server, so no runtime policy enforcement |
| a redirect with a `{parameter}` in its path | S3's per-object redirect is keyed to one exact object, not a pattern |
| a redirect with `query.pass`/`query.map` | S3's per-object redirect cannot compute a target per request |
| a redirect with a `status` other than 301 | S3's per-object website redirect always answers 301 |
| a route not admitting both GET and HEAD, or admitting other methods | the output cannot enforce a different method set |
| `respond.status` other than 200 | an uploaded response object cannot preserve a custom HTTP status |
| a route with `enabled: false` or `expires` | no server to answer a disabled/expired route; remove the route instead |

Run `urlcode capabilities --target static` for the full catalog.

## What the build emits

`--out` (default `dist/static`) receives:

- `objects/<key>` — the actual files to upload, one per served route. A `page`
  or `download` route becomes one file; a `static` mount becomes one file per
  entry in its directory. Object keys match the S3 convention: the route
  pattern with its leading `/` stripped, and `/` itself becomes `index.html`
  (matching a bucket's own "Index document" setting). A redirect route also
  gets a zero-byte placeholder object at its key, so it exists to carry
  metadata.
- `objects.json` — `{ format, objects: [{ key, contentType, cacheControl?,
  contentDisposition? }] }`. Plain file upload loses this metadata (S3 does not
  reliably infer content type or cache headers from an extension-less key), so
  a deploy step reads this file and sets each object's own `Content-Type`,
  `Cache-Control` and `Content-Disposition` from it, for example with
  `aws s3 cp --content-type ... --cache-control ...` per entry, or an
  equivalent `aws s3 sync` post-processing step.
- `redirects.json` — `{ format, redirects: [{ key, location, status: 301 }] }`.
  Each entry is applied as the S3 object's
  [website redirect location](https://docs.aws.amazon.com/AmazonS3/latest/userguide/how-to-page-redirect.html)
  metadata (`x-amz-website-redirect-location`), for example
  `aws s3api put-object --website-redirect-location <location> --bucket ... --key <key>`.
  S3 always answers a request for that key with a 301 to `location`
  regardless of the object's own content — this is why a declared `status`
  other than 301 is refused rather than silently downgraded.
- `404.html` (an object in `objects.json`) — present when the project
  declares `site.notFound`. Configure the bucket or CDN error document to this
  key so unmatched requests receive the page with status 404.
- `manifest.json` — the same project-level semantic manifest every target
  writes (see [tooling](TOOLING.md)).

None of these are edited by hand, and `dist/` belongs in `.gitignore`. This
target ships no runtime import (there is nothing to run), so there is no
`@jimhoyd/urlcode/static` entry point — the build output is the deployment.

## What this is not: GitHub Pages

**This target's claimed support is S3 + CloudFront, not GitHub Pages.**
GitHub Pages has no per-object redirect metadata and no server-side rewrite
layer, so a `redirect` route compiled the way this target compiles it (S3
object metadata) has no equivalent there — the only options are a
meta-refresh/JavaScript page (visibly a redirect, not an HTTP one: search
engines, curl and anything that does not run JavaScript sees the source page,
not a 3xx) or a static 404-page trick, both lower fidelity than what every
other target in this project does for the same route. Rather than claim a
portability promise this platform cannot keep, GitHub Pages is out of scope
for this target. If you need Pages, treat it as a distinct target with its own
explicit fidelity caveat, not a rename of this one.

## Verification status

This target has local build tests only (`test/static.test.ts`): the compiled
object layout, the redirect manifest, and every refusal above. **It has not
been deployed to S3 or fronted by CloudFront.** Bucket policy, CloudFront
caching behavior, TLS/domain setup and the exact `aws s3` invocations above are
unverified until a real deployment exercises them.


## Building pages with middleware

Use [prerendering](PRERENDER.md) to execute functions and native middleware at
build time, then export the generated native page routes with this target.
Trusted Node execution is the build default; `sandbox: true` retains its
restricted imports and resource limits. Neither mode adds a request-time server
to the static output. Authentication, request-dependent headers and other
per-request middleware cannot be baked into a public file safely.
