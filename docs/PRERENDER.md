# Prerendering pages into a native static project

Render a project's function and middleware routes once, at build time, into a
project whose routes are all native `page` handlers. The published site answers
from prevalidated byte buffers: no guest code runs to serve a request at all,
so whatever execution mode the source routes used — trusted by default, or
isolated QuickJS/WASM where a route declares `sandbox: true` — along with its
deadline and memory budget where sandboxed, is not on the request path.

The shared orchestration ships as a build helper, `@jimhoyd/urlcode/prerender`, and the
runnable recipe is [`examples/prerender`](../examples/prerender/README.md), which
consumes it. Both are covered by `test/prerender.test.ts`. Everything here uses
the existing runtime: prerendering adds no field to route YAML, no CLI command
and no capability.

## Why render ahead of time

A function response body is readable by middleware through `text()`. A native
`page`, `static`, `download`, `redirect` or `respond` body is not — that
opacity is a deliberate contract, not a gap, and it is what keeps native file
serving free of guest code. See [middleware](MIDDLEWARE.md).

So a shared template cannot be wrapped around a native file at request time. The
answer is to apply the template while the content is still a function response,
and publish the result:

```
function + template middleware  ──render once──▶  HTML file  ──▶  page route
   (trusted or sandboxed, build time)                        (no guest code)
```

The alternative — reading Markdown through `next().text()` on a native route —
is not supported and should not be attempted. Prepare content at build time.

## The build helper

```js
import {prerenderPages, assertNativeProject, pageFileName} from '@jimhoyd/urlcode/prerender';

const rendered = await prerenderPages('./render-source', './out/pages', {
  origin: 'https://docs.example',   // what a page sees as its own origin
});
// rendered.pages  → [{path: '/guide', file: 'guide.html', bytes: 531}, …]
// rendered.fixtures → byte-for-byte GET and empty HEAD cases, ready to extend
// rendered.count, rendered.bytes, rendered.directory
```

`prerenderPages` owns everything that is easy to get wrong and nothing that is
site-specific. It activates the source project, selects the active literal GET
function routes, renders each one through its middleware, checks the status and
content type, enforces the budgets, derives and validates a safe output filename,
writes the files and closes the runtime — then hands back metadata. It does not
write a project, choose response headers, copy assets or compile content: the
caller assembles a project, or a generated include, from `pages` and `fixtures`.

`assertNativeProject(project, {allow})` activates a project and proves it cannot
execute guest code to answer a request: every route is one of the allowed native
handlers and none carries middleware. `allow` defaults to `['page', 'static',
'download']`, which is what a real site serves; narrow it to `['page']` for a
page-only artifact. Run it on the **final assembled site**, not only on the
rendered pages, so what you deploy is what was checked.

| Option | Default | Meaning |
|---|---|---|
| `origin` | `http://localhost` | HTTP(S) origin a render sees; no path or credentials |
| `fileName` | `pageFileName` | Route path to filename; the path and the result are both validated either way |
| `ignoreUnrenderable` | `false` | Allow source routes this build will not render |
| `maxPages` | 500 | Pages in one render |
| `maxPageBytes` | 512 KiB | Bytes per rendered page |
| `maxTotalBytes` | 32 MiB | Bytes across the whole render |
| `log` | none | `{event: 'prerendered', path, file, bytes}` per page |

## What the helper guarantees

The runtime enforces its own protections when a generated project activates:
asset declarations reject absolute paths, traversal, dot segments, symlinks,
hardlinks and nonregular files, and static trees refuse `urlcode.yaml`,
`package.json`, `package-lock.json`, hidden entries, `node_modules` and
`.pem/.key/.p12/.pfx/.env` files. See [assets](ASSETS.md).

Those checks fail a deployment. The helper fails the build earlier and more
specifically:

