# HTTP request and response configuration

Implemented in alpha.4. This is a documented HTTP subset, not a promise that every
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
        X-App: gitroll-link
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

| Field | Behavior |
|---|---|
| `methods` | Allowed methods, default GET/HEAD; exact lists, 405 plus Allow on mismatch |
| `parameters` | Required/defaulted/typed path, query and header inputs; see the specification |
| `request.body.required` | Reject an empty body with 400; default false |
| `request.body.maxBytes` | 0–1048576; tighter per-route budget, enforced while reading fixed/chunked bodies; 413 on overflow |
| `request.body.contentTypes` | Exact lowercase MIME essences for nonempty bodies; parameters ignored; mismatch/missing type returns 415 |
| `request.body.format` | `text`: validate UTF-8; `json`: validate UTF-8, JSON media type and JSON syntax; malformed input returns 400 |

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

Framing, hop-by-hop headers, Location, Allow, range/cache validators,
Content-Encoding, X-Request-ID and X-Content-Type-Options are reserved to the
runtime/handler. Configure redirect URLs/status on `redirect`; asset content type,
cache and disposition on its own handler. Asset metadata cannot be overridden by
`response.headers`. On functions/declared responses, Content-Type may be configured;
JSON declarations require a JSON type. No response header secret interpolation.

`respond` is an additional native handler (exactly one handler per route):

- `status`: 200–599, default 200; 206 and 304 are reserved for native asset semantics.
- `text`: literal UTF-8 body, default content type text/plain.
- `json`: any JSON-compatible YAML value, serialized with application/json.
- Omit both for an empty body; declaring both fails. Body limit is 1 MiB.
- Status 204/205 cannot declare a nonempty body. HEAD always suppresses the body.

Functions still return their own Response/status/body. YAML header policy does
not replace function status/body. Asset handlers retain conditional/HEAD/range
behavior described in [assets](ASSETS.md). Use OPTIONS explicitly if you need a
declared response; merely adding a header does not implement CORS preflight.

## Still outside this contract

Automatic CORS/preflight policy, cookie parsing/signing, authentication, body JSON
Schema validation, multipart/file uploads, streaming, compression negotiation,
content negotiation, WebSocket upgrades and proxies are not implemented. Do not
advertise these as supported just because raw headers can be declared. Future
features need their own portable semantics and tests; unknown YAML fields fail.
