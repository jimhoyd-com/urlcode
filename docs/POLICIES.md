# Policies

Policies are host-enforced behavior declared in YAML around a route: a
per-client request budget, a User-Agent deny list, a security-header profile,
content-coding negotiation and an HTTP caching strategy. They run in the host
process, outside the sandbox, so they can see the client address, keep counters
across requests and touch the transport, which route middleware by design
cannot ([middleware](MIDDLEWARE.md), [function security](FUNCTION-SECURITY.md)).

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

The design and the reasoning behind each choice are in the
[extensions spike](SPIKE-EXTENSIONS.md). Operators who need behavior the
declarative block cannot express pass host [plugins](PLUGINS.md) in code; plugins
are never named in YAML.

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
adjusts them for one route. Both accept the same keys: `profile` plus one entry
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
refuse functions and middleware; nothing degrades silently. One exception is
stated rather than hidden: a policy the platform itself already provides is
**delegated**, meaning accepted and dropped, and reported as such in the
inventory, so one YAML can serve a Node host and a serverless host without
edits. The self-hosted
message reads `/path declares policies.throttle, which the vercel target
cannot enforce`; the Cloudflare build reports
`/path: policies.throttle cannot be compiled for this target`.

| Policy | Self-hosted (`node`) | Vercel / AWS | Cloudflare build |
|---|---|---|---|
| `agents` | native | native | compiled into the artifact |
| `security` | native | native | compiled into the artifact |
| `throttle` | native, in-process counters | native only with `partition: route`; `client` and `client-route` refused because a client fans across instances and the budget would silently be quota × instances | refused |
| `compression` | native | delegated: the provider compresses | delegated |
| `cache` | native: headers plus origin memory cache | native | refused |

"Compiled" means the effective configuration for every route is validated at
build time and carried in the Worker artifact; the Worker has no filesystem and
no Node imports, so only modules free of both qualify. The Worker's client
identity is the platform's `cf-connecting-ip`; the serverless adapters use the
platform-set source address (`sourceIp` on Lambda, the leftmost
`X-Forwarded-For` entry the platform writes on Vercel). None of these read a
forwarded header a client could have set.

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

## The built-in `hardened` profile

`policies.profile: hardened` expands to the following and nothing else, so it
can be read in one place and overridden key by key. This is
`builtinProfiles.hardened` in `src/policies.js`:

```yaml
policies:
  security: { headers: oshp }
  agents: { deny: [ai-crawlers], status: 403 }
  throttle: { quota: 120, window: 60, partition: client, status: 429 }
  compression: { encodings: [br, gzip], minBytes: 1024 }
  cache: { strategy: revalidate }
```

The numbers are starting points chosen to be safe for a single small instance;
they are not tuned for any workload and not a security assessment of your
deployment. Note what the profile implies per target: on Vercel and AWS it
refuses activation as written, because `throttle.partition: client` is
refused there; set `throttle: false` (or `partition: route`) at the project
or route level. `compression` is delegated to the platform. On Cloudflare
only `agents` and `security` survive and `compression` is delegated, so the
profile must also drop `throttle` and `cache` there.
There is no `strict` profile: anything stricter is a per-project decision.

## Supplying your own patterns

The runtime ships mechanisms and one named profile, not an opinion about who
should be blocked. Ways to express your own:

- **Custom profiles.** Define any number under `profiles` and select one per
  project or per route. Profiles are plain data and travel with the YAML.
- **Per-route overrides.** Any key can be tightened, replaced or set to
  `false` on a route.
- **Own agent lists.** `agents.deny` and `agents.allow` accept bundled list
  names and project-relative `.json` files in the same schema, so a list you
  do not want to redistribute stays yours. `denyPatterns`/`allowPatterns`
  take a bounded, linear-time pattern subset. See [agents](policies/agents.md).
- **Header by header.** `security.set` adds or overrides a header and wins over
  the profile, YAML `response.headers` and handler output; `security.unset`
  drops one the profile would emit. Headers the runtime or a handler owns
  (`content-type`, `cache-control`, `set-cookie`, `etag`, `location`, and the
  rest listed in `src/policies/security.js`) cannot be `set`.
  See [security](policies/security.md).
- **Explicit cache fields.** A strategy sets defaults; `maxAge`,
  `staleWhileRevalidate`, `staleIfError`, `cdnMaxAge`, `originTtl`, `vary`,
  `statuses`, `maxBytes` and `maxEntries` override what it implies.
  See [cache](policies/cache.md).
- **Plugins.** Verified-bot checks, shared-store throttling, purge endpoints
  and anything vendor-specific are host code an operator passes in;
  see [plugins](PLUGINS.md).

## Client identity and `--trusted-proxies`

