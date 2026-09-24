# HTTP request and response configuration

This is a documented HTTP subset, not a promise that every
HTTP feature is configurable. It builds on [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html).

```yaml
version: "1"
routes:
  /echo:
    methods: [POST]
    request:
      body:
        required: true
        maxBytes: 16384
        contentTypes: [application/json]
        format: json
    function:
      source: functions/echo.mjs
    response:
      headers:
        Cache-Control: no-store
        X-App: my-links
  /go:
    redirect:
      url: https://example.com
      status: 302
    response:
      headers:
        Cache-Control: public, max-age=60
  /status:
    respond:
      status: 200
      json: {ok: true}
```

`functions/echo.mjs`:

```js
export default async function echo(request) {
  return Response.json(await request.json());
}
```

## Requests

Keep ordinary routes short: omit `methods` to accept GET and HEAD. Set
`methods: [POST]` for a POST-only handler, or `methods: [GET, HEAD, POST]` for all
three. Use uppercase method names. Explicit lists replace the defaults; GET does
not implicitly add HEAD when a list is supplied. The schema advertises the same
default as the runtime. No declaration is needed for the default 302 redirect
status or default `Cache-Control: no-store` on functions/redirects.


| Field | Behavior |
|---|---|
| `methods` | Allowed methods, default GET/HEAD; exact lists, 405 plus Allow on mismatch |
| `parameters` | Required/defaulted/typed path, query and header inputs; see the specification |
| `request.body.required` | Reject an empty body with 400; default false |
| `request.body.maxBytes` | 0–1048576; tighter per-route budget, enforced while reading fixed/chunked bodies; 413 on overflow |
| `request.body.contentTypes` | Exact lowercase MIME essences for nonempty bodies; parameters ignored; mismatch/missing type returns 415 |
| `request.body.format` | `text`: validate UTF-8; `json`: validate UTF-8, JSON media type and JSON syntax; malformed input returns 400 |
| `request.body.schema` | Requires `format: json`. A JSON Schema subset checked after parsing; a body that breaks it returns 422 (see below) |

The operator request limit remains an upper bound; YAML cannot raise it. A route
without body policy keeps the existing server limit. A configured body policy
rejects nonidentity Content-Encoding for nonempty bodies; no automatic decompression.
Empty optional bodies skip media/format checks. Inputs are validated before the
handler; the original body remains available through function `request.text()` or
`request.json()`. No YAML body interpolation or automatic argument binding.
Request header inputs use `parameters` with `in: header`; this is validation,
not arbitrary modification or forwarding of the incoming request.

## Responses

`response.headers` maps HTTP names to literal strings. Names are case insensitive;
duplicate spellings and invalid names/control characters fail activation. YAML
values replace the same handler headers, including all prior Set-Cookie values.
Only `Set-Cookie` accepts a list, producing separate header lines:

```yaml
response:
  headers:
    Cache-Control: no-store
    Set-Cookie:
      - "theme=light; Path=/; SameSite=Lax; Secure"
      - "notice=seen; Path=/; HttpOnly; SameSite=Lax; Secure"
```

Use functions for dynamic cookies; never commit session credentials or secret
values into header literals. Header configuration applies to handler responses,
including declared error statuses, but not runtime validation/errors (400, 404,
405, 413, 415, 500, etc.). Defaults remain `no-store`, `nosniff` and a request ID.
Header policy is bounded to 64 keys/16 KiB; merged function headers remain bounded.
A header repeated in the result the runtime writes (from a policy, or from a
handler result that carries more than one pair for the same name) is sent as
separate wire lines, the same as a declared `Set-Cookie` list; it is never
collapsed to only its last value.

Framing, hop-by-hop headers, Location, Allow, range/cache validators,
Content-Encoding, X-Request-ID and X-Content-Type-Options are reserved to the
runtime/handler. The runtime frames every response the same way on every host:
Content-Length is the UTF-8 byte length of the body it sends, whatever length a
handler states. Only a HEAD answer carries a stated length, the one GET would
send, and no body. The self-hosted and Vercel writers also make Node refuse a
body that differs from the stated length. Configure redirect URLs/status on `redirect`; asset content type,
cache and disposition on its own handler. Asset metadata cannot be overridden by
`response.headers`. On functions/declared responses, Content-Type may be configured;
JSON declarations require a JSON type. No response header secret interpolation.

### Body schema and input patterns

`request.body.schema` accepts `type` (`object`, `array`, `string`, `integer`,
`number`, `boolean`, `null`), `properties`, `required`, `additionalProperties`
(true or false), `items`, scalar `enum`, `minLength`/`maxLength`, `pattern`,
`format: uuid`, `minimum`/`maximum` and `minItems`/`maxItems`. Anything else,
including `$ref`, `oneOf` and `default`, fails activation. A schema is limited to
6 levels, 128 nodes and 64 properties per object. It is checked by the runtime
itself, so it behaves the same on every host and is not compiled from author
code.