- **Filenames are validated, never trusted.** `pageFileName` maps one route path
  to one flat name: segments joined with `~`, which cannot occur in a segment, so
  `/a/b` (`a~b.html`) and `/a-b` (`a-b.html`) are distinct rather than a silent
  collision, and the mapping stays injective for every accepted path. Dots,
  underscores and mixed case are fine, so a docs URL like `/docs/ASSETS.md`
  works. Parameters, wildcards, traversal and dot segments are rejected. A custom
  `fileName` hook is allowed — hashing the route is a reasonable choice — but its
  result goes through the same check: a flat name, no leading dot, not a
  protected name, `.html`, and unique **case-insensitively**, because on macOS
  and Windows two names differing only in case are one file.
- **Directories may not overlap.** In either direction: a build must not write
  into the reviewed source, nor read a source nested inside its output.
- **Nothing is written until everything renders.** Pages are held in memory and
  written only after the last one passes, and the pages directory must not
  already exist — it is created, along with any missing parents, only once every
  render has succeeded, so a failed build creates nothing at all. An existing
  pages directory is refused with an error carrying `code: 'EEXIST'`. If your
  artifact has a root above that directory, claiming it is yours: check it before
  calling, and let the helper create it as a parent after the render.
- **Every render is checked.** A non-200 status, a content type that is not
  `text/html`, an empty body, an oversized body or an exceeded aggregate budget
  fails the build instead of publishing a file.
- **Bytes are preserved.** The response body is a byte array, not a string. It is
  kept as a `Buffer` through the file and its fixture alike, so a multi-byte
  character is never re-encoded or truncated.
- **Skipping is explicit.** By default a source route the build would not render
  fails it, because silently rendering a subset publishes an incomplete site that
  looks whole. Pass `ignoreUnrenderable` when a mixed project is intended.
- **The runtime is always closed.** In a `finally`, so a failing build exits
  instead of hanging on its worker threads.

The helper is operator build tooling. It runs in Node with normal filesystem
access because it is not guest code; it does not itself widen a source route's
declared execution mode — a route with `sandbox: true` still renders isolated,
with no filesystem, and no host-code fallback is introduced for it. It is a
separate package export from the runtime for that reason. Review it as you
review any deployment tooling.

## Assembling a site

What the helper returns is deliberately not a project, because that is the part
every site does differently. A small site writes one `page` route per file, as
[`examples/prerender`](../examples/prerender/README.md) does in about twenty
lines. A larger one copies the rendered pages next to its own assets, adds
`static` and `download` routes and response security headers, keeps a committed
entry point and writes only a generated include, then extends `fixtures` with its
own cases before asserting the whole thing is native:

```js
const rendered = await prerenderPages(renderSource, 'project/public/pages');
for (const page of rendered.pages)
  config.routes[page.path] = {page: {file: `public/pages/${page.file}`}, response: {headers: security}};
await writeFile('project/generated/routes.yaml', stringify(config));
await writeFile('project/tests/requests.json', JSON.stringify([...rendered.fixtures, ...ownCases]));
await assertNativeProject('project');
```

Applying your own `response.headers` is expected; the helper never chooses them
for you and never discards them.

A site that renders straight into the tree it serves, rather than into a staging
project, needs no copy step at all — point `prerenderPages` at the pages
directory inside the serving project, keeping the render source outside it.

## Limits worth knowing before you design a site

| Limit | Value | Where |
|---|---|---|
| Function modules per snapshot | 127 | source project; the render splits into passes |
| Function module source bytes | 1 MiB each, 4 MiB total per snapshot | source project; the render splits into passes |
| Function/middleware response body | 1 MiB default (`--max-response-bytes`) | render step |
| Rendered page bytes | 512 KiB (`maxPageBytes`) | helper |
| Rendered pages, total bytes | 500, 32 MiB (`maxPages`, `maxTotalBytes`) | helper |
| Middleware entries per route | 16 | source project |
| Asset file size | 16 MiB | generated project |
| Total unique asset bytes | 64 MiB | generated project |
| Static entries traversed | 10,000 | generated project |
| Directory depth | 20 | generated project |

