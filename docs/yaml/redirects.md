# YAML guide: Redirects

Snippets are entries under `routes:` unless stated otherwise; the [guide index](../YAML-GUIDE.md) lists every page.

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

## 2b. Root-relative and suffix redirects

```yaml
  /people/{id}:
    parameters:
      - {name: id, in: path, required: true, schema: {type: string, minLength: 1}}
    redirect: {url: '/profiles/{id}'}         # Location: /profiles/42
  /legacy/**:
    redirect: {url: 'https://example.com/modern/{**}'}   # /legacy/a/b/c -> /modern/a/b/c
```

A destination starting with a single `/` stays on this site and answers a path-only `Location`. `//host`
and dot segments are refused. `/legacy/**` needs at least one segment after the prefix, so `/legacy`
and `/legacy/` are 404, and an exact or `{param}` route under it wins. See [route matching](../ROUTING.md).

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
of identity. See [input and redirect semantics](../SPECIFICATION.md).
