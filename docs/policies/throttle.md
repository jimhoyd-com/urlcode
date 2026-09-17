# Throttle policy

`policies.throttle` gives each client, route or client-route pair a request
budget: `quota` requests per `window` seconds. The runtime counts requests in
a sliding window (two fixed windows blended by elapsed time, the usual middle
ground between a fixed window that bursts at its edges and a token bucket
that is hard to explain in a header) and refuses the request that would
exceed the budget before it reads a body or reaches the sandbox. Refused
requests are not counted, so a retrying client cannot keep its own window
from clearing.

```yaml
version: "1"
policies:
  throttle:
    quota: 120          # requests
    window: 60          # seconds
    partition: client   # client | route | client-route  (default client)
    status: 429         # 4xx or 5xx answered on refusal (default 429)
    mode: enforce       # enforce | report               (default enforce)
    maxKeys: 100000     # bounded counter table, LRU eviction

routes:
  /api/lookup/{id}:
    function: { source: functions/lookup.mjs }
    policies:
      throttle: { quota: 10, window: 60 }   # tighter budget with its own counter
```

A route override that restates `quota` and `window` gets its own counters; a
route that inherits the project budget shares the client's counter with every
other route on the same budget. `throttle: false` on a route turns it off there.

## Standards

- [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585) status 429 by default;
  any 4xx or 5xx `status` is accepted and the body is a short plain-text line.
- [RFC 9110 `Retry-After`](https://www.rfc-editor.org/rfc/rfc9110#field.retry-after),
  integer seconds, on every refusal.
- [IETF httpapi RateLimit header fields](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/)
  on every response, allowed or refused, in structured-field syntax:
  `RateLimit-Policy: "default";q=<quota>;w=<window>` and
  `RateLimit: "default";r=<remaining>;t=<seconds until reset>`.

A refusal also carries `content-type: text/plain; charset=utf-8` and
`cache-control: no-store` so no intermediary keeps it.

## Targets

| Target | `partition: route` | `client` / `client-route` |
|---|---|---|
| node (`urlcode serve`) | native | native |
| vercel | native, per instance | refused at activation |
| aws | native, per instance | refused at activation |
| cloudflare | refused | refused |

Counters live in the process. On serverless targets a route counter is at
least an honest per-instance ceiling, while a client counter would silently
become `quota × instances`, so those partitions are refused with the route
named. The Cloudflare build refuses the policy; map the same `quota` and
`window` to a provider rate rule instead.

## Client identity

`client` is the socket peer address. Behind a load balancer every request
would share one address, so name the proxies allowed to speak for a client:
`urlcode serve --trusted-proxies 10.0.0.0/8,::1`. Only then is
`X-Forwarded-For` consulted, walking from the right past trusted hops. When no
client can be resolved (a caller that passed none, an adapter without a peer)
requests share a single bucket rather than escaping the budget; the policy
inventory (`urlcode audit`, `testPlan().policies`) reports this as
`unresolvedClient: "shared key"`.

## Report before enforce

Run a release with `mode: report`: headers are emitted and every request logs
`{ event: "throttle", route, outcome: "allowed" | "exceeded", remaining }`
(never the client address), but nothing is refused. Read the `exceeded` lines
against real traffic, set `quota` from what you saw, then switch to `enforce`.
In enforce mode only `exceeded` is logged.

## What it does not do

- No shared state across processes or instances. Two `urlcode serve`
  processes behind one balancer each enforce the full budget. A host plugin
  (`onRequest` returning a refusal, backed by whatever store you run) is the
  place for a cluster-wide budget; see the plugin contract in
  `docs/SPIKE-EXTENSIONS.md`.
- No per-user or per-token keys. The partition is address or route; a token
  bucket per API key is again a plugin.
- Counters do not survive a reload: a new snapshot starts empty.
- `maxKeys` bounds memory with least-recently-used eviction; an evicted key
  starts fresh, so a table sized below the number of concurrent clients
  under-counts rather than blocks.

## Interaction with other policies

Request order is agents, throttle, cache. A denied agent never touches a
counter; a throttled request never reaches the cache lookup or the handler.
Security headers and compression still apply to a refusal. A cache hit is
answered before the throttle's response hook runs, so cached responses do
not carry `RateLimit` headers even though the request was counted.
