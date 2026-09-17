# YAML guide and recipe book

This guide targets URLCode 0.1.0. Start with the function example below,
then add only the fields your route needs. The authoritative machine-readable
shape is [JSON Schema](../schemas/urlcode.schema.json); semantic rules are in the
[specification](SPECIFICATION.md). Unsupported fields fail validation.

## Run all the examples

The [cookbook project](../examples/cookbook/urlcode.yaml) includes the six stateless handler
types, middleware, typed/defaulted inputs, methods, response headers, body checks,
expiry and file organization. Its referenced JavaScript and assets are included.
From the runtime checkout:

```sh
npm ci
node src/cli.js validate --project examples/cookbook
node src/cli.js test --project examples/cookbook
node src/cli.js audit --project examples/cookbook --expect-routes 21
node src/cli.js dev --project examples/cookbook
```

The cookbook is a larger learning project. The normal `urlcode init ../gitroll-link`
remains a small two-route starter. For an independent application with a pinned
runtime dependency, clone [urlcode-template](https://github.com/jimhoyd-com/urlcode-template).

## 1. A URL that runs code

A complete `urlcode.yaml`:

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

Create `functions/hello.mjs`:

```js
export default function hello(request, {args, env}) {
  return Response.json({message: `${env.GREETING}, ${args.name}!`});
}
```

GET `/hello/Ada` returns JSON. HEAD invokes the function and suppresses the body.
Methods default to GET and HEAD. Function paths resolve from the project root,
not the YAML file's directory. `.js` and `.mjs` ES modules work; TypeScript, Node
APIs, npm imports, network access and filesystem access do not.

## 2. Ordinary and permanent redirects

The following snippets are **entries under `routes:`** unless stated otherwise:

```yaml
  /go:
    redirect:
      url: https://example.com/
  /moved:
    redirect:
      url: https://example.com/new
      status: 308
    response:
      headers:
        Cache-Control: public, max-age=60
```

302 is the default. Allowed codes are 301, 302, 303, 307 and 308. Choose status
and cache policy deliberately: a cached permanent redirect can outlive a server
rollback. Requests' query strings are not forwarded by default. No function or
middleware means no sandbox execution for these routes.

## 3. Parameterized redirects and explicit query forwarding

```yaml
  /product/{id}:
    parameters:
      - name: id
        in: path
        required: true
        schema: {type: string, minLength: 1, maxLength: 64}
      - name: page
        in: query
        schema: {type: integer, minimum: 1, maximum: 100, default: 1}
      - name: tag
        in: query
        schema: {type: array, items: {type: string}, maxItems: 3}
      - name: x-channel
        in: header
        schema: {type: string, enum: [web, email], default: web}
    redirect:
      url: https://example.com/products/{id}
      query:
        map:
          page: {from: query, name: page}
          label: {from: query, name: tag}
          channel: {from: header, name: x-channel}
        pass: [utm_source]
```

`/product/abc?page=2&tag=red&tag=blue&utm_source=news&ignored=no` redirects to
`https://example.com/products/abc?page=2&label=red&label=blue&channel=web&utm_source=news`.
The unknown `ignored` key is dropped. Missing `page` becomes 1. Arrays produce
repeated destination keys. Invalid page values return 400 before redirecting.

Destination hosts/schemes are literal HTTP(S); path placeholders are safely
encoded. No arbitrary input-controlled host, credentials, secret interpolation,
or unrestricted `pass: true`. Mapping/passthrough keys must not collide with
existing destination keys. Header inputs are client-supplied values, not proof
of identity. See [input and redirect semantics](SPECIFICATION.md).

## 4. Input types and constraints

Use this list under a route's `parameters` when those inputs are needed:

```yaml
    parameters:
      - name: search
        in: query
        required: true
        schema: {type: string, minLength: 1, maxLength: 200}
      - name: page
        in: query
        schema: {type: integer, minimum: 1, default: 1}
      - name: weight
        in: query
        schema: {type: number, minimum: 0, maximum: 1}
      - name: preview
        in: query
        schema: {type: boolean, default: false}
      - name: category
        in: query
        schema: {type: string, enum: [docs, news], default: docs}
      - name: ids
        in: query
        schema: {type: array, items: {type: integer}, maxItems: 10}
```

Path inputs must be required strings with no default. Query/header scalar types
are string, integer, number and boolean; arrays are query-only. Booleans are
exactly `true`/`false`; numbers do not accept exponent notation or whitespace.
Defaults apply to absence, not empty strings. Duplicate scalar values fail.
Required, missing and invalid inputs return 400. This is a documented subset,
not full OpenAPI/JSON Schema: no `pattern`, `format`, nested input objects,
`oneOf`, `style` or `explode` in parameter schemas.

## 5. Methods and body validation

```yaml
  /echo:
    methods: [POST]
    request:
      body:
        required: true
        maxBytes: 4096
        contentTypes: [application/json]
        format: json
    function:
      source: functions/echo.mjs
```

```js
export default async function echo(request) {
  return Response.json(await request.json());
}
```

This validates JSON syntax/media type/UTF-8 and body size, not an application
object schema. Validate business fields in code. Empty required body: 400;
oversized body: 413; wrong media type: 415. For text, use `contentTypes:
[text/plain]`, `format: text`, and `request.text()`; see the runnable `/text`
recipe. `maxBytes: 0` can reject nonempty bodies. Bodies are buffered, not streamed.

Allowed methods: GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS. An explicit list
replaces the defaults: `[GET]` does not add HEAD. Wrong method returns 405 with
Allow. Asset handlers accept only GET/HEAD. Body bytes are not automatically
mapped to function arguments.

## 6. All function argument sources

Within `function.args`, supported values are:

```yaml
      args:
        label: campaign
        attempts: 3
        preview: false
        code: {from: path, name: code}
        page: {from: query, name: page}
        channel: {from: header, name: x-channel}
        greeting: {env: GREETING}
        token: {secret: TOKEN}
```

This is a field-shape illustration: declare the referenced path/query/header
inputs and route binding aliases before using it. Null, array and arbitrary
object arguments are not supported. Read `context.args` or directly access
`context.inputs.path/query/header`, `context.env` and `context.secrets`.
`function.export` selects a named export; omit it for `default`.

For a dynamic redirect, use validated choices instead of accepting any URL:

```js
export default function choice(request, {args}) {
  const destinations = {docs: 'https://example.com/docs', home: 'https://example.com/'};
  return Response.redirect(destinations[args.destination], 302);
}
```

The runnable `/choice` recipe declares an enum query input and binds it to args.
Functions can return `Response.json(...)`, `new Response('text', {status, headers})`,
or `Response.redirect(...)`. HTML is a string response with Content-Type text/html;
escape untrusted values yourself. See the exact [guest API](SPECIFICATION.md#functions).

## 7. Middleware before and after a handler

```yaml
  /go-with-header:
    middleware:
      - source: middleware/headers.mjs
        export: decorate
    redirect: {url: 'https://example.com/'}
```

```js
export async function decorate(request, context, next) {
  context.state.example = 'cookbook';
  const response = await next();
  response.headers.set('x-middleware', context.state.example);
  return response;
}
```

Entries run in declared order before the handler and reverse order afterward.
Return a Response early to skip downstream code; call `next()` at most once.
Up to 16 middleware entries share one sandbox/deadline and approved route
bindings. Native bodies are opaque; preserving them requires retaining original
status/headers. Return a new Response to replace native content or destination.
YAML response headers apply last. See [middleware](MIDDLEWARE.md) for details.

## 8. Native responses, headers and cookies

```yaml
  /status:
    respond:
      json: {ok: true, service: gitroll-link}
  /notice:
    respond:
      status: 503
      text: Temporarily unavailable
    response:
      headers:
        Retry-After: "60"
  /empty:
    respond: {status: 204}
  /cookie-demo:
    respond: {text: Non-secret preferences only}
    response:
      headers:
        Set-Cookie:
          - "theme=light; Path=/; Secure; SameSite=Lax"
          - "notice=seen; Path=/; HttpOnly; Secure; SameSite=Lax"
```

`respond` defaults to 200. Use text or JSON, never both. Omit both for an empty
body; 204/205 must have no body. 206/304 belong to native asset handling.
Header values are literal strings; quote numeric-looking values. Only Set-Cookie
accepts arrays. Do not put live session tokens in YAML. Secure cookies require
HTTPS at the browser. Functions can create dynamic cookies, but no cookie
parsing/signing/authentication framework is built in.

Do not set Content-Length, Location, Allow, ETag, Content-Range or other
runtime-owned headers in YAML. Use the corresponding handler. The full reserved
list and precedence rules are in [HTTP](HTTP.md).

## 9. Explicit OPTIONS response (not automatic CORS)

```yaml
  /preflight:
    methods: [OPTIONS]
    respond: {status: 204}
    response:
      headers:
        Access-Control-Allow-Origin: https://app.example.com
        Access-Control-Allow-Methods: GET, HEAD
        Access-Control-Allow-Headers: Content-Type
```

This teaches declared headers only; it is not a working cross-origin GET API.
For a real API, OPTIONS and the actual methods must be handled on the same URL,
and actual responses also need the appropriate CORS headers. Because one path
has one handler, use a function with `[GET, HEAD, OPTIONS]` to branch on method.
Never reflect arbitrary Origin with credentials. Automatic CORS is unsupported.

## 10. Pages, static folders, downloads and MIME

```yaml
  /about:
    page:
      file: public/about.html
      cacheControl: no-cache
  /assets/*:
    static:
      directory: public/assets
      index: index.html
      cacheControl: public, max-age=3600
  /download:
    download:
      file: public/guide.txt
      filename: urlcode-guide.txt
      contentType: text/plain
      cacheControl: no-store
```

All files must exist. MIME is detected by extension, not content sniffing; unknown
extensions become application/octet-stream. `contentType` overrides detection
without MIME parameters. An override on a static mount affects all its files.
The download name defaults to the source basename. `index` is opt-in and only
applies to slash-terminated requests. No automatic slash redirect or SPA fallback.

Cache choices: `no-cache` (asset default), `no-store`, `public, max-age=3600`,
`public, max-age=31536000, immutable`. Reserve immutable caching for versioned
URLs. GET/HEAD, ETag/date validation and single byte ranges are supported.
Files stay snapshotted until reload/restart. See [assets](ASSETS.md) for complete
conditional/range semantics and publication safety. Files are limited to 16 MiB
each and 64 MiB total unique bytes per snapshot.

## 11. Enable, disable and expire

```yaml
  /paused:
    enabled: false
    redirect: {url: 'https://example.com/'}
  /campaign:
    description: A scheduled end, no scheduled start
    expires: "2030-01-01T00:00:00Z"
    redirect: {url: 'https://example.com/'}
```

Quote timestamps so they remain strings. Disabled routes return 404; expired
routes return 410. Expiry is an absolute UTC timestamp, not a TTL. There is no
start-time scheduler. `description` is authoring metadata. Changing YAML activates
through dev reload or production restart/deployment; it is not an HTTP mutation.

## 12. Environment and secret references

Route-level shape (references only, never secret values):

```yaml
    env:
      GREETING: {value: Hello}
      REGION: {env: APP_REGION}
    secrets:
      TOKEN: {secret: APP_TOKEN}
```

Literal non-secret env needs no grant. External env and secrets require an
operator-owned policy outside the checkout, granting exact names to the route
and pinning the reviewed config/code digest. `urlcode permissions --project
./gitroll-link` prints a proposed policy; review it and store it outside the app.
Then pass `--policy /operator/path/policy.json` to validate/dev/test/serve.
This inspection does not authorize the project or execute its code.

Use ignored `.env.local` for local values; process environment wins. Production
`serve` reads process environment, never `.env.local`. Let your supervisor resolve
provider secrets and inject them; direct provider secret-store adapters do not
exist yet. Every config/code change invalidates the grant; rotate values by
restarting/redeploying. Never return a secret in an example response. Middleware
and functions on an approved route can read its bindings. See [policy setup](FUNCTION-SECURITY.md).

## 13. Split files and folders

Complete entry point:

```yaml
version: "1"
includes:
  - routes/code.yaml
  - routes/marketing/links.yaml
routes: {}
```

Each included file contains `version: "1"` and `routes`. No nested includes,
globs, anchors, merge keys or remote includes. References always use project-root
paths. Duplicate routes fail; include order is not priority. See [organization](ORGANIZATION.md)
and [matching/regex/wildcard rules](ROUTING.md).

## 14. Assert inputs and outputs

Save a JSON array as `tests/requests.json`:

```json
[
  {"path":"/hello/Ada","status":200,"expectBody":"{\"message\":\"Hello, Ada!\"}"},
  {"path":"/hello/Ada","method":"HEAD","status":200,"expectBody":""},
  {"path":"/go","status":302,"expectHeaders":{"location":"https://example.com/"}},
  {"path":"/go","method":"POST","status":405,"expectHeaders":{"allow":"GET, HEAD"}}
]
```

This fixture targets recipes 1 and 2 together; the runnable cookbook has its own
matching expectations. Supported test fields: `path`, optional `method`, request
`headers` and string `body`, required `status`, optional exact string `expectBody`
and string-map `expectHeaders`. Tests do not follow external redirects. There
are no route-local YAML test fields or JSON-path assertions yet.

Run validate, test, routes, and audit with an intentional expected count. Test
both positive and negative inputs, every allowed method, HEAD, middleware short
circuits and relevant asset conditions. Audit needs meaningful body/header
assertions; a status-only success is insufficient. Benchmarks and recovery drills
are separate from functional correctness. See [readiness](READINESS.md).

See [organization and readability practices](BEST-PRACTICES.md) for conventions
that keep larger projects easy to maintain.

## 15. Live short-link records

Set `dynamicLinks: true` in the entry `urlcode.yaml` before adding this route.
It defaults to false and cannot be enabled by an included file.

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

The seventh handler resolves stored records without rebuilding YAML. It requires
an external operator store binding; the [live-link example](../examples/live-links/README.md)
has separate setup and fixtures. See [dynamic links](DYNAMIC-LINKS.md) for CLI/API
creation, optimistic updates, disabled/expired records, persistence and backups.
This is not a general database capability for sandboxed functions.

## 16. Hardened profile and per-route overrides

```yaml
version: "1"
policies:
  profile: hardened               # security, agents, throttle, compression, cache
  throttle: { quota: 60, window: 60 }   # tighten one number; the rest stays
profiles:
  public-api:
    security: { headers: oshp-no-csp, set: { x-robots-tag: noindex } }
    cache: { strategy: swr, maxAge: 30, staleWhileRevalidate: 300 }
routes:
  /:
    page: {source: pages/index.html}
  /api/lookup/{id}:
    parameters:
      - {name: id, in: path, required: true, schema: {type: string, maxLength: 64}}
    function: {source: functions/lookup.mjs}
    policies:
      profile: public-api          # merges over the project layer
      throttle: {quota: 10, window: 60, partition: client-route}
  /healthz:
    respond: {text: ok}
    policies: {throttle: false, agents: false}
```

Everything under `policies` is optional and off unless declared. The project
block sets defaults, a route block adjusts them, `false` removes one policy for
that route and an object merges shallowly over what is below it. `hardened`
is the only built-in profile; `profiles` defines your own. Serve with
`--trusted-proxies` when a proxy sits in front so `client` partitioning sees
the real peer. Not every target accepts every policy: see the per-target
table in [policies](POLICIES.md) before deploying the same YAML to an adapter.

## Common mistakes

| Mistake | Correction |
|---|---|
| Two handlers on one route | Choose exactly one; put reusable logic in middleware |
| `/r/:id`, `/r/{id:.*}` or a regex | Use `/r/{id}` plus a required path input; no regex/greedy matching |
| `${TOKEN}` or `process.env` | Use declared binding references and an external operator grant |
| `fetch`, npm or Node imports | Unsupported in the guest; do not claim a network/storage integration |
| Asset MIME/header overrides in `response.headers` | Configure `contentType`, `cacheControl`, `filename` on the asset handler |
| `methods: [GET]` expecting HEAD | Declare HEAD too or omit methods for default GET/HEAD |
| YAML fields for rate limits/workers/DNS/TLS | Deployment controls live outside portable route YAML |
| YAML aliases, anchors or implicit date objects | Use plain JSON-compatible YAML and quoted timestamps |
| Automatic hot updates in `serve` | Deploy/restart or use the embedding reload API deliberately |
| “All examples are production-ready” | Validate your security, load and deployment requirements separately |

Live-link recipes require `dynamicLinks: true` in the entry `urlcode.yaml`. It is
false by default and cannot be set in included route files. Parameterized routes
and functions alone do not need it. See [dynamic-link opt-in](DYNAMIC-LINKS.md#explicit-project-opt-in).
