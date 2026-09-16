# URLCode

**URLs that run code.** Define redirects and request functions in portable YAML,
run them locally, and operate the same project on your own infrastructure.
Your URLs, your source, your data.

## Status

`0.1.0-alpha.7` is the isolated-function local/self-hosted alpha, not a
stable production release. It includes redirects, parameters, JavaScript
functions, middleware, pages, static assets, downloads, starters, tests and process/container packaging. See the
[implemented contract](docs/SPECIFICATION.md), [operations guide](docs/OPERATIONS.md)
and [roadmap](ROADMAP.md) for limits and unfinished work.

The license remains undecided. No license has been applied and the npm package
is private to prevent accidental registry publication. Development and Git
pushes continue; do not assume permission terms have already been selected.

## Documentation

Start with the [YAML guide and recipe book](docs/YAML-GUIDE.md),
[complete field reference](docs/YAML-REFERENCE.md), and
[runnable 17-route cookbook](examples/cookbook/README.md). For AI-assisted
authoring, use [the AI guide](docs/AI-AUTHORING.md) and [llms.txt](llms.txt).
Operators should read [capacity/concurrency](docs/CAPACITY.md) and the
[DDoS and recovery playbook](docs/RESILIENCE.md). [All documentation](docs/README.md).

## Start your own project

Use [urlcode-template](https://github.com/jimhoyd-com/urlcode-template) for a small
app with just a function route and a regular redirect. Clone it or use GitHub’s
**Use this template** button, then run `npm ci` and `npm run dev`. The runtime is
a pinned dependency; no separate checkout or global installation is needed.

```sh
git clone https://github.com/jimhoyd-com/urlcode-template.git gitroll-link
cd gitroll-link
npm ci
npm run dev
```

## Try it

Requires Node.js 22.13+ and npm; CI targets Node 22 and 24 on macOS, Linux and
Windows. Install the runtime from source (no registry release or Homebrew tap yet):

```sh
git clone https://github.com/jimhoyd-com/urlcode.git
cd urlcode
make dev
```

`make dev` installs dependencies if needed and starts the included function/redirect demo.
No global install, account, database, Docker or configuration step is required.
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
make init DEST=../gitroll-link
make dev PROJECT=../gitroll-link PORT=3001
# Without Make:
npm run init -- ../gitroll-link
npm run dev -- --project ../gitroll-link --port 3001
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
this example. See [middleware semantics and limits](docs/MIDDLEWARE.md).

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
`serve` requires restart/redeployment. Live user-created link storage is future
work. See [matching, precedence and dynamic-link behavior](docs/ROUTING.md).

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
an explicit operator policy. Provider secret-store integration,
Cloudflare/AWS/Vercel adapters, CSV tools, templates/signals,
Homebrew and richer monitoring are future work. Unsupported config fails rather
than silently losing behavior. There is no required admin UI or database.

Placecode and Peercode remain planned reference applications to prove the public
interfaces can support real businesses. Build and stabilize the free product
first; only then define and build optional managed URLCode Cloud.

See [contributing](CONTRIBUTING.md), [security](SECURITY.md), and the
[roadmap](ROADMAP.md).
