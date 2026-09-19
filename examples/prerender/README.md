# Prerender a dynamic project into a native static one

Three pages rendered by a function and one shared template middleware, then
rendered once at build time into a project that serves the same bytes with
native `page` routes and no sandbox on the request path.

From the runtime checkout:

```sh
node src/cli.ts dev --project examples/prerender        # the dynamic source, live
node src/cli.ts test --project examples/prerender       # 7 fixtures
node examples/prerender/prerender.mjs examples/prerender /absolute/out
node src/cli.ts test --project /absolute/out            # fixtures the build wrote
node src/cli.ts audit --project /absolute/out --expect-routes 3
```

The same three URLs answer identically before and after. The difference is what
runs to serve them: the source project runs function and middleware code per
request, the generated project reads a prevalidated byte buffer.

| | Source project | Generated project |
|---|---|---|
| Handlers | 3 × `function` | 3 × `page` |
| Middleware | shared template | none |
| Guest execution per request | yes | none |
| Content | reviewed literals in YAML | rendered HTML files |

`prerender.mjs` is operator build tooling that runs in Node, not guest code. The
orchestration lives in the runtime's build helper:

```js
import {prerenderPages, assertNativeProject} from '@jimhoyd/urlcode/prerender';
```

`prerenderPages` activates the source project, renders each page through its
middleware, validates every response, enforces the budgets, derives safe
filenames, writes the files and closes the runtime. It fails the build rather
than publishing a bad page. What is left in this recipe is the part every site
does differently: assembling a project from the returned `pages` and `fixtures`,
then calling `assertNativeProject` to prove the artifact is inert. A larger site
assembles differently — its own static and download routes, response security
headers and a generated include — using the same helper.

The recipe renders content that is already prepared. It is not a Markdown
compiler, an HTML sanitizer, an asset pipeline or an incremental build, and it
copies no static tree. [Prerendering](../../docs/PRERENDER.md) documents the
helper, its options and guarantees, the limits and how a larger site generates
its source project.
