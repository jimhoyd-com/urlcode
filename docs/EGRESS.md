# Bounded proxy and webhook transport

Outbound requests use a host-owned HTTPS transport. Guests do not receive a fetch
API. Project declarations express behavior; an external operator policy, pinned
to the complete project revision, grants exact HTTPS origins separately to proxy
and signal operations. A configured destination never grants its own authority.
Binding injection uses existing explicitly granted secrets, resolved before the
host transport receives a literal header value. Never log those values.

The transport resolves the destination for each request, refuses any DNS response
containing a nonpublic address, and pins its connection lookup to one validated
answer. HTTPS certificate and hostname verification remain enabled. There is no
connection pool, fallback address, redirect following, or automatic retry. Private,
loopback, link-local, documentation, multicast, IPv4-mapped IPv6 and transition
addresses are refused. IPv6 filtering is deliberately conservative: 2001::/16,
2002::/16 and 3fff::/16 are refused along with addresses outside ordinary global
unicast. Network-level egress controls remain useful defense in depth.

Default limits per client are 16 simultaneous requests, five seconds including
DNS, 1 MiB request and response bodies and 16 KiB headers. Excess concurrency is
refused immediately. Requests use bounded buffering rather than streaming. Abort
and shutdown destroy active HTTP requests; unresolved system DNS operations may
finish in the background but cannot open a socket after cancellation. Those DNS
operations retain a separate concurrency slot until they settle, so repeatedly
timing out DNS cannot create an unbounded underlying lookup backlog. A shared
64-operation DNS cap also spans all client instances and runtime reloads in the
host Node isolate; closing a client does not release an unresolved DNS slot. Closing a
client refuses future requests and drains its bounded outstanding promises.
Errors carry only a fixed category, never a destination, request, header or secret.

Proxy destinations have a literal HTTPS authority. Path placeholders are encoded
as individual components; dot-segment values are refused. Query names and incoming
and outgoing headers require explicit selection. Host, framing, hop-by-hop and
proxy-authorization headers cannot be supplied. Ambient authorization, cookies,
forwarding metadata (the entire `x-forwarded-*` family) and Set-Cookie cannot be selected. Explicit host-resolved
Authorization injection is supported. Set-Cookie forwarding is deliberately
unsupported because multiple cookie fields cannot safely be represented by the
portable scalar header contract. Upstream redirects are returned as responses;
Location is forwarded only if explicitly selected and is never fetched. Headers
nominated by an incoming or upstream Connection field are removed even if selected.
Header names are normalized to lowercase; array-valued upstream fields are omitted.
An encoded request body requires explicitly selecting its Content-Encoding
header; literal header injection cannot change or replace that coding. Bodies
remain raw bytes, including content encoding; select Content-Encoding when
forwarding compressed responses. No transparent decompression occurs.

Webhook signals are best effort. The broker schedules work after the caller's
synchronous emit operation, with eight concurrent deliveries by default and no
queue. Saturation and closed brokers drop new events. Each event contains only
version, declared route pattern, status and method: never the actual request URL,
parameters, body, client identity, incoming headers or bindings. The webhook
receives a POST with JSON. Only 2xx responses count as delivered; all other status
codes and transport failures count as failed. Delivery order is unspecified,
there are no retries or durability guarantees, and shutdown aborts outstanding
work and awaits settlement. Counter snapshots report accepted, delivered, failed
and dropped events without including destination data. Applications must not use
these signals for guaranteed billing, audit retention or job execution.

The transport is a new security-sensitive host bridge. Unit tests and CI are not
an independent assessment or proof of hostile multi-tenant readiness. Public
provider network deployments require separate operator-owned fixtures and evidence.

## Project declarations and external grants

```yaml
version: "1"
routes:
  /items/{id}:
    proxy:
      url: https://api.example.com/items/{id}
      query: [page]
      requestHeaders: [accept]
      responseHeaders: [content-type, content-encoding]
      headers:
        authorization: {secret: API_TOKEN}
    parameters:
      - {name: id, in: path, required: true, schema: {type: string}}
    secrets:
      API_TOKEN: {secret: UPSTREAM_AUTHORIZATION}
    signals:
      - url: https://hooks.example.com/events
```

An injected secret is the complete header value (for example an operator-provided
Bearer value); interpolation and ambient credentials are not supported. Each
proxy placeholder must name a declared string path parameter. Proxy routes refuse
middleware in this initial implementation: middleware cannot safely authorize an
already materialized upstream request. Use host request policies before egress.
Proxy routes require cache disabled or `no-store`; explicit cache declarations
cannot override this. Responses always remove CDN cache directives and receive
`Cache-Control: no-store`. Compressed upstream bytes are refused if their
Content-Encoding field was not explicitly selected; it cannot be overridden by
route response headers.

The external version-1 policy has the existing `projectSha256` and route grants:

```json
{"version":1,"projectSha256":"<reviewed revision hash>","routes":{"/items/{id}":{"secrets":["UPSTREAM_AUTHORIZATION"],"egress":{"proxy":["https://api.example.com"],"signals":["https://hooks.example.com"]}}}}
```

Use `permissions` to generate requested grants for review. Exact origin strings
omit a trailing slash and the default 443 port. Nondefault ports are explicit.
Proxy and signal purposes are independent even when they share an origin. Every
route's grant is checked against the current revision before credentials, assets,
workers or network clients are activated. Each runtime shares one bounded proxy
client and one bounded signal client, with at most 64 origins per purpose.

Signals emit when route execution and response policies produce a result,
including guest middleware responses and returned error status codes. Thrown
handler errors and host request-policy/plugin short circuits (including cache
hits) do not emit. HEAD requests and generated readiness probes do not emit.
The response never waits for webhook delivery. Counter events contain only
accepted/delivered/failed/dropped outcomes and counts and are exposed through
runtime metrics and the Prometheus `signals_total` series. A closed runtime stops
new requests, aborts egress and drains bounded pending work. Client disconnects
are not currently propagated into the runtime transport; the five-second deadline
still applies. All non-self-hosted targets currently refuse proxy and signals.
See the [executable example](../examples/egress/README.md).

Revision hashes also include declared project policies, profiles and site
configuration. Changing an inherited pre-egress restriction invalidates grants
just like changing a route or function source. Projects with these declarations
must regenerate and review their operator policy after upgrading to this hash
coverage; an old grant is intentionally refused rather than silently retaining
network authority under changed behavior.
