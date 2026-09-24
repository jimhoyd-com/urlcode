# YAML guide and recipe book

<!-- urlcode-current-version:start -->
This guide targets URLCode 0.5.9. Start with the function example below,
then add only the fields your route needs. The authoritative machine-readable
shape is [JSON Schema](../schemas/urlcode.schema.json); semantic rules are in the
[specification](SPECIFICATION.md). Unsupported fields fail validation.
<!-- urlcode-current-version:end -->

## Run all the examples

The [cookbook project](../examples/cookbook/urlcode.yaml) includes six of URLCode's
nine handler types (`redirect`, `respond`, `page`, `static`, `download`, `function`;
`conditional`, `proxy` and the `extension` mount are not stateless demo routes and
live in their own recipes and docs), plus middleware, typed/defaulted inputs,
methods, response headers, body checks, expiry and file organization. Its
referenced JavaScript and assets are included.

`examples/cookbook` ships inside the installed package (it is listed in
`package.json`'s `files`), so you can run it after a project-local install
without cloning this repository:

```sh
mkdir cookbook-check && cd cookbook-check && npm init -y
npm install --save-dev --save-exact @jimhoyd/urlcode
COOKBOOK=node_modules/@jimhoyd/urlcode/examples/cookbook
npx --no --package @jimhoyd/urlcode urlcode validate --project "$COOKBOOK"
npx --no --package @jimhoyd/urlcode urlcode test --project "$COOKBOOK"
npx --no --package @jimhoyd/urlcode urlcode audit --project "$COOKBOOK" --expect-routes 40
npx --no --package @jimhoyd/urlcode urlcode dev --project "$COOKBOOK"
```

Working from a clone of this repository instead, run the same commands with
`node packages/core/src/cli.ts` in place of `npx --no --package @jimhoyd/urlcode urlcode`
(see [Contributing](../CONTRIBUTING.md)).

The cookbook is the largest of several runnable demo projects under `examples/`
(each its own complete `urlcode.yaml`, like `examples/data-dir`); `recipes/` is
a separate catalog of small YAML snippets copied *into* your own project with
`urlcode recipes add` rather than run in place — see [recipes](RECIPES.md). The
normal `urlcode init ../my-links` creates a bare zero-route scaffold; add only
the routes the application needs; the site's `package.json` pins the runtime.

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
| [Policies and profiles](yaml/policies.md) | 15. Protect a route with an extension; 16. Hardened profile and per-route overrides |
| [Site conventions](yaml/site.md) | 17. Site conventions |

## Common mistakes

| Mistake | Correction |
|---|---|
| Two handlers on one route | Choose exactly one; put reusable logic in middleware |
| `/r/:id`, `/r/{id:.*}` or a regex | Use `/r/{id}` plus a required path input; no regex/greedy matching |
| `${TOKEN}` in YAML, or reading `process.env` directly in code | YAML has no interpolation; declare route-level `env`/`secrets` bindings and read them from the `env`/`secrets` context a function receives, backed by an external operator grant |
| Assuming `fetch`, npm and Node imports are unsupported | They run fine in the trusted, in-process default; only an explicit `sandbox: true` route drops them (see [function security](FUNCTION-SECURITY.md)) |
| Asset MIME/header overrides in `response.headers` | Configure `contentType`, `cacheControl`, `filename` on the asset handler |
| `methods: [GET]` expecting HEAD | Declare HEAD too or omit methods for default GET/HEAD |
| YAML fields for rate limits/workers/DNS/TLS | Deployment controls live outside portable route YAML |
| YAML aliases, anchors or implicit date objects | Use plain JSON-compatible YAML and quoted timestamps |
| Automatic hot updates in `serve` | Deploy/restart or use the embedding reload API deliberately |
| “All examples are production-ready” | Validate your security, load and deployment requirements separately |
