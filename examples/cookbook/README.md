# Runnable YAML cookbook

25 routes covering all six handlers, middleware, inputs, body validation, response
headers, cookies, methods, expiry, assets, included files and host policies
(security headers, agent denial, caching and a request budget) plus generated site
conventions (robots.txt, favicon, security.txt, llms.txt). No credentials or
external services are required. Redirects target example.com; tests never follow them.

From the runtime checkout:

```sh
node src/cli.js validate --project examples/cookbook
node src/cli.js test --project examples/cookbook
node src/cli.js audit --project examples/cookbook --expect-routes 25
node src/cli.js dev --project examples/cookbook
```

The [YAML guide](../../docs/YAML-GUIDE.md) explains the recipes and binding policy.
`/notice` deliberately returns 503, `/paused` 404 and `/expired` 410. `/preflight`
is an OPTIONS/header example, not a complete cross-origin API. The small default
starter remains the recommended starting point for a new application.
