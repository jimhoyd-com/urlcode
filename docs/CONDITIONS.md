# Conditional routing

Conditions are exact string comparisons over a bounded, portable input subset.
A route's `match` is a conjunction: every declared query/header/cookie, host and
method must match. A mismatch returns 404 without trying a less-specific path.
Path precedence is unchanged; matching conditions is not authorization.

```yaml
version: "1"
routes:
  /beta:
    match:
      headers: {x-beta-user: "true"}
    redirect: {url: https://beta.example.com}
  /campaign:
    conditional:
      cases:
        - match: {query: {source: newsletter}}
          redirect: {url: https://example.com/newsletter}
        - match: {query: {source: partner}}
          redirect: {url: https://example.com/partner}
      fallback:
        respond: {text: "Choose a campaign"}
```

Use `conditional.cases` for multiple definitions at one path; duplicate YAML keys
remain errors. Each case has a nonempty match and exactly one redirect/respond
handler. The optional fallback has one of those handlers and no condition. No
nested cases or case-local middleware/bindings/policies. Shared parameters,
methods, response headers, middleware and policies belong to the route. A missing
fallback returns 404. Up to 16 cases per route; pairs must be provably disjoint:
at least one shared field must require different values. Ambiguous cases fail
activation instead of relying on order. Cases are considered before fallback.

Conditions admit query/header/cookie maps with 1–16 entries, names up to 128
characters and values up to 1,024. Header names normalize to lowercase; duplicate
case-insensitive names fail validation. Query strings are decoded once, have no
type conversion or default substitution, and duplicate examined values return
400. Examined duplicate header/cookie values return 400 when transport counts
are available. Cookies compare unquoted wire values, without percent decoding;
the Cookie header is bounded to 8 KiB. Missing values do not match empty strings.
Standard authentication and transport headers cannot be predicates. There are no regex, numeric,
geography, device, wildcard or arbitrary-code predicates.

`match.host` compares the canonical authority of the **operator-configured public
origin**, not client Host or forwarded headers. Configure the origin to use host
conditions; one runtime does not infer multiple trusted public hosts. Methods are
uppercase existing HTTP method tokens. A top-level match is checked before the
route's method/handler execution; it may mask a method rejection with 404.

Conditional results force `Cache-Control: no-store`; provider-specific CDN and
surrogate cache directives cannot enable caching. Cache policies must be
disabled or use no-store. This prevents one header/cookie branch from populating
a shared origin or downstream cache. Route conditions and case coverage require
explicit request fixtures; generated probes do not imply branch coverage.

Self-hosted, AWS and Vercel execute the shared matcher. Node-adapter tests are
local, not provider-deployment evidence; provider header coalescing limits still
apply. Cloudflare refuses conditions until an artifact lowering and conformance
tests exist. `urlcode capabilities` reports these distinctions. Operator plugins
remain trusted host code; conditions add no guest authority.

The [executable conditions project](../examples/conditions) includes explicit
branch, fallback, duplicate and trusted-origin requests. Run:

```sh
urlcode test --project examples/conditions --origin https://conditions.example.test
```

Host names are canonical ASCII authorities (maximum 255 characters), with an
optional nondefault port. IPv6 literals and IDN Unicode host spellings are not
part of this initial condition syntax. Raw query comparisons remain separate
from typed route inputs: a parameter default does not make an absent condition
match, while all shared parameter validation still runs before a case handler.
