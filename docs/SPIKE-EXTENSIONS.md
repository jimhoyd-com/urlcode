# Spike: plugins, adapters and optional runtime features

> Status update: the host hook seam, the plugin API and the five policies of
> section 5 are implemented; [policies](POLICIES.md) and [plugins](PLUGINS.md)
> describe the shipped behavior, which takes precedence where this text differs.

Status: exploratory. Nothing here is committed scope; it records what the
runtime has today, how comparable tools expose the same needs, which gaps
matter for real deployments, and a proposed shape for closing them without
breaking the [project boundary](PROJECT-DIRECTION.md). The
[roadmap](../ROADMAP.md) owns sequence; the [specification](SPECIFICATION.md)
owns what is implemented.

Every feature below is **optional and off by default**. A `version: "1"`
project with none of them keeps its current behavior byte for byte.

## 1. What exists today

### Extension surfaces

| Surface | Where | Who can use it | Runs where |
|---|---|---|---|
| Route middleware | `routes.<path>.middleware[]` | Project author | QuickJS/WASM guest, one chain per request, 16 max, route-local only |
| Functions | `routes.<path>.function` | Project author | Same guest, one per route |
| Provider adapters | `@jimhoyd/urlcode/vercel`, `@jimhoyd/urlcode/aws`, `@jimhoyd/urlcode/cloudflare` | Operator | Host process; wrap `runtime.handle()` |
| Build helpers | `@jimhoyd/urlcode/prerender` | Operator/build | Host process, build time only |
| Embedding API | `createRuntime`, `startServer`, `openLinkStore`, `startLinkApi` | Operator application | Host process |
| Operator policy | `URLCODE_POLICY` / policy file | Operator | Host, revision-pinned grants |

Two facts shape every proposal in this spike:

1. **There is no trusted, host-side, project-declared hook.** The only
   project-level code path is guest middleware, which cannot see the socket,
   client address, other requests or a clock beyond `Date.now()`. Anything that
   needs cross-request state (rate counters, caches) or raw transport
   (compression, connection budgets) cannot be middleware under the current
   isolation model, and must not become one.
2. **There is no global middleware.** Every wrap is per route. Cross-cutting
   behavior such as "block these agents everywhere" has to be repeated on
   every route, and cannot cover native routes without dragging them into the
   sandbox and losing their fast path.

### Request pipeline (self-hosted server)

```
socket limits (1024 conns, 15 s idle, 1000 req/socket)
  → in-flight admission (64 app, 16 health)
    → body read (bounded)
      → runtime.handle(): match → enabled/expires → methods → request.body policy
        → [guest chain: middleware… → handler]  or  native handler
          → response.headers overrides → writeResponse
```

Adapters call `handle()` directly and skip the socket/admission stages,
delegating them to the provider.

### Already answered, in the operator's stack

The docs are consistent that these belong at ingress, not in route YAML:
rate limiting, WAF, TLS, DDoS mitigation, forwarded-header trust
([resilience](RESILIENCE.md), [capacity](CAPACITY.md)). Compression, CORS,
content negotiation and streaming are listed as explicitly outside the
[HTTP contract](HTTP.md). Caching is declarative and limited to a fixed
`cacheControl` vocabulary on asset handlers ([assets](ASSETS.md)).

## 2. How comparable tools do it

