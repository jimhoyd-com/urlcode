# Policies: Client identity, inventory and logging

Part of [policies](../POLICIES.md), which holds the shared rules and the per-target table.

## Client identity and `--trusted-proxies`

`throttle` partitions by `client`. On the self-hosted server the client is the
socket peer unless `urlcode serve --trusted-proxies 10.0.0.0/8,fd00::/8`
names the addresses allowed to speak for a client. Then `X-Forwarded-For` is
walked from the right, skipping trusted hops, and the first untrusted address is
the client; a chain made only of trusted proxies yields its leftmost entry, and
a malformed entry is skipped. A forwarded header from a peer
outside the trusted set is ignored, as is a request carrying more than one
`X-Forwarded-For` field. Ranges are IPv4 or IPv6 CIDRs (at most 256);
IPv4-mapped IPv6 peers match IPv4 ranges. `startServer({ trustedProxies })`
takes the same list.

A request whose client cannot be resolved (an adapter without a peer, an
embedding caller that passes none) shares one bucket rather than being exempt,
so a misconfigured proxy fails closed. The throttle summary in
`testPlan().policies` records this as `unresolvedClient: "shared key"`. The runtime still
never trusts forwarded headers for its public origin; set `--origin`
explicitly, as [resilience](../RESILIENCE.md) already requires.

## What `routes` and `audit` report

`urlcode routes` prints the inventory with a `policies` array per route naming
the policies effective on it (`testPlan().inventory[].policies`) and the full
`policies` map. The embedding API and a plugin's `onActivate` see
`testPlan().policies`, a map from route pattern to each policy's summary with
its `target` value (`native`, `compiled` or `delegated`), the per-route
capability table the portability rule calls for. `urlcode audit` prints the
same table under `policies` and, with `--compliance`, checks the declared
configuration against standards-referenced rules; see
[compliance](../COMPLIANCE.md). `urlcode doctor` lists the policy names this
runtime knows.

## Logging

Policies log through the runtime's request log with one-line events:
`{ event: 'throttle', route, outcome: 'exceeded' | 'allowed', remaining }`,
`{ event: 'agents', route, list, outcome: 'denied' | 'reported' }` and the
cache events described on the [cache page](cache.md). Events name the
configured route pattern and the list or strategy, never a client address, a
User-Agent string or request text. A logging failure never changes a response.
