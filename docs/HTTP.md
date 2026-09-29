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
        POST:
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
| `request.body.<METHOD>` | That method's body policy, below; `<METHOD>` must be one of the route's `methods` |
| `request.body.<METHOD>.required` | Reject an empty body with 400; default false |
| `request.body.<METHOD>.maxBytes` | 0–1048576; tighter per-route budget, enforced while reading fixed/chunked bodies; 413 on overflow |
| `request.body.<METHOD>.contentTypes` | Exact lowercase MIME essences for nonempty bodies; parameters ignored; mismatch/missing type returns 415 |
| `request.body.<METHOD>.format` | `text`: validate UTF-8; `json`: validate UTF-8, JSON media type and JSON syntax; malformed input returns 400 |
| `request.body.<METHOD>.schema` | Requires `format: json`. A JSON Schema 2020-12 document in a bounded profile, compiled at load and checked after parsing; a body that breaks it returns 422 (see below) |

The operator request limit remains an upper bound; YAML cannot raise it. A
method without a body policy keeps the existing server limit. A configured body policy
rejects nonidentity Content-Encoding for nonempty bodies; no automatic decompression.
Empty optional bodies skip media/format checks. Inputs are validated before the
handler; the original body remains available through function `request.text()` or
`request.json()`. No YAML body interpolation or automatic argument binding.
Request header inputs use `parameters` with `in: header`; this is validation,
not arbitrary modification or forwarding of the incoming request.

### Per-method body rules

`request.body` is keyed by HTTP method, and each key holds that method's
policy. This is the one way to write a body rule, including on a single-method
route, and it matches OpenAPI, where each operation on a path has its own
request body. So one path can read with GET and create with POST, each with
its own rules:

```yaml
routes:
  /api/requests:
    methods: [GET, POST]
    parameters:
      - {name: status, in: query, schema: {type: string, enum: [pending, approved]}}
    request:
      body:
        GET: {maxBytes: 0}
        POST:
          required: true
          maxBytes: 4096
          contentTypes: [application/json]
          format: json
          schema:
            type: object
            required: [title]
            additionalProperties: false
            properties:
              title: {type: string, minLength: 1, maxLength: 200}
    function: {source: functions/requests.mjs}
```

- Every key must be one of the route's `methods`, or the project fails to load.
  Remember that the default `methods` are GET and HEAD.
- A declared method without an entry has no body policy: it keeps the server
  limit, and the other methods' rules never apply to it.
- RFC 9110 gives content in a GET, HEAD or DELETE request no defined meaning,
  so their entries may only set `maxBytes`. `maxBytes: 0` refuses any body
  with 413. `required`, `contentTypes`, `format` or `schema` on these methods
  fails at load.
- POST, PUT, PATCH and OPTIONS entries take the whole policy.
- A shared block's `request` is copied as a whole, so its method keys must suit
  every route that uses it.
- `urlcode explain` and `manifest` list the policy under each method. The
  capability query (`get_capability("request.body")`) and
  `get_schema("request.body.POST.schema")` describe the same shape.

