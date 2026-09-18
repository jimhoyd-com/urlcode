# Middleware patterns

Fourteen reusable middleware modules on fifteen routes (`auth.mjs` serves two),
covering what Express, Koa,
Hono, Next.js and edge runtimes usually ship as middleware, rewritten for
URLCode's small sandboxed guest API. Run `urlcode validate --local --project .`
and `urlcode serve --project .`, then keep the routes you need and delete the
rest; every module is independent.

| Route | Module | Pattern |
| --- | --- | --- |
| `/api/private` | `middleware/auth.mjs` (`bearer`) | Bearer token with constant-time comparison |
| `/admin/panel` | `middleware/auth.mjs` (`basic`) | HTTP Basic decoded in the guest |
| `/cors/data` | `middleware/cors.mjs` | Origin allowlist and preflight |
| `/traced` | `middleware/request-id.mjs` | Caller correlation id and Server-Timing |
| `/maintenance` | `middleware/maintenance.mjs` | 503 kill switch with bypass header |
| `/fragile` | `middleware/errors.mjs` | Error boundary returning JSON 500 |
| `/api/items` | `middleware/envelope.mjs` | JSON response envelope |
| `/negotiated` | `middleware/negotiate.mjs` | Accept negotiation, 406 otherwise |
| `/resource` | `middleware/methods.mjs` | POST method override |
| `/versioned` | `middleware/etag.mjs` | Weak ETag and 304 for function output |
| `/experiment` | `middleware/bucket.mjs` | Sticky A/B cookie bucket |
| `/welcome` | `middleware/locale.mjs` | Accept-Language redirect |
| `/downloads/report` | `middleware/referer.mjs` | Referer allowlist on a download |
| `/profile` | `middleware/body.mjs` | Body validation handed through `context.state` |
| `/inspect` | `middleware/debug.mjs` | Redacted request echo for authoring |

Tokens, passwords and switches are literal `env` values so the recipe runs
without grants. Before deploying, move credentials to `{secret: name}` bindings
with an operator grant, replace the example.com destinations, and delete the
`/inspect` route or set `DEBUG` to `false`. The guest exposes no crypto, so none
of these modules can verify signatures or hash passwords; treat them as request
shaping, not as a security boundary. See the runtime's middleware documentation
for the full list of guest limits.
