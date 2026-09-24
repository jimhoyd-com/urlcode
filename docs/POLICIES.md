# Policies

Policies are host-enforced behavior declared in YAML around a route: a
per-client request budget, a User-Agent deny list, a security-header profile,
content-coding negotiation and an HTTP caching strategy. They run in the host
process, outside function/middleware execution — trusted or sandboxed alike —
so they can see the client address, keep counters across requests and touch
the transport, which route middleware by design cannot
([middleware](MIDDLEWARE.md), [function security](FUNCTION-SECURITY.md)).

Everything here is optional and off by default. A project with no `policies`
key and no `profiles` key behaves exactly as before: no policy module is
compiled and the request path is unchanged. Each policy has its own page:

| Policy | Page | What it does |
|---|---|---|
| `throttle` | [throttle](policies/throttle.md) | Sliding-window request budget with `RateLimit`/`RateLimit-Policy` headers, 429 and `Retry-After` |
| `agents` | [agents](policies/agents.md) | Deny or allow by `User-Agent`, from bundled lists, project files and bounded patterns |
| `security` | [security](policies/security.md) | OWASP Secure Headers Project response headers, with per-header `set`/`unset` |
| `compression` | [compression](policies/compression.md) | `Accept-Encoding` negotiation; assets precompressed at snapshot time |
| `cache` | [cache](policies/cache.md) | Named strategies from RFC 9111/5861/8246/9213 plus an origin memory cache |

Operators who need behavior the declarative block cannot express pass host
[plugins](PLUGINS.md) in code; plugins are never named in YAML.

## Declaring policies

```yaml
version: "1"
policies:                      # project defaults; every key optional
  profile: hardened            # built-in, or a name under `profiles`
  throttle: { quota: 60, window: 60 }
routes:
  /api/lookup/{id}:
    function: { source: functions/lookup.mjs }
    policies:
      throttle: { quota: 10, window: 60 }
      cache: false
```