The function still branches on `request.method` for the work it does per
method. That is the specified way to serve several methods on one path, because
a path has one handler. `urlcode review` does not suggest splitting the path
into one route per method.


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
send, and no body. The self-hosted and Vercel writers also ask Node itself to
refuse a body that differs from the stated length, as a self-check on top of
that measured length -- except on Node 22.13.0-22.14.x, where that Node
self-check is itself broken and asking for it turns a correct response into a
crash, so it is skipped only on that narrow, documented-floor range
(`engines`: `>=22.13.0`; [RIM-OUTPUT-001](RUNTIME-IMPLEMENTATION.md)).
A [streamed response](SPECIFICATION.md#streamed-responses) is the one
exception: its length is not known when its head is sent, so it carries no
Content-Length (on HEAD either) and HTTP/1.1 frames it with chunked transfer;
`response.headers` and every other header rule above still apply to it.
Configure redirect URLs/status on `redirect`; asset content type,
cache and disposition on its own handler. Asset metadata cannot be overridden by
`response.headers`. On functions/declared responses, Content-Type may be configured;
JSON declarations require a JSON type. No response header secret interpolation.

### Body schema and input patterns

`request.body.<METHOD>.schema` is a [JSON Schema 2020-12](https://json-schema.org/draft/2020-12)
document restricted to a bounded profile. The runtime checks it against the
profile when the project loads and compiles it once with
[Ajv](https://ajv.js.org/); a request only runs the compiled validator. A
schema that leaves the profile fails validation and activation with a message
naming the keyword and the JSON pointer inside the schema, for example
`Body schema /properties/a/unevaluatedProperties: keyword "unevaluatedProperties"
is not in the supported JSON Schema 2020-12 profile`. Nothing outside the
profile is silently ignored.

Every refusal has that `Body schema <pointer>: <problem>` form, including
schemas that use only profile keywords but combine them into a mistake. These
are refused at load with a hint:

- a name in `properties` that a `patternProperties` pattern on the same schema
  also matches (both would apply; Ajv's strict mode refuses the overlap);
- a `required` name that `additionalProperties: false` forbids because it is
  neither in `properties` nor matched by a `patternProperties` pattern;
- a type-specific keyword beside a `type` it cannot apply to, such as
  `minLength` on `type: number` or `required` on `type: string`;
- a `const` value, or an `enum` entry, that is not of the declared `type`;
- `items: false` with a `minItems` larger than the `prefixItems` it closes.

If Ajv still refuses a schema the profile admitted, the message keeps the same
form: the pointer comes from Ajv's meta-schema error or path, or is `/`, and
Ajv's wording is redacted (quoted text, URLs and `#` references elided, control
characters replaced, length capped). No diagnostic echoes a `$ref` value or a
string constant.

| Keyword | In the profile |
|---|---|
| `$schema` | Root only, and only `https://json-schema.org/draft/2020-12/schema`. A schema without it is read as 2020-12 |
| `$defs`, `$ref` | `$defs` at the root only (at most 32 entries). `$ref` only as a local `#/$defs/<name>` to a declared entry. Remote, `$id`-relative and other JSON-pointer references are refused, never resolved or fetched, and a reference cycle is refused |
| `$comment`, `title`, `description`, `examples`, `deprecated` | Annotations; they change nothing |
| `type` | `object`, `array`, `string`, `integer`, `number`, `boolean`, `null`, or a list of distinct ones such as `[string, "null"]` |
| `enum`, `const` | Scalar values only (string, number, boolean or `null`); `enum` lists 1 to 64 |
| `allOf`, `anyOf`, `oneOf`, `not` | 1 to 16 schemas per list |
| `properties`, `additionalProperties`, `required`, `propertyNames`, `minProperties`, `maxProperties` | At most 64 properties per object; `additionalProperties` is a boolean or a schema |
| `patternProperties` | 1 to 16 patterns, each admitted like `pattern` below, and only beside `propertyNames` with a `maxLength` of at most 128 |
| `items`, `prefixItems`, `minItems`, `maxItems`, `uniqueItems` | Counts up to 10,000; `uniqueItems: true` only beside `maxItems` of at most 64 |
| `minLength`, `maxLength`, `pattern`, `format` | Lengths up to 1,048,576; `pattern` only beside `maxLength` of at most 128; `format` one of the standard string formats below |
| `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` | Finite numbers; `multipleOf` greater than 0 |

Everything else is refused, including `$id`, `$anchor`, `$dynamicRef`,
`$dynamicAnchor`, `$vocabulary`, `if`/`then`/`else`, `dependentSchemas`,
`dependentRequired`, `unevaluatedProperties`, `unevaluatedItems`, `contains`,
the `content*` keywords, `readOnly`/`writeOnly`, draft-07 spellings
(`definitions`, `dependencies`), OpenAPI's `nullable` (write a type list with
`"null"`) and `default` (the runtime never fills in a request body). A `format`
outside the list below, such as `idn-email` or `uri-reference`, is refused
rather than skipped, naming the supported ones.

**String formats.** `format` checks a string (any other type passes, as in JSON Schema) against one
of these, and a mismatch is a 422 issue with `keyword: format` and the format in
`expected`. Each format has its own length cap: a longer value fails the format
without being scanned, so unlike `pattern` a `format` needs no `maxLength`
beside it.

| `format` | Accepts | Cap |
|---|---|---|
| `uuid` | RFC 9562 hyphenated form, versions 1 to 8, RFC variant, any case | 36 |
| `date` | RFC 3339 `full-date`, `2024-02-29`: a real calendar day, leap years included | 10 |
| `time` | RFC 3339 `full-time`, `08:30:06.25Z` or `08:30:06-08:00`: the offset is required, fractions up to 9 digits, `T`/`Z` in either case. A leap second (`:60`) only at 23:59 UTC; the date is not checked against the leap-second table | 24 |
| `date-time` | RFC 3339 `date-time`: a `date`, `T` and a `time` as above | 35 |
| `email` | RFC 5321 mailbox: a dot-atom or quoted local part of at most 64, `@`, then a `hostname` without the trailing dot or an address literal (`[192.0.2.1]`, `[IPv6:::1]`). ASCII only: no internationalized mailbox (`idn-email`) | 254 |
| `uri` | RFC 3986 URI with a scheme (a fragment allowed); each part checked against its own characters and every `%` followed by two hex digits; an `[IPv6]` or `[vX.…]` host literal; a port of up to 5 digits. ASCII only: a relative reference or an IRI is refused | 2,048 |
| `hostname` | RFC 1123 names: labels of 1 to 63 letters, digits and `-` (not first or last), 253 in all, an optional trailing dot. An `xn--` A-label is accepted without decoding its Punycode; any other label with `--` in positions 3 and 4 is refused, and a U-label (`bücher`) is refused | 253 |
| `ipv4` | Dotted quad, each part 0 to 255 without a leading zero | 15 |
| `ipv6` | RFC 4291 text forms: eight groups of 1 to 4 hex digits, one `::`, an optional dotted IPv4 tail; no zone id (`%eth0`) | 45 |

These are URLCode's own checks rather than a format library such as
`ajv-formats`. That library (3.0.1, MIT, about 57 KB unpacked) would add a
dependency. Its documented standalone setup reaches the formats through a
`require`, which the Cloudflare build refuses. Its `email` and `uri` regexes
repeat groups on unbounded input, which the pattern guard refuses in an
author's `pattern`. URLCode's checks are one short module. Each one refuses a value over its cap before any regex runs. Every regex
they use passes the same guard as an author `pattern`, and the rest is a linear
scan. The server registers them with Ajv. The Cloudflare build inlines the same
functions into `body-validators.js`, so the Worker runs identical code with no
runtime code generation and no import.

A schema is limited to 8 levels, 256 schema nodes, 32 `$ref` uses and 1,024
nodes once every `$ref` is expanded, so a chain of small definitions used many
times is refused like one large schema. Standard JSON Schema semantics apply:
a keyword constrains only values of the type it is about, `required` checks
presence, and only the object's own properties count. An absent property and a
`null` one differ: `required: [phone]` with `phone: {type: [string, "null"]}`
accepts `{"phone": null}` and refuses `{}`.

```yaml
schema:
  $schema: https://json-schema.org/draft/2020-12/schema
  $defs:
    email: {type: string, format: email}
  type: object
  required: [name, email, phone]
  additionalProperties: false
  properties:
    name: {type: string, minLength: 1, maxLength: 100}
    email: {$ref: "#/$defs/email"}
    phone: {type: [string, "null"], maxLength: 32}
    channel:
      anyOf:
        - {const: email}
        - {const: phone}
```

A string `minLength`/`maxLength` may be as large as 1,048,576, the largest
request body any route admits (`request.body.<METHOD>.maxBytes` defaults to it and
cannot exceed it), so a long text field such as a document or a pasted log
needs no workaround. A string with a `pattern` keeps the 128-character
`maxLength` described below, because that bound limits regex cost rather than
size; the validator checks `maxLength` before `pattern`, and `propertyNames`
before `patternProperties`, so an over-long value or key never reaches the
regex. The route's own `maxBytes` is not compared with the schema: it is
checked first and answers 413, so a `maxLength` larger than `maxBytes` allows
is accepted but never reached.

On the Cloudflare Worker, which forbids code generation at runtime,
`urlcode build --target cloudflare` compiles every body schema with the same
Ajv options into a standalone `body-validators.js` module, one validator per route and method, so the Worker runs
the same validator as the server. See [Cloudflare](CLOUDFLARE.md#what-has-run-on-workerd)
for what has run on workerd.

A failing body answers **422** as `application/json`, whatever the client's
`Accept` header: a route that declares a JSON body schema is a JSON endpoint,
so its validation errors are JSON too (the server and the Cloudflare Worker
agree). The validator stops at the first failure, following Ajv's own advice
for untrusted input, so one request cannot make it record an error per array
element:

```json
{"error":"body_validation_failed","message":"Request body failed validation","issues":[{"pointer":"/title","keyword":"maxLength","message":"must be at most 8 characters","expected":8}]}
```

Each issue carries `pointer` (RFC 6901; the root is `""`), `keyword`, the fixed
`message`, and where the schema states one, `expected` (the type or list of
types, bound, format, `multipleOf` or, for `enum` and `const`, up to 16 short
declared values) or `property`: the missing name for `required`, and for
`additionalProperties` the undeclared property the client sent. The pointer
names only properties the schema declares: an array position is `/[]`, not an
index, and any other key the client chose (under `additionalProperties` or
`patternProperties`) is `/*`. An undeclared property is named in `property`
only when it looks like an identifier (a letter or `_`, then up to 63 letters,
digits, `_` or `-`); any other name is left out rather than echoed. A
`propertyNames` failure never names the property. Values are never included,
because they may hold a secret. When an `anyOf` or `oneOf` fails, the issue is
the alternative itself (`must match at least one declared alternative`), not
each branch's failure. The body is capped at 4096 bytes; when trailing issues
are dropped to fit, `"truncated":true` is added. Malformed JSON stays 400 and a
wrong media type 415, and the same checks run after the route's identity and
access checks (a request an extension's `authorize()` refuses gets that refusal,
not a 422) and before any function or sandbox code.

Earlier releases interpreted a private subset (no `$schema`, `$defs`, `$ref`,
type lists or combinators) and listed up to 8 issues, three of them for
undeclared properties. A client that relied on several issues in one answer
now receives the first.

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

## Error format

The errors the runtime writes itself (the 405 for an undeclared method, the 404
for an unmatched path, a disabled route or a missing asset, 410, the 400/413/415
body and input refusals, a body-schema 422, and the generic 500/502/503/504) are
a plain-text line by default: `Method not allowed\n`, `Not found\n`. A JSON API
can ask for a fixed JSON envelope instead, without a function:

```yaml
site:
  errors:
    format: json
    paths: [/api/*]          # exact paths, or prefixes ending in /*
routes:
  /status:
    respond: {json: {status: ok}}
    errors: {format: json}   # one route, outside any site scope
  /api/legacy:
    respond: {text: legacy}
    errors: {format: text}   # a route's own setting wins over the scope
```

With `json`, the body is exactly one of:

```json
{"error":{"code":"METHOD_NOT_ALLOWED","message":"Method not allowed"}}
{"error":{"code":"UNPROCESSABLE_CONTENT","message":"Request body failed validation","issues":[...]}}
```

with `Content-Type: application/json; charset=utf-8`. The message is the same
fixed words the text line carries; it never includes request data, a thrown
message or any other internal detail. `issues` (and `truncated`) appear only on
the body-schema 422, bounded exactly as the [text-mode JSON 422](#body-schema-and-input-patterns).
The code set is closed and keyed by status:

| Status | `code` |
|---|---|
| 400 | `BAD_REQUEST` |
| 404 | `NOT_FOUND` |
| 405 | `METHOD_NOT_ALLOWED` |
| 410 | `GONE` |
| 413 | `CONTENT_TOO_LARGE` |
| 414 | `URI_TOO_LONG` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` |
| 421 | `MISDIRECTED_REQUEST` |
| 422 | `UNPROCESSABLE_CONTENT` |
| 500 | `INTERNAL_ERROR` |
| 502 | `BAD_GATEWAY` |
| 503 | `SERVICE_UNAVAILABLE` |
| 504 | `GATEWAY_TIMEOUT` |

Any other status the runtime might write gets `ERROR`; the runtime generates
none today. The envelope has no configurable fields.

Which format applies:

1. A matched route's own `errors.format` (`text` or `json`).
2. Otherwise `json` when the decoded request path is inside `site.errors.paths`,
   whether or not a route matches it. `/api/*` covers `/api`, `/api/` and
   everything below; an exact entry covers only that path. A target that does
   not decode (`/api/%zz`) is placed by its raw path.
3. Otherwise `text`, byte for byte as a project without either key.

What does not change: the status, `Allow` on a 405, `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, `X-Request-Id`, the security-profile headers
and the HEAD rule (the JSON length is stated, no body is sent). The format
applies only to answers the runtime writes itself. A handler's own status and
body (`respond: {status: 404}`, a function's `Response`), a policy's answer (a
`throttle` 429, an `agents` 403, a cache hit), an operator plugin's answer and
an extension's answer or denial (an auth 401) are never rewritten. A
`site.notFound` page is not served for an unmatched path in a JSON scope: an
API client gets the JSON 404 instead of HTML. The server's own `/_urlcode/*`
probes stay text.

Targets: self-hosted, AWS and Vercel write it in the shared runtime (including
the adapters' own body-limit 413), and the Cloudflare Worker artifact carries
the route formats and the site scope. Static hosting has no server to write an
error, so it refuses `errors: {format: json}` and `site.errors` before building
(`urlcode capabilities --target static` lists `errors` as refused).

## Still outside this contract

Automatic CORS/preflight policy, cookie parsing/signing, authentication
(beyond the operator-installed auth extension), JSON Schema beyond the
`request.body.<METHOD>.schema` profile above, OpenAPI export, multipart/file uploads, streaming, content negotiation,
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
