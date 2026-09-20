# YAML guide: Middleware

Snippets are entries under `routes:` unless stated otherwise; the [guide index](../YAML-GUIDE.md) lists every page.

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
Up to 16 middleware entries share the route's execution mode, one deadline and
one set of approved route bindings; the mode is the route's `sandbox` field, not
a per-entry choice. On a `sandbox: true` route native bodies are opaque;
preserving them requires retaining original status/headers. Return a new
Response to replace native content or destination.
YAML response headers apply last. See [middleware](../MIDDLEWARE.md) for details.