| Concern | Express / Koa | Fastify | Hono | Caddy | NGINX | Cloudflare / Vercel / Netlify | URLCode today |
|---|---|---|---|---|---|---|---|
| Plugin model | `app.use(fn)` global + router-local | `fastify.register(plugin, opts)` with encapsulation, `fastify-plugin` to break out; typed hooks (`onRequest`, `preHandler`, `onSend`…) | `app.use(path?, mw)`; first-party `hono/*` middleware | Modules compiled in; JSON/Caddyfile directives | Compiled modules; directives per `location` | Config file + edge middleware (`middleware.ts`, `_middleware`) | Route-local guest middleware only |
| Throttle | `express-rate-limit` (memory/Redis stores) | `@fastify/rate-limit` | `hono-rate-limiter` | `rate_limit` (plugin) | `limit_req`, `limit_conn` | Provider WAF/rate rules; Vercel Firewall; Netlify Rate Limiting | Global in-flight cap only; no per-client budget |
| Block bots / UA | `express-useragent`, `isbot` in middleware | `isbot` in hook | `isbot` in middleware | Request matchers on `header` | `map $http_user_agent`, `if`, `deny` | Bot Fight Mode, Super Bot Fight, WAF managed rules | None; would need per-route guest middleware, cannot cover native routes |
| Injection / hardening | `helmet`, `express-validator` | `@fastify/helmet`, schema validation built-in | `secureHeaders`, `validator` | Built-in header directives | Header directives | Managed WAF rulesets | Header injection prevented at runtime; body JSON syntax check; **no** security-header preset, no schema body validation |
| Compression | `compression` | `@fastify/compress` | `hono/compress` | `encode gzip zstd` | `gzip on; brotli` | Automatic at edge | None; identity only |
| Caching | `apicache`, CDN | `@fastify/caching` | `hono/cache` | `cache` (plugin) | `proxy_cache` | Edge cache + `Cache-Control`, ISR | Asset `cacheControl` vocabulary; no response cache |
| Templates | `res.render()`, view engines | `@fastify/view` | `hono/jsx`, `html` helper | `templates` directive | SSI | Framework-owned | None at request time; build-time [prerender](PRERENDER.md) only |
| Adapters | `serverless-http`, `@vendia`, `@hono/node-server` | `@fastify/aws-lambda` | First-party adapters for every runtime | n/a | n/a | n/a | Vercel, AWS, Cloudflare; native handlers only |

Three patterns recur and are worth borrowing:

- **Fastify's encapsulated `register` with typed lifecycle hooks.** Plugins
  declare which phase they attach to. That gives a static, inspectable plugin
  graph, which is exactly the property URLCode wants for a portable format.
- **Hono's "one first-party set of small middleware, each optional".** Small,
  named, zero-config-by-default modules, every one of which is also expressible
  on any adapter. That matches the "declarative first, code only when needed"
  contract.
- **Caddy/NGINX declarative directives.** Behavior is data, not code, and can
  be validated and exported. URLCode YAML is already this. The gap is that the
  vocabulary stops at routes and headers.

## 3. Gap list

Ranked by how often a self-hosted operator hits it before the first deploy.

| # | Gap | Evidence | Severity |
|---|---|---|---|
| G1 | No cross-cutting (global) behavior | Middleware is route-local; every operator concern is copy-pasted per route or done at ingress | High |
| G2 | No per-client throttle | Only the 64/16 in-flight caps; shortener demo built its own | High |
| G3 | No bot / user-agent policy | Retrospectives, resilience doc: "filter upstream" | High for short-link use cases (crawlers hitting redirects) |
| G4 | No security-header preset | `helmet`-equivalent is the first thing every framework user adds | Medium |
| G5 | No compression | Assets and JSON go uncompressed unless a proxy handles it | Medium |
| G6 | No response cache / stale-while-revalidate | Functions are `no-store`; a hot function re-runs the sandbox per hit | Medium |
| G7 | No request-time template layer | Native bodies are opaque by design; prerender covers static sites but not dynamic pages | Medium |
| G8 | No host-side plugin contract | Adapters and `startServer` are the only host extension points and are undocumented as such | Medium |
| G9 | Adapters refuse functions/middleware/links | Documented and deliberate, but it means any feature built as guest middleware is also refused on serverless | Design constraint |
| G10 | No JSON Schema body validation | `request.body.format: json` checks syntax only | Low |
| G11 | No CORS preflight helper | Documented gap | Low |
| G12 | No SPA fallback for client-routed apps | [Assets](ASSETS.md) rules it out beside directory listing and trailing-slash redirects; a host plugin cannot supply it either, because an unmatched path throws 404 before the request object or any plugin hook exists | Low |

