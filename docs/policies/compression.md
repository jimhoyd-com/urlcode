# Compression policy

`policies.compression` negotiates a content coding (RFC 9110 §12.5.3) on the
host, outside the sandbox, for every result a route produces: `respond`
bodies, function results, asset responses, cache hits and early denials.
It runs last in the response phase, after the cache store and the security
headers, so every header it reads is final. Asset snapshots are compressed
once at load and served by reference (the NGINX `gzip_static` / Caddy
`precompressed` model); other bodies are compressed on the request path
within a fixed size bound.

## YAML

```yaml
version: "1"
policies:
  compression:
    encodings: [br, gzip]     # preference order; br | gzip | deflate | zstd
    minBytes: 1024            # bodies below this stay identity (default 1024)
    types:                    # media types eligible; `type/*` wildcards allowed
      - text/*
      - application/json
      - application/javascript
      - application/xml
      - image/svg+xml
      - application/manifest+json
      - application/ld+json
    level: 6                  # 1–11, optional; mapped per codec (table below)
    allowWithSecrets: false   # compress even where BREACH applies (default false)

routes:
  /api/report:
    function: { source: functions/report.mjs }
    secrets: { KEY: { secret: api-key } }
    policies:
      compression: { allowWithSecrets: true }   # route keys merge over project keys
```

`encodings`, `minBytes`, `types`, `level` and `allowWithSecrets` are the
only keys; the list above is the default `types`. `zstd` is accepted only
when the running Node exposes `zlib.zstdCompressSync` (Node 22.15+ / 23.8+);
otherwise startup fails with the route named, rather than silently serving
identity. YAML `response.headers` cannot set `Content-Encoding` (it is a
runtime-owned header); this policy is the only thing that sets it.

### Levels

Without `level`, each codec uses a latency-leaning level for request-path
bodies and a size-leaning level for asset variants that are computed once.
With `level`, one number in YAML is mapped onto each codec's own scale and
applies to both paths.

| Coding | Dynamic default | Stored default | `level` mapping |
|---|---|---|---|
| `br` | quality 4 | quality 9 | `level` (1–11) |
| `gzip` | 6 | 9 | `min(level, 9)` |
| `deflate` | 6 | 9 | `min(level, 9)` |
| `zstd` | 3 | 12 | `min(level × 2, 22)` |

## Negotiation

The `Accept-Encoding` field is parsed per RFC 9110: each coding carries a
`q` weight (default 1, `q=0` means not acceptable), `*` supplies the weight
of any coding not named, and a coding neither named nor covered by `*` is
not acceptable. The acceptable coding in `encodings` with the highest weight
wins; equal weights are broken by the order of `encodings`, so
`Accept-Encoding: gzip, br` selects `br` when the project lists `br` first.
When nothing in `encodings` is acceptable, including `identity;q=0` or
`*;q=0`, the response is sent as identity; a 406 helps nobody.

Every response whose media type is in `types` gets `Vary: Accept-Encoding`,
merged into an existing `Vary` without duplication and preserved on 304 and
206, so a shared cache keys the URL by the field even when this particular
response was not compressed.

## When compression is skipped

The response is sent as identity, still with `Vary`, when any of these hold:

- the status is 206 (a byte range of the identity representation), 304, 204
  or 205, or the result already carries `Content-Encoding`;
- `Cache-Control` contains `no-transform`;
- the media type is not in `types`, or the body is below `minBytes`;
- the request method is `HEAD` and the body has no precomputed variant (see
  below);
- the body exceeds 1 MiB and has no precomputed variant: a synchronous
  compression of that size would hold the event loop for every other
  request, so such bodies stay identity on the request path;
- compressing did not shrink the body;
- **BREACH:** the route declares `secrets`, or the response carries
  `Set-Cookie`, unless `allowWithSecrets: true`.

### BREACH rationale

Compressing a body that mixes a secret (a session token, a CSRF token, an
API key echoed into a page) with attacker-influenced input leaks the secret
through the compressed length: an attacker who can make the victim's
browser issue requests with chosen input measures which guesses shrink the
response. The signal is only there when secret and input share a
compressed body, so the policy refuses to compress exactly where a secret is
plausible: a route that has been granted secrets, and any response that
sets a cookie. `allowWithSecrets: true` is for routes whose bodies do not
echo the secret (a route that uses a key to call an upstream API and returns
public data); set it per route, not for the project.

## ETag and HEAD

RFC 9110 requires a strong validator to differ between representations, so
an encoded body cannot carry the identity ETag unchanged. The policy handles
the two paths differently:

- **Precompressed assets** keep a strong ETag with the coding appended
  inside the quotes: `"<sha256>-br"`, `"<sha256>-gz"`, `"<sha256>-df"`,
  `"<sha256>-zs"`. The asset handler validates `If-None-Match` against the
  identity tag; the policy validates the suffixed tag for the coding it
  selected and answers 304 (with the suffixed ETag and `Vary`) when it
  matches. A suffixed tag presented with a different `Accept-Encoding`
  selects a different representation and gets a fresh 200. `If-Range` only
  ever matches the identity tag, so a range request against a variant tag
  gets the full identity body, as the RFC prescribes for a non-matching
  validator.
- **Dynamically compressed bodies** (functions, `respond`, middleware
  results, cache hits) keep the handler's ETag but weakened: `W/"v1"`. Weak
  comparison treats `W/"v1"` and `"v1"` as equal, so a client revalidating
  with the weak tag gets the same 304 it would for identity, and a
  handler's own `If-None-Match` logic keeps working. Nothing is appended,
  because a dynamic body has no stable bytes for a strong tag to name.

`HEAD` reports what `GET` would send when the answer is free: a
precompressed asset answers `HEAD` with `Content-Encoding` and the variant's
`Content-Length`. A dynamic body is not compressed for `HEAD` (it would pay
the whole compression for one number) and reports the identity length,
the same `Content-Length` its `GET` would carry uncompressed.

## Precompression and memory bounds

`compileAssets` runs before policies compile, so the policy, not the asset
loader, computes variants: in `compile()` it walks the route's asset
snapshot (one file for `page`/`download`, the whole tree for `static`) and
compresses every file whose type is in `types` and whose size is at least
`minBytes`, once per configured coding. A project without the policy pays
nothing. Variants are stored on the immutable snapshot and replaced with it
on reload. Bounds:

- a variant at least as large as the original is dropped;
- the aggregate of all variants across the runtime is capped at 64 MiB
  (the same figure as the asset snapshot itself); beyond it, remaining
  files are served identity or compressed on the request path when they
  fit the 1 MiB dynamic bound;
- a request for a stored variant costs one buffer reference, no copy.

`urlcode audit` and `testPlan()` report `precompressed`, the number of
variants a route holds, alongside `encodings`, `minBytes`, the count of
`types` and `level`.

## Per-target behavior

| Target | Support | Notes |
|---|---|---|
| node | native | Negotiation, precompressed assets and dynamic compression as described. |
| vercel | delegated | The platform compresses responses at its edge; the policy is accepted and dropped so one YAML serves every host. |
| aws | delegated | CloudFront/API Gateway compression is configured on the platform; the policy is accepted and dropped. |
| cloudflare | delegated | Workers responses are compressed by the Cloudflare edge; the build accepts and drops the policy. |

A refusal is deliberate: the YAML stays portable and the difference is
visible at build time rather than as a silent double compression. Remove
the key, or set `compression: false` on the routes that use a profile which
declares it, when deploying to those targets.
