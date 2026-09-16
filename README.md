# URLCode

**URLs that run code.** Define redirects and request functions in portable YAML,
run them locally, and operate the same project on your own infrastructure.
Your URLs, your source, your data.

## Status

`0.1.0-alpha.1` is the first executable local/self-hosted implementation, not a
stable production release. It includes redirects, parameters, JavaScript
functions, starters, tests and process/container packaging. See the
[implemented contract](docs/SPECIFICATION.md), [operations guide](docs/OPERATIONS.md)
and [roadmap](ROADMAP.md) for limits and unfinished work.

The license remains undecided. No license has been applied and the npm package
is private to prevent accidental registry publication. Development and Git
pushes continue; do not assume permission terms have already been selected.

## Try it

Requires Node.js 22.13+ and npm; CI targets Node 22 and 24 on macOS, Linux and
Windows. Install the runtime from source (no registry release or Homebrew tap yet):

```sh
git clone https://github.com/jimhoyd-com/urlcode.git
cd urlcode
npm ci
npm run verify
npm link
urlcode init ../my-links --template dynamic
cd ../my-links
urlcode dev
```

Open `http://127.0.0.1:3000/go` for a redirect or
`http://127.0.0.1:3000/hello/Ada` for a custom function. In another terminal:

```sh
cd my-links  # use the directory you created above
urlcode test
urlcode add https://example.com/new --alias new
urlcode validate --local
```

If global linking is unavailable, invoke `/path/to/urlcode/src/cli.js` with
`node` instead of `urlcode`. [Starters](docs/STARTERS.md) are application files,
independent of the runtime checkout. Own them in your own Git repository.

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

Custom functions are ES modules receiving a standard `Request` and validated
context, and returning a standard `Response`. See the
[dynamic starter](starters/dynamic/urlcode.yaml) and [function](starters/dynamic/functions/hello.mjs).
Functions run in bounded workers with deadlines. They are trusted operator code,
not a security sandbox for untrusted tenants.

## Commands available

| Command | Purpose |
|---|---|
| `init <directory> --template redirects\|dynamic` | Create an independent starter; refuse existing destinations |
| `add <url> --alias <code>` | Validate and atomically add a redirect; generate a code if omitted |
| `validate --local` | Validate config, references, bindings and function initialization; read `.env.local` |
| `dev` | Local server, watched reload and `.env.local` |
| `serve` | Fixed production process snapshot; environment injection, no dotenv loading |
| `test` | Local HTTP assertions from `tests/requests.json`; never follow redirects |
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
or injected environment values for serving. Provider secret-store integration,
Cloudflare/AWS/Vercel adapters, CSV tools, templates/signals, static handlers,
Homebrew and richer monitoring are future work. Unsupported config fails rather
than silently losing behavior. There is no required admin UI or database.

Placecode and Peercode remain planned reference applications to prove the public
interfaces can support real businesses. Build and stabilize the free product
first; only then define and build optional managed URLCode Cloud.

See [contributing](CONTRIBUTING.md), [security](SECURITY.md), and the
[roadmap](ROADMAP.md).
