# CORS JSON API

Run `urlcode validate --local --project .`, `urlcode test --project .` and
`urlcode audit --project . --expect-routes 1`.

`/api/items` answers a literal JSON list declared with `respond`, so no handler
code runs. `middleware/cors.mjs` (trusted, the default) runs around it: it
answers `OPTIONS` preflight itself with 204 and adds
`Access-Control-Allow-Origin` to responses for origins in its allowlist. Other
origins get `Vary: Origin` and no allow header, so browsers refuse them.

Edit `allowedOrigins` in the middleware and the `respond.json` value. Replace
`respond` with a `function` only when the data must be computed per request;
the middleware wraps either. The route must list `OPTIONS` in `methods`, or the
runtime answers 405 before the middleware runs. CORS is not a host policy in
this contract; middleware is the supported place for it, and middleware needs
the self-hosted Node lifecycle, so serverless targets refuse this project. A
browser-facing API that also needs credentials must add
`Access-Control-Allow-Credentials` deliberately, never with a wildcard origin.