`policies` at the top level sets project defaults; `routes.<path>.policies`
adjusts them for one route. Two route-level short forms exist. `auth`
expands to `policies.extensions.auth` when the project declares an auth
[extension](EXTENSIONS.md), carrying the same keys minus `required`;
`required: false` documents the intent and emits no policy. It accepts
`required`, `role`, `permission`, `verified`, `freshWithinSeconds`, `onDeny`
and `bearer` and nothing else — `role` is singular, and there is no `roles`.
`bearer: {scopes: [...]}` protects the route with an API key instead of a
session and is exclusive of the other keys (see
[extensions](EXTENSIONS.md#bearerapi-key-routes)). Like
`cache` below, it is refused rather than silently ignored in three cases: when
the project declares no `extensions.auth`, when the route also sets
`policies.extensions.auth` (use one form), and when the route sets
`policies.extensions: false`. `cache: {strategy, maxAge, ...}` expands to
`policies.cache` the same way — the compiler merges it into that route's
`policies` before anything else reads the project, so `routes`, `audit` and
`explain` see only the expanded long form, and it is refused alongside a
direct `policies.cache` on the same route (use one form):

```yaml
routes:
  /feed:
    function: { source: functions/feed.mjs }
    cache: { strategy: swr, maxAge: 30 }   # expands to policies: { cache: {...} }
```

Both accept the same keys: `profile` plus one entry
per policy, each either an object or `false`. Unknown keys fail validation, as
everywhere in the project format. The
[field reference](YAML-REFERENCE.md) lists every accepted field with its
bounds; the [JSON Schema](../schemas/urlcode.schema.json) is the source.

Values are behavior, never infrastructure: a quota is a number a proxy or CDN
can restate, while trusted proxy ranges, storage URLs and vendor rule
identifiers stay in operator configuration. That is what keeps a project
portable between a laptop, a container and an adapter.

## Where policies run

Policies run once the route is known and before its contract is checked. A
denied agent or an exhausted budget is answered without reading a body or
starting the sandbox. The self-hosted pipeline:

```
socket limits → admission → body read
  → runtime.handle(): match → enabled/expires
    → plugins onRequest                       (outermost, first plugin first)
    → agents → throttle → cache lookup        (request phase; may short-circuit)
    → methods (405) → request.body checks
    → native handler | guest chain
    → YAML response.headers
    → cache store → throttle headers → security → compression   (response phase)
    → plugins onResponse                      (reverse order, first plugin last)
    → writeResponse
```

Request order is fixed: agents first because a denial is the cheapest
outcome, then throttle, then the cache lookup, so a denied or refused request
neither counts against a budget nor touches the cache. Response order is the
cache store, then the throttle's `RateLimit` headers (after the store, so a
cached copy is never stamped with one client's remaining budget), then
security headers, then compression last so every header it depends on is
already final. YAML `response.headers` are applied by the runtime before the
response phase, so an explicit header always beats a profile default.

A result produced by a request-phase policy (an agent denial, a throttle
refusal, a cache hit) skips that policy's own response hook and passes through
the others: a hit is not stored twice but still carries the client's
rate-limit headers, and a denial is not stored because its status is not
cacheable. A throttle refusal carries its own `RateLimit` and `Retry-After`
headers. A plugin short-circuit ran before any policy, so it skips the
response hook of every policy that has a request phase; security headers and
compression still apply to it.

Two responses bypass the response phase entirely: the `405` the runtime returns
for an undeclared method, and any error the runtime throws (404 for no match,
410 for an expired route, 413/415 from body checks, sandbox 502/504). Those
receive the runtime's standard headers only. Policies with an `onError` hook
and plugin `onError` hooks observe thrown errors; they cannot change them.

Adapters call `handle()` directly and delegate socket limits and admission to
the provider; the policy order inside `handle()` is the same. The Cloudflare
Worker runs the same request and response order with the two policies it can
carry.

## Portability and the per-target table

A project is portable when a second person can run it elsewhere and get the
same declared behavior or an explicit refusal. A target that cannot honor a
policy refuses activation naming the route and the policy, exactly as adapters
refuse functions and middleware; nothing degrades silently. Two different
things are both called **delegated**, and the capability report's reason text
tells them apart: most of the time it means a policy the platform itself
already provides is accepted and dropped (compression, cache); for
`throttle`'s `partition: route` on Vercel/AWS it means the opposite — this
runtime's own in-process code still counts and refuses requests, but the
count is per instance, so the effective ceiling depends on a deployment fact
(instance count) the build cannot see. Either way it is reported as such in
the inventory, so one YAML can serve a Node host and a serverless host
without edits. The self-hosted
message reads `/path declares policies.throttle, which the vercel target
cannot enforce`; the Cloudflare build reports
`/path: policies.throttle cannot be compiled for this target`.

| Policy | Self-hosted (`node`) | Vercel / AWS | Cloudflare build |
|---|---|---|---|
| `agents` | native | native | compiled into the artifact |
| `security` | native | native | compiled into the artifact |
| `throttle` | native, in-process counters | delegated (enforced, per-instance) only with `partition: route`: counters are per instance, so the enforced quota is effectively **quota × instance count** once the target scales past one instance; `client` and `client-route` are refused outright because a client fans across instances and no per-instance caveat makes that honest | refused |
| `compression` | native | delegated only with no explicit `encodings`, `minBytes`, `types`, `level` or `allowWithSecrets`: the provider compresses with its own defaults; any of those keys is refused, because the provider has no channel to receive them and dropping them silently would change the project's behavior | delegated under the same no-explicit-settings condition; refused otherwise |
| `cache` | native: headers plus origin memory cache | native | refused |

"Compiled" means the effective configuration for every route is validated at
build time and carried in the Worker artifact; the Worker has no filesystem and
no Node imports, so only modules free of both qualify. The Worker's client
identity is the platform's `cf-connecting-ip`; the serverless adapters use the
platform-set source address (`sourceIp` on Lambda, Vercel's own
`X-Vercel-Forwarded-For` — Vercel's documented copy of the client IP that
survives even when a project puts another proxy in front of Vercel, unlike
plain `X-Forwarded-For`, which that outer proxy can overwrite before Vercel
ever sees it). None of these read a forwarded header a client could have set.

The cross-request state a policy keeps (throttle counters, the origin cache) is
per runtime instance on every target, never shared between replicas or
serverless instances. Given identical request bytes and project, every target
answers with the same status and headers; only that state may differ.

## Merge semantics

The effective configuration for a route is built from four layers, each
merged over the one below:

1. the project `profile` (built-in or custom),
2. the project `policies` keys,
3. the route `profile`, if the route names one,
4. the route `policies` keys.

Within a layer, `false` removes a policy declared below it; an object merges
shallowly over what is there, so a route can tighten one number without
restating the rest. Only top-level keys of each policy merge: a route that
writes `agents: { deny: [crawlers] }` replaces the whole `deny` array, not one
entry of it.

```yaml
policies:
  profile: hardened
  throttle: { quota: 5 }          # hardened's window and partition remain
profiles:
  mine:
    security: { headers: oshp-no-csp }
routes:
  /feed:
    policies:
      profile: mine                # merges over the project layer, not instead of it
      throttle: false              # removed for this route only
      cache: { strategy: swr, maxAge: 3 }
```

Here `/feed` ends up with `security: { headers: oshp-no-csp }`, the
`hardened` agents and compression entries, no throttle, and the route's cache
entry. Any other route gets `hardened` with `throttle.quota` at 5.

`profiles` is a top-level map of reusable policy sets, each a `policies`
object without a `profile` key. A custom profile whose name matches a built-in
shadows it, so a project can redefine `hardened` and every reference to it
resolves to the project's version. Naming an unknown profile fails validation.

When any policy is declared anywhere in the project, every route is compiled
against the effective table; a route with nothing effective simply has empty
chains. When none is declared, no policy code runs.

## Further pages

| Page | Sections |
|---|---|
| [The built-in `hardened` profile and hardening guidance](policies/hardened.md) | The built-in `hardened` profile; Hardened configuration guidance |
| [The policy contract and your own patterns](policies/contract.md) | The policy contract in TypeScript; Supplying your own patterns |
| [Client identity, inventory and logging](policies/operations.md) | Client identity and `--trusted-proxies`; What `routes` and `audit` report; Logging |
| [Interoperability between policies](policies/interoperability.md) | Interoperability |
