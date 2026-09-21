# YAML guide and recipe book

<!-- urlcode-current-version:start -->
This guide targets URLCode 0.4.7. Start with the function example below,
then add only the fields your route needs. The authoritative machine-readable
shape is [JSON Schema](../schemas/urlcode.schema.json); semantic rules are in the
[specification](SPECIFICATION.md). Unsupported fields fail validation.
<!-- urlcode-current-version:end -->

## Run all the examples

The [cookbook project](../examples/cookbook/urlcode.yaml) includes the six stateless handler
types, middleware, typed/defaulted inputs, methods, response headers, body checks,
expiry and file organization. Its referenced JavaScript and assets are included.
From the runtime checkout:

```sh
npm ci
node src/cli.ts validate --project examples/cookbook
node src/cli.ts test --project examples/cookbook
node src/cli.ts audit --project examples/cookbook --expect-routes 40
node src/cli.ts dev --project examples/cookbook
```

The cookbook is a larger learning project. The normal `urlcode init ../my-links`
remains a small two-route starter. For an independent application with a pinned
runtime dependency, clone [urlcode-template](https://github.com/jimhoyd-com/urlcode-template).

## Pages

Each page holds the recipes for one task; the section numbers continue across pages.

| Page | Sections |
|---|---|
| [Functions, inputs and methods](yaml/functions.md) | 1. A URL that runs code; 4. Input types and constraints; 5. Methods and body validation; 6. All function argument sources |
| [Redirects](yaml/redirects.md) | 2. Ordinary and permanent redirects; 3. Parameterized redirects and explicit query forwarding |
| [Middleware](yaml/middleware.md) | 7. Middleware before and after a handler |
| [Declared responses, headers and cookies](yaml/responses.md) | 8. Native responses, headers and cookies; 9. Explicit OPTIONS response (not automatic CORS) |
| [Pages, static folders and downloads](yaml/assets.md) | 10. Pages, static folders, downloads and MIME |
| [Enable, disable and expire](yaml/conditions.md) | 11. Enable, disable and expire |
| [Bindings, split files and tests](yaml/organization.md) | 12. Environment and secret references; 13. Split files and folders; 14. Assert inputs and outputs |
| [Policies and profiles](yaml/policies.md) | 16. Hardened profile and per-route overrides |
| [Site conventions](yaml/site.md) | 17. Site conventions |

## Common mistakes

| Mistake | Correction |
|---|---|
| Two handlers on one route | Choose exactly one; put reusable logic in middleware |
| `/r/:id`, `/r/{id:.*}` or a regex | Use `/r/{id}` plus a required path input; no regex/greedy matching |
| `${TOKEN}` or `process.env` | Use declared binding references and an external operator grant |
| `fetch`, npm or Node imports | Unsupported in the guest; do not claim a network/storage integration |
| Asset MIME/header overrides in `response.headers` | Configure `contentType`, `cacheControl`, `filename` on the asset handler |
| `methods: [GET]` expecting HEAD | Declare HEAD too or omit methods for default GET/HEAD |
| YAML fields for rate limits/workers/DNS/TLS | Deployment controls live outside portable route YAML |
| YAML aliases, anchors or implicit date objects | Use plain JSON-compatible YAML and quoted timestamps |
| Automatic hot updates in `serve` | Deploy/restart or use the embedding reload API deliberately |
| “All examples are production-ready” | Validate your security, load and deployment requirements separately |
