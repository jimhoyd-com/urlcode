# CORS JSON API

Run `urlcode validate --local --project .`, `urlcode test --project .` and
`urlcode audit --project . --expect-routes 1`.

`/api/items` returns JSON from a function (trusted, the default). `middleware/cors.mjs` runs
around it: it answers `OPTIONS` preflight itself with 204 and adds
`Access-Control-Allow-Origin` to responses for origins in its allowlist. Other
origins get `Vary: Origin` and no allow header, so browsers refuse them.

Edit `allowedOrigins` in the middleware and the function body. The route must
list `OPTIONS` in `methods`, or the runtime answers 405 before the middleware
runs. CORS is not a host policy in this contract; middleware is the supported
place for it, and middleware needs the self-hosted Node lifecycle, so serverless targets refuse this
project. A browser-facing API that also needs credentials must add
`Access-Control-Allow-Credentials` deliberately, never with a wildcard origin.
