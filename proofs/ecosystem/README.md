# Ecosystem conformance fixture

Two bounded checks for the ecosystem-compatibility acceptance items of
[#841](https://github.com/jimhoyd-com/urlcode/issues/841):

1. **Direct npm library use.** A trusted function route imports an ordinary
   npm library, [zod](https://zod.dev/) `4.6.5` (pinned exactly), through its
   own API. There is no URLCode adapter, extension descriptor, catalog entry or
   wrapper.
2. **A second, materially different host.** URLCode runs inside a
   [Hono](https://hono.dev/) application (`hono` `4.13.10` on
   `@hono/node-server` `2.1.1`). Hono owns the HTTP server and its own routes,
   and URLCode serves `/app/*`. The reverse direction, a Hono app served from
   URLCode, is covered too.

This is a conformance fixture, not a starter, an adapter package or a release
claim. `test/ecosystem.integration.ts` (`npm run test:ecosystem`) packs this
checkout's core as a release does and installs it with the three libraries
into a copy of this directory. It then runs every check below against URLCode's
own server (`urlcode serve`) and the Hono host side by side. Installation needs
the npm registry; nothing after it does.

## Layout

| Path | Owner | What it is |
|---|---|---|
| `app/urlcode.yaml` | application | Every route; nothing in it names zod, Hono or a package |
| `app/functions/validate.mjs` | application | `import * as z from 'zod'` and a zod schema; 200 with the parsed value or 422 with zod's issue codes |
| `app/functions/hono-subapp.mjs` | application | A Hono app answering from trusted function routes (`export default request => app.fetch(request)`) |
| `app/functions/echo.mjs`, `stream.mjs` | application | What a function sees of a request; a `stream: true` body |
| `app/tests/requests.json` | application | Declarative fixtures for `urlcode test` |
| `sandboxed/` | application | The same zod import on a `sandbox: true` route; expected to be refused |
| `host.mjs` | operator | Two plain extensions with no package, defined with `defineExtension` and composed by `composeHost` (which a hermetic `urlcode test` requires): `probe` reports the origin, client address and same-origin verdict URLCode computed; `hono` mounts a whole Hono app |
| `hono/server.mjs` | operator | The Hono application hosting URLCode (`createRuntime` and `createEmbeddedHandler` from `@jimhoyd/urlcode`) |

## Run it

From a checkout, after `npm run build`:

```sh
npm run test:ecosystem
```

To try it by hand, `npm install` in this directory; `@jimhoyd/urlcode` links the
checkout. Then pin the extensions in `host.mjs` to the reviewed revision.
`urlcode extensions --project app --host-file host.mjs` prints it:

```sh
export PROJECT_SHA256=<revision>
npm test                 # the declarative fixtures on URLCode's own harness
npm start                # URLCode's own server on http://localhost:4190
npm run start:hono       # the Hono host on http://localhost:4191; URLCode answers /app/* (and /mounted/app/*)
```

## 1. Direct library use

**Supported:** any trusted `function`/`middleware` route on the self-hosted
Node runtime, including a runtime embedded in another Node host. Imports
resolve the way any Node ESM module's do
([function security](../../docs/FUNCTION-SECURITY.md#what-the-trusted-default-can-and-cant-do)).

| Check | Result |
|---|---|
| zod is installed as an ordinary dependency, with no `urlcode` key or `urlcode.json`, and nothing in `urlcode.yaml` names it | holds |
| `urlcode validate --local` and `urlcode test`, zod accepting and rejecting, on the packed consumer | pass |
| The same responses through URLCode's server and the Hono host | identical |
| The same import on a `sandbox: true` route (`sandboxed/`) | refused before serving by `validate`, `serve` and the embedded `createRuntime`: `code: sandbox-import`, "`/functions/validate.mjs imports "zod". A sandbox: true function has no Node built-ins or packages...`" |
| `urlcode explain /app/api/validate` | `execution: trusted (in-process)`, `sandbox: false`, and the note that handler execution is not evaluated |

Direct use grants nothing. It adds no binding, egress or capability, and
operator grants, revision pins and target refusals apply unchanged. Functions
are refused on the Cloudflare, AWS, Vercel and static targets, so direct
library use in a function is self-hosted (or embedded Node) only.

Review findings, recorded as the test asserts them:

- `urlcode review` suggests `request.body.POST.schema` as the native
  alternative to the zod code (`manual-body-validation`). That fits the
  declarative-first rule: where a JSON Schema body contract expresses the
  rule, it is the better choice, and zod is for what it cannot express.
- `urlcode review` does not report Hono's in-process `app.fetch(request)` as
  an outbound network call: `app` is built from an imported `Hono`, so the
  member call is recognised as in-process. (It used to be a false positive;
  see [the review rule](../../docs/TOOLING.md#project-review).)
- `review` names the directly imported npm packages and records bounded local
  import dependencies and npm metadata in the approval digest. Package code,
  dynamic loading and other opaque dependencies still need human review; the
  lockfile does not attest installed bytes. See
  [trusted dependency review](../../docs/FUNCTION-SECURITY.md#trusted-dependency-review).


## 2. Hono as a second host

### Directions and capabilities

| Direction | How | Status |
|---|---|---|
| URLCode inside Hono | `createRuntime(project, {origin, extensions})` once before listening, then `createEmbeddedHandler(runtime, {origin, trustedProxies, loopbackHost})` and `app.all('/app/*', c => urlcode(c.req.raw, {peer, rawHeaders}))`; `app.mount('/mounted', …)` uses a second handler with `basePath: '/mounted'` | Works through the published API; the only glue is reading the peer and raw header lines. The remaining gaps are below |
| Hono inside URLCode, application side | A trusted function route returns `app.fetch(request)` | Works. Function routes have no wildcard, so every path shape is a declared route (`/app/sub/hello`, `/app/sub/items`, `/app/sub/items/{id}`), and URLCode still validates `{id}` |
| Hono inside URLCode, operator side | An `extension:` mount (`/app/hono/*`) whose registration calls `app.fetch` | Works. The app's router owns the paths under the mount. Review shows the mount as "provider-defined, not enumerated"; responses are buffered and no-store like any extension mount |

The reusable contract is not Hono-specific: `createRuntime`, then
`createEmbeddedHandler` ([hosting inside another framework](../../docs/OPERATIONS.md#hosting-urlcode-inside-another-framework)),
then `runtime.close()`. The only Hono-specific details are:

- reading the socket peer and raw header lines from `@hono/node-server`'s
  `c.env.incoming`;
- `mount()` stripping its prefix, which `basePath` restores;
- the adapter's default content type.

Any host that can produce a `Request` and a client address can use the same
handler; one without raw header lines declares `headerLines: 'unavailable'`.

### What was checked, both hosts side by side

| Area | Result |
|---|---|
| Routing | Hono's `/` and `/healthz` beside URLCode's `/app/*`. URLCode's 404, 405 with `Allow`, parameter 400, redirect and extension mounts are identical in both hosts |
| Request and response bodies | JSON and text in; zod 200/422; Hono sub-app JSON; the 1 MiB body limit refused with 413 before reading in both hosts |
| Headers and cookies | `X-Request-Id` (the same id the function sees), `nosniff` and default `no-store`; two `Set-Cookie` lines kept apart; custom request and response headers |
| Streaming | `stream: true` arrives chunk by chunk with no `Content-Length` in both hosts |
| The URL a function sees | Built from the operator `origin` in both, never from the `Host` the server received |
| Origin and same-origin | `ExtensionRequest.origin` is the operator origin. `isSameOriginRequest` admits the site origin and refuses a foreign or missing origin, `Sec-Fetch-Site: cross-site` and repeated `Origin` lines |
| Client address | The socket peer; `X-Forwarded-For` from a trusted proxy (`--trusted-proxies` / `trustedProxies`) resolves to the client, and a repeated one is ignored, in both hosts |
| Loopback `Host` admission | A foreign `Host` is refused with 421 by both hosts on URLCode's paths (`loopbackHost`); Hono's own routes are Hono's to guard |
| Base path | Behind `mount('/mounted', …)`, the redirect is `/mounted/app/api/who/ada` and a function's URL keeps `/mounted` |
| Startup refusal | A stale revision pin, or a sandboxed direct import, exits 1 with URLCode's message and no stack; nothing listens |
| Shutdown | Explicit `close()` closes Hono's server, then `runtime.close()`, and releases the port on every platform. The SIGTERM handler is checked on Unix; Windows process termination does not invoke it |

### Gaps

Each gap is observed in the test or read from the source at the location
given. The embedded handler (#889) closed the earlier ones: the missing
response adapter (the fixture no longer copies core's response rules),
trusted-proxy client resolution, the loopback `Host` check, repeated request
headers (raw lines on Node, `headerLines: 'unavailable'` elsewhere) and the
base path.

1. **Server-owned operations stay with `urlcode serve`.** Missing under Hono,
   as [operations](../../docs/OPERATIONS.md#hosting-urlcode-inside-another-framework)
   lists them:
   - `/_urlcode/health`, `/ready` and `/metrics`, and the readiness drain;
   - the per-request event log (the test sees no `request` records from the
     Hono host);
   - in-flight admission and the header, request and keep-alive timeouts;
   - the streamed-response limits (`StreamHost`: concurrent streams, idle
     time, duration and bytes);
   - trusting an upstream `X-Request-Id`;
   - hot reload and watch, `--data-dir`, and loading `--policy`/`--host-file`
     from the CLI. The host passes `permissions`, `extensions` and `plugins`
     to `createRuntime` itself.

   The embedder must provide each of these or do without it.
2. **A pure-fetch host counts repeated headers conservatively.** With
   `headerLines: 'unavailable'` (Bun, Deno, a Worker), a joined header value
   containing a comma counts as two lines, so the duplicate-header refusals
   still fire, and a single line with a legitimate comma in a checked header
   is refused too. On Node the host passes `incoming.rawHeaders` and the counts
   are exact.
3. **The base path covers `Location` and `request.url` only.** Links inside
   HTML bodies and absolute URLs generated from `origin` (sitemaps, canonical
   links) are not rewritten.
4. **Byte-level response differences.** A fetch `Headers` object joins
   repeated non-cookie response headers into one line, where RIM-OUTPUT-001
   writes separate lines. `@hono/node-server` adds
   `Content-Type: text/plain; charset=UTF-8` to any non-empty body without a
   type, such as URLCode's text 405. Status, body and every other compared
   header match.
5. **Reverse direction, application side, has no catch-all.** Function
   routes accept exact and `{param}` paths only, so a sub-app's routes are
   re-declared in YAML. Use an extension mount when the sub-app's router
   should own a prefix.

Express was not evaluated. It would need the same handler plus a Node
`req`/`res` to `Request`/`Response` conversion, which `@hono/node-server`
already provides here.