## 4. Design constraints these must respect

From [AGENTS.md](../AGENTS.md), [project direction](PROJECT-DIRECTION.md)
and [function security](FUNCTION-SECURITY.md):

- Route YAML describes **behavior**, not infrastructure. A throttle budget is
  behavior ("this route allows 10 requests per minute per client"); a Redis
  URL is infrastructure and stays in operator config.
- Guest code stays untrusted and capability-free. None of the features below
  expose new host APIs to the sandbox.
- A project must run on a laptop, a container and an adapter. Every feature
  needs a documented answer for each target: native, refused at activation,
  or delegated to the provider with the same declared semantics.
- Unknown YAML fields fail. New vocabulary must land in the schema with
  generated reference docs and executable examples.

## 5. Proposal: a `policies` block plus host-side plugins

Two additions, both optional. Declarative policies cover the common cases
without code; a host plugin contract covers the rest for operators who embed
the runtime.

The runtime stays generic: it ships mechanisms and named profiles, never an
opinion about who should be blocked or which vendor should sit in front of
the origin. Recommendations for a hardened deployment are collected in
section 6 as guidance an operator applies, not as defaults the runtime
imposes.

### 5.1 Portability rule

A project file is portable when a second person can run it on a different
host and get the same declared behavior or an explicit refusal. Every policy
therefore follows four rules:

1. **Vocabulary comes from a published standard** wherever one exists, so
   the values are already documented outside this project and can be
   translated to any proxy, CDN or framework.
2. **No operator identity in YAML.** Trusted proxy ranges, storage URLs,
   list-refresh credentials and vendor rule identifiers live in operator
   configuration (`urlcode serve` flags, environment, policy file), never in
   the project.
3. **Enforce or refuse, never degrade silently.** Each policy has a
   per-target row (self-hosted, Vercel/AWS, Cloudflare). A target that cannot
   enforce a policy refuses activation naming the route and policy, exactly as
   adapters already refuse functions. `urlcode audit` reports the table.
4. **Deterministic on identical input.** Given the same request bytes and the
   same project, every target answers the same status and headers; only
   cross-request state (throttle counters, cache hits) may differ, and that
   difference is documented.

### 5.2 Declarative `policies`

```yaml
version: "1"
policies:                      # project defaults; each key optional
  profile: hardened            # named preset, see 6.1; explicit keys override
  throttle:
    quota: 60                  # RateLimit-Policy: "default";q=60;w=60
    window: 60
    partition: client          # client | route | client-route
    status: 429
  agents:
    deny: [ai-crawlers]        # named list bundled with the runtime, see 5.3
    denyPatterns: ["^curl/"]   # anchored, bounded, linear-time subset
    allowPatterns: ["^Mozilla/5\\.0 \\(compatible; Googlebot"]
    status: 403
  security:
    headers: oshp              # oshp | oshp-no-csp | off
  compression:
    encodings: [br, gzip]      # RFC 9110 content codings, preference order
    minBytes: 1024
    types: [text/*, application/json, application/javascript, image/svg+xml]
  cache:
    strategy: swr              # see 5.4 catalogue
    maxAge: 30
    staleWhileRevalidate: 300
    vary: [accept-language]

routes:
  /api/lookup/{id}:
    function: { source: functions/lookup.mjs }
    policies:
      throttle: { quota: 10, window: 60 }
      cache: false
```

