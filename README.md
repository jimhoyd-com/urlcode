# URLCode

**A portable runtime for programmable URL behavior.** Define an application's
public URL surface in YAML, add isolated JavaScript only where declarative
handlers are not enough, and run the same project locally or on your own
infrastructure. Your routes, source and data remain yours. **URL behavior as code.**

[![Verify](https://github.com/jimhoyd-com/urlcode/actions/workflows/ci.yml/badge.svg)](https://github.com/jimhoyd-com/urlcode/actions/workflows/ci.yml)

[Documentation](docs/README.md) · [Starter](https://github.com/jimhoyd-com/urlcode-template) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

URLCode is not a URL shortener. Short links are one supported route type beside
redirects, validated HTTP responses, isolated request functions, middleware,
pages, static assets and downloads. It is also not a general Node web framework:
the project format intentionally describes bounded behavior that a runtime can
validate, inspect and eventually carry across hosting providers.

See [project direction](docs/PROJECT-DIRECTION.md) for the product boundary,
the relationship to application projects and the license.

## Status

`0.3.0` is the current local/self-hosted release of the implemented
contract, following `0.1.0`, the first stable one. It includes redirects, parameters, JavaScript
functions, middleware, live short-link storage, pages, static assets, downloads, starters, tests and process/container packaging. See the
[implemented contract](docs/SPECIFICATION.md), [operations guide](docs/OPERATIONS.md)
and [roadmap](ROADMAP.md) for limits and unfinished work.

Live-link storage uses separate bounded reader/writer pools. It requires a Node
build containing a patched SQLite version — 3.51.3 or newer, 3.50.7, or 3.44.6 —
which some current releases on a supported Node line do not carry. Run
`urlcode doctor` and check `liveLinks` before relying on it; everything else
runs on any supported Node.
See [pool controls and scaling limits](docs/DYNAMIC-LINKS.md#separate-reader-and-writer-pools).

URLCode is free and open-source software licensed under the
[Apache License 2.0](LICENSE). Commercial use, modification, redistribution and
self-hosting are permitted under its terms.

## Documentation

Start with the [YAML guide and recipe book](docs/YAML-GUIDE.md),
[complete field reference](docs/YAML-REFERENCE.md), and
[runnable 40-route cookbook](examples/cookbook/README.md). For AI-assisted
authoring, use [the AI guide](docs/AI-AUTHORING.md) and [llms.txt](llms.txt).
Follow [organization and readability practices](docs/BEST-PRACTICES.md) as your
project grows. Operators should read [capacity/concurrency](docs/CAPACITY.md) and the
[DDoS and recovery playbook](docs/RESILIENCE.md). Embedding the runtime from
TypeScript is covered in [TypeScript](docs/TYPESCRIPT.md). [All documentation](docs/README.md).

## Next-phase authoring and routing

The unreleased source after `0.3.0` adds [strict redirect interchange](docs/INTERCHANGE.md),
[local recipes](docs/RECIPES.md), [sharded bulk import](docs/BULK.md),
[build-time TypeScript guests](docs/TYPESCRIPT-AUTHORING.md), and a
[read-only authoring SDK/MCP](docs/TOOLING.md). These are unreleased changes;
use the schema and documentation from the same checked-out runtime revision.

```sh
urlcode recipes list
urlcode recipes add typescript --out ./hello-source
urlcode build-typescript --project ./hello-source --out ./hello-built
urlcode bulk-import csv redirects.csv --out ./imported --dry-run
urlcode mcp --project ./hello-built
```

[Conditional routing](docs/CONDITIONS.md) adds bounded exact matches and explicit
mutually exclusive cases without allowing duplicate YAML keys. Self-hosted
[proxy and webhook signals](docs/EGRESS.md) require external revision-pinned
origin grants and bounded host transport; guests gain no network API. The
[next-phase plan](docs/NEXT-PHASE-PLAN.md) records implementation scope and limits.
Provider adapters have a shared [conformance fixture and evidence runner](docs/PROVIDER-VERIFICATION.md);
actual AWS, Vercel and Cloudflare deployment observations remain pending.

## Start your own project

Use [urlcode-template](https://github.com/jimhoyd-com/urlcode-template) for a small
app with just a function route and a regular redirect. Clone it or use GitHub’s
**Use this template** button, then run `npm ci` and `npm run dev`. The runtime is
a pinned dependency; no separate checkout or global installation is needed.

```sh
git clone https://github.com/jimhoyd-com/urlcode-template.git my-links
cd my-links
npm ci
npm run dev
```

Live stored-link routes require **`dynamicLinks: true`** in the entry `urlcode.yaml`;
the starter explicitly sets false. Ordinary functions and parameterized redirects
do not need it. [Live-link setup](docs/DYNAMIC-LINKS.md).

## Built with URLCode

[urlcode-shortener](https://github.com/jimhoyd-com/urlcode-shortener) is a
standalone, account-free demo built on URLCode's public runtime and storage APIs.
It combines short links that expire after one hour or less, QR downloads, and a
shadcn/ui + Tailwind frontend. URLCode handles the page/assets and stored-link
redirects; the application adds anonymous creation and its own limits.

Read its [build retrospective](https://github.com/jimhoyd-com/urlcode-shortener/blob/main/docs/BUILD-RETROSPECTIVE.md)
for what the runtime supplied, what the application still needed, and proposed
improvements. The demo's license, hosting and production validation remain open;
it does not change URLCode's Apache-2.0 license or guest isolation model.

[urlcode-docs](https://github.com/jimhoyd-com/urlcode-docs) demonstrates URLCode
hosting a static documentation site with shadcn/ui and Tailwind. It syncs this
repository’s Markdown and examples at a pinned revision, applies templates through
sandboxed middleware during the build, and serves the output through native
page/static/download routes. This repository remains the documentation source of
truth. See the [docs-site retrospective](https://github.com/jimhoyd-com/urlcode-docs/blob/main/docs/BUILD-RETROSPECTIVE.md)
for reuse, integration work and upstream improvements. Hosting and a public domain
are not yet selected; the original site-code license is pending.

## Start from YAML

Already wrote `urlcode.yaml`? Run `urlcode scaffold --project ./my-links --dry-run`,
then remove `--dry-run` to create missing modules, pages and directories. Existing
files are preserved; code placeholders return 501 until implemented.
[Scaffolding guide](docs/SCAFFOLDING.md).

## Try it

Requires Node.js 22.13+; CI targets Node 22, 24 and 26 on macOS, Linux and
Windows. Every channel installs the same signed tarball, and all of them give
you a command called `urlcode` — the package is scoped, the binary is not.

```sh
npm install --global @jimhoyd/urlcode          # macOS, Linux, Windows
```

```sh
# macOS, Linux. brew trust is required for any third-party tap.
brew tap jimhoyd-com/urlcode
brew trust jimhoyd-com/urlcode
brew install urlcode
```

```sh
curl -fsSL https://raw.githubusercontent.com/jimhoyd-com/urlcode/main/install.sh | sh
```

The script checks the download against the release's `SHA256SUMS` before
installing, and takes `--prefix` so it needs no privileges. Then:

```sh
urlcode init my-urls && cd my-urls
urlcode dev
```

See [installation](docs/INSTALL.md) for project-local installs, building the
container image and verifying a release's signed provenance. To work from a
clone instead:

```sh
git clone https://github.com/jimhoyd-com/urlcode.git
cd urlcode
make dev
```

`make dev` installs dependencies if needed and starts the included function/redirect demo.
No global install, account, database, Docker or configuration step is required.
A clone runs the TypeScript source directly (`node src/cli.ts`, which needs
Node 22.18+); the installed package runs the built `dist/cli.js`.
Without Make (including Windows), use:

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:3000/hello/Ada` to run your custom function,
`/go` for a regular redirect.
Edit `starters/default/routes/` or `functions/hello.mjs` under
that starter; valid changes reload automatically. Press Ctrl+C to stop.
In another terminal, run `make test-project` or `npm run test:project`.

To create your own independent project:

```sh
make init DEST=../my-links
make dev PROJECT=../my-links PORT=3001
# Without Make:
npm run init -- ../my-links
npm run dev -- --project ../my-links --port 3001
```

Choose either command pair; initialization refuses to overwrite existing work.
[Starters](docs/STARTERS.md) are ordinary application files, independent of the
runtime checkout. Own them in your own Git repository. Global `npm link` remains
optional if you want the `urlcode` command everywhere. See
[local development](docs/LOCAL-DEVELOPMENT.md) for commands and troubleshooting.

## A URL that runs your function

A request to `/hello/Ada` runs your JavaScript and returns
`{"message":"Hello, Ada!"}`. Put this in `urlcode.yaml`:

```yaml
version: "1"
routes:
  /hello/{name}:
    parameters:
      - name: name
        in: path
        required: true
        schema: {type: string, minLength: 1, maxLength: 80}
    function:
      source: functions/hello.mjs
      args:
        name: {from: path, name: name}
    env:
      GREETING: {value: Hello}
```

And in `functions/hello.mjs`:

```js
export default function hello(request, { args, env }) {
  return Response.json({ message: `${env.GREETING}, ${args.name}!` });
}
```

Your function chooses the response: JSON, text, HTML, or a redirect via
`Response.redirect("https://example.com", 302)`. The starter includes
this runnable example. Functions run in an isolated sandbox; see its supported
[API and security boundaries](docs/FUNCTION-SECURITY.md).

## Reusable middleware

Add an ordered `middleware` list alongside any route handler:

```yaml
    middleware:
      - source: middleware/headers.mjs
```

```js
export default async function headers(request, context, next) {
  const response = await next();
  response.headers.set('x-example-middleware', 'active');
  return response;
}
```

Middleware can return a response early, share request-local `context.state`, or
wrap the handler with `await next()`. It runs in the same isolated sandbox and
under one deadline for the whole chain. The starter's function route includes
this example. See [middleware semantics and limits](docs/MIDDLEWARE.md) and the
[fourteen cookbook middleware examples](docs/MIDDLEWARE-EXAMPLES.md), also
available as `urlcode recipes add middleware`.

## A URL that redirects

```yaml
version: "1"
routes:
  /go:
    redirect:
      url: https://example.com
      status: 302
```

Ordinary redirects use an indexed lookup: no database, Lambda or per-route
user function. Configuration is compiled at startup, not parsed per request.
Literal paths win over parameterized routes; conflicting definitions fail validation.

Custom functions are ES modules using a documented text/JSON `Request`/`Response`
subset and validated context. See the
[starter](starters/default/urlcode.yaml) and [function](starters/default/functions/hello.mjs).
Functions are treated as untrusted and run inside a QuickJS/WebAssembly sandbox,
with a fresh heap per invocation. No Node APIs, filesystem, shell, network or
ambient environment is exposed. Independent worker deadlines bound execution.
External env/secret bindings require route-scoped operator grants pinned to the
project revision. See the [security model](docs/FUNCTION-SECURITY.md).

## Pages, files and downloads

Add these routes alongside your functions and redirects:

```yaml
  /about:
    page:
      file: public/about.html
  /assets/*:
    static:
      directory: public/assets
  /download:
    download:
      file: public/guide.txt
      filename: urlcode-guide.txt
```

Create the referenced files first. MIME types are detected from file extensions;
unknown types use `application/octet-stream`. Downloads set attachment headers.
Optional `contentType` overrides detection. HEAD, ETags, conditional requests and
single byte ranges are supported. Files are served natively without executing a
function. See [asset configuration and safety limits](docs/ASSETS.md).

## Organize routes across files

Keep everything in `urlcode.yaml`, or use its `includes` list to load files from
folders you choose. The [public template](https://github.com/jimhoyd-com/urlcode-template)
demonstrates a function file and a redirect file in a nested folder. All commands
see one combined project. See [organization examples](docs/ORGANIZATION.md).

## Route matching and adding links

Routes support exact paths and non-greedy single-segment parameters such as
`/r/{code}`. Only static-file mounts support a trailing `/*`; regex routing is
not supported. `dev` swaps validated configuration snapshots when YAML changes;
`serve` requires restart/redeployment for YAML changes. Stored short links can
now be created/updated/deleted live without reloads through the optional
[dynamic-link handler and management API](docs/DYNAMIC-LINKS.md). See [matching, precedence and dynamic-link behavior](docs/ROUTING.md).

## Create short links without restarting

```yaml
  /r/{code}:
    parameters:
      - name: code
        in: path
        required: true
        schema: {type: string, minLength: 1, maxLength: 128}
    link:
      collection: links
      code: {from: path, name: code}
```

Keep this route in YAML; store individual codes outside Git. Bind an optional
local SQLite store with `--link-store links=/absolute/links.sqlite`, then use
`urlcode links create` or the separate authenticated management API. Successful
record changes are visible without rewriting YAML or rebuilding the route table.
Ordinary YAML routes still need no database. See [setup, API and limitations](docs/DYNAMIC-LINKS.md).

## HTTP in YAML

Configure methods and validated path/query/header inputs, request body size and
media types, response headers, cookies, and declared text/JSON responses.
See the [HTTP configuration reference](docs/HTTP.md) for supported fields and
examples. Runtime framing and asset validators stay protected.

## Check your links before release

`urlcode routes` lists the configured routes. `urlcode audit --expect-routes 2`
checks the count, generates native response checks and reports missing route/method
coverage in your request fixtures. `urlcode benchmark --requests 1000 --concurrency 2`
measures your local project without following external redirects. Each command
accepts `--project`. See [readiness and release checks](docs/READINESS.md).

## Commands available

| Command | Purpose |
|---|---|
| `init <directory>` | Create an independent starter; refuse existing destinations |
| `add <url> --alias <code>` | Validate and atomically add a redirect; generate a code if omitted |
| `validate --local` | Validate config, references, bindings and function initialization; read `.env.local` |
| `dev` | Local server, watched reload and `.env.local` |
| `serve` | Fixed production process snapshot; environment injection, no dotenv loading |
| `test` | Local HTTP assertions from `tests/requests.json`; never follow redirects |
| `permissions` | Inspect requested bindings and project digest without executing code; grants nothing |
| `doctor` | Report runtime/platform details and implemented provider scope |

Use `--project <directory>` to select an app. Servers accept `--host`, `--port`
and `--origin` (public URL origin for functions). Bind defaults to `127.0.0.1`.

## Production direction

The free runtime is meant to be useful and production-capable for people who
operate it themselves. Current hardening includes strict YAML/schema checks,
request/response limits, worker deadlines, bounded function concurrency, safe
configuration replacement, graceful shutdown, health/readiness and structured
logs without request content. It still needs broader deployment/soak validation
and the remaining release features. Read [operations](docs/OPERATIONS.md) before
exposing a server. [Benchmark instructions and measurements](docs/PERFORMANCE.md)
are available; measurements are not capacity guarantees.

Git owns definitions and code. Secrets stay in ignored `.env.local` for development
or injected environment values for serving, accessible to functions only through
an explicit operator policy. Vercel, AWS Lambda and Cloudflare Workers each have a
target guide in [docs](docs/README.md); none has been deployed to its platform
yet. Provider secret-store integration, durable signal delivery and richer
monitoring remain future work. The unreleased source adds strict bulk conversion,
local recipes and best-effort signals. Unsupported config fails rather
than silently losing behavior. There is no required admin UI or database.

See [contributing](CONTRIBUTING.md), [security](SECURITY.md), and the
[roadmap](ROADMAP.md).

See [capabilities and normalized route representation](docs/CAPABILITIES.md) for the target catalog,
programmatic compatibility analysis and provider verification limits.
