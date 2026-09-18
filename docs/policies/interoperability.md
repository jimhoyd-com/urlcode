# Policies: Interoperability between policies

Part of [policies](../POLICIES.md), which holds the shared rules and the per-target table.

## Interoperability

Every pair of policies, and every policy against the runtime's own responses,
was reviewed by reading the code and by exercising a server. The rules below
are the ones the current code enforces; where a combination misbehaves, the
rule says so and names what to do instead.

### Cannot coexist

Hard conflicts: the runtime refuses activation, or the combination produces
a wrong answer today.

- **Origin cache and conditional or range requests.** A request carrying
  `If-None-Match`, `If-Modified-Since`, `If-Match`, `If-Unmodified-Since` or
  `Range` is never answered from the origin cache: a stored entry is a full
  `200` representation and the handler owns validators and ranges, so such
  requests always reach it and get the handler's `304`, `412` or `206`.
  Unconditional requests are served from the entry.
- **`security.unset` and a route that switches profile.** `unset` is
  validated against the profile in effect on that route. A project-level
  `unset` merges into a route that names a profile without that header
  (`headers: off`, or `oshp-no-csp` with `unset: [Content-Security-Policy]`)
  and activation fails with `unset names "...", which the off profile does
  not emit`. Write `unset: []` on that route: a route key replaces the whole
  array.
- **`security.set` of `Cache-Control`, `Content-Encoding`, `ETag`,
  `Content-Type`, `Set-Cookie`, `Location` and the other reserved names** is
  refused at activation (`is owned by the runtime or handler`). `Vary`,
  `RateLimit`, `RateLimit-Policy`, `Retry-After` and `Age` are reserved for
  the same reason: the cache and throttle policies own them, and a `set` of
  any of the five is refused at activation with the route named. Declare
  `vary` on the cache policy instead.
- **`agents.denyEmpty`, `throttle` and the generated probes.** `urlcode
  audit`, `urlcode test` and `urlcode benchmark` send generated probes as
  `Mozilla/5.0 (compatible; RouteProbe/0.1)`,
  so `denyEmpty` does not fail them; a deny pattern that matches that string
  would. A tight `throttle` fails an audit once the probes exceed `quota`
  (the audit runs from one address, so a `static` tree with more files than
  the quota trips it): keep the quota at least the number of generated cases
  or run the audit in `mode: report`.
- **`hardened` on Vercel and AWS** is refused as written, because
  `throttle.partition: client` cannot be honoured there; **on Cloudflare**
  the build refuses `throttle` and `cache`. Override the offending keys with
  `false` or `partition: route` as [the `hardened` page](hardened.md) describes.
- **`compression.encodings: [zstd]` on a Node without `zlib.zstdCompressSync`**
  fails activation with the route named rather than serving identity.

### Coexist with defined precedence

Pairs that work, with the rule the code applies.

- **Request order is `agents`, `throttle`, cache lookup.** A denied agent is
  never counted and never looked up; a throttled request is never looked up.
  An agent on an `allow` list passes `agents` and is still throttled. An
  `agents` denial and a `throttle` refusal both pass through the cache
  policy's response hook (they carry no flight, so nothing is stored) and
  pick up its declared `vary` names, then security headers, then
  `Vary: Accept-Encoding` from compression; their bodies are below `minBytes`
  so they are never encoded.
- **Cache hit and the response phase.** A hit skips only the cache's own
  response hook: it still carries the client's `RateLimit` headers (the
  request was counted), the security profile, and is compressed on the way
  out. Stored entries are the handler's bytes and headers after YAML
  `response.headers` and the cache policy ran, before throttle, security and
  compression: bodies are stored uncompressed and encoded again on every hit,
  and a `RateLimit` value is never stored. A cache hit on an asset serves the
  same snapshot buffer, so a precompressed variant is used for `GET` and
  reported at the variant's length for `HEAD`, exactly as when uncached.
- **Cache `Vary` and compression `Vary`.** The cache merges its declared
  `vary` names first; compression appends `Accept-Encoding` without
  duplicating it and leaves a `Vary: *` alone. The origin key uses only the
  cache's names: because bodies are stored uncompressed, `Accept-Encoding` is
  not part of the key and need not be.
- **ETags across `cache` and `compression`.** `revalidate` keeps a handler or
  asset `ETag` and computes a strong SHA-256 tag for a `200` without one.
  Compression then weakens a dynamically encoded body's tag (`W/"..."`) and
  suffixes a precompressed asset's (`"...-gz"`). Revalidation works in every
  combination: the cache's `304` compares weakly, the asset handler compares
  weakly against the identity tag, and compression answers `304` for a
  suffixed tag it produced. The `304` that `revalidate` produces keeps
  `Content-Type`, so compression adds `Vary: Accept-Encoding` to it as it
  does to the asset handler's own `304`.
