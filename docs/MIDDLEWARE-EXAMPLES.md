# Middleware examples

Fourteen reusable middleware modules covering fifteen patterns (`auth.mjs`
exports both `bearer` and `basic`), each in
[`examples/cookbook/middleware`](../examples/cookbook/middleware) with a route in
[`routes/middleware.yaml`](../examples/cookbook/routes/middleware.yaml) and request
fixtures in the cookbook tests. The same modules ship as the `middleware`
[local recipe](RECIPES.md):

```sh
urlcode recipes add middleware --out ./my-middleware
urlcode test --project ./my-middleware
```

They cover what Express, Koa, Fastify, Hono, Next.js and edge runtimes usually
ship as middleware, rewritten for URLCode's [guest API](MIDDLEWARE.md): text/JSON
`Request`/`Response`, `Headers`, `context.inputs/args/env/secrets/state`, timers
and nothing else. There is no `crypto`, `URL`, `fetch`, storage or console, and
`context.state` dies with the request. Patterns that need any of those are listed
at the end so nobody wastes time porting them.

| Pattern | Module | Framework equivalent | Demonstrates |
| --- | --- | --- | --- |
| Bearer token gate | `auth.mjs` `bearer` | Hono `bearerAuth`, `express-bearer-token` | Early 401, `www-authenticate`, constant-time compare against an `env` binding |
| Basic authentication | `auth.mjs` `basic` | Hono `basicAuth`, `express-basic-auth` | Hand-written base64 (no `atob`), both checks always evaluated, `state.user` |
| CORS | `cors.mjs` | Express `cors`, Hono `cors` | `OPTIONS` answered before the handler, origin allowlist, `vary: origin` |
| Correlation id and timing | `request-id.mjs` | Hono `requestId`/`timing`, Express `response-time` | Validating a caller header, `server-timing`, coexisting with the runtime's own `x-request-id` |
| Maintenance switch | `maintenance.mjs` | Next.js and Netlify Edge maintenance examples | 503 with `retry-after`, bypass header, flipping behavior from a binding |
| Error boundary | `errors.mjs` | Koa `onerror`, Express error handlers | Catching a downstream throw, JSON 500 instead of a bare 502 |
| JSON envelope | `envelope.mjs` | Response transformers | Reading a function body once, passing native bodies through untouched |
| Content negotiation | `negotiate.mjs` | Express `res.format` | Parsing `accept` with q-values, 406, `vary: accept` |
| Method override | `methods.mjs` `override` | Express `method-override` | Bounded tunneling through POST, 405 with `allow` |
| ETag and 304 | `etag.mjs` | Express `etag`, Fastify `@fastify/etag` | FNV-1a weak tag, `if-none-match`, null-body 304 |
| A/B bucket | `bucket.mjs` | Vercel and Cloudflare A/B examples | Cookie parsing, `set-cookie`, replacing a native redirect |
| Locale redirect | `locale.mjs` | Next.js i18n middleware | `accept-language` ranking, allowlisted languages, `vary` |
| Referer allowlist | `referer.mjs` | Hotlink protection rules | Gating a native download without reading it |
| Body validation | `body.mjs` | `express-validator`, Fastify schemas | Single-use body, 422 error list, handoff through `state` |
| Debug echo | `debug.mjs` | Request loggers | Inspecting inputs, args and redacted headers when the console is silent |

## Reading the modules

Every module follows the shape in [middleware](MIDDLEWARE.md): read the request,
optionally return early, otherwise `await next()` once and return a `Response`.
Three habits recur and are worth copying:

- **Configuration lives in bindings.** Tokens, allowlists and switches are read
  from `context.env`. The cookbook binds literal values so it runs without grants;
  a deployed project uses `{secret: name}` for credentials and an operator grant.
- **Native bodies stay opaque.** `envelope`, `negotiate` and `etag` only rewrite a
  body when the downstream response is a function response with a readable
  content type. `bucket`, `locale` and `referer` wrap native redirects and
  downloads without touching their bytes; to change the destination they return
  a new `Response` instead.
- **Chains compose through `state`.** `/fragile` runs `request-id` before
  `errors`, so the fallback JSON carries the correlation id. `/profile` parses
  the body once in middleware and the function reads `context.state.body`.

## Limits these examples respect

- **No `crypto`.** The auth modules compare a shared token; they cannot verify
  HMAC signatures, JWTs or password hashes. Signed URLs would be a runtime
  feature, not a middleware example.
- **No cross-request state.** Rate limiting, caching, sessions and CSRF tokens
  need storage the guest does not have. Throttling and cache headers exist as
  native [policies](POLICIES.md) instead.
- **No logging target.** The guest console is a no-op; `debug.mjs` returns the
  information to the caller instead, and only when both a binding and a header
  ask for it. Remove that route before publishing a project.
- **Runtime headers win.** The runtime stamps `x-request-id` on every response,
  which is why the tracing example uses `x-correlation-id`. YAML
  `response.headers` also override middleware headers.

Each cookbook route has fixtures for its success path, its early responses, its
validation failures and every declared method, which is what `urlcode audit`
expects before it reports a middleware-wrapped route as covered.