Startup snapshots asset bytes in memory, and a reload can briefly hold two
snapshots. A large site is bounded by the generated project's memory, not by the
render step. For collections beyond these budgets, publish to an external asset
service and redirect; provider asset adapters are not implemented.

## Function budgets

The first two rows above are the sandbox's snapshot budgets: at most 127 guest
modules and 4 MiB of module source in one snapshot. They are deliberate — part
of what [function security](FUNCTION-SECURITY.md) promises about sandboxed guest
code — and the render step does not relax them for trusted generated content.
Serving a project that crosses either still fails at startup, naming the module
that crossed it:

```
ConfigError: Function source limit exceeded: /pages/reference.mjs (12841 bytes)
    brings the snapshot to 4196103 bytes, over the total limit of 4194304 bytes
```

`prerenderPages` does not inherit that as a page ceiling. Before rendering it
measures each route's module closure, reading sources only, and packs the routes
into **passes** that each stay inside the budgets. It then builds one runtime per
pass, holding only that pass's snapshot, and renders that pass's pages. A render
that needs more than one pass logs `{event: 'prerender-passes', passes}`.

Nothing about the contract changes: all passes render before anything is
written, into one output directory that must not already exist, so a failure in
the last pass leaves no partial artifact — the same atomicity a single pass has.
Output filenames are checked for collision across passes, and `maxPages`,
`maxTotalBytes` and the returned fixtures count the whole render, not a pass.

Two consequences worth knowing:

- **A module shared by every page is paid for in every pass.** A template
  middleware is counted once per pass, not once per render, so it costs bytes
  against each pass's budget.
- **One route must still fit one snapshot.** A single route whose own modules
  and their imports exceed the budgets cannot be split, and fails with the
  collector's message. That is a route to make smaller, not a pass to add.

The `urlcode-docs` site rendered 62 documentation pages this way. That
repository has since been deleted, so no link is given; the runnable
version of the same pattern is [`examples/prerender`](../examples/prerender/README.md).

## Larger sites: generating the source project

The example keeps page content as reviewed literal `args` in YAML, which stays
readable and lets `dev` serve the site live. A site with hundreds of pages
instead generates its source project from host-prepared content: the build reads
its Markdown or data, compiles and sanitizes it in Node, writes a temporary
project whose routes carry that HTML as literal arguments, renders it with the
helper, and discards the temporary project.

That keeps every property intact — content is still reviewed input, guest code
still reads nothing from disk, and the published artifact is still inert. Two
things to hold onto:

- **Generated YAML is operator input.** It is written by your build, from your
  content, and reviewed like any other deployment artifact. Route YAML never
  gains the ability to name host code or a callback.
- **Sanitize before rendering, not after.** The template escapes the values it
  interpolates, but content injected as raw HTML is published as written. Whatever
  produces that HTML owns its safety.

The `urlcode-docs` site built itself this way before that repository was
retired. It was a working integration, not a deployment or performance claim.

## What this is not

Not a static-site generator: no Markdown, no sanitizer, no asset pipeline, no
incremental or watch build, no link checking, no sitemap. Not a way to make
native bodies readable. Not a template engine — the template is ordinary
middleware you write. Not a CLI command: prerendering is a step inside a build
that already runs JavaScript, so the helper is a library. Content compilation,
sanitization, search, asset assembly and deployment stay in the application.


Trusted build-time functions and middleware use ordinary Node imports, including
npm packages and dynamic imports. The pass planner applies source-graph budgets
only to `sandbox: true` routes; it does not parse trusted modules as sandbox
code. Page-count and output-byte budgets still apply to both modes. After
rendering, emit native page/file routes without middleware, then use the static
build target. Static hosting cannot execute middleware on incoming requests.
