# Implemented alpha contract

This document and [JSON Schema](../schemas/urlcode.schema.json) describe
0.1.0-alpha.1. `version: "1"` is the current alpha profile, not a promise that
v1 is stable. Later planned features are rejected until implemented.

## Files and validation

`urlcode.yaml` contains `version`, `routes`, and optional `includes` (an explicit
list of project-relative YAML files). Included files have the same version/routes
shape and cannot recursively include files. Duplicate paths across files fail.
File references resolve inside the project; escaping symlinks fail. No glob,
remote config or arbitrary infrastructure configuration.

YAML 1.2 JSON-compatible values only: string mapping keys, finite numbers,
booleans and null. No duplicate keys, aliases, anchors, tags, merge keys,
multiple documents, reserved prototype keys or nesting of 40+ levels. Unknown
schema fields fail. Files are limited to 32 MiB each, 256 includes and 100,000
routes total. At most 1,000 parameterized routes and 1,024 distinct input schemas.

## Routes

Keys are absolute case-sensitive paths. Trailing slashes are significant.
Parameters occupy whole segments, e.g. `/p/{id}`, with distinct identifier names.
No regex/wildcard paths, host matching or dot segments. Route keys cannot contain
percent encoding, spaces, backslashes or query strings. Path length is limited
to 2,048 characters and 32 segments. `/_urlcode` is reserved.

One handler per route: `redirect` or `function`. Optional properties:

- `methods`: unique HTTP methods; default GET and HEAD. Explicit lists are exact;
  adding GET does not implicitly add HEAD. Wrong method returns 405 plus Allow.
- `enabled`: false returns 404, the same as unknown paths.
- `expires`: UTC ISO timestamp (`...ssZ` or `...ss.sssZ`); expired routes return 410.
- `description`: optional authoring metadata.
- `parameters`, `env`, `secrets`: inputs and explicit binding references.

Literal paths win; parameter routes with more literal segments win next.
Equally specific overlapping patterns fail even if methods differ. Match a route
before checking its methods; do not fall back to a less specific route for 405.
Requests decode the path once; invalid UTF-8/percent encoding, encoded slashes or
backslashes, control characters and dot segments return 400. Query values decode
once. Incoming query data is not automatically forwarded.

## Inputs

Declare each path placeholder as a required string. Query/header inputs may be
string, integer, number or boolean. Query arrays declare scalar `items`; repeated
keys retain order (maximum 100 values). Header names are case-insensitive.
Duplicate scalar query/header inputs return 400. Required missing inputs return
400; defaults apply only to absent inputs. Empty strings are present values.

Supported validation: `type`, scalar `enum`, `default`, string `minLength`/
`maxLength`, numeric `minimum`/`maximum`, query array `items` and `maxItems`.
Regular-expression patterns, structured bodies, cookies, nested inputs and
OpenAPI `style`/`explode` fields are not implemented. This uses a documented
OpenAPI-like input subset; it is not an OpenAPI document or full JSON Schema
input vocabulary. String limits are at most 8,192 characters.

Integers use `-?(0|[1-9][0-9]*)` and must be safe JavaScript integers. Numbers
allow the same grammar plus a fractional suffix; no exponent, plus sign, leading
zeros, whitespace, NaN or infinity. Booleans are exactly `true` or `false`.
Unknown query keys are ignored unless explicitly passed by a redirect.

## Redirects

`redirect.url` is an absolute HTTP(S) URL with literal scheme/host and no embedded
credentials or whitespace/control characters. `{pathInput}` placeholders are
allowed only in the destination pathname and encoded as single components.
No environment/secret interpolation. Status defaults to 302; allowed values are
301, 302, 303, 307 and 308.

`redirect.query.map` maps output keys to `{from: path|query|header, name: input}`
references to declared inputs. Typed/defaulted values are used. Arrays produce
repeated output keys. Absent optional inputs are omitted.
`redirect.query.pass` is false or an explicit allowlist; unrestricted `true` is
not supported. Conflicts between destination keys, maps and passthrough fail.
Declared passthrough inputs use validated/defaulted values; undeclared allowlisted
keys preserve repeated values. Headers are forwarded only through explicit maps.

## Functions

```yaml
version: "1"
routes:
  /hello/{name}:
    parameters:
      - name: name
        in: path
        required: true
        schema: {type: string, minLength: 1}
    function:
      source: functions/hello.mjs
      export: default
      args:
        name: {from: path, name: name}
    env:
      GREETING: {value: Hello}
```

```js
export default function hello(request, { args, env }) {
  return Response.json({ message: `${env.GREETING}, ${args.name}!` });
}
```

ES modules only (`.mjs`, or `.js` with a project `package.json` declaring
`"type":"module"`). TypeScript compilation is not included. Function `export`
defaults to `default`. A handler receives standard Web Request/Response APIs;
context provides `inputs.path/query/header`, `args`, `env` and `secrets`.
Arguments may be scalar literals, input references, `{env: alias}` or
`{secret: alias}`. Aliases must be declared on the route.

`env` bindings use `{value: "literal"}` or `{env: EXTERNAL_NAME}`; `secrets`
use `{secret: logical_name}`. Missing bindings reject activation. Development
reads `.env.local`, with process values taking precedence; serving never reads
it. Dotenv supports single-line NAME=value and paired single/double quotes,
blank lines and full-line comments. No expansion, escapes or shell execution.
Use `.env.example` for names/placeholders only.

Two function workers by default, no queue; saturation returns 503. A 5-second
handler/response-body deadline returns 504 and terminates/replaces the worker.
Errors or oversized responses return a generic 502 without operator exceptions.
Workers have a 128 MiB V8 old-generation limit (not a total-process memory limit).
Three replacements per worker per minute are allowed; recurring crashes require
reload/restart. Readiness is degraded while any worker is unavailable.

HEAD executes a function with method HEAD and suppresses its response body;
functions must guard their own side effects. Worker stdout/stderr are suppressed
to avoid accidental secret logging. Operator functions can still read files,
access process environment, import dependencies and make network calls: they
are trusted code, not a sandbox. Entry references are contained; transitive
imports are ordinary trusted Node imports. Portability of arbitrary Node modules
is not promised for future provider adapters. Prefer Web APIs in app functions.

Function URLs use an explicit `--origin` or the listening origin, never arbitrary
Host/forwarded headers. Request and response bodies default to 1 MiB. Hop-by-hop
response headers are stripped; cookies are preserved individually. Default cache
policy is `no-store`; functions may explicitly override it. 204/304 and HEAD have
no response body. Application code remains responsible for authentication,
validation of external services and preventing deliberate secret disclosure.

## Reload and status

`dev` polls project YAML/JSON/JS and `.env.local` every 500 ms, excluding common
build/dependency directories and hidden files. Includes and source dependencies
must be normal watched files; changes in symlink targets or `node_modules`
require restart. A candidate fully validates and initializes its functions
before activation. Invalid candidates leave the old snapshot serving. In-flight
function calls finish on their original snapshot; new requests use the new one.
Production `serve` is a fixed snapshot; restart/redeploy for code or secret rotation.

The health `version` is a digest of route definitions, not a full artifact digest
or secret fingerprint. Production release identity should be the Git commit and
container image digest. See [operations](OPERATIONS.md).
