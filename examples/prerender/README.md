# Prerender a dynamic project into a native static one

Three pages rendered by a function and one shared template middleware, then
rendered once at build time into a project that serves the same bytes with no
code on the request path at all.

The source routes run trusted and in-process, which is the default for
`function`/`middleware` and the right choice here: the page code is reviewed
first-party code that reads nothing but the literal arguments in
`urlcode.yaml`. Prerendering does not depend on that — a route declaring
`sandbox: true` prerenders the same way — and either way the generated project
runs no code at all.

Copy it with `urlcode examples add prerender --out prerender`, then from that
directory (`/operator/prerendered` is any output directory outside the project):

```sh
urlcode dev --project .                                  # the dynamic source, live
urlcode test --project .                                 # 7 fixtures
node prerender.mjs . /operator/prerendered
urlcode test --project /operator/prerendered             # fixtures the build wrote
urlcode audit --project /operator/prerendered --expect-routes 3
```

The same three URLs answer identically before and after. The difference is what
runs to serve them: the source project executes the function and its middleware
per request, the generated project reads a prevalidated byte buffer and runs no
project code at all.

| | Source project | Generated project |
|---|---|---|
| Handlers | 3 × `function` | 3 × `page` |
| Middleware | shared template | none |
| Project code per request | function + middleware | none |
| Content | reviewed literals in YAML | rendered HTML files |

`prerender.mjs` is operator build tooling, not a route handler. The
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
