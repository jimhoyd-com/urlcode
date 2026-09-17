# Spike: plugins, adapters and optional runtime features

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
| Provider adapters | `urlcode/vercel`, `urlcode/aws`, `urlcode/cloudflare` | Operator | Host process; wrap `runtime.handle()` |
| Build helpers | `urlcode/prerender` | Operator/build | Host process, build time only |
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

### 5.1 Declarative `policies` (project-level and route-level)

```yaml
version: "1"
policies:                # project defaults, all optional
  throttle:
    limit: 60
    window: 1m
    key: client          # client | route | client+route
  agents:
    block: [bots, ai-crawlers]        # curated lists shipped with the runtime
    blockPatterns: ["^curl/"]         # anchored, case-insensitive, no backtracking classes
    allowPatterns: ["Googlebot"]      # allow wins over block
    status: 403
  security:
    headers: strict      # strict | basic | off
  compression:
    encodings: [br, gzip]
    minBytes: 1024
    types: [text/*, application/json, application/javascript, image/svg+xml]
  cache:
    ttl: 30s
    staleWhileRevalidate: 5m
    vary: [accept-language]

routes:
  /api/lookup/{id}:
    function: { source: functions/lookup.mjs }
    policies:
      throttle: { limit: 10, window: 1m }   # tightens the default
      cache: false                          # opts out
```

Semantics that keep this portable:

- **Evaluation point.** Policies run on the host, *before* `handle()` for
  request-side ones (throttle, agents) and *after* it for response-side ones
  (security headers, compression, cache). Native routes keep their fast path;
  nothing enters the sandbox.
- **Throttle identity.** `client` means the socket peer address unless the
  operator sets `--trusted-proxies`, in which case the last untrusted hop of
  `X-Forwarded-For` is used. This is the one place the forwarded-header rule
  in [resilience](RESILIENCE.md) is honoured programmatically. State is an
  in-process fixed-window or sliding-window counter with a bounded key table
  (LRU, default 100k entries); multi-instance sharing is out of scope and
  documented as such, exactly as [capacity](CAPACITY.md) says today.
- **Agents.** Curated lists are versioned data files in the package, updated
  by release, and reported by `urlcode doctor`. Patterns are compiled with a
  linear-time subset (no lookarounds, bounded length) so a policy cannot
  become a ReDoS vector. Blocking answers with the configured status and no
  body; it is logged with the list name, never the raw UA string.
- **Security headers.** `strict` sets `Strict-Transport-Security`,
  `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`,
  `Permissions-Policy` and a conservative `Content-Security-Policy`;
  `basic` omits CSP. Explicit `response.headers` still win.
- **Compression.** Negotiated from `Accept-Encoding`; applied only to
  listed types and above `minBytes`; never to responses already carrying
  `Content-Encoding`, `206`, or `Cache-Control: no-transform`. Assets are
  precompressed at snapshot time so the request path stays a buffer copy.
- **Cache.** Keyed by method, path, query and the declared `vary` headers;
  only `GET`/`HEAD`, only status 200/301/302/404/410; never when a route
  declares `secrets`, sets cookies, or when a response carries
  `Cache-Control: private|no-store`. Memory-bounded, reported through health.
  This is what turns a hot function into a one-sandbox-per-TTL cost.
- **Adapters.** Each policy states its target behavior in a capability table:

  | Policy | Self-hosted | Vercel / AWS | Cloudflare build |
  |---|---|---|---|
  | throttle | native | refused (no shared state) unless `key: route` and `--allow-per-instance` | refused; guide points to WAF rate rules |
  | agents | native | native (pure function of headers) | compiled into Worker |
  | security | native | native | compiled |
  | compression | native | refused: provider does it | refused: provider does it |
  | cache | native | refused | refused; map to `Cache-Control` only |

  "Refused" follows the existing adapter rule: fail activation with the
  route and policy named rather than silently degrade.

### 5.2 Host-side plugin contract (`urlcode/plugins`)

For operators embedding the runtime who need behavior the declarative block
cannot express, add a small, documented, host-trusted hook API modelled on
Fastify's phases. Plugins are **not** part of the project format; they are
passed by the operator application to `startServer`/`createRuntime`, so a
project stays portable and reviewable while an operator can still add a
Redis-backed limiter or a custom bot classifier.