A failing body answers **422** as `text/plain`: `Request body failed validation`
then one line per failure, at most 8, each naming only a path the schema
declared (`/title must be a string`). Array positions print as `[]`. Nothing the
client sent is echoed, in line with the fixed-words rule for runtime errors.
Malformed JSON stays 400 and a wrong media type 415.

A client that sends `Accept: application/json` gets the same failures as
`application/json` instead (the server and the Cloudflare Worker agree):

```json
{"error":"body_validation_failed","message":"Request body failed validation","issues":[{"pointer":"/title","keyword":"maxLength","message":"must be at most 8 characters","expected":8}]}
```

Each issue carries `pointer` (RFC 6901, built only from names the schema
declared; array positions are `/[]`, not an index; the root is `""`), `keyword`
(`type`, `enum`, `required`, `additionalProperties`, `minLength`, `maxLength`,
`format`, `pattern`, `minimum`, `maximum`, `minItems` or `maxItems`), the fixed
`message`, and where the schema states one, `expected` (the type, bound, format
or, for `enum`, up to 16 short declared values) or `property` (the missing name
from `required`). The offending value is never included, because it may hold a
secret. At most 8 issues are listed and the body is capped at 4096 bytes;
when trailing issues are dropped to fit, `"truncated":true` is added.

Negotiation is deliberately conservative: JSON is sent only when the Accept
header names `application/json` explicitly with `q` above 0 and no higher `q` for
an explicit `text/plain`. A missing header, `*/*`, `application/*`, browsers'
default Accept and a malformed `q` keep the plain-text answer. The status is 422
either way and the same checks run before any function or sandbox code.

Parameter schemas (path, query, header) also accept `format: uuid` and `pattern`
on string inputs, rejecting a mismatch with 400. `pattern` runs on every request
in the host process, so it is restricted: 1 to 128 characters, `maxLength` of at
most 128 on the same schema, no group repeated by `*`, `+` or `{n,}`, no
lookaround, no backreference and at most three unbounded quantifiers. Every
variable-width part (`*`, `+`, `?`, `{n,}`, `{n,m}` with `m > n`, and each
alternation) also counts against one budget of backtracking paths on a
128-character value, so a long flat run of optional or bounded atoms is refused
like its grouped form, and an unanchored pattern (one not starting with `^`)
gets less room because it is retried from every position. That
restriction is conservative, not a proof of linear time. It is what stands
between an author regex and a backtracking stall, so prefer `format` or `enum`
when either fits.

`respond` is an additional native handler (exactly one handler per route):

- `status`: 200–599, default 200; 206 and 304 are reserved for native asset semantics.
- `text`: literal UTF-8 body, default content type text/plain.
- `json`: any JSON-compatible YAML value, serialized with application/json.
- Omit both for an empty body; declaring both fails. Body limit is 1 MiB.
- A short HTML answer is `text` plus a declared content type. There is no
  `respond.html`; use the `page` handler for anything larger than a snippet:

  ```yaml
  /:
    respond:
      text: "<!doctype html><h1>Hello</h1>"
    response:
      headers:
        Content-Type: text/html; charset=utf-8
  ```

  The body is served verbatim and the default `nosniff` and `no-store` still
  apply. Under the `oshp` security profile the CSP (`default-src 'self'`) blocks
  inline `<script>` and `<style>`, so keep the snippet to markup.
- Status 204/205 cannot declare a nonempty body. HEAD always suppresses the body.

Functions still return their own Response/status/body. YAML header policy does
not replace function status/body. Asset handlers retain conditional/HEAD/range
behavior described in [assets](ASSETS.md). Use OPTIONS explicitly if you need a
declared response; merely adding a header does not implement CORS preflight.

## Still outside this contract

Automatic CORS/preflight policy, cookie parsing/signing, authentication
(beyond the operator-installed auth extension), JSON Schema beyond the
`request.body.schema` subset above, multipart/file uploads, streaming, content negotiation,
WebSocket upgrades and proxies are not implemented. Do not advertise these as
supported just because raw headers can be declared. Compression negotiation,
security-header profiles, per-client throttling, User-Agent policy and HTTP
caching strategies exist only as optional, off-by-default
[policies](POLICIES.md); a project that declares none keeps the identity-only
behavior described here, and YAML `response.headers` beat any header a policy
would add. Future features need their own portable semantics and tests; unknown
YAML fields fail.

Middleware runs after route/method/input/body validation and before YAML response
header overrides. See [middleware](MIDDLEWARE.md) for ordering and native body
preservation rules.
