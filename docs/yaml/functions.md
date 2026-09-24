# YAML guide: Functions, inputs and methods

Snippets are entries under `routes:` unless stated otherwise; the [guide index](../YAML-GUIDE.md) lists every page.

## 1. A URL that runs code

A complete `urlcode.yaml`:

```yaml
version: "1"
routes:
  /hello/{name}:
    function: functions/hello.mjs
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

`function: functions/hello.mjs` is the short form. The loader expands it to the
long form before anything else reads the route: every `{param}` in the path
becomes a required string input (`minLength: 1`, `maxLength: 128`) and a
matching `args` entry, so the route above is the same route as

```yaml
  /hello/{name}:
    parameters:
      - name: name
        in: path
        required: true
        schema: {type: string, minLength: 1, maxLength: 128}
    function:
      source: functions/hello.mjs
      args:
        name: {from: path, name: name}
    env:
      GREETING: {value: Hello}
```

A path parameter the route declares itself keeps its own schema; only the
undeclared ones get the default. Use the long form when you need a named
`export`, query, header, `env` or `secret` arguments, or a tighter path schema.
`routes`, `audit` and `explain` show the expansion. Middleware has the same
short form: `middleware: [middleware/headers.mjs]` means
`middleware: [{source: middleware/headers.mjs}]`. The path must be
project-relative, end in `.mjs` or `.js` and contain no `..` segment.
Methods default to GET and HEAD. Function paths resolve from the project root,
not the YAML file's directory. Modules are ES modules either way: `.mjs` always
works, while a trusted `.js` module is loaded by Node and therefore needs the
nearest `package.json` to say `"type": "module"` (a `sandbox: true` route reads
`.js` as ESM regardless). Serving never transpiles TypeScript; build it first
with [TypeScript authoring](../TYPESCRIPT-AUTHORING.md). The route above
declares no `sandbox`, so it runs trusted and in-process: Node APIs, npm
imports, network and filesystem access are all available to it, exactly as they
are to any other Node code in the host. Add `sandbox: true` to trade them away
for isolation -- inside the guest none of them exist. See
[trust model and sandbox opt-in](../FUNCTION-SECURITY.md).

### Host overrides for env bindings

An `env` entry with only `value` is a plain literal — never touched by any
grant or by the host environment, so it always stays reviewable as exactly
what it says. An entry with `env` reads that name from the process
environment and requires an operator grant for the exact name (`urlcode
permissions`, [trust model and sandbox opt-in](../FUNCTION-SECURITY.md)). It
may also declare an optional `default`:

```yaml
routes:
  /hello/{name}:
    function: functions/hello.mjs
    env:
      GREETING: {env: GREETING, default: Hello}
```

Here `env.GREETING` is `"Hello"` unless the process has a non-empty `GREETING`
environment variable and the operator has granted this route that name, in
which case the granted value wins. Unlike an `env`-only binding with no
`default`, a missing grant here is not fatal: the binding just falls back to
`default` and the host environment variable is never read — so a project can
ship `{env: NAME, default: ...}` bindings that work out of the box, and an
operator can later opt in to letting the host override them, without ever
loosening what a plain `{value: ...}` literal means. This is the sanctioned
way to vary a declared value per deployment or test run; it does not
authorize reading `process.env` directly from function code (see [trust model
and sandbox opt-in](../FUNCTION-SECURITY.md) — a trusted function's
independent Node access is not the same thing as a binding grant). `urlcode
explain` shows the resolved shape as `alias=$NAME (default "literal")`.

The long form without an `args` key binds every declared path input the same way, so
`function: {source: functions/hello.mjs}` with a declared `name` path parameter receives
`args.name`. Write `args: {}` to bind nothing. A function also receives
`context.route.pattern`, the route key that matched (`/hello/{name}`), so one module can serve
several routes without parsing `request.url`, and `context.requestId`, the string the response
carries in `X-Request-Id`, for correlating its own logs with the request log; both are present
for trusted and `sandbox: true` functions and middleware alike.

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
`context.inputs.path/query/header`, `context.env`, `context.secrets` and `context.requestId`.
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
escape untrusted values yourself. A trusted (default) function has Node's full
`Response`; a `sandbox: true` route gets the narrower [guest API](../SPECIFICATION.md#functions).
