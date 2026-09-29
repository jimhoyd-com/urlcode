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
| `host.mjs` | operator | Two plain extension registrations: `probe` reports the origin, client address and same-origin verdict URLCode computed; `hono` mounts a whole Hono app |
| `hono/server.mjs` | operator | The Hono application hosting URLCode (`createRuntime` from `@jimhoyd/urlcode`) |
| `hono/urlcode-fetch.mjs` | operator | The bridge: a standard `Request` to `runtime.handle()` and back to a standard `Response` |

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
npm run start:hono       # the Hono host on http://localhost:4191; URLCode answers /app/*
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
- `urlcode review` reports Hono's in-process `app.fetch(request)` as an
  outbound network call (`outbound-network-call`, low confidence). This is a
  false positive: the pattern `\bfetch\s*\(` in
  `packages/core/src/review.ts:106` also matches a member call.
- Neither `explain` nor `review` names the npm packages a trusted route
  imports. The route is labelled trusted, and its dependency surface is
  opaque to review. The operator approval digest also covers only the entry
  file ([known gap](../../docs/FUNCTION-SECURITY.md#granting-selected-bindings)).

## 2. Hono as a second host

### Directions and capabilities

| Direction | How | Status |
|---|---|---|
| URLCode inside Hono | `createRuntime(project, {origin, extensions})` once before listening, then `app.all('/app/*', c => bridge(c.req.raw, {client, rawHeaders}))` | Works through the published API plus a 112-line operator bridge. The gaps are below |
| Hono inside URLCode, application side | A trusted function route returns `app.fetch(request)` | Works. Function routes have no wildcard, so every path shape is a declared route (`/app/sub/hello`, `/app/sub/items`, `/app/sub/items/{id}`), and URLCode still validates `{id}` |
| Hono inside URLCode, operator side | An `extension:` mount (`/app/hono/*`) whose registration calls `app.fetch` | Works. The app's router owns the paths under the mount. Review shows the mount as "provider-defined, not enumerated"; responses are buffered and no-store like any extension mount |

The reusable contract is not Hono-specific. It consists of `createRuntime`,
`runtime.handle(RuntimeRequest)` returning a `HandlerResult`, and
`runtime.requestLimit`, `errorFormat`, `errorHeaders` and `close`. The only
Hono-specific details are:

- reading the socket peer and raw header lines from `@hono/node-server`'s
  `c.env.incoming`;
- `mount()` stripping its prefix;
- the adapter's default content type.

Any host that can produce a `Request` and a client address can use the same
bridge.

### What was checked, both hosts side by side

| Area | Result |
|---|---|
| Routing | Hono's `/` and `/healthz` beside URLCode's `/app/*`. URLCode's 404, 405 with `Allow`, parameter 400, redirect and extension mounts are identical in both hosts |
| Request and response bodies | JSON and text in; zod 200/422; Hono sub-app JSON; the 1 MiB body limit refused with 413 before reading in both hosts |
| Headers and cookies | `X-Request-Id` (the same id the function sees), `nosniff` and default `no-store`; two `Set-Cookie` lines kept apart; custom request and response headers |
| Streaming | `stream: true` arrives chunk by chunk with no `Content-Length` in both hosts |
| The URL a function sees | Built from the operator `origin` in both, never from the `Host` the server received |
| Origin and same-origin | `ExtensionRequest.origin` is the operator origin. `isSameOriginRequest` admits the site origin and refuses a foreign or missing origin, `Sec-Fetch-Site: cross-site` and repeated `Origin` lines |
| Startup refusal | A stale revision pin, or a sandboxed direct import, exits 1 with URLCode's message and no stack; nothing listens |
| Shutdown | SIGTERM closes Hono's server, then `runtime.close()`; the port is released |

### Gaps

Each gap is observed in the test or read from the source at the location
given. None is fixed here.

1. **No public fetch-style or Node handler for an embedded runtime.** The
   rules that turn a `HandlerResult` into a response live in
   `packages/core/src/http-response.ts`: `prepareResponse` (line 50),
   `prepareStream` (line 95), `errorResponse` (line 208) and the error-code
   table (line 167). The package exports none of them, so
   `hono/urlcode-fetch.mjs` copies them and can drift from
   RIM-OUTPUT-001, RIM-ERRORS-001 and RIM-STREAM-001. `createVercelHandler`
   is the only exported `(req, res)` handler. It runs as target `vercel`,
   which refuses function routes (`packages/core/src/capabilities.ts:137`),
   so it is not an embedding option.
2. **Client address and trusted proxies belong to the host.**
   `compileTrustedProxies` and `resolveClient`
   (`packages/core/src/client-address.ts:42`, `:68`) are applied only in
   `startServer` (`packages/core/src/server.ts:288`) and are not exported.
   The bridge passes the socket peer and has no trusted-proxy list, so
   `X-Forwarded-For` is ignored even from a trusted proxy. That is safe, but
   it is not `--trusted-proxies`.
3. **The loopback `Host` check is lost.** `loopbackHostCheck`
   (`client-address.ts:126`, wired at `server.ts:349`) answers 421 to a
   foreign `Host` on a loopback bind. Under Hono the same request is served.
4. **Server-owned operations are absent.** Missing under Hono:
   - `/_urlcode/health`, `/ready` and `/metrics` (`server.ts:251`), and the
     readiness drain;
   - the per-request event log (`server.ts:321`; the test sees no `request`
     records from the Hono host);
   - in-flight admission (`server.ts:274`) and the header, request and
     keep-alive timeouts (`server.ts:225`);
   - the streamed-response limits (`StreamHost`, `server.ts:202`: concurrent
     streams, idle time, duration and bytes). The bridge's stream has none;
   - hot reload and watch (`server.ts:350`), `--data-dir`, and loading
     `--policy`/`--host-file` from the CLI. The host passes `permissions`,
     `extensions` and `plugins` to `createRuntime` itself.

   The embedder must provide each of these or do without it.
5. **Repeated request headers need the raw lines.** A fetch `Request` joins
   repeated header fields. `RuntimeRequest.headerCounts` is optional
   (`runtime.ts:90`), and a missing count reads as 0. The duplicate-header
   refusals therefore weaken on a pure-fetch host (Bun, Deno, a Worker):
   - duplicate scalar parameters (`match.ts:98`);
   - duplicate `Content-Type` (`http-policy.ts:90`);
   - repeated `Origin`/`Sec-Fetch-Site`/`Referer` (`extension-http.ts:191`).

   On Node the bridge passes `incoming.rawHeaders`, so the counts are exact,
   and the test checks repeated `Origin` in both hosts. A host with no raw
   lines cannot.
6. **No base path.** URLCode matches the full path it is given. Mounted with
   its full paths (`/app/*`), everything matches. Behind Hono's
   prefix-stripping `mount('/mounted', ...)`, the redirect it generates
   (`Location: /app/api/who/ada`) and a function's `request.url` both lose
   `/mounted`.
7. **Byte-level response differences.** A fetch `Headers` object joins
   repeated non-cookie response headers into one line, where RIM-OUTPUT-001
   writes separate lines. `@hono/node-server` adds
   `Content-Type: text/plain; charset=UTF-8` to any body without a type,
   such as URLCode's text 405. Status, body and every other compared header
   match.
8. **Reverse direction, application side, has no catch-all.** Function
   routes accept exact and `{param}` paths only, so a sub-app's routes are
   re-declared in YAML. Use an extension mount when the sub-app's router
   should own a prefix.

Express was not evaluated. It would need the same bridge plus a Node
`req`/`res` to `Request`/`Response` conversion, which `@hono/node-server`
already provides here.
