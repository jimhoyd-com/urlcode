# Middleware

Middleware is reusable JavaScript around any route handler. It is optional and
route-local; plain redirects and assets retain their native fast path when no
middleware is attached. Adding middleware requires sandbox execution.

```yaml
version: "1"
routes:
  /go:
    middleware:
      - source: middleware/headers.mjs
        export: default
    redirect:
      url: https://example.com
```

```js
export default async function headers(request, context, next) {
  context.state.startedAt = Date.now();
  const response = await next();
  response.headers.set('x-example-middleware', 'active');
  return response;
}
```

Paths resolve from the project root. Up to 16 entries are allowed; each accepts
`source` and optional `export` (default `default`). Reuse a module across routes.
There are no global middleware settings or middleware-specific argument fields.
This is URLCode's small portable API, not Express/Node middleware compatibility.
Fourteen ready-to-copy patterns (auth, CORS, tracing, error boundary, ETag and
more) are in [middleware examples](MIDDLEWARE-EXAMPLES.md).

## Order and responses

For `[first, second]`, execution is first-before, second-before, handler,
second-after, first-after. Call `await next()` to obtain the downstream response.
Call it at most once, during the middleware invocation, with no arguments.
Always return a `Response`. Return early to skip downstream middleware and the
handler, for example `return new Response('Denied', {status: 403})`.
Middleware may catch downstream JavaScript exceptions and return a fallback.

Every middleware and the function share the same request and context. Validated
`inputs`, function `args`, and route-scoped `env`/`secrets` are available along
with a fresh `context.state` object for this chain. State never survives the
request. Header edits are visible downstream; editing the request does not
reroute it or change already validated inputs. Request bodies are single-use:
reading one consumes it for downstream code. There is no `clone()` or streaming
API; pass parsed data through `context.state` when needed.

Function responses support the existing text/JSON guest API. To transform their
body, read it and return a new `Response`. Native redirect/respond/page/static/
download bodies are opaque and cannot be read through `text()` or `json()`.
Returning the same native response preserves original bytes, including binary
files, ranges and HEAD lengths. You may add headers, but cannot change its
original status or existing native headers while preserving that body. To replace
status, destination or content, return a new `Response` instead. Replacement
responses follow the normal sandbox text/JSON and size limits. To wrap a shared
template around file content, render it through a function at build time and
publish the result: see [prerendering](PRERENDER.md).

Route selection, enabled/expiry checks, methods and input/body validation run
before middleware. Their errors do not pass through the chain. A missing file
inside a selected static mount is a downstream 404 response. YAML
`response.headers` apply last and override matching middleware headers. Runtime
framing and asset metadata protections still apply.

## Isolation and testing

The whole chain and handler run in one fresh QuickJS/WASM guest with one memory
budget and one deadline. No Node, filesystem, shell, fetch or ambient environment
is exposed. Modules can only access this route's declared dependency graphs.
All middleware receive that route's approved bindings, so review the whole chain;
source changes invalidate grants. See [security](FUNCTION-SECURITY.md).

Invalid responses and repeated `next()` calls fail with 502, exhausted capacity
returns 503, and the shared deadline returns 504. Middleware cannot extend the
deadline or catch the outer worker termination. Forgotten downstream work is
still drained within that deadline.

Include explicit request fixtures for middleware-wrapped routes: test success,
early responses, validation failures and every configured method. Audit will
report missing coverage instead of assuming native handler behavior. Benchmark
with middleware enabled to measure its actual sandbox overhead.