```js
import { startServer } from 'urlcode';
import { rateLimit } from '@urlcode/plugin-rate-limit-redis';

await startServer({
  project: './site',
  plugins: [
    rateLimit({ url: process.env.REDIS_URL, limit: 100, window: '1m' }),
    {
      name: 'audit',
      onRequest(ctx)  { /* ctx.method, ctx.path, ctx.headers, ctx.client; return Response to short-circuit */ },
      onResponse(ctx, result) { /* may return replaced result; body still a Buffer */ },
      onActivate(runtime) { /* inspect runtime.testPlan(); throw to refuse deployment */ },
    },
  ],
});
```

Rules:

- Hooks are `onActivate`, `onRequest`, `onResponse`, `onError`, `onClose`.
  No hook can reach inside the guest or extend a deadline.
- Plugins declare `name`, `version` and `adapters: ['node', 'vercel', …]`.
  Activation refuses a plugin on a host it does not list, mirroring route
  refusal.
- The same interface is used internally to implement the declarative
  `policies`, so first-party and third-party behavior share one code path
  and one test harness.
- Because they are host code, plugins are the operator's trust boundary, not
  the project's. Document this loudly; it is the difference between "a plugin
  ecosystem" and "a way to run untrusted npm packages next to the runtime".

### 5.3 Templates

Request-time templating conflicts with the opaque-native-body rule, and the
[prerender](PRERENDER.md) helper already handles the static case. Two
bounded options fit the boundary:

1. **Build-time only (recommended first).** Promote prerender into a CLI
   command, `urlcode build --prerender`, and add a `layouts` convention in
   the starter so a page function can `import layout from '../layouts/site.mjs'`
   and the output is native. Zero runtime change, works on every adapter.
2. **Declarative `page.template` (later, if demanded).** A `page` handler may
   name a template file plus a `slots` map of literal strings or validated
   inputs. Rendering is a pure substitution with automatic HTML escaping,
   executed on the host at snapshot time for literal slots and on the
   request path only for input-driven slots. No expressions, no loops, no
   guest code. This is closer to NGINX SSI than to a view engine, and that is
   the point: it stays inspectable and portable.

A general view engine (EJS, Nunjucks) is out of scope: it would be a second
code path with its own sandbox questions.

## 6. What this spike does not recommend

- **Global guest middleware.** It would pull every native route into the
  sandbox and end the fast path. Cross-cutting behavior belongs on the host.
- **A plugin field in route YAML that names npm packages.** It breaks the
  "project is portable, operator owns trust" split.
- **Provider settings in YAML** (`cloudflare.rateLimitRuleId` and the like).
  Declared semantics map to provider features in the adapter, not in the
  project.
- **Shared-state throttling in the runtime.** Multi-instance coordination is
  a plugin's job (5.2), not the core's.

## 7. Suggested sequence

| Step | Scope | Why first |
|---|---|---|
| 1 | Internal host hook interface + `policies.security` | Smallest change; establishes the plugin seam with a feature that is pure header math and works on every adapter |
| 2 | `policies.agents` with curated lists | High demand for short-link projects; stateless; compiles to Cloudflare |
| 3 | `policies.throttle` (in-process) with `--trusted-proxies` | Removes the most repeated application-layer code; needs the admission counters that already exist |
| 4 | `policies.compression` with precompressed asset snapshots | Measurable win in benchmarks; needs the asset snapshot pipeline |
| 5 | `policies.cache` | Depends on clear rules from steps 1 to 4 for what is cacheable |
| 6 | Public `urlcode/plugins` API + one reference package (Redis throttle) | Proves the seam from outside the repo |
| 7 | `urlcode build --prerender` and starter layouts | Template story without a runtime change |

Each step ships with schema changes, `npm run docs:reference`, cookbook
routes, adapter capability-table updates and fixtures that assert the
self-hosted server and each adapter agree on status, body and headers.

## 8. Open questions

- Should `policies` be a top-level key or nested under a new `server` key so
  project-level defaults are visibly separate from routes?
- Does a blocked agent count against the throttle? (Proposed: no; blocking
  is cheaper than counting.)
- Which curated bot lists are acceptable to vendor under Apache-2.0, and how
  are they refreshed between releases?
- Is a cached function response allowed to be served after the source that
  produced it changed on reload? (Proposed: cache is keyed by snapshot
  version and dropped on reload.)