`throttle` partitions by `client`. On the self-hosted server the client is the
socket peer unless `urlcode serve --trusted-proxies 10.0.0.0/8,fd00::/8`
names the addresses allowed to speak for a client. Then `X-Forwarded-For` is
walked from the right, skipping trusted hops, and the first untrusted address is
the client; a chain made only of trusted proxies yields its leftmost entry, and
a malformed entry stops the walk at the peer. A forwarded header from a peer
outside the trusted set is ignored, as is a request carrying more than one
`X-Forwarded-For` field. Ranges are IPv4 or IPv6 CIDRs (at most 256);
IPv4-mapped IPv6 peers match IPv4 ranges. `startServer({ trustedProxies })`
takes the same list.

A request whose client cannot be resolved (an adapter without a peer, an
embedding caller that passes none) shares one bucket rather than being exempt,
so a misconfigured proxy fails closed. The throttle summary in
`testPlan().policies` records this as `unresolvedClient: "shared key"`. The runtime still
never trusts forwarded headers for its public origin; set `--origin`
explicitly, as [resilience](RESILIENCE.md) already requires.

## What `routes` and `audit` report

`urlcode routes` prints the inventory with a `policies` array per route naming
the policies effective on it (`testPlan().inventory[].policies`). The
embedding API and a plugin's `onActivate` see `testPlan().policies`, a map from
route pattern to each policy's summary with its `target` value (`native` or
`compiled`), the per-route capability table the portability rule calls for.
`urlcode audit` runs the same plan; its summary counts routes and checks and
does not yet print the policy table. `urlcode doctor` lists the policy names
this runtime knows.

## Logging

Policies log through the runtime's request log with one-line events:
`{ event: 'throttle', route, outcome: 'exceeded' | 'allowed', remaining }`,
`{ event: 'agents', route, list, outcome: 'denied' | 'reported' }` and the
cache events described on the [cache page](policies/cache.md). Events name the
configured route pattern and the list or strategy, never a client address, a
User-Agent string or request text. A logging failure never changes a response.

## Hardened configuration guidance

Advice, not defaults, condensed from the spike's section 6.

1. **Network and edge first.** Volumetric protection, TLS termination and
   per-client connection budgets stay with the provider or the reverse proxy.
   Runtime policies are a second layer, never the first.
2. **Ingress to origin.** Bind privately; allow only the proxy's addresses;
   pass `--trusted-proxies` so `client` partitioning sees the real peer.
3. **Request policies.** Agents before throttle: denials are cheaper than
   counting. Start throttle in `mode: report` for a release to see real
   quotas in the headers and logs, then switch to `enforce`.
4. **Allow before deny.** Keep an explicit allow for the crawlers you need
   indexed; a broad deny without one is the common self-inflicted outage.
5. **Route contract.** Exact methods, `request.body` limits and `expires` on
   campaign routes still do most of the work.
6. **Response policies.** Security headers on every route; compression only
   on listed types and never on secret-bearing responses (the BREACH class of
   attack, which is why compression is skipped where a route declares secrets
   unless `allowWithSecrets` says otherwise); caching only with a strategy
   whose semantics you can state, `immutable` only on content-hashed paths,
   `no-store` everywhere else.
7. **Lists as pinned data.** Bundled agent lists ship with the release, so a
   rollback rolls the list back too.
8. **Read the table.** Check `urlcode routes` on each target you deploy to;
   the same YAML is refused where it cannot be enforced, and that is the
   point.

## Interoperability

To be completed after the interoperability review. The rules below are the
ones the current code enforces:

- `throttle` with `partition: client` or `client-route` is refused on Vercel
  and AWS; `partition: route` is accepted there. Every `throttle` is refused
  by the Cloudflare build.
- `compression` is delegated on Vercel, AWS and Cloudflare: accepted, dropped and reported as `delegated`.
- `cache` is refused by the Cloudflare build.
- A plugin `onRequest` short-circuit skips every policy request hook: the
  request is not matched against agent lists, not counted by throttle and
  not looked up in the cache.
- A result produced by a request-phase policy skips only that policy's own
  response hook: a cache hit is not stored again but still gets throttle
  headers; a throttle refusal is not stamped twice. A plugin short-circuit
  skips the cache store and the throttle headers. Security headers and
  compression apply in every case.
- A denied agent does not count against a throttle budget. A refused request
  is not counted either, so a retry loop cannot keep its own window closed.
- YAML `response.headers`, handler headers and asset headers beat security
  profile headers; `security.set` beats all of them.
- `Strict-Transport-Security` is emitted only when the origin is `https`
  (`--origin` or the adapter's resolved origin).
- Throttle counters are one table per runtime shared by every route with the
  same window; the largest declared `maxKeys` bounds it.
- The `405` for an undeclared method and thrown runtime errors receive no
  policy response headers and no plugin `onResponse` call.