- **Who owns `Cache-Control`.** YAML `response.headers` first, then an asset
  handler's `cacheControl` when the cache policy is only inherited, then a
  handler's `private` or `no-store`, then the strategy; `security.set` cannot
  name it. A `no-store` or `private` handler answer is never stored whatever
  the strategy says.
- **Security headers and everything else.** Profile headers fill gaps only:
  YAML `response.headers`, function, asset, redirect and early-denial headers
  keep their values. `set` overrides all of them. `Strict-Transport-Security`
  needs an `https` origin. The profile is applied on cache hits and on early
  denials (including a plugin short-circuit), on the self-hosted server and
  in the Worker alike.
- **Compression and secrets or cookies.** A route with `secrets` or a
  response with `Set-Cookie` is sent as identity (still with `Vary`) unless
  `allowWithSecrets: true`. A route with `secrets` also never enters the
  origin cache, so the two policies agree on what a secret-bearing route is.
- **Throttle and the 405.** The request phase runs before the method check,
  so a request that ends as `405` was counted, and the `405` passes through
  the response phase: it carries the `RateLimit` headers, the security
  profile and plugin `onResponse` rewrites. Nothing stores it.
- **Plugins and policies.** `onRequest` runs before every policy; a
  short-circuit result skips `agents`, `throttle` and the cache lookup
  (nothing is counted, matched or stored) and skips the cache store and the
  throttle headers, then receives security headers and compression, then
  every plugin's `onResponse`. On a thrown error the policies' `onError`
  hooks run first (in the order the policies were declared) and then plugin
  `onError` hooks in reverse. Only the cache policy has an error hook today
  and it never returns a fallback (`stale-if-error` is header-only); if a
  future policy did, that fallback would pass through the response phase and
  every plugin `onResponse`, and plugin `onError` would not run for that
  request.
- **Reload.** Every reload builds a new runtime with fresh shared state:
  throttle counters start empty and the origin cache and precompressed
  variants are rebuilt; a client mid-window gets a fresh budget. The plugin
  objects are the ones the operator passed and persist across reloads:
  `onActivate` runs for the new runtime before `onClose` runs for the old,
  so a plugin's own state (a shared-store connection, a `WeakMap`) survives a
  reload unless its `onClose` discards it. A plugin whose `onActivate`
  throws makes the reload fail and the old runtime keeps serving.
- **Merge edge cases.** A route `profile` that lacks a key the project layer
  had leaves that key in force (layers merge, they do not replace); `false`
  at the project level followed by an object at the route level re-enables
  the policy with the route's object alone, so it must be complete
  (`throttle` needs `quota` and `window`); a custom profile named like a
  built-in shadows it everywhere.
- **Memory bounds add up.** Per runtime: 64 MiB of asset snapshot, up to
  64 MiB of precompressed variants, up to 64 MiB of origin-cache bodies (a
  stored asset references the snapshot buffer rather than copying it, but
  is counted against the cache budget), and the throttle table at the
  largest `maxKeys` (100,000 keys by default). Two routes serving the same
  file compress it separately and both count. During a reload both
  generations exist at once. [Capacity](../CAPACITY.md) states the asset,
  throttle and cache figures; the precompressed budget belongs in that table
  too.
- **Cloudflare.** The artifact carries the effective `agents` and `security`
  configuration per route, with the entries of any project list file
  embedded under the reference as written in YAML (no filesystem path); a
  route-level `agents: false` leaves the artifact without that key. The
  Worker runs `agents` on the request and `security` on the response, so an
  early denial carries the profile exactly as on the self-hosted server.

### Not covered by policies

- **Every error the runtime throws** (404 for no match, disabled route or
  missing link, 410, 400/413/415 from body checks, 502/503/504 from the
  sandbox or a link store) bypasses the response phase: no `Vary`, no
  `RateLimit`, no compression, no plugin `onResponse`, on every target.
  What they do get is the `security` policy: the matched route's effective
  profile when the error came after routing (so a route with
  `security: false` answers its 410 bare), otherwise the project-level
  profile, including a host-side error such as an oversized body or shed
  admission and the Worker's own 404. The runtime's fixed headers
  (`Content-Type`, `Cache-Control: no-store`, `Content-Length`,
  `X-Request-Id`, `X-Content-Type-Options`) can never be replaced by it.
  Plugins keep `onError` for observation; a policy error hook may answer with
  a fallback, and none does today.
- **The audit's probes** share one address and one `User-Agent`, so they do
  not exercise `agents` or `throttle` the way real traffic does;
  the policy table in `testPlan().policies` is the audit's evidence for
  those two.
- **`stale-if-error` at the origin**: header-only, as the
  [cache page](cache.md) states.
- **Cross-instance state**: counters and the cache are per runtime on every
  target; a shared budget or a shared cache is a plugin.