| Policy | Standard it is expressed in | Self-hosted | Vercel / AWS | Cloudflare build |
|---|---|---|---|---|
| throttle | RFC 6585 (429), RFC 9110 `Retry-After`, IETF httpapi `RateLimit`/`RateLimit-Policy` draft fields | native, in-process | refused unless `partition: route` (no shared state) | refused; guide maps quota/window to a provider rate rule |
| agents | RFC 9110 `User-Agent` product tokens; RFC 9309 for the companion `robots.txt`; bot-auth drafts for verified allow | native | native | compiled |
| security | OWASP Secure Headers Project values; CSP Level 3; RFC 6797 HSTS | native | native | compiled |
| compression | RFC 9110 `Accept-Encoding`/`Content-Encoding`; RFC 1952 gzip, RFC 7932 brotli, RFC 8878 zstd | native, assets precompressed at snapshot | refused: provider does it | refused: provider does it |
| cache | RFC 9111; RFC 5861 `stale-while-revalidate`/`stale-if-error`; RFC 8246 `immutable`; RFC 9213 `CDN-Cache-Control` | native origin cache plus headers | headers only | headers only |

**Throttle.** Values mirror the IETF `RateLimit-Policy` structured field
(`q` quota, `w` window in seconds) so the runtime can emit
`RateLimit-Policy` and `RateLimit` on every response and `Retry-After` on
429 without inventing a second vocabulary; an NGINX `limit_req` or a CDN
rule expresses the same numbers. Algorithm is a sliding-window counter,
the standard middle ground between fixed windows (burst at boundaries) and
token buckets (harder to explain in headers). `client` identity is the
socket peer unless `urlcode serve --trusted-proxies <cidr,...>` names the
proxies allowed to set `X-Forwarded-For`; only `X-Forwarded-For` is read;
RFC 7239 `Forwarded` is not parsed. Counters are in-process with a bounded LRU
table; multi-instance sharing is a host plugin concern (5.5).

**Agents.** Matching is against the `User-Agent` field only; product tokens
are compared case-insensitively. `deny` names a bundled list; patterns use
a linear-time subset (anchors, classes, alternation, bounded repetition,
no backreferences or lookaround, 256 bytes max) so a project cannot make
the matcher a ReDoS vector. `allowPatterns` win over `deny`, which lets an
operator keep a search crawler while denying a category. The runtime
matches strings only; verifying that a claimed agent is genuine (reverse
DNS as documented by the major search engines, or the HTTP Message
Signature based web-bot-auth drafts) is a plugin concern. Denials answer
with the configured status and an empty body and log the list name, never
the raw header. A `robots.txt` route remains an ordinary `respond` or
`page` handler; `urlcode init` can generate one from the same lists.

**Security headers.** Profiles copy the current OWASP Secure Headers
Project recommended values verbatim and record the OSHP revision in the
generated reference, so "what does `oshp` set" is answerable from a public
source. Explicit `response.headers` override profile values header by
header. HSTS is only emitted when `--origin` is `https`.

**Compression.** Negotiation follows RFC 9110 `Accept-Encoding` q-values
with the project's `encodings` order as tie-breaker. Skipped when the
response already carries `Content-Encoding`, is `206`, carries
`Cache-Control: no-transform`, or is below `minBytes`. Asset snapshots are
precompressed at load, the same trick as NGINX `gzip_static` and Caddy
`precompressed`, so a request costs a buffer copy. The runtime adds
`Vary: Accept-Encoding`. When a response carries a session cookie or a
route declares `secrets`, compression is skipped (BREACH mitigation) unless
the route says `compression: { allowWithSecrets: true }`.

### 5.3 Bot lists: which to bundle and how to refresh

Vendoring a list into an Apache-2.0 package requires a license that allows
redistribution with attribution and no share-alike obligation. Findings:

| Source | License | Format | Maintenance | Bundle? |
|---|---|---|---|---|
| [ai-robots-txt/ai.robots.txt](https://github.com/ai-robots-txt/ai.robots.txt) | MIT | `robots.json` plus generated `robots.txt`, NGINX, Caddy, HAProxy, Apache files | Tagged releases, Atom feed, GitHub Action regenerates outputs from JSON | **Yes**: `ai-crawlers` |
| [monperrus/crawler-user-agents](https://github.com/monperrus/crawler-user-agents) | MIT (CC-SA before 2016-11-07; use only later revisions) | JSON with `pattern`, `url`, `instances`, `tags` | npm/PyPI/Go packages, PR-driven | **Yes**: `crawlers`, tags give `seo`, `monitoring` sub-lists |
| [atmire/COUNTER-Robots](https://github.com/atmire/COUNTER-Robots) | MIT | JSON with `pattern`, dates, generated plain text | Library-statistics community, periodic | Optional: `counter-robots` for analytics-exclusion use |
| [omrilotan/isbot](https://github.com/omrilotan/isbot) | Unlicense (public domain) | Aggregated regex parts exported as `list` | npm releases; aggregates the two above plus device-detector and vendor lists | Not directly: it includes LGPL-derived device-detector data, so vendor its upstream sources instead |
| matomo device-detector | LGPL-3.0 | YAML regexes | Active | **No**: copyleft data, not vendored |
| Cloudflare / Google / Bing verified-bot data | Proprietary or API-only | Reverse-DNS and IP ranges | Vendor | **No**: verification belongs in a plugin that calls the vendor |
| IAB/ABC spiders list | Paid, proprietary | Text | Commercial | **No** |

Bundling plan:

- Ship `data/agents/<list>.json` normalized to one schema
  (`{name, pattern, source, sourceRevision, addedAt}`), with each upstream
  `LICENSE` reproduced under `data/agents/LICENSES/` and named in `NOTICE`
  as Apache-2.0 §4(d) requires.
- A `scripts/sync-agent-lists.ts` pulls pinned upstream tags, validates every
  pattern against the linear-time subset (rejecting or rewriting the rest),
  and records the upstream revision. Refresh is a normal pull request run by
  Dependabot-style automation on a schedule; a release notes the list
  revisions it carries, and `urlcode doctor` prints them.
- Projects may also point at their own file (`deny: [./agents/deny.json]`)
  in the same schema, which keeps the YAML portable while letting an
  operator use a list the project does not want to redistribute.

### 5.4 Caching strategies catalogue

Caching is where "just one setting" fails users most. The policy therefore
names a strategy from a fixed catalogue; each row is a standard pattern
with a known name outside this project and a defined header output, so a
CDN or proxy in front of the origin interprets the result correctly.

| `strategy` | Emitted headers | Origin memory cache | Typical use |
|---|---|---|---|
| `no-store` (current function/redirect default) | `Cache-Control: no-store` | off | personalized, secret-bearing |
| `revalidate` (current asset default) | `Cache-Control: no-cache`, `ETag`, `Last-Modified`; answers `304` to `If-None-Match`/`If-Modified-Since` | off | HTML, anything that must be fresh but is cheap to validate |
| `public` | `Cache-Control: public, max-age=N` | optional | stable API answers, feeds |
| `immutable` | `Cache-Control: public, max-age=31536000, immutable` (RFC 8246) | off | content-hashed asset URLs only; the runtime refuses it on unhashed paths unless `force: true` |
| `swr` | `Cache-Control: public, max-age=N, stale-while-revalidate=M` (RFC 5861) | on: serves stale and refreshes once in the background | hot functions, link previews |
| `sie` | adds `stale-if-error=M` (RFC 5861) | on | keep answering during an upstream failure |
| `micro` | `Cache-Control: no-store` to clients; origin cache TTL of 1 to 5 seconds | on | the NGINX micro-caching pattern: absorb thundering herds on a function without changing client semantics |
| `cdn-only` | `Cache-Control: no-store` plus `CDN-Cache-Control: max-age=N` (RFC 9213) | off | let the CDN cache while browsers do not |
| `private` | `Cache-Control: private, max-age=N` | off | per-user data that a browser may keep |

Rules common to all strategies:

- Only `GET`/`HEAD` and status 200, 301, 302, 404, 410 enter the origin
  cache. Responses carrying `Set-Cookie`, routes declaring `secrets`, and
  responses with `Cache-Control: private` or `no-store` are never stored.
- Cache key is method, path, query and the declared `vary` headers, and
  the runtime emits a matching `Vary`. `Accept-Encoding` is added
  automatically when compression is on.
- The origin cache is keyed by snapshot version and dropped on reload, so a
  deploy never serves the previous code's output.
- Concurrent misses for one key coalesce into one handler invocation
  (`singleflight`, NGINX `proxy_cache_lock`), which is the actual reason
  to cache a function at all.
- Memory bound and hit/miss/stale counters are exposed through the health
  endpoint and request logs.
- Surrogate keys and purge (`Surrogate-Key`, `Cache-Tag`) are out of scope
  for the runtime; a plugin can add them.

### 5.5 Host-side plugin contract (`@jimhoyd/urlcode/plugins`)

For operators embedding the runtime who need behavior the declarative block
cannot express, add a small, documented, host-trusted hook API modelled on
Fastify's phases. Plugins are **not** part of the project format; they are
passed by the operator application to `startServer`/`createRuntime`, so a
project stays portable while an operator can still add a shared-store
limiter, a verified-bot check or a cache purge endpoint.

```js
import { startServer } from '@jimhoyd/urlcode';

await startServer({
  project: './site',
  plugins: [
    {
      name: 'shared-throttle', version: '1.0.0', targets: ['node'],
      onActivate(runtime) { /* inspect runtime.testPlan(); throw to refuse */ },
      onRequest(ctx)      { /* ctx.method, path, headers, client; return a result to short-circuit */ },
      onResponse(ctx, result) { /* return a replaced result; body stays a Buffer */ },
      onError(ctx, error) {},
      onClose() {},
    },
  ],
});
```

Rules:

- No hook can reach inside the guest, extend a deadline, or see bindings.
- Plugins declare `name`, `version` and `targets`; activation refuses a
  plugin on a host it does not list, mirroring route refusal.
- The declarative `policies` are implemented on this same interface, so
  first-party and third-party behavior share one code path and one test
  harness.
- Plugins are host code and therefore the operator's trust boundary, not
  the project's. The documentation must say so plainly.

### 5.6 Templates

Request-time templating conflicts with the opaque-native-body rule, and the
[prerender](PRERENDER.md) helper already handles the static case. Two
bounded options fit the boundary:

1. **Build-time only (recommended first).** Promote prerender into a CLI
   command, `urlcode build --prerender`, and add a `layouts` convention in
   the starter so a page function can import a layout module and the output
   is native. Zero runtime change, works on every target.
2. **Declarative `page.template` (later, if demanded).** A `page` handler
   may name a template file plus a `slots` map of literal strings or
   validated inputs. Rendering is pure substitution with contextual HTML
   escaping, done at snapshot time for literal slots and on the request path
   only for input-driven slots. No expressions, no loops, no guest code.
   Closer to server-side includes than to a view engine, and that is the
   point: inspectable and portable.

A general view engine is out of scope: it would be a second code path with
its own sandbox questions.

## 6. Hardened configuration guidance

This section is advice, not defaults. It reflects patterns that have held
up under public traffic in the frameworks and proxies surveyed in section 2.

### 6.1 The `hardened` profile

`policies.profile: hardened` expands to the following and nothing else, so
it can be read in one place and overridden key by key:

```yaml
policies:
  security: { headers: oshp }
  agents: { deny: [ai-crawlers], status: 403 }
  throttle: { quota: 120, window: 60, partition: client, status: 429 }
  compression: { encodings: [br, gzip], minBytes: 1024 }
  cache: { strategy: revalidate }
```

The numbers are starting points chosen to be safe for a single small
instance, not tuned for any workload. A `strict` profile is deliberately
not offered: anything stricter is a per-project decision.

### 6.2 Layering, in order of where a request is stopped

1. **Network and edge.** Volumetric protection, TLS termination and
   per-client connection budgets stay with the hosting provider or the
   reverse proxy, as [resilience](RESILIENCE.md) already states. Runtime
   policies are a second layer, never the first.
2. **Ingress to origin.** Bind privately; allow only the proxy's addresses;
   pass `--trusted-proxies` so `client` partitioning uses the real peer.
   Never trust `X-Forwarded-For` from an untrusted hop.
3. **Runtime request policies.** Agents before throttle (denials are
   cheaper than counting), then admission, then routing.
4. **Route contract.** Exact methods, `request.body` limits and content
   types, `expires` on campaign routes.
5. **Response policies.** Security headers on everything, compression only
   on listed types, caching only on the strategies whose semantics you can
   state, `no-store` everywhere else.

### 6.3 Strategies that have proven out elsewhere

- **Emit rate-limit headers even before enforcing.** Running throttle in
  `report` mode (headers plus a log line, no 429) for a release before
  turning on enforcement is how most API operators find their real quotas.
  Proposed: `throttle.mode: enforce | report`.
- **Deny lists as data with a pinned revision.** Every proxy that blocks
  agents well treats the list as a versioned artifact that ships with the
  deploy, not a live feed, so a rollback also rolls back the list.
- **Allow before deny.** Keep an explicit allow for the crawlers you need
  indexed; broad denies without it are the most common self-inflicted
  outage in this space.
- **Micro-cache the expensive path, revalidate the rest.** One-second
  origin caching on a hot function removes most thundering-herd load
  without changing what a browser sees.
- **Immutable only with content hashes.** Long `max-age` on a path that can
  change is the classic stale-asset bug; the runtime refusing `immutable`
  on unhashed paths encodes that lesson.
- **Compression off on secret-bearing responses.** Compression plus
  attacker-controlled input in the same response is the BREACH class of
  attack; skip it where secrets or session cookies are present.
- **Report the capability table.** Print which policies are enforced, which
  are refused and which are delegated on the current target at startup and
  in `urlcode audit`, so a person who copies the YAML to another host sees
  the difference immediately.

## 7. What this spike does not recommend

- **Global guest middleware.** It would pull every native route into the
  sandbox and end the fast path. Cross-cutting behavior belongs on the host.
- **A plugin field in route YAML that names npm packages.** It breaks the
  "project is portable, operator owns trust" split.
- **Provider settings in YAML** such as vendor rule identifiers. Declared
  semantics map to provider features in the adapter, not in the project.
- **Shared-state throttling in the runtime.** Multi-instance coordination is
  a plugin's job.
- **Copyleft or proprietary agent data.** Only MIT/public-domain lists are
  vendored; verification against vendor systems stays in plugins.

## 8. Suggested sequence

| Step | Scope | Why first |
|---|---|---|
| 1 | Internal host hook interface + `policies.security` | Smallest change; establishes the plugin seam with pure header math that works on every target |
| 2 | `policies.agents` with bundled lists, sync script, NOTICE entries | High demand for short-link projects; stateless; compiles to Cloudflare |
| 3 | `policies.throttle` with `report` mode, RateLimit headers and `--trusted-proxies` | Removes the most repeated application-layer code; reuses existing admission counters |
| 4 | `policies.compression` with precompressed asset snapshots | Measurable win in benchmarks |
| 5 | `policies.cache` catalogue | Depends on clear rules from steps 1 to 4 for what is cacheable |
| 6 | Public `@jimhoyd/urlcode/plugins` API + one reference package (shared-store throttle) | Proves the seam from outside the repo |
| 7 | `urlcode build --prerender` and starter layouts | Template story without a runtime change |

Each step ships with schema changes, `npm run docs:reference`, cookbook
routes, capability-table updates and fixtures that assert the self-hosted
server and each adapter agree on status, body and headers.

## 9. Open questions

- Should `policies` be a top-level key or nested under a `server` key so
  project-level defaults are visibly separate from routes?
- Does a denied agent count against the throttle? (Proposed: no.)
- The IETF `RateLimit` header fields and the web-bot-auth architecture are
  still Internet-Drafts; the YAML keys are chosen to survive renames in the
  header syntax, but the emitted field names may need a version switch.
- Which OSHP revision to pin first, and whether the CSP in `oshp` should be
  report-only by default for `page` routes that carry inline scripts.
