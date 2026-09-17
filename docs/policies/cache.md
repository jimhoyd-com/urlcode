# `policies.cache`

Named HTTP caching strategies, enforced on the host. A route picks one
strategy from a fixed catalogue; every row is a pattern with a name outside
this project and a defined header output, so a browser, a CDN and the
runtime's own origin memory cache all read the same thing. Explicit fields
(`maxAge`, `staleWhileRevalidate`, `staleIfError`, `cdnMaxAge`, `originTtl`)
override what a strategy implies.

```yaml
policies:
  cache: { strategy: revalidate }      # project default
routes:
  /feed:
    function: { source: feed.mjs }
    policies:
      cache: { strategy: swr, maxAge: 30, staleWhileRevalidate: 300, vary: [Accept-Language] }
```

## Strategies

| `strategy` | Emitted headers | Origin memory cache | Typical use |
|---|---|---|---|
| `no-store` | `Cache-Control: no-store` | off | personalized, secret-bearing |
| `revalidate` | `Cache-Control: no-cache`, `ETag` (a strong SHA-256 tag is computed for results without one); answers `304` to `If-None-Match`, and to `If-Modified-Since` when the result carries `Last-Modified` | off | HTML, anything that must be fresh but is cheap to validate |
| `public` | `Cache-Control: public, max-age=N` (`maxAge` required) | on only when `originTtl` > 0 | stable API answers, feeds |
| `immutable` | `Cache-Control: public, max-age=31536000, immutable` (RFC 8246; `maxAge` overrides the year) | off | content-hashed URLs only; refused elsewhere unless `force: true` |
| `swr` | `Cache-Control: public, max-age=N, stale-while-revalidate=M` (RFC 5861; both required) | on: fresh for `originTtl` (default `maxAge`), then stale served once | hot functions, link previews |
| `sie` | as `swr` plus `stale-if-error=K` (`staleIfError` required; `staleWhileRevalidate` optional) | on, as `swr` | keep answering during an upstream failure (headers only at the origin; see below) |
| `micro` | `Cache-Control: no-store` to clients | on: `originTtl` default 1 s, at most 5 s unless `force: true` | the NGINX micro-cache: absorb a thundering herd without changing what a browser sees |
| `cdn-only` | `Cache-Control: no-store` plus `CDN-Cache-Control: max-age=N` (RFC 9213; `cdnMaxAge` required) | off | let the CDN cache while browsers do not |
| `private` | `Cache-Control: private, max-age=N` (`maxAge` required) | off | per-user data a browser may keep |

`immutable` accepts a route whose pattern has a segment with eight or more
hex characters (`/app.3f2a9c1d.js`) or a parameter named like a digest
(`{hash}`, `{digest}`, `{sha}`, `{version}`, `{build}`, `{rev}`,
`{fingerprint}`). Anything else fails configuration with the route named
unless `force: true`.

## Who owns `Cache-Control`

Explicit beats strategy, in this order:

1. A `response.headers.cache-control` declared in YAML on the route is kept
   as written; the strategy does not touch it.
2. An asset handler's `cacheControl` (`page`, `download`, `static`) is kept
   when the cache policy is only inherited from the project or a profile.
   When the route itself declares `policies.cache`, the strategy overrides it.
3. A handler result that already says `no-store` or `private` is kept and is
   never stored: a personalized answer under a `public` route stays private.
4. Otherwise the strategy's header replaces whatever the handler emitted.

`Vary` is merged with the declared `vary` names (no duplicates, `*` left
alone), for every strategy, so the origin key and the wire header agree.
Compression adds `Accept-Encoding` to `Vary` after this policy.

## Origin memory cache

On for `swr`, `sie`, `micro`, and `public` with `originTtl` set. Rules:

- Only `GET` and `HEAD` are looked up; only `GET` results are stored, and a
  `HEAD` hit serves the `GET` entry's headers with an empty body and the
  entry's `Content-Length`. A route whose `methods` exclude `GET` has the
  origin cache off.
- Only statuses in `statuses` (default `200, 301, 302, 404, 410`) are stored.
- Never stored: results carrying `Set-Cookie`; routes declaring `secrets`;
  results whose handler `Cache-Control` says `private` or `no-store`; bodies
  larger than `maxBytes` (default 1 MiB).
- Key: route pattern, request path, query string and the values of the
  declared `vary` request headers. The method is not part of the key so
  `HEAD` shares the `GET` entry.
- Hits carry `Age` (RFC 9111). No non-standard headers are added.
- Concurrent misses for one key coalesce: the first request reaches the
  handler, up to 64 others wait for its result, and any beyond that proceed
  to the handler themselves. If the fill fails, waiters fall through to the
  handler rather than receiving the error.
- Bounds: `maxEntries` per route configuration (default 10000) and 64 MiB of
  bodies across the whole runtime; the least recently used entry is evicted
  first. The store belongs to one runtime instance and is dropped on close and
  reload, so a deploy never serves the previous code's output.
- Stored entries hold the handler's headers as they were after YAML
  `response.headers` and this policy ran, before security headers and
  compression. Those run again on every hit, so a hit is compressed and
  hardened the same way as a miss. Bodies are stored uncompressed.

### `swr` at the origin: stale served once, next request refreshes

A policy has no handle to the route's handler, so it cannot revalidate in the
background. The origin-side approximation is: a request that finds an entry
past `originTtl` but within `staleWhileRevalidate` is answered from the stale
entry immediately, and the entry is flagged so the next request for that key
goes to the handler and replaces it. If that refresh fails the flag is
cleared and the stale entry may be served once more, as long as it is within
the window. Beyond `max-age + stale-while-revalidate` nothing is served from
memory. Clients and CDNs that honour RFC 5861 do their own background
revalidation from the emitted header.

### `sie` limitation

`stale-if-error` is header-only at the origin. Policies observe errors but
cannot replace a thrown error with a result (the runtime rethrows), so a
handler failure is not answered from a stale entry by this runtime. Downstream
caches honouring RFC 5861 still serve stale on a 5xx. Origin-side
stale-if-error needs the plugin API or a runtime change that lets a policy's
error hook return a result.

## Targets

| Target | Support | Note |
|---|---|---|
| node | native | headers and origin cache per runtime instance |
| vercel | native | headers; the origin cache is per function instance, so hit rates depend on instance reuse |
| aws | native | headers; the origin cache is per Lambda instance |
| cloudflare | refused | the Worker build has no policy runtime; activation fails with the route named |

## Diagnostics

`describe()` (in `urlcode test`, the readiness plan and plugin activation)
reports `strategy`, the emitted `cacheControl` string (or `explicit response
header` / `asset handler` when something else owns it), `cdnCacheControl`,
`originTtl`, `staleWhileRevalidate`, `staleIfError`, `vary` and whether the
origin cache is `on`.

Log events, through the runtime's `log`:

```json
{ "event": "cache", "route": "/feed", "outcome": "hit" }
```

`outcome` is `hit`, `stale`, `miss` or `store`. The route is the configured
pattern, never the request path or key.
