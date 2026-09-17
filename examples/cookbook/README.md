# Runnable YAML cookbook

40 routes covering all six handlers, middleware, inputs, body validation, response
headers, cookies, methods, expiry, assets, included files and host policies
(security headers, agent denial, caching and a request budget) plus generated site
conventions (robots.txt, favicon, security.txt, llms.txt). Fifteen of the routes
exercise the fourteen reusable modules in `middleware/`, described in
[middleware examples](../../docs/MIDDLEWARE-EXAMPLES.md). No credentials or
external services are required. Redirects target example.com; tests never follow them.

From the runtime checkout:

```sh
node src/cli.ts validate --project examples/cookbook
node src/cli.ts test --project examples/cookbook
node src/cli.ts audit --project examples/cookbook --expect-routes 40
node src/cli.ts dev --project examples/cookbook
```

The [YAML guide](../../docs/YAML-GUIDE.md) explains the recipes and binding policy.
`/notice` deliberately returns 503, `/paused` 404 and `/expired` 410. `/preflight`
is an OPTIONS/header example, not a complete cross-origin API; `/cors/data` is the
middleware version. `/maintenance` returns 503 without its bypass header and
`/inspect` echoes request details only with `X-Debug: 1`. The small default
starter remains the recommended starting point for a new application.
