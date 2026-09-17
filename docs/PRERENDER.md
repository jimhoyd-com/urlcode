# Prerendering pages into a native static project

Render a project's function and middleware routes once, at build time, into a
project whose routes are all native `page` handlers. The published site answers
from prevalidated byte buffers: no guest code runs to serve a request, so the
sandbox, its deadline and its memory budget are not on the request path at all.

The runnable recipe is [`examples/prerender`](../examples/prerender/README.md),
covered by `test/prerender.test.js`. Everything here uses the existing runtime:
prerendering adds no field to route YAML, no CLI command and no capability.

## Why render ahead of time

A function response body is readable by middleware through `text()`. A native
`page`, `static`, `download`, `redirect`, `respond` or `link` body is not — that
opacity is a deliberate contract, not a gap, and it is what keeps native file
serving free of guest code. See [middleware](MIDDLEWARE.md).

So a shared template cannot be wrapped around a native file at request time. The
answer is to apply the template while the content is still a function response,
and publish the result:

```
function + template middleware  ──render once──▶  HTML file  ──▶  page route
        (sandbox, build time)                                   (no sandbox)
```

The alternative — reading Markdown through `next().text()` on a native route —
is not supported and should not be attempted. Prepare content at build time.

## The five steps

1. **Activate the source project.** `createRuntime(project)` compiles routes,
   validates assets and starts the function pool exactly as `serve` does.
2. **Choose what to render.** `runtime.testPlan().inventory` lists every route
   with its `handler`, `methods`, `middleware` count and `state`. Prerender the
   active `function` routes that accept GET and whose path is a literal — a
   parameterized or wildcard path has no single output file.
3. **Render each page.** `await runtime.handle({target, method: 'GET'})` returns
   `{status, headers, body}`. Check the status is 200 and the content type is
   `text/html` before writing anything. The body is a byte array, not a string:
   wrap it with `Buffer.from(result.body)` and write those bytes, so a multi-byte
   character is never re-encoded or truncated.
4. **Close the runtime.** It owns worker threads. Close it in a `finally`, so a
   failed build exits instead of hanging.
5. **Emit the native project.** One `page` route per rendered file, plus
   `tests/requests.json` fixtures, then activate the generated project and assert
   its inventory contains only `page` routes with no middleware. A build that
   ever emitted guest code then fails instead of shipping.

## Safety rules the build owns

The runtime enforces its own protections when the generated project activates:
asset declarations reject absolute paths, traversal, dot segments, symlinks,
hardlinks and nonregular files, and static trees refuse `urlcode.yaml`,
`package.json`, `package-lock.json`, hidden entries, `node_modules` and
`.pem/.key/.p12/.pfx/.env` files. See [assets](ASSETS.md).

Those checks fail a deployment. A build should fail earlier and more specifically,
so keep these in the recipe:

- **Derive filenames, never accept them.** Map each route path to exactly one
  flat lowercase name, reject anything else, and verify the derived name matches
  a strict pattern and is not a protected name. A flat name cannot contain a path
  separator or a leading dot, so no output can escape the pages directory.
- **Refuse collisions.** `/a/b` and `/a-b` must not both claim `a-b.html`.
- **Write outside the source.** The artifact is a separate deployable tree; a
  build that writes into the reviewed project can overwrite the code it rendered.
- **Fail closed on every render.** A 404, a 500, a non-HTML content type, an empty
  body or an oversized body is a build failure, never a published file.
- **Bound the build.** Cap the page count and the bytes per page well below the
  runtime's asset budgets, so a runaway render is a clear error rather than a
  64 MiB project that fails at activation.

The build script is operator code. It runs in Node with normal filesystem access
because it is not guest code; nothing here gives the sandbox a filesystem, and no
host-code fallback is introduced. Review it as you review any deployment tooling.

## Limits worth knowing before you design a site

| Limit | Value | Where |
|---|---|---|
| Function/middleware response body | 1 MiB default (`--max-response-bytes`) | render step |
| Middleware entries per route | 16 | source project |
| Asset file size | 16 MiB | generated project |
| Total unique asset bytes | 64 MiB | generated project |
| Static entries traversed | 10,000 | generated project |
| Directory depth | 20 | generated project |

Startup snapshots asset bytes in memory, and a reload can briefly hold two
snapshots. A large site is bounded by the generated project's memory, not by the
render step. For collections beyond these budgets, publish to an external asset
service and redirect; provider asset adapters are not implemented.

## Larger sites: generating the source project

The example keeps page content as reviewed literal `args` in YAML, which stays
readable and lets `dev` serve the site live. A site with hundreds of pages
instead generates its source project from host-prepared content: the build reads
its Markdown or data, compiles and sanitizes it in Node, writes a temporary
project whose routes carry that HTML as literal arguments, renders it with the
five steps above, and discards the temporary project.

That keeps every property intact — content is still reviewed input, guest code
still reads nothing from disk, and the published artifact is still inert. Two
things to hold onto:

- **Generated YAML is operator input.** It is written by your build, from your
  content, and reviewed like any other deployment artifact. Route YAML never
  gains the ability to name host code or a callback.
- **Sanitize before rendering, not after.** The template escapes the values it
  interpolates, but content injected as raw HTML is published as written. Whatever
  produces that HTML owns its safety.

The [urlcode-docs showcase](https://github.com/jimhoyd-com/urlcode-docs) builds
84 pages this way and asserts 171 request fixtures against the result. That is a
working integration, not a deployment or performance claim.

## What this is not

Not a static-site generator: no Markdown, no sanitizer, no asset pipeline, no
incremental or watch build, no link checking, no sitemap. Not a way to make
native bodies readable. Not a template engine — the template is ordinary
middleware you write. A reusable helper or CLI command may follow once real
integrations agree on the smallest useful API; until then the recipe is the API,
and copying it is the intended use.
