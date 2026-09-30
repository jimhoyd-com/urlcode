# Single-page app shell

A prebuilt single-page app (React, Vue, Svelte or plain JavaScript) routes in
the browser: `/projects/42/settings` exists only in its client router. A
reload or a shared link sends that path to the server, which must answer with
the app's `index.html` so the router can take over. URLCode has no native SPA
fallback ([assets][docs/ASSETS.md]), and no YAML route can answer a
`page` at any depth. This recipe is the tested composition for it
([#809](https://github.com/jimhoyd-com/urlcode/issues/809)): native YAML for
everything it can express, including the API's JSON errors (`site.errors`),
plus one small operator plugin for the one thing it cannot: the shell.

Save [the host file](#the-host-file) outside the project, then run:

```sh
urlcode validate --local --project . --host-file /operator/host.mjs
urlcode test --project . --host-file /operator/host.mjs
urlcode audit --project . --expect-routes 4 --host-file /operator/host.mjs
urlcode dev --project . --host-file /operator/host.mjs
```

Any path outside the project works, for example `host.mjs` beside an `app/`
project directory with `--project app --host-file host.mjs`.

## What YAML owns and what the plugin owns

| Request | Answered by | Result |
|---|---|---|
| `/` | `page` (YAML) | the shell, `no-cache` |
| `/assets/app.js` | `static` on `/assets/*` (YAML) | the file, cached one hour; missing files 404 |
| `/api/status` | `respond` (YAML) | `{"ok":true,"service":"spa-shell"}`, `no-store` |
| `/api/status`, POST | `methods` (YAML) and `site.errors` | 405 with `Allow: GET, HEAD` and the JSON error envelope |
| `/robots.txt`, `/index.html` | `static` on `/*` (YAML) | the file under `public/`; missing files 404 |
| `/projects/42/settings?tab=members`, GET or HEAD | the `spa-shell` plugin on the `/*` route | the shell, `text/html`, `no-cache` |
| `/projects/42`, POST (any method but GET/HEAD) | `static` on `/*` (YAML) | 405 with `Allow: GET, HEAD` |
| `/api/anything-else`, GET or HEAD | `static` on `/*` (YAML) and `site.errors` | `{"error":{"code":"NOT_FOUND","message":"Not found"}}` 404 JSON, `no-store` |
| `/api/anything-else`, other methods | `static` on `/*` (YAML) and `site.errors` | 405 with `Allow: GET, HEAD`, JSON envelope `METHOD_NOT_ALLOWED` |
| `/assets`, `/assets/client/route` | `static` (YAML) | 404, never the shell |

The `/*` static mount is what lets the runtime match an unseen path of any
depth; on its own it answers 404 for a path with no file. The plugin's
`onRequest` runs only when the matched route is that catch-all and answers the
shell for an extensionless GET or HEAD. It returns nothing for everything
else, so the mount answers natively. A path with a dot segment or an extension
in its last segment (`/missing.png`, `/.env`) is a file request: the mount
serves the file or answers 404. The plugin leaves `/api` alone (it is in
`exclude`), so the mount answers there too, and `site.errors` makes every
error the runtime writes under `/api/*` the fixed JSON envelope instead of a
text line ([error format][docs/HTTP.md#error-format]). An API client gets
JSON, never HTML, for a path no route declares. Because `/*` matches every
path, a method other than GET or HEAD on an undeclared API path is the mount's
405 (with `Allow`), not a 404.

The plugin never reads or rewrites a response, and neither does `site.errors`:
it only chooses how the runtime writes its own errors. Every other route's
answer, including a policy denial and an extension's 401, is written exactly as
it was produced. When the `/*` route itself is
protected (`auth: true`), plugins run after authorization, so a denied client
path gets the denial, not the shell.

## The host file

Save it as `/operator/host.mjs`: `--host-file` refuses a path inside the
project. It is trusted operator code with the host's
privileges, like every [host plugin][docs/PLUGINS.md]. With no
extensions in the list, `composeHost` needs no project revision pin.

```js
// host.mjs, beside the project directory: trusted operator code, never part of the project.
import {readFile, realpath} from 'node:fs/promises';
import {isAbsolute, join, relative, sep} from 'node:path';
import {composeHost} from '@jimhoyd/urlcode/host';

const under = (path, prefix) => path === prefix || path.startsWith(prefix + '/');
// A segment starting with a dot, or a last segment with an extension, names a file: the mount answers it.
const fileLike = path => {const parts = path.split('/'); return parts.some(part => part.startsWith('.')) || parts.at(-1).includes('.');};

export function spaShell({route = '/*', shell = 'public/index.html', exclude = ['/assets', '/api']} = {}) {
  let body;
  return {
    name: 'spa-shell', version: '1', targets: ['node'],
    async onActivate({root, testPlan}) {
      if (testPlan().inventory.find(entry => entry.path === route)?.handler !== 'static') throw new Error(`spa-shell needs a static ${route} route`);
      const base = await realpath(root), file = await realpath(join(base, shell)), inside = relative(base, file);
      if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith('..' + sep)) throw new Error('spa-shell: the shell must be a file inside the project');
      body = await readFile(file);
    },
    onRequest(request) {
      // Only the catch-all mount: every other route, and every denial, answers natively.
      if (request.route !== route) return undefined;
      // Other methods, excluded prefixes and file-like paths fall through to the mount: 405, the file or 404.
      if (request.method !== 'GET' && request.method !== 'HEAD') return undefined;
      if (exclude.some(prefix => under(request.path, prefix)) || fileLike(request.path)) return undefined;
      return {status: 200, headers: [['content-type', 'text/html; charset=utf-8'], ['cache-control', 'no-cache']], body};
    },
  };
}

export default await composeHost(import.meta.url, [], {plugins: [spaShell()]});
```

`spaShell()` options:

- `shell`: the project-relative shell file. Activation refuses a path that
  resolves outside the project, through `..` or a symlink, and reads it again
  on every reload, so a new build needs a reload like any other asset.
- `route`: the catch-all static route; activation refuses when the project has
  no static route by that name.
- `exclude`: prefixes that never get the shell (the mount answers: the file,
  404 or 405). Add every namespace that is not a client route. Declare the
  real API endpoints in YAML; they match before the catch-all. List an API
  prefix in `site.errors.paths` as well, so its errors are JSON.

## Replacing the fixture frontend

Copy your build output into `public/` (`index.html` at the top, bundles under
`public/assets/`), keep the asset URLs root-relative (`/assets/...`), and use
`public, max-age=31536000, immutable` on `/assets/*` only when the bundler
fingerprints file names. Add JSON endpoints under `/api/` as `respond` routes,
or functions when the answer must be computed per request.

## Limits

- The plugin needs the self-hosted Node runtime. The project alone reports
  AWS and Vercel as compatible, but without the plugin every client path is a
  404; the Cloudflare Worker takes no plugins, and the static export has no
  runtime at all. The API's JSON errors are YAML (`site.errors`), so they hold
  with or without the host file.
- A shell answer from the plugin short-circuits the `/*` route's own request
  policies (`throttle`, `agents`, `cache`), because unprotected-route plugins
  run before them ([ordering][docs/PLUGINS.md#ordering]). Put policies you
  need on the client routes in the operator host, or protect the route.
- The shell is sent whole: no ETag, conditional or range handling, unlike the
  native `/` page.
- The exclusion and file-name rules are the plugin's, not the runtime's;
  review them for your app's URL scheme. Report a need for a native fallback
  on [#809](https://github.com/jimhoyd-com/urlcode/issues/809).

<!-- x-release-please-start-version -->
[docs/ASSETS.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/ASSETS.md
[docs/HTTP.md#error-format]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/HTTP.md#error-format
[docs/PLUGINS.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/PLUGINS.md
[docs/PLUGINS.md#ordering]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/PLUGINS.md#ordering
<!-- x-release-please-end -->
