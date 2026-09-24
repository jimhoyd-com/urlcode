# Middleware

Middleware is reusable JavaScript around any route handler. It is optional and
route-local; plain redirects and assets retain their native fast path when no
middleware is attached. Middleware runs trusted and unsandboxed by default,
in-process with full Node access, the same as a `function` route; add
`sandbox: true` on the route to run the whole chain isolated instead (see
[trust model and sandbox opt-in](FUNCTION-SECURITY.md)).

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
reading one consumes it for downstream code. On a `sandbox: true` route there is
no `clone()` or streaming API at all, so pass parsed data through
`context.state`; a trusted route receives Node's own `Request`/`Response` and so
does have `clone()`, but passing parsed data through `context.state` keeps the
chain portable between the two modes.

To transform a function response's body, read it and return a new `Response`;
on a `sandbox: true` route that body is limited to the text/JSON guest API. On a `sandbox: true` route, native
redirect/respond/page/static/download bodies are opaque and cannot be read
through `text()` or `json()`; a trusted chain receives them as an ordinary
`Response` and can read them, so wrapping `respond: {text: hello}` and returning
`HELLO` works there and fails in the guest.
Returning the same native response preserves original bytes, including binary
files, ranges and HEAD lengths. You may add headers, but cannot change its
original status or existing native headers while preserving that body. To replace
status, destination or content, return a new `Response` instead. Replacement
responses follow the normal response size limits, and (on a `sandbox: true`
route) the guest's text/JSON constraints. To wrap a shared
template around file content, render it through a function at build time and
publish the result: see [prerendering](PRERENDER.md).

Route selection, enabled/expiry checks, methods and input/body validation run
before middleware. Their errors do not pass through the chain. A missing file
inside a selected static mount is a downstream 404 response. YAML
`response.headers` apply last and override matching middleware headers. Runtime
framing and asset metadata protections still apply.

## Trust, isolation and testing

The whole chain and handler run as one unit, in one execution mode, chosen by
the route's `sandbox` field — not a per-middleware-entry choice. By default
(`sandbox` false/absent) that means trusted, in-process execution with full
Node access and no fixed worker-pool ceiling. With `sandbox: true` it means
one fresh QuickJS/WASM guest with one memory budget and one deadline: no
Node, filesystem, shell, fetch or ambient environment, and modules limited to
this route's declared dependency graph. Either way, all middleware on a route
receive that route's approved bindings, so review the whole chain; source
changes invalidate grants. See [trust model and sandbox opt-in](FUNCTION-SECURITY.md).

Invalid responses and repeated `next()` calls fail with 502, and the deadline
returns 504 either way. A `sandbox: true` chain also sheds load with 503 when
the shared worker pool is exhausted, and cannot extend the deadline or catch
the outer worker termination; forgotten downstream work is still drained
within it. A trusted chain has no worker pool to exhaust (see
[capacity](CAPACITY.md)), but its deadline is a race against the call's own
promise rather than a forced kill — it cannot preempt code that blocks the
event loop synchronously.

Include explicit request fixtures for middleware-wrapped routes: test success,
early responses, validation failures and every configured method. Audit will
report missing coverage instead of assuming native handler behavior. Benchmark
with middleware enabled to measure its actual overhead, sandboxed or trusted.
