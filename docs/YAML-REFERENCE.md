# YAML field reference

Generated from the bundled JSON Schema by `npm run docs:reference`. Required
means required within its containing object, not that the object itself must be
present. `routes.*` means a route path; other `*` markers mean user-selected
keys. `[]` means an array item. Option rows describe union alternatives.
Every property carries a schema-level description, and the reference check
fails when one is missing; array items, map values and union options without
one show — in that column. Read the linked guide section for behavior JSON
Schema does not express.

Read the [YAML guide](YAML-GUIDE.md) for examples and [specification](SPECIFICATION.md)
for semantic validation beyond JSON Schema. Exactly one handler is required per
route; respond.text/respond.json are mutually exclusive. Runtime defaults include
GET/HEAD, redirect 302, respond 200, default module export, and asset no-cache.
Only Set-Cookie accepts response header arrays. This table does not imply all
schema-valid combinations activate successfully.

## Areas

- [Project entry: version, includes, shared](#project-entry-version-includes-shared)
- [Routes: common fields (methods, parameters, env, secrets, policies, cache)](#routes-common-fields-methods-parameters-env-secrets-policies-cache)
- [Handler: redirect](#handler-redirect)
- [Handler: function](#handler-function)
- [Handler: page, static, download](#handler-page-static-download)
- [Handler: respond](#handler-respond)
- [Middleware](#middleware)
- [Handler: conditional](#handler-conditional)
- [Handler: proxy and signals](#handler-proxy-and-signals)
- [Handler: extension mount](#handler-extension-mount)
- [Policies and profiles](#policies-and-profiles)
- [Site conventions](#site-conventions)
- [Extensions (top-level)](#extensions-top-level)

## Project entry: version, includes, shared

See [organization](yaml/organization.md) for examples.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `version` | constant | yes | const: "1" | Project format version; always "1". |
| `includes` | array | no | maxItems: 256; uniqueItems: true | Other YAML files whose routes join this project; entry urlcode.yaml only, with no nesting. |
| `includes[]` | string | no | maxLength: 1024 | — |
| `shared` | object | no | maxProperties: 32 | Reusable named request and response.headers blocks a route selects with use. Resolved at load time; the route hash, audit and routes output show the resolved route. Entry urlcode.yaml only. Response headers the runtime owns are refused. |
| `shared.*` | object | no | unknown keys rejected | — |
| `shared.*.request` | object | no | unknown keys rejected | Request body checks a route inherits when it names this block with use. |
| `shared.*.request.body` | object | no | unknown keys rejected | What the request body must look like before the handler runs (docs/HTTP.md). |
| `shared.*.request.body.required` | boolean | no | — | Whether an empty body is refused with 400. |
| `shared.*.request.body.maxBytes` | integer | no | minimum: 0; maximum: 1048576 | Largest body accepted, in bytes; a larger one answers 413. |
| `shared.*.request.body.contentTypes` | array | no | minItems: 1; maxItems: 16; uniqueItems: true | Lowercase media types a nonempty body may declare; any other answers 415. |
| `shared.*.request.body.contentTypes[]` | string | no | pattern: "^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$" | — |
| `shared.*.request.body.format` | string | no | enum: ["text","json"] | text checks the body is UTF-8; json also checks it parses as JSON; malformed input answers 400. |
| `shared.*.request.body.schema` | object | no | — | A JSON Schema subset checked after parsing (requires format: json); a body that breaks it answers 422. Supported keywords: type (object, array, string, integer, number, boolean, null), properties, required, additionalProperties (true or false), items, enum (scalar values), minLength, maxLength (up to 1048576, the request body limit), pattern (needs maxLength of at most 128 on the same node), format (uuid only), minimum, maximum, minItems, maxItems (up to 10000). Anything else, including $ref, oneOf, default and format: email, fails activation. At most 6 levels, 128 nodes and 64 properties per object. |
| `shared.*.response` | object | no | unknown keys rejected | Response headers a route inherits when it names this block with use. |
| `shared.*.response.headers` | object | no | maxProperties: 64 | Literal response headers added to the route's answer; only Set-Cookie takes a list, and runtime-owned headers are refused (docs/HTTP.md). |
| `shared.*.response.headers.*` | one of the shapes below | no | — | — |
| `shared.*.response.headers.* (option 1)` | string | no | maxLength: 4096 | — |
| `shared.*.response.headers.* (option 2)` | array | no | minItems: 1; maxItems: 16 | — |
| `shared.*.response.headers.* (option 2)[]` | string | no | maxLength: 4096 | — |

## Routes: common fields (methods, parameters, env, secrets, policies, cache)

See [functions, inputs and methods](yaml/functions.md) and [bindings, split files and tests](yaml/organization.md) for examples.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `routes` | object | yes | maxProperties: 100000 | Map of route path patterns to the route each one serves (matching rules in docs/ROUTING.md). |
| `routes.*` | object | no | unknown keys rejected | — |
| `routes.*.methods` | array | no | default: ["GET","HEAD"]; minItems: 1; uniqueItems: true | HTTP methods this route answers; any other method gets 405 with Allow, and an explicit list replaces the GET/HEAD default. |
| `routes.*.methods[]` | string | no | enum: ["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"] | — |
| `routes.*.enabled` | boolean | no | — | Set false to switch the route off so it answers 404 without removing it. |
| `routes.*.sandbox` | boolean | no | default: false | Run this route's function/middleware in the isolated QuickJS/WASM worker pool instead of the trusted, in-process default. false or absent (the default) means trusted, unsandboxed, direct host-process execution. |
| `routes.*.sandboxReason` | string | no | maxLength: 500 | Optional justification for this route's sandbox decision, whether sandbox is true or false: why it needs isolation, or why it is safe to trust. Never inferred or enforced; surfaced verbatim by explain/context/manifest. |
| `routes.*.coveredElsewhere` | object | no | minProperties: 1 | Audit-only waiver: methods of this route whose normal-response fixture is provided by other tests (for example stateful create/update/delete). Each method needs a non-empty reason and must be one of the route's methods. audit lists waived pairs with their reasons under waivedRouteMethods and still requires the route to have another normally covered method; it never hides a function route that only serves errors. Project file only: there is no CLI flag. |
| `routes.*.coveredElsewhere.*` | string | no | minLength: 1; maxLength: 500 | Why this method is tested elsewhere. |
| `routes.*.expires` | string | no | — | Quoted UTC timestamp (YYYY-MM-DDTHH:MM:SSZ) after which the route answers 410 Gone. |
| `routes.*.description` | string | no | maxLength: 1024 | Free-text note for authors and tooling; it does not change how the route answers. |
| `routes.*.parameters` | array | no | maxItems: 64 | Path, query and header inputs the route accepts, validated before the handler runs; a missing or invalid input answers 400. |
| `routes.*.parameters[]` | object | no | unknown keys rejected | — |
| `routes.*.parameters[].name` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_-]*$" | Input name: the {placeholder} in the route path, the query key or the header name. |
| `routes.*.parameters[].in` | string | yes | enum: ["path","query","header"] | Where the input is read from: path, query or header. |
| `routes.*.parameters[].required` | boolean | no | — | Whether a request without this input is refused with 400; path inputs must be required. |
| `routes.*.parameters[].schema` | object | yes | unknown keys rejected | Type and constraints the input must satisfy, a documented subset of JSON Schema (docs/HTTP.md). |
| `routes.*.parameters[].schema.type` | string | yes | enum: ["string","integer","number","boolean","array"] | Value type the raw input is converted to; path inputs are strings and arrays are query-only. |
| `routes.*.parameters[].schema.enum` | array | no | minItems: 1; uniqueItems: true | The only values the input may take. |
| `routes.*.parameters[].schema.enum[]` | string / number / boolean | no | — | — |
| `routes.*.parameters[].schema.default` | string / number / boolean / array | no | — | Value used when a query or header input is absent; path inputs cannot have one. |
| `routes.*.parameters[].schema.default[]` | string / number / boolean | no | — | — |
| `routes.*.parameters[].schema.minLength` | integer | no | minimum: 0; maximum: 8192 | Shortest string the input accepts. |
| `routes.*.parameters[].schema.maxLength` | integer | no | minimum: 0; maximum: 8192 | Longest string the input accepts. |
| `routes.*.parameters[].schema.minimum` | number | no | — | Smallest number an integer or number input accepts. |
| `routes.*.parameters[].schema.maximum` | number | no | — | Largest number an integer or number input accepts. |
| `routes.*.parameters[].schema.pattern` | string | no | minLength: 1; maxLength: 128 | Regular expression a string input must match, from a bounded subset that also needs maxLength (docs/HTTP.md). |
| `routes.*.parameters[].schema.format` | string | no | enum: ["uuid"] | Named string format the input must match; only uuid is supported. |
| `routes.*.parameters[].schema.items` | object | no | unknown keys rejected | Element type of a query array input. |
| `routes.*.parameters[].schema.items.type` | string | yes | enum: ["string","integer","number","boolean"] | Scalar type each repeated query value is converted to. |
| `routes.*.parameters[].schema.maxItems` | integer | no | minimum: 0; maximum: 100 | Most repeated values a query array input accepts. |
| `routes.*.env` | object | no | — | Non-secret values the route's function and middleware read as context.env, each a literal or a granted process environment variable. |
| `routes.*.env.*` | one of the shapes below | no | — | — |
| `routes.*.env.* (option 1)` | object | no | unknown keys rejected | — |
| `routes.*.env.* (option 1).value` | string | yes | — | Literal value, never overridden by the host environment and needing no grant. |
| `routes.*.env.* (option 2)` | object | no | unknown keys rejected | — |
| `routes.*.env.* (option 2).env` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" | Process environment variable to read, which an operator policy must grant to this route. |
| `routes.*.env.* (option 2).default` | string | no | — | Value used when the variable is ungranted or unset, so the route still activates without an operator grant. |
| `routes.*.secrets` | object | no | — | Secret values the route's function, middleware, proxy and signals can use, each resolved from a name an operator policy grants to this route. |
| `routes.*.secrets.*` | object | no | unknown keys rejected | — |
| `routes.*.secrets.*.secret` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" | External secret name the operator grants to this route; the value never appears in YAML. |
| `routes.*.request` | object | no | unknown keys rejected | Request body checks run before the handler; declaring it replaces the request block of a shared block named by use. |
| `routes.*.request.body` | object | no | unknown keys rejected | What the request body must look like before the handler runs (docs/HTTP.md). |
| `routes.*.request.body.required` | boolean | no | — | Whether an empty body is refused with 400. |
| `routes.*.request.body.maxBytes` | integer | no | minimum: 0; maximum: 1048576 | Largest body accepted, in bytes; a larger one answers 413. |
| `routes.*.request.body.contentTypes` | array | no | minItems: 1; maxItems: 16; uniqueItems: true | Lowercase media types a nonempty body may declare; any other answers 415. |
| `routes.*.request.body.contentTypes[]` | string | no | pattern: "^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$" | — |
| `routes.*.request.body.format` | string | no | enum: ["text","json"] | text checks the body is UTF-8; json also checks it parses as JSON; malformed input answers 400. |
| `routes.*.request.body.schema` | object | no | — | A JSON Schema subset checked after parsing (requires format: json); a body that breaks it answers 422. Supported keywords: type (object, array, string, integer, number, boolean, null), properties, required, additionalProperties (true or false), items, enum (scalar values), minLength, maxLength (up to 1048576, the request body limit), pattern (needs maxLength of at most 128 on the same node), format (uuid only), minimum, maximum, minItems, maxItems (up to 10000). Anything else, including $ref, oneOf, default and format: email, fails activation. At most 6 levels, 128 nodes and 64 properties per object. |
| `routes.*.response` | object | no | unknown keys rejected | Literal response headers added to every answer; declaring it replaces the response block of a shared block named by use. |
| `routes.*.response.headers` | object | no | maxProperties: 64 | Literal response headers added to the route's answer; only Set-Cookie takes a list, and runtime-owned headers are refused (docs/HTTP.md). |
| `routes.*.response.headers.*` | one of the shapes below | no | — | — |
| `routes.*.response.headers.* (option 1)` | string | no | maxLength: 4096 | — |
| `routes.*.response.headers.* (option 2)` | array | no | minItems: 1; maxItems: 16 | — |
| `routes.*.response.headers.* (option 2)[]` | string | no | maxLength: 4096 | — |
| `routes.*.policies` | object | no | unknown keys rejected | This route's policy layer, merged over the project policies; false on a key turns that policy off here. |
| `routes.*.policies.profile` | string | no | pattern: "^[a-z][a-z0-9-]{0,63}$" | Built-in (hardened) or a name under top-level profiles |
| `routes.*.policies.throttle` | one of the shapes below | no | — | Per-client request budget, or false to turn it off at this layer. |
| `routes.*.policies.throttle (option 1)` | constant | no | const: false | — |
| `routes.*.policies.throttle (option 2)` | object | no | unknown keys rejected | Per-client request budget expressed like the IETF RateLimit-Policy field: quota requests per window seconds. quota and window are required once project and route layers are merged. |
| `routes.*.policies.throttle (option 2).quota` | integer | no | minimum: 1; maximum: 1000000 | Requests a partition may make per window before it is refused. |
| `routes.*.policies.throttle (option 2).window` | integer | no | minimum: 1; maximum: 86400 | Length of the sliding counting window, in seconds. |
| `routes.*.policies.throttle (option 2).partition` | string | no | enum: ["client","route","client-route"]; default: "client" | What gets its own counter: each client address, the whole route, or each client on each route (docs/policies/throttle.md). |
| `routes.*.policies.throttle (option 2).status` | integer | no | default: 429; minimum: 400; maximum: 599 | Status answered, with Retry-After, to a request over budget. |
| `routes.*.policies.throttle (option 2).mode` | string | no | enum: ["enforce","report"]; default: "enforce" | enforce refuses requests over budget; report only logs them so a quota can be tuned first. |
| `routes.*.policies.throttle (option 2).maxKeys` | integer | no | default: 100000; minimum: 1000; maximum: 10000000 | Most counters kept in memory; the least recently used is evicted and starts fresh. |
| `routes.*.policies.agents` | one of the shapes below | no | — | User-Agent allow and deny rules, or false to turn them off at this layer. |
| `routes.*.policies.agents (option 1)` | constant | no | const: false | — |
| `routes.*.policies.agents (option 2)` | object | no | unknown keys rejected | User-Agent policy. Named lists ship with the runtime; project-relative .json files in the same schema supply your own. |
| `routes.*.policies.agents (option 2).deny` | array | no | maxItems: 32; uniqueItems: true | Bundled list names or project-relative .json lists whose User-Agents are refused (docs/policies/agents.md). |
| `routes.*.policies.agents (option 2).deny[]` | string | no | minLength: 1; maxLength: 1024 | — |
| `routes.*.policies.agents (option 2).allow` | array | no | maxItems: 32; uniqueItems: true | Bundled list names or project-relative .json lists whose User-Agents always pass, even when a deny rule matches. |
| `routes.*.policies.agents (option 2).allow[]` | string | no | minLength: 1; maxLength: 1024 | — |
| `routes.*.policies.agents (option 2).denyPatterns` | array | no | maxItems: 256; uniqueItems: true | Case-insensitive patterns, from a bounded regex subset, whose matching User-Agents are refused. |
| `routes.*.policies.agents (option 2).denyPatterns[]` | string | no | minLength: 1; maxLength: 256 | — |
| `routes.*.policies.agents (option 2).allowPatterns` | array | no | maxItems: 256; uniqueItems: true | Case-insensitive patterns, from a bounded regex subset, whose matching User-Agents always pass. |
| `routes.*.policies.agents (option 2).allowPatterns[]` | string | no | minLength: 1; maxLength: 256 | — |
| `routes.*.policies.agents (option 2).denyEmpty` | boolean | no | default: false | Deny requests that send no User-Agent |
| `routes.*.policies.agents (option 2).status` | integer | no | default: 403; minimum: 400; maximum: 599 | Status answered to a denied request. |
| `routes.*.policies.agents (option 2).mode` | string | no | enum: ["enforce","report"]; default: "enforce" | enforce refuses matching requests; report only logs them so a list can be tried first. |
| `routes.*.policies.security` | one of the shapes below | no | — | Response security header profile, or false to turn it off at this layer. |
| `routes.*.policies.security (option 1)` | constant | no | const: false | — |
| `routes.*.policies.security (option 2)` | object | no | unknown keys rejected | Response security headers. Profiles follow the OWASP Secure Headers Project; set overrides or adds individual headers; unset removes one from the profile. |
| `routes.*.policies.security (option 2).headers` | string | no | enum: ["oshp","oshp-no-csp","off"]; default: "oshp" | Which header profile to add: oshp, oshp-no-csp (the same without Content-Security-Policy) or off (docs/policies/security.md). |
| `routes.*.policies.security (option 2).set` | object | no | maxProperties: 32 | Headers added or overwritten verbatim on every response, taking precedence over the profile. |
| `routes.*.policies.security (option 2).set.*` | string | no | maxLength: 4096 | — |
| `routes.*.policies.security (option 2).unset` | array | no | maxItems: 32; uniqueItems: true | Header names the selected profile would add that this route or project leaves out. |
| `routes.*.policies.security (option 2).unset[]` | string | no | minLength: 1; maxLength: 128 | — |
| `routes.*.policies.compression` | one of the shapes below | no | — | Response compression negotiated from Accept-Encoding, or false to turn it off at this layer. |
| `routes.*.policies.compression (option 1)` | constant | no | const: false | — |
| `routes.*.policies.compression (option 2)` | object | no | unknown keys rejected | Content-coding negotiation per RFC 9110. Assets are precompressed at snapshot time; other bodies compress on the request path. |
| `routes.*.policies.compression (option 2).encodings` | array | no | default: ["br","gzip"]; minItems: 1; uniqueItems: true | Content codings offered, in preference order when the client weights them equally. |
| `routes.*.policies.compression (option 2).encodings[]` | string | no | enum: ["br","gzip","deflate","zstd"] | — |
| `routes.*.policies.compression (option 2).minBytes` | integer | no | default: 1024; minimum: 0; maximum: 1048576 | Bodies smaller than this many bytes are sent uncompressed. |
| `routes.*.policies.compression (option 2).types` | array | no | maxItems: 64; uniqueItems: true | Media types eligible for compression, with type/* wildcards; a documented default list of text and structured-data types when omitted. |
| `routes.*.policies.compression (option 2).types[]` | string | no | minLength: 1; maxLength: 128 | — |
| `routes.*.policies.compression (option 2).level` | integer | no | minimum: 1; maximum: 11 | One compression effort setting mapped onto each codec's own scale (docs/policies/compression.md). |
| `routes.*.policies.compression (option 2).allowWithSecrets` | boolean | no | default: false | Compress even on routes with secrets or responses that set cookies, where BREACH-style leaks are possible. |
| `routes.*.policies.cache` | one of the shapes below | no | — | HTTP caching strategy, or false to turn it off at this layer. |
| `routes.*.policies.cache (option 1)` | constant | no | const: false | — |
| `routes.*.policies.cache (option 2)` | object | no | unknown keys rejected | Named HTTP caching strategy per RFC 9111/5861/8246/9213; explicit fields override what the strategy implies. strategy is required once project and route layers are merged. |
| `routes.*.policies.cache (option 2).strategy` | string | no | enum: ["no-store","revalidate","public","immutable","swr","sie","micro","cdn-only","private"] | Named caching pattern that decides the Cache-Control output and whether the origin memory cache is used (docs/policies/cache.md). |
| `routes.*.policies.cache (option 2).maxAge` | integer | no | minimum: 0; maximum: 31536000 | Seconds the response stays fresh (max-age), overriding what the strategy implies. |
| `routes.*.policies.cache (option 2).staleWhileRevalidate` | integer | no | minimum: 0; maximum: 31536000 | Seconds a stale response may still be served while it is refreshed (stale-while-revalidate). |
| `routes.*.policies.cache (option 2).staleIfError` | integer | no | minimum: 0; maximum: 31536000 | Seconds a stale response may be served when the origin fails (stale-if-error); emitted as a header only. |
| `routes.*.policies.cache (option 2).cdnMaxAge` | integer | no | minimum: 0; maximum: 31536000 | Seconds a CDN may keep the response, sent as CDN-Cache-Control. |
| `routes.*.policies.cache (option 2).originTtl` | integer | no | minimum: 0; maximum: 86400 | Seconds an origin memory cache may serve a stored response |
| `routes.*.policies.cache (option 2).vary` | array | no | maxItems: 8; uniqueItems: true | Request headers the response varies on, added to Vary and to the origin cache key. |
| `routes.*.policies.cache (option 2).vary[]` | string | no | minLength: 1; maxLength: 128 | — |
| `routes.*.policies.cache (option 2).statuses` | array | no | maxItems: 16; uniqueItems: true | Response statuses the origin memory cache may store. |
| `routes.*.policies.cache (option 2).statuses[]` | integer | no | minimum: 200; maximum: 599 | — |
| `routes.*.policies.cache (option 2).maxBytes` | integer | no | minimum: 0; maximum: 16777216 | Largest body the origin cache stores |
| `routes.*.policies.cache (option 2).maxEntries` | integer | no | minimum: 1; maximum: 1000000 | Most responses the origin memory cache keeps for this configuration; the least recently used is evicted first. |
| `routes.*.policies.cache (option 2).force` | boolean | no | default: false | Allow immutable on a path without a content hash |
| `routes.*.policies.extensions` | one of the shapes below | no | — | Route requirements for declared extensions, keyed by extension name and validated by each extension's policy schema, or false to drop them at this layer. |
| `routes.*.policies.extensions (option 1)` | constant | no | const: false | — |
| `routes.*.policies.extensions (option 2)` | object | no | maxProperties: 16 | — |
| `routes.*.policies.extensions (option 2).*` | one of the shapes below | no | — | — |
| `routes.*.policies.extensions (option 2).* (option 1)` | constant | no | const: false | — |
| `routes.*.policies.extensions (option 2).* (option 2)` | object | no | — | — |
| `routes.*.match` | object | no | minProperties: 1; unknown keys rejected | Exact conditions every request must meet for this route to answer; a mismatch answers 404 (docs/CONDITIONS.md). |
| `routes.*.match.query` | object | no | minProperties: 1; maxProperties: 16 | Query keys and the exact values they must have. |
| `routes.*.match.query.*` | string | no | maxLength: 1024 | — |
| `routes.*.match.headers` | object | no | minProperties: 1; maxProperties: 16 | Request headers and the exact values they must have; names compare case-insensitively. |
| `routes.*.match.headers.*` | string | no | maxLength: 1024 | — |
| `routes.*.match.cookies` | object | no | minProperties: 1; maxProperties: 16 | Cookie names and the exact values they must have. |
| `routes.*.match.cookies.*` | string | no | maxLength: 1024 | — |
| `routes.*.match.host` | string | no | maxLength: 255 | Host the operator-configured public origin must have; never read from the client Host header. |
| `routes.*.match.method` | string | no | enum: ["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"] | HTTP method the request must use. |
| `routes.*.auth` | one of the shapes below | no | — | Short form for a route protected by the declared auth extension: true, or an object that expands to policies.extensions.auth with the same keys minus required; required: false emits no policy. Core owns only this mapping; the object's other keys belong to the auth extension, whose policy schema validates them (reported at this route's auth key). Refused without an extensions.auth declaration or alongside policies.extensions.auth. |
| `routes.*.auth (option 1)` | constant | no | const: true | — |
| `routes.*.auth (option 2)` | object | no | — | The auth extension's route requirement, plus required. Only required is defined here: the other keys are the auth extension's own policy vocabulary, validated by its policySchema (urlcode extensions --json) at validate time and at startup. |
| `routes.*.auth (option 2).required` | boolean | no | default: true | Set false to document that the route is deliberately public; no auth requirement is emitted. |
| `routes.*.cache` | object | no | unknown keys rejected | Short form for policies.cache: the same object, expanded to policies.cache before anything else reads the project. Refused alongside policies.cache; use one form. |
| `routes.*.cache.strategy` | string | no | enum: ["no-store","revalidate","public","immutable","swr","sie","micro","cdn-only","private"] | Named caching pattern that decides the Cache-Control output and whether the origin memory cache is used (docs/policies/cache.md). |
| `routes.*.cache.maxAge` | integer | no | minimum: 0; maximum: 31536000 | Seconds the response stays fresh (max-age), overriding what the strategy implies. |
| `routes.*.cache.staleWhileRevalidate` | integer | no | minimum: 0; maximum: 31536000 | Seconds a stale response may still be served while it is refreshed (stale-while-revalidate). |
| `routes.*.cache.staleIfError` | integer | no | minimum: 0; maximum: 31536000 | Seconds a stale response may be served when the origin fails (stale-if-error); emitted as a header only. |
| `routes.*.cache.cdnMaxAge` | integer | no | minimum: 0; maximum: 31536000 | Seconds a CDN may keep the response, sent as CDN-Cache-Control. |
| `routes.*.cache.originTtl` | integer | no | minimum: 0; maximum: 86400 | Seconds an origin memory cache may serve a stored response |
| `routes.*.cache.vary` | array | no | maxItems: 8; uniqueItems: true | Request headers the response varies on, added to Vary and to the origin cache key. |
| `routes.*.cache.vary[]` | string | no | minLength: 1; maxLength: 128 | — |
| `routes.*.cache.statuses` | array | no | maxItems: 16; uniqueItems: true | Response statuses the origin memory cache may store. |
| `routes.*.cache.statuses[]` | integer | no | minimum: 200; maximum: 599 | — |
| `routes.*.cache.maxBytes` | integer | no | minimum: 0; maximum: 16777216 | Largest body the origin cache stores |
| `routes.*.cache.maxEntries` | integer | no | minimum: 1; maximum: 1000000 | Most responses the origin memory cache keeps for this configuration; the least recently used is evicted first. |
| `routes.*.cache.force` | boolean | no | default: false | Allow immutable on a path without a content hash |
| `routes.*.use` | string | no | pattern: "^[a-z][a-z0-9-]{0,63}$" | Name of a top-level shared block whose request and response.headers this route inherits. A key the route declares itself replaces the shared block as a whole; there is no deep merge. |

## Handler: redirect

See [redirects](yaml/redirects.md) for examples.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `routes.*.redirect` | object | no | unknown keys rejected | HTTP redirect. The route path may end in /** to redirect a whole subtree (literal prefix, one terminal **, no path placeholders, no conditional); no other wildcard is accepted. |
| `routes.*.redirect.url` | string | yes | maxLength: 8192 | Destination URL: a literal http(s) URL or a same-site path starting with /, where {name} placeholders are filled from declared path inputs and a subtree redirect can append the matched remainder (docs/yaml/redirects.md). |
| `routes.*.redirect.status` | number | no | enum: [301,302,303,307,308] | Redirect status code; 302 when omitted. |
| `routes.*.redirect.query` | object | no | unknown keys rejected | Which request values are copied into the destination query string; nothing is forwarded unless listed here. |
| `routes.*.redirect.query.pass` | one of the shapes below | no | — | Incoming query keys copied to the destination unchanged; false or omitted forwards none. |
| `routes.*.redirect.query.pass (option 1)` | constant | no | const: false | — |
| `routes.*.redirect.query.pass (option 2)` | array | no | uniqueItems: true | — |
| `routes.*.redirect.query.pass (option 2)[]` | string | no | — | — |
| `routes.*.redirect.query.map` | object | no | — | Destination query keys, each filled from a declared path, query or header input. |
| `routes.*.redirect.query.map.*` | object | no | unknown keys rejected | — |
| `routes.*.redirect.query.map.*.from` | string | yes | enum: ["path","query","header"] | Where the declared input comes from: path, query or header. |
| `routes.*.redirect.query.map.*.name` | string | yes | — | Name of the declared input whose validated value fills this destination key. |

## Handler: function

See [functions, inputs and methods](yaml/functions.md) for examples.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `routes.*.function` | one of the shapes below | no | — | Run a JavaScript module for this route, as a project-relative .mjs/.js path or an object naming source, export and args (docs/yaml/functions.md). |
| `routes.*.function (option 1)` | string | no | minLength: 1; maxLength: 1024 | — |
| `routes.*.function (option 2)` | object | no | unknown keys rejected | — |
| `routes.*.function (option 2).source` | string | yes | maxLength: 1024 | Project-relative path of the .mjs or .js module to run. |
| `routes.*.function (option 2).export` | string | no | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" | Named export to call; the default export when omitted. |
| `routes.*.function (option 2).args` | object | no | — | Named values passed to the function as context.args: literals, declared inputs or route bindings; omitted binds every declared path input. |
| `routes.*.function (option 2).args.*` | one of the shapes below | no | — | — |
| `routes.*.function (option 2).args.* (option 1)` | string / number / boolean | no | — | — |
| `routes.*.function (option 2).args.* (option 2)` | object | no | unknown keys rejected | — |
| `routes.*.function (option 2).args.* (option 2).from` | string | yes | enum: ["path","query","header"] | Where the declared input comes from: path, query or header. |
| `routes.*.function (option 2).args.* (option 2).name` | string | yes | — | Name of the declared input whose validated value becomes this argument. |
| `routes.*.function (option 2).args.* (option 3)` | object | no | unknown keys rejected | — |
| `routes.*.function (option 2).args.* (option 3).env` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" | Alias of a binding in this route's env whose value becomes this argument. |
| `routes.*.function (option 2).args.* (option 4)` | object | no | unknown keys rejected | — |
| `routes.*.function (option 2).args.* (option 4).secret` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" | Alias of a binding in this route's secrets whose value becomes this argument. |

## Handler: page, static, download

See [pages, static folders and downloads](yaml/assets.md) for examples.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `routes.*.page` | object | no | unknown keys rejected | Serve one project file as the response, with ETag, conditional and range support. |
| `routes.*.page.file` | string | yes | minLength: 1; maxLength: 1024 | Project-relative path of the file to serve. |
| `routes.*.page.contentType` | string | no | maxLength: 128; pattern: "^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$" | Media type sent instead of the one detected from the file extension. |
| `routes.*.page.cacheControl` | string | no | enum: ["no-cache","no-store","public, max-age=3600","public, max-age=31536000, immutable"] | Cache-Control header for the file; no-cache when omitted. |
| `routes.*.download` | object | no | unknown keys rejected | Serve one project file as an attachment the browser saves rather than displays. |
| `routes.*.download.file` | string | yes | minLength: 1; maxLength: 1024 | Project-relative path of the file to serve. |
| `routes.*.download.contentType` | string | no | maxLength: 128; pattern: "^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$" | Media type sent instead of the one detected from the file extension. |
| `routes.*.download.cacheControl` | string | no | enum: ["no-cache","no-store","public, max-age=3600","public, max-age=31536000, immutable"] | Cache-Control header for the file; no-cache when omitted. |
| `routes.*.download.filename` | string | no | minLength: 1; maxLength: 255 | File name offered in Content-Disposition; the source file's basename when omitted. |
| `routes.*.static` | object | no | unknown keys rejected | Serve a project directory. The route path must end in a terminal /* (for example /assets/*); a static route without it is rejected. |
| `routes.*.static.directory` | string | yes | minLength: 1; maxLength: 1024 | Project-relative directory whose files are served under the route prefix. |
| `routes.*.static.contentType` | string | no | maxLength: 128; pattern: "^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$" | Media type sent for every file in the directory instead of the one detected from each extension. |
| `routes.*.static.cacheControl` | string | no | enum: ["no-cache","no-store","public, max-age=3600","public, max-age=31536000, immutable"] | Cache-Control header for every file in the directory; no-cache when omitted. |
| `routes.*.static.index` | string | no | pattern: "^[A-Za-z0-9_-]+\\.html$" | HTML file served for a request ending in /; without it such requests get 404. |

## Handler: respond

See [declared responses, headers and cookies](yaml/responses.md) for examples.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `routes.*.respond` | object | no | unknown keys rejected | Answer directly with a fixed status and an optional text or JSON body, with no code or file. |
| `routes.*.respond.status` | integer | no | minimum: 200; maximum: 599 | HTTP status of the declared response; 200 when omitted. |
| `routes.*.respond.text` | string | no | maxLength: 1048576 | Plain-text response body; cannot be combined with json. |
| `routes.*.respond.json` | any JSON value | no | — | Any JSON value sent as the response body; cannot be combined with text. |

## Middleware

See [middleware before and after a handler](yaml/middleware.md) for examples.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `routes.*.middleware` | array | no | maxItems: 16 | Modules that run in order before the handler and in reverse after it, each able to answer early or change the response (docs/MIDDLEWARE.md). |
| `routes.*.middleware[]` | one of the shapes below | no | — | — |
| `routes.*.middleware[] (option 1)` | string | no | minLength: 1; maxLength: 1024 | — |
| `routes.*.middleware[] (option 2)` | object | no | unknown keys rejected | — |
| `routes.*.middleware[] (option 2).source` | string | yes | maxLength: 1024 | Project-relative path of the .mjs or .js middleware module. |
| `routes.*.middleware[] (option 2).export` | string | no | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" | Named export to call; the default export when omitted. |

## Handler: conditional

See [enable, disable and expire](yaml/conditions.md) for examples.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `routes.*.conditional` | object | no | unknown keys rejected | Several redirect or respond answers at one path, chosen by disjoint request conditions (docs/CONDITIONS.md). |
| `routes.*.conditional.cases` | array | yes | minItems: 1; maxItems: 16 | The alternatives, each a match plus one redirect or respond; their conditions must not overlap. |
| `routes.*.conditional.cases[]` | object | no | unknown keys rejected | — |
| `routes.*.conditional.cases[].redirect` | object | no | unknown keys rejected | Where this case or fallback redirects, with the same url, status and query keys as a route redirect. |
| `routes.*.conditional.cases[].redirect.url` | string | yes | maxLength: 8192 | Destination URL: a literal http(s) URL or a same-site path starting with /, where {name} placeholders are filled from declared path inputs. |
| `routes.*.conditional.cases[].redirect.status` | number | no | enum: [301,302,303,307,308] | Redirect status code; 302 when omitted. |
| `routes.*.conditional.cases[].redirect.query` | object | no | unknown keys rejected | Which request values are copied into the destination query string; nothing is forwarded unless listed here. |
| `routes.*.conditional.cases[].redirect.query.pass` | one of the shapes below | no | — | Incoming query keys copied to the destination unchanged; false or omitted forwards none. |
| `routes.*.conditional.cases[].redirect.query.pass (option 1)` | constant | no | const: false | — |
| `routes.*.conditional.cases[].redirect.query.pass (option 2)` | array | no | uniqueItems: true | — |
| `routes.*.conditional.cases[].redirect.query.pass (option 2)[]` | string | no | — | — |
| `routes.*.conditional.cases[].redirect.query.map` | object | no | — | Destination query keys, each filled from a declared path, query or header input. |
| `routes.*.conditional.cases[].redirect.query.map.*` | object | no | unknown keys rejected | — |
| `routes.*.conditional.cases[].redirect.query.map.*.from` | string | yes | enum: ["path","query","header"] | Where the declared input comes from: path, query or header. |
| `routes.*.conditional.cases[].redirect.query.map.*.name` | string | yes | — | Name of the declared input whose validated value fills this destination key. |
| `routes.*.conditional.cases[].respond` | object | no | unknown keys rejected | Answer directly with a fixed status and an optional text or JSON body. |
| `routes.*.conditional.cases[].respond.status` | integer | no | minimum: 200; maximum: 599 | HTTP status of the declared response; 200 when omitted. |
| `routes.*.conditional.cases[].respond.text` | string | no | maxLength: 1048576 | Plain-text response body; cannot be combined with json. |
| `routes.*.conditional.cases[].respond.json` | any JSON value | no | — | Any JSON value sent as the response body; cannot be combined with text. |
| `routes.*.conditional.cases[].match` | object | yes | minProperties: 1; unknown keys rejected | Exact conditions that select this case. |
| `routes.*.conditional.cases[].match.query` | object | no | minProperties: 1; maxProperties: 16 | Query keys and the exact values they must have. |
| `routes.*.conditional.cases[].match.query.*` | string | no | maxLength: 1024 | — |
| `routes.*.conditional.cases[].match.headers` | object | no | minProperties: 1; maxProperties: 16 | Request headers and the exact values they must have; names compare case-insensitively. |
| `routes.*.conditional.cases[].match.headers.*` | string | no | maxLength: 1024 | — |
| `routes.*.conditional.cases[].match.cookies` | object | no | minProperties: 1; maxProperties: 16 | Cookie names and the exact values they must have. |
| `routes.*.conditional.cases[].match.cookies.*` | string | no | maxLength: 1024 | — |
| `routes.*.conditional.cases[].match.host` | string | no | maxLength: 255 | Host the operator-configured public origin must have; never read from the client Host header. |
| `routes.*.conditional.cases[].match.method` | string | no | enum: ["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"] | HTTP method the request must use. |
| `routes.*.conditional.fallback` | object | no | unknown keys rejected | Answer when no case matches; 404 when omitted. |
| `routes.*.conditional.fallback.redirect` | object | no | unknown keys rejected | Where this case or fallback redirects, with the same url, status and query keys as a route redirect. |
| `routes.*.conditional.fallback.redirect.url` | string | yes | maxLength: 8192 | Destination URL: a literal http(s) URL or a same-site path starting with /, where {name} placeholders are filled from declared path inputs. |
| `routes.*.conditional.fallback.redirect.status` | number | no | enum: [301,302,303,307,308] | Redirect status code; 302 when omitted. |
| `routes.*.conditional.fallback.redirect.query` | object | no | unknown keys rejected | Which request values are copied into the destination query string; nothing is forwarded unless listed here. |
| `routes.*.conditional.fallback.redirect.query.pass` | one of the shapes below | no | — | Incoming query keys copied to the destination unchanged; false or omitted forwards none. |
| `routes.*.conditional.fallback.redirect.query.pass (option 1)` | constant | no | const: false | — |
| `routes.*.conditional.fallback.redirect.query.pass (option 2)` | array | no | uniqueItems: true | — |
| `routes.*.conditional.fallback.redirect.query.pass (option 2)[]` | string | no | — | — |
| `routes.*.conditional.fallback.redirect.query.map` | object | no | — | Destination query keys, each filled from a declared path, query or header input. |
| `routes.*.conditional.fallback.redirect.query.map.*` | object | no | unknown keys rejected | — |
| `routes.*.conditional.fallback.redirect.query.map.*.from` | string | yes | enum: ["path","query","header"] | Where the declared input comes from: path, query or header. |
| `routes.*.conditional.fallback.redirect.query.map.*.name` | string | yes | — | Name of the declared input whose validated value fills this destination key. |
| `routes.*.conditional.fallback.respond` | object | no | unknown keys rejected | Answer directly with a fixed status and an optional text or JSON body. |
| `routes.*.conditional.fallback.respond.status` | integer | no | minimum: 200; maximum: 599 | HTTP status of the declared response; 200 when omitted. |
| `routes.*.conditional.fallback.respond.text` | string | no | maxLength: 1048576 | Plain-text response body; cannot be combined with json. |
| `routes.*.conditional.fallback.respond.json` | any JSON value | no | — | Any JSON value sent as the response body; cannot be combined with text. |

## Handler: proxy and signals

See [bounded egress](EGRESS.md) for examples.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `routes.*.proxy` | object | no | unknown keys rejected | Forward the request to one granted HTTPS upstream and return its answer (docs/EGRESS.md). |
| `routes.*.proxy.url` | string | yes | maxLength: 8192 | Upstream HTTPS URL with a literal host, where {name} placeholders are filled from declared path inputs; its origin must be granted for proxy. |
| `routes.*.proxy.headers` | object | no | maxProperties: 32 | Headers added to the upstream request, each a literal or a secret from this route's secrets. |
| `routes.*.proxy.headers.*` | one of the shapes below | no | — | — |
| `routes.*.proxy.headers.* (option 1)` | string | no | maxLength: 4096 | — |
| `routes.*.proxy.headers.* (option 2)` | object | no | unknown keys rejected | — |
| `routes.*.proxy.headers.* (option 2).secret` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" | Alias of a binding in this route's secrets used as the complete header value. |
| `routes.*.proxy.query` | array | no | maxItems: 32; uniqueItems: true | Incoming query keys forwarded upstream; all others are dropped. |
| `routes.*.proxy.query[]` | string | no | minLength: 1; maxLength: 128 | — |
| `routes.*.proxy.requestHeaders` | array | no | maxItems: 32; uniqueItems: true | Incoming request headers forwarded upstream; all others are dropped. |
| `routes.*.proxy.requestHeaders[]` | string | no | minLength: 1; maxLength: 128 | — |
| `routes.*.proxy.responseHeaders` | array | no | maxItems: 32; uniqueItems: true | Upstream response headers returned to the client; all others are dropped. |
| `routes.*.proxy.responseHeaders[]` | string | no | minLength: 1; maxLength: 128 | — |
| `routes.*.signals` | array | no | minItems: 1; maxItems: 8 | Webhooks told, best effort and after the response, that this route answered (docs/EGRESS.md). |
| `routes.*.signals[]` | object | no | unknown keys rejected | — |
| `routes.*.signals[].url` | string | yes | maxLength: 8192 | HTTPS webhook URL that receives a JSON POST, allowed only when an operator policy grants its origin for signals. |
| `routes.*.signals[].headers` | object | no | maxProperties: 32 | Headers added to the webhook POST, each a literal or a secret from this route's secrets. |
| `routes.*.signals[].headers.*` | one of the shapes below | no | — | — |
| `routes.*.signals[].headers.* (option 1)` | string | no | maxLength: 4096 | — |
| `routes.*.signals[].headers.* (option 2)` | object | no | unknown keys rejected | — |
| `routes.*.signals[].headers.* (option 2).secret` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" | Alias of a binding in this route's secrets used as the complete header value. |

## Handler: extension mount

See [extensions](EXTENSIONS.md) for examples.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `routes.*.extension` | string | no | pattern: "^[a-z][a-z0-9-]{0,63}$" | Name of a declared extension that handles every request to this route, typically a prefix such as /auth/*. |

## Policies and profiles

See [policies and profiles](yaml/policies.md) for examples.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `policies` | object | no | unknown keys rejected | Project-wide policy defaults that every route inherits and may override in its own policies. |
| `policies.profile` | string | no | pattern: "^[a-z][a-z0-9-]{0,63}$" | Built-in (hardened) or a name under top-level profiles |
| `policies.throttle` | one of the shapes below | no | — | Per-client request budget, or false to turn it off at this layer. |
| `policies.throttle (option 1)` | constant | no | const: false | — |
| `policies.throttle (option 2)` | object | no | unknown keys rejected | Per-client request budget expressed like the IETF RateLimit-Policy field: quota requests per window seconds. quota and window are required once project and route layers are merged. |
| `policies.throttle (option 2).quota` | integer | no | minimum: 1; maximum: 1000000 | Requests a partition may make per window before it is refused. |
| `policies.throttle (option 2).window` | integer | no | minimum: 1; maximum: 86400 | Length of the sliding counting window, in seconds. |
| `policies.throttle (option 2).partition` | string | no | enum: ["client","route","client-route"]; default: "client" | What gets its own counter: each client address, the whole route, or each client on each route (docs/policies/throttle.md). |
| `policies.throttle (option 2).status` | integer | no | default: 429; minimum: 400; maximum: 599 | Status answered, with Retry-After, to a request over budget. |
| `policies.throttle (option 2).mode` | string | no | enum: ["enforce","report"]; default: "enforce" | enforce refuses requests over budget; report only logs them so a quota can be tuned first. |
| `policies.throttle (option 2).maxKeys` | integer | no | default: 100000; minimum: 1000; maximum: 10000000 | Most counters kept in memory; the least recently used is evicted and starts fresh. |
| `policies.agents` | one of the shapes below | no | — | User-Agent allow and deny rules, or false to turn them off at this layer. |
| `policies.agents (option 1)` | constant | no | const: false | — |
| `policies.agents (option 2)` | object | no | unknown keys rejected | User-Agent policy. Named lists ship with the runtime; project-relative .json files in the same schema supply your own. |
| `policies.agents (option 2).deny` | array | no | maxItems: 32; uniqueItems: true | Bundled list names or project-relative .json lists whose User-Agents are refused (docs/policies/agents.md). |
| `policies.agents (option 2).deny[]` | string | no | minLength: 1; maxLength: 1024 | — |
| `policies.agents (option 2).allow` | array | no | maxItems: 32; uniqueItems: true | Bundled list names or project-relative .json lists whose User-Agents always pass, even when a deny rule matches. |
| `policies.agents (option 2).allow[]` | string | no | minLength: 1; maxLength: 1024 | — |
| `policies.agents (option 2).denyPatterns` | array | no | maxItems: 256; uniqueItems: true | Case-insensitive patterns, from a bounded regex subset, whose matching User-Agents are refused. |
| `policies.agents (option 2).denyPatterns[]` | string | no | minLength: 1; maxLength: 256 | — |
| `policies.agents (option 2).allowPatterns` | array | no | maxItems: 256; uniqueItems: true | Case-insensitive patterns, from a bounded regex subset, whose matching User-Agents always pass. |
| `policies.agents (option 2).allowPatterns[]` | string | no | minLength: 1; maxLength: 256 | — |
| `policies.agents (option 2).denyEmpty` | boolean | no | default: false | Deny requests that send no User-Agent |
| `policies.agents (option 2).status` | integer | no | default: 403; minimum: 400; maximum: 599 | Status answered to a denied request. |
| `policies.agents (option 2).mode` | string | no | enum: ["enforce","report"]; default: "enforce" | enforce refuses matching requests; report only logs them so a list can be tried first. |
| `policies.security` | one of the shapes below | no | — | Response security header profile, or false to turn it off at this layer. |
| `policies.security (option 1)` | constant | no | const: false | — |
| `policies.security (option 2)` | object | no | unknown keys rejected | Response security headers. Profiles follow the OWASP Secure Headers Project; set overrides or adds individual headers; unset removes one from the profile. |
| `policies.security (option 2).headers` | string | no | enum: ["oshp","oshp-no-csp","off"]; default: "oshp" | Which header profile to add: oshp, oshp-no-csp (the same without Content-Security-Policy) or off (docs/policies/security.md). |
| `policies.security (option 2).set` | object | no | maxProperties: 32 | Headers added or overwritten verbatim on every response, taking precedence over the profile. |
| `policies.security (option 2).set.*` | string | no | maxLength: 4096 | — |
| `policies.security (option 2).unset` | array | no | maxItems: 32; uniqueItems: true | Header names the selected profile would add that this route or project leaves out. |
| `policies.security (option 2).unset[]` | string | no | minLength: 1; maxLength: 128 | — |
| `policies.compression` | one of the shapes below | no | — | Response compression negotiated from Accept-Encoding, or false to turn it off at this layer. |
| `policies.compression (option 1)` | constant | no | const: false | — |
| `policies.compression (option 2)` | object | no | unknown keys rejected | Content-coding negotiation per RFC 9110. Assets are precompressed at snapshot time; other bodies compress on the request path. |
| `policies.compression (option 2).encodings` | array | no | default: ["br","gzip"]; minItems: 1; uniqueItems: true | Content codings offered, in preference order when the client weights them equally. |
| `policies.compression (option 2).encodings[]` | string | no | enum: ["br","gzip","deflate","zstd"] | — |
| `policies.compression (option 2).minBytes` | integer | no | default: 1024; minimum: 0; maximum: 1048576 | Bodies smaller than this many bytes are sent uncompressed. |
| `policies.compression (option 2).types` | array | no | maxItems: 64; uniqueItems: true | Media types eligible for compression, with type/* wildcards; a documented default list of text and structured-data types when omitted. |
| `policies.compression (option 2).types[]` | string | no | minLength: 1; maxLength: 128 | — |
| `policies.compression (option 2).level` | integer | no | minimum: 1; maximum: 11 | One compression effort setting mapped onto each codec's own scale (docs/policies/compression.md). |
| `policies.compression (option 2).allowWithSecrets` | boolean | no | default: false | Compress even on routes with secrets or responses that set cookies, where BREACH-style leaks are possible. |
| `policies.cache` | one of the shapes below | no | — | HTTP caching strategy, or false to turn it off at this layer. |
| `policies.cache (option 1)` | constant | no | const: false | — |
| `policies.cache (option 2)` | object | no | unknown keys rejected | Named HTTP caching strategy per RFC 9111/5861/8246/9213; explicit fields override what the strategy implies. strategy is required once project and route layers are merged. |
| `policies.cache (option 2).strategy` | string | no | enum: ["no-store","revalidate","public","immutable","swr","sie","micro","cdn-only","private"] | Named caching pattern that decides the Cache-Control output and whether the origin memory cache is used (docs/policies/cache.md). |
| `policies.cache (option 2).maxAge` | integer | no | minimum: 0; maximum: 31536000 | Seconds the response stays fresh (max-age), overriding what the strategy implies. |
| `policies.cache (option 2).staleWhileRevalidate` | integer | no | minimum: 0; maximum: 31536000 | Seconds a stale response may still be served while it is refreshed (stale-while-revalidate). |
| `policies.cache (option 2).staleIfError` | integer | no | minimum: 0; maximum: 31536000 | Seconds a stale response may be served when the origin fails (stale-if-error); emitted as a header only. |
| `policies.cache (option 2).cdnMaxAge` | integer | no | minimum: 0; maximum: 31536000 | Seconds a CDN may keep the response, sent as CDN-Cache-Control. |
| `policies.cache (option 2).originTtl` | integer | no | minimum: 0; maximum: 86400 | Seconds an origin memory cache may serve a stored response |
| `policies.cache (option 2).vary` | array | no | maxItems: 8; uniqueItems: true | Request headers the response varies on, added to Vary and to the origin cache key. |
| `policies.cache (option 2).vary[]` | string | no | minLength: 1; maxLength: 128 | — |
| `policies.cache (option 2).statuses` | array | no | maxItems: 16; uniqueItems: true | Response statuses the origin memory cache may store. |
| `policies.cache (option 2).statuses[]` | integer | no | minimum: 200; maximum: 599 | — |
| `policies.cache (option 2).maxBytes` | integer | no | minimum: 0; maximum: 16777216 | Largest body the origin cache stores |
| `policies.cache (option 2).maxEntries` | integer | no | minimum: 1; maximum: 1000000 | Most responses the origin memory cache keeps for this configuration; the least recently used is evicted first. |
| `policies.cache (option 2).force` | boolean | no | default: false | Allow immutable on a path without a content hash |
| `policies.extensions` | one of the shapes below | no | — | Route requirements for declared extensions, keyed by extension name and validated by each extension's policy schema, or false to drop them at this layer. |
| `policies.extensions (option 1)` | constant | no | const: false | — |
| `policies.extensions (option 2)` | object | no | maxProperties: 16 | — |
| `policies.extensions (option 2).*` | one of the shapes below | no | — | — |
| `policies.extensions (option 2).* (option 1)` | constant | no | const: false | — |
| `policies.extensions (option 2).* (option 2)` | object | no | — | — |
| `profiles` | object | no | maxProperties: 32 | Reusable named policy sets selectable with policies.profile. A name shadows a built-in profile of the same name. |
| `profiles.*` | object | no | unknown keys rejected | — |
| `profiles.*.throttle` | one of the shapes below | no | — | This profile's throttle policy, applied like policies.throttle, or false to turn it off. |
| `profiles.*.throttle (option 1)` | constant | no | const: false | — |
| `profiles.*.throttle (option 2)` | object | no | unknown keys rejected | Per-client request budget expressed like the IETF RateLimit-Policy field: quota requests per window seconds. quota and window are required once project and route layers are merged. |
| `profiles.*.throttle (option 2).quota` | integer | no | minimum: 1; maximum: 1000000 | Requests a partition may make per window before it is refused. |
| `profiles.*.throttle (option 2).window` | integer | no | minimum: 1; maximum: 86400 | Length of the sliding counting window, in seconds. |
| `profiles.*.throttle (option 2).partition` | string | no | enum: ["client","route","client-route"]; default: "client" | What gets its own counter: each client address, the whole route, or each client on each route (docs/policies/throttle.md). |
| `profiles.*.throttle (option 2).status` | integer | no | default: 429; minimum: 400; maximum: 599 | Status answered, with Retry-After, to a request over budget. |
| `profiles.*.throttle (option 2).mode` | string | no | enum: ["enforce","report"]; default: "enforce" | enforce refuses requests over budget; report only logs them so a quota can be tuned first. |
| `profiles.*.throttle (option 2).maxKeys` | integer | no | default: 100000; minimum: 1000; maximum: 10000000 | Most counters kept in memory; the least recently used is evicted and starts fresh. |
| `profiles.*.agents` | one of the shapes below | no | — | This profile's agents policy, applied like policies.agents, or false to turn it off. |
| `profiles.*.agents (option 1)` | constant | no | const: false | — |
| `profiles.*.agents (option 2)` | object | no | unknown keys rejected | User-Agent policy. Named lists ship with the runtime; project-relative .json files in the same schema supply your own. |
| `profiles.*.agents (option 2).deny` | array | no | maxItems: 32; uniqueItems: true | Bundled list names or project-relative .json lists whose User-Agents are refused (docs/policies/agents.md). |
| `profiles.*.agents (option 2).deny[]` | string | no | minLength: 1; maxLength: 1024 | — |
| `profiles.*.agents (option 2).allow` | array | no | maxItems: 32; uniqueItems: true | Bundled list names or project-relative .json lists whose User-Agents always pass, even when a deny rule matches. |
| `profiles.*.agents (option 2).allow[]` | string | no | minLength: 1; maxLength: 1024 | — |
| `profiles.*.agents (option 2).denyPatterns` | array | no | maxItems: 256; uniqueItems: true | Case-insensitive patterns, from a bounded regex subset, whose matching User-Agents are refused. |
| `profiles.*.agents (option 2).denyPatterns[]` | string | no | minLength: 1; maxLength: 256 | — |
| `profiles.*.agents (option 2).allowPatterns` | array | no | maxItems: 256; uniqueItems: true | Case-insensitive patterns, from a bounded regex subset, whose matching User-Agents always pass. |
| `profiles.*.agents (option 2).allowPatterns[]` | string | no | minLength: 1; maxLength: 256 | — |
| `profiles.*.agents (option 2).denyEmpty` | boolean | no | default: false | Deny requests that send no User-Agent |
| `profiles.*.agents (option 2).status` | integer | no | default: 403; minimum: 400; maximum: 599 | Status answered to a denied request. |
| `profiles.*.agents (option 2).mode` | string | no | enum: ["enforce","report"]; default: "enforce" | enforce refuses matching requests; report only logs them so a list can be tried first. |
| `profiles.*.security` | one of the shapes below | no | — | This profile's security policy, applied like policies.security, or false to turn it off. |
| `profiles.*.security (option 1)` | constant | no | const: false | — |
| `profiles.*.security (option 2)` | object | no | unknown keys rejected | Response security headers. Profiles follow the OWASP Secure Headers Project; set overrides or adds individual headers; unset removes one from the profile. |
| `profiles.*.security (option 2).headers` | string | no | enum: ["oshp","oshp-no-csp","off"]; default: "oshp" | Which header profile to add: oshp, oshp-no-csp (the same without Content-Security-Policy) or off (docs/policies/security.md). |
| `profiles.*.security (option 2).set` | object | no | maxProperties: 32 | Headers added or overwritten verbatim on every response, taking precedence over the profile. |
| `profiles.*.security (option 2).set.*` | string | no | maxLength: 4096 | — |
| `profiles.*.security (option 2).unset` | array | no | maxItems: 32; uniqueItems: true | Header names the selected profile would add that this route or project leaves out. |
| `profiles.*.security (option 2).unset[]` | string | no | minLength: 1; maxLength: 128 | — |
| `profiles.*.compression` | one of the shapes below | no | — | This profile's compression policy, applied like policies.compression, or false to turn it off. |
| `profiles.*.compression (option 1)` | constant | no | const: false | — |
| `profiles.*.compression (option 2)` | object | no | unknown keys rejected | Content-coding negotiation per RFC 9110. Assets are precompressed at snapshot time; other bodies compress on the request path. |
| `profiles.*.compression (option 2).encodings` | array | no | default: ["br","gzip"]; minItems: 1; uniqueItems: true | Content codings offered, in preference order when the client weights them equally. |
| `profiles.*.compression (option 2).encodings[]` | string | no | enum: ["br","gzip","deflate","zstd"] | — |
| `profiles.*.compression (option 2).minBytes` | integer | no | default: 1024; minimum: 0; maximum: 1048576 | Bodies smaller than this many bytes are sent uncompressed. |
| `profiles.*.compression (option 2).types` | array | no | maxItems: 64; uniqueItems: true | Media types eligible for compression, with type/* wildcards; a documented default list of text and structured-data types when omitted. |
| `profiles.*.compression (option 2).types[]` | string | no | minLength: 1; maxLength: 128 | — |
| `profiles.*.compression (option 2).level` | integer | no | minimum: 1; maximum: 11 | One compression effort setting mapped onto each codec's own scale (docs/policies/compression.md). |
| `profiles.*.compression (option 2).allowWithSecrets` | boolean | no | default: false | Compress even on routes with secrets or responses that set cookies, where BREACH-style leaks are possible. |
| `profiles.*.cache` | one of the shapes below | no | — | This profile's cache policy, applied like policies.cache, or false to turn it off. |
| `profiles.*.cache (option 1)` | constant | no | const: false | — |
| `profiles.*.cache (option 2)` | object | no | unknown keys rejected | Named HTTP caching strategy per RFC 9111/5861/8246/9213; explicit fields override what the strategy implies. strategy is required once project and route layers are merged. |
| `profiles.*.cache (option 2).strategy` | string | no | enum: ["no-store","revalidate","public","immutable","swr","sie","micro","cdn-only","private"] | Named caching pattern that decides the Cache-Control output and whether the origin memory cache is used (docs/policies/cache.md). |
| `profiles.*.cache (option 2).maxAge` | integer | no | minimum: 0; maximum: 31536000 | Seconds the response stays fresh (max-age), overriding what the strategy implies. |
| `profiles.*.cache (option 2).staleWhileRevalidate` | integer | no | minimum: 0; maximum: 31536000 | Seconds a stale response may still be served while it is refreshed (stale-while-revalidate). |
| `profiles.*.cache (option 2).staleIfError` | integer | no | minimum: 0; maximum: 31536000 | Seconds a stale response may be served when the origin fails (stale-if-error); emitted as a header only. |
| `profiles.*.cache (option 2).cdnMaxAge` | integer | no | minimum: 0; maximum: 31536000 | Seconds a CDN may keep the response, sent as CDN-Cache-Control. |
| `profiles.*.cache (option 2).originTtl` | integer | no | minimum: 0; maximum: 86400 | Seconds an origin memory cache may serve a stored response |
| `profiles.*.cache (option 2).vary` | array | no | maxItems: 8; uniqueItems: true | Request headers the response varies on, added to Vary and to the origin cache key. |
| `profiles.*.cache (option 2).vary[]` | string | no | minLength: 1; maxLength: 128 | — |
| `profiles.*.cache (option 2).statuses` | array | no | maxItems: 16; uniqueItems: true | Response statuses the origin memory cache may store. |
| `profiles.*.cache (option 2).statuses[]` | integer | no | minimum: 200; maximum: 599 | — |
| `profiles.*.cache (option 2).maxBytes` | integer | no | minimum: 0; maximum: 16777216 | Largest body the origin cache stores |
| `profiles.*.cache (option 2).maxEntries` | integer | no | minimum: 1; maximum: 1000000 | Most responses the origin memory cache keeps for this configuration; the least recently used is evicted first. |
| `profiles.*.cache (option 2).force` | boolean | no | default: false | Allow immutable on a path without a content hash |
| `profiles.*.extensions` | one of the shapes below | no | — | This profile's extensions policy, applied like policies.extensions, or false to turn it off. |
| `profiles.*.extensions (option 1)` | constant | no | const: false | — |
| `profiles.*.extensions (option 2)` | object | no | maxProperties: 16 | — |
| `profiles.*.extensions (option 2).*` | one of the shapes below | no | — | — |
| `profiles.*.extensions (option 2).* (option 1)` | constant | no | const: false | — |
| `profiles.*.extensions (option 2).* (option 2)` | object | no | — | — |

## Site conventions

See [site conventions](yaml/site.md) for examples.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `site` | object | no | unknown keys rejected | Site conventions. Each declared key generates one native route (robots.txt, sitemap.xml, favicon.ico, .well-known/security.txt, llms.txt, 404.html); a declared route at the same path wins. Entry urlcode.yaml only. |
| `site.robots` | object | no | unknown keys rejected | Generates /robots.txt (RFC 9309). List entries are bundled agent list names or paths starting with /. |
| `site.robots.disallow` | array | no | maxItems: 1024; uniqueItems: true | Bundled agent list names to shut out entirely, or paths starting with / that every agent is asked not to fetch. |
| `site.robots.disallow[]` | string | no | minLength: 1; maxLength: 2048 | — |
| `site.robots.allow` | array | no | maxItems: 1024; uniqueItems: true | Bundled agent list names or paths starting with /, emitted as Allow lines. |
| `site.robots.allow[]` | string | no | minLength: 1; maxLength: 2048 | — |
| `site.robots.sitemap` | boolean | no | — | Append a Sitemap line built from the public origin (--origin); omitted when no origin is known. |
| `site.robots.extra` | array | no | maxItems: 1024 | Literal lines appended to robots.txt verbatim, such as comments or Crawl-delay. |
| `site.robots.extra[]` | string | no | maxLength: 2048 | — |
| `site.sitemap` | one of the shapes below | no | — | Generates /sitemap.xml (sitemaps.org 0.9) from active literal GET routes serving HTML. Requires --origin. |
| `site.sitemap (option 1)` | constant | no | const: true | — |
| `site.sitemap (option 2)` | object | no | unknown keys rejected | — |
| `site.sitemap (option 2).exclude` | array | no | maxItems: 1024; uniqueItems: true | Exact paths, or prefixes ending in /*, left out of the sitemap. |
| `site.sitemap (option 2).exclude[]` | string | no | minLength: 1; maxLength: 2048 | — |
| `site.sitemap (option 2).changefreq` | string | no | enum: ["always","hourly","daily","weekly","monthly","yearly","never"] | changefreq value written on every sitemap URL. |
| `site.sitemap (option 2).priority` | number | no | minimum: 0; maximum: 1 | priority value written on every sitemap URL. |
| `site.favicon` | string | no | minLength: 1; maxLength: 1024 | Project-relative .ico, .svg or .png served at /favicon.ico. |
| `site.securityTxt` | object | no | unknown keys rejected | Generates /.well-known/security.txt (RFC 9116). |
| `site.securityTxt.contact` | array | yes | minItems: 1; maxItems: 64 | How to report a vulnerability: mailto:, tel: or https: URIs, one Contact line each. |
| `site.securityTxt.contact[]` | string | no | minLength: 1; maxLength: 2048 | — |
| `site.securityTxt.expires` | string | yes | pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$" | UTC timestamp after which the file is stale; it must be in the future when the project activates. |
| `site.securityTxt.policy` | array | no | maxItems: 64 | https: links to your vulnerability disclosure policy. |
| `site.securityTxt.policy[]` | string | no | maxLength: 2048; pattern: "^https://" | — |
| `site.securityTxt.acknowledgments` | array | no | maxItems: 64 | https: links to the page thanking security researchers. |
| `site.securityTxt.acknowledgments[]` | string | no | maxLength: 2048; pattern: "^https://" | — |
| `site.securityTxt.preferredLanguages` | array | no | minItems: 1; maxItems: 64 | Language tags for reports, emitted as one comma-separated Preferred-Languages line. |
| `site.securityTxt.preferredLanguages[]` | string | no | minLength: 2; maxLength: 35 | — |
| `site.securityTxt.canonical` | array | no | maxItems: 64 | https: URLs where this security.txt is published. |
| `site.securityTxt.canonical[]` | string | no | maxLength: 2048; pattern: "^https://" | — |
| `site.securityTxt.encryption` | array | no | maxItems: 64 | https:, dns: or openpgp4fpr: URIs for the key researchers should encrypt reports with. |
| `site.securityTxt.encryption[]` | string | no | minLength: 1; maxLength: 2048 | — |
| `site.llms` | string | no | minLength: 1; maxLength: 1024 | Project-relative text file served at /llms.txt. |
| `site.notFound` | string | no | minLength: 1; maxLength: 1024; pattern: "\\.[hH][tT][mM][lL]?$" | Project-relative .html file served with status 404 and text/html for a GET or HEAD that matches no route. Generated as a page route at /404.html, which is also the object name static hosting uses. |

## Extensions (top-level)

See [extensions](EXTENSIONS.md) for examples.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `extensions` | object | no | maxProperties: 16 | Versioned logical extension configurations. Requires explicit external operator registrations pinned to the project revision; never loads project code. |
| `extensions.*` | object | no | unknown keys rejected | — |
| `extensions.*.version` | constant | yes | const: "1" | Version of this extension configuration contract; always "1". |
| `extensions.*.config` | object | yes | — | The extension's own settings, validated against the configuration schema its registration declares (urlcode extensions --json). |
