# Prerender a dynamic project into a native static one

Three pages rendered by a function and one shared template middleware, then
rendered once at build time into a project that serves the same bytes with
native `page` routes and no sandbox on the request path.

From the runtime checkout:

```sh
node src/cli.js dev --project examples/prerender        # the dynamic source, live
node src/cli.js test --project examples/prerender       # 7 fixtures
node examples/prerender/prerender.mjs examples/prerender /absolute/out
node src/cli.js test --project /absolute/out            # fixtures the build wrote
node src/cli.js audit --project /absolute/out --expect-routes 3
```

The same three URLs answer identically before and after. The difference is what
runs to serve them: the source project executes a QuickJS/WASM guest per request,
the generated project reads a prevalidated byte buffer.

| | Source project | Generated project |
|---|---|---|
| Handlers | 3 × `function` | 3 × `page` |
| Middleware | shared template | none |
| Guest execution per request | yes | none |
| Content | reviewed literals in YAML | rendered HTML files |

`prerender.mjs` is operator build tooling that runs in Node, not guest code. It
reads the source project through `createRuntime().handle()`, checks every render,
writes the pages, emits `urlcode.yaml` and `tests/requests.json`, and then
activates the result to prove it contains nothing executable. It fails the build
rather than publishing a bad page: a non-200 status, a body that is not
`text/html`, an empty or oversized render, a route path it cannot turn into one
safe flat filename, two routes claiming the same filename, or an output directory
inside the source project.

The recipe renders content that is already prepared. It is not a Markdown
compiler, an HTML sanitizer, an asset pipeline or an incremental build, and it
copies no static tree. [Prerendering](../../docs/PRERENDER.md) explains the
contract, the limits and how a larger site generates its source project.
