# YAML field reference

Generated from the bundled JSON Schema by `npm run docs:reference`. Required
means required within its containing object, not that the object itself must be
present. `routes.*` means a route path; other `*` markers mean user-selected
keys. `[]` means an array item. Option rows describe union alternatives.
Fields with no schema-level description show — in that column; read the
linked guide section for behavior JSON Schema does not express.

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
| `version` | constant | yes | const: "1" | — |
| `includes` | array | no | maxItems: 256; uniqueItems: true | — |
| `includes[]` | string | no | maxLength: 1024 | — |
| `shared` | object | no | maxProperties: 32 | Reusable named request and response.headers blocks a route selects with use. Resolved at load time; the route hash, audit and routes output show the resolved route. Entry urlcode.yaml only. Response headers the runtime owns are refused. |
| `shared.*` | object | no | unknown keys rejected | — |
| `shared.*.request` | object | no | unknown keys rejected | — |
| `shared.*.request.body` | object | no | unknown keys rejected | — |
| `shared.*.request.body.required` | boolean | no | — | — |
| `shared.*.request.body.maxBytes` | integer | no | minimum: 0; maximum: 1048576 | — |
| `shared.*.request.body.contentTypes` | array | no | minItems: 1; maxItems: 16; uniqueItems: true | — |
| `shared.*.request.body.contentTypes[]` | string | no | pattern: "^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$" | — |
| `shared.*.request.body.format` | string | no | enum: ["text","json"] | — |
| `shared.*.request.body.schema` | object | no | — | A JSON Schema subset checked after parsing (requires format: json); a body that breaks it answers 422. Supported keywords: type (object, array, string, integer, number, boolean, null), properties, required, additionalProperties (true or false), items, enum (scalar values), minLength, maxLength, pattern (needs maxLength of at most 128 on the same node), format (uuid only), minimum, maximum, minItems, maxItems. Anything else, including $ref, oneOf, default and format: email, fails activation. At most 6 levels, 128 nodes and 64 properties per object. |
| `shared.*.response` | object | no | unknown keys rejected | — |
| `shared.*.response.headers` | object | no | maxProperties: 64 | — |
| `shared.*.response.headers.*` | one of the shapes below | no | — | — |
| `shared.*.response.headers.* (option 1)` | string | no | maxLength: 4096 | — |
| `shared.*.response.headers.* (option 2)` | array | no | minItems: 1; maxItems: 16 | — |
| `shared.*.response.headers.* (option 2)[]` | string | no | maxLength: 4096 | — |

## Routes: common fields (methods, parameters, env, secrets, policies, cache)

See [functions, inputs and methods](yaml/functions.md) and [bindings, split files and tests](yaml/organization.md) for examples.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `routes` | object | yes | maxProperties: 100000 | — |
| `routes.*` | object | no | unknown keys rejected | — |
| `routes.*.methods` | array | no | default: ["GET","HEAD"]; minItems: 1; uniqueItems: true | — |
| `routes.*.methods[]` | string | no | enum: ["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"] | — |
| `routes.*.enabled` | boolean | no | — | — |
| `routes.*.sandbox` | boolean | no | default: false | Run this route's function/middleware in the isolated QuickJS/WASM worker pool instead of the trusted, in-process default. false or absent (the default) means trusted, unsandboxed, direct host-process execution. |
| `routes.*.sandboxReason` | string | no | maxLength: 500 | Optional justification for this route's sandbox decision, whether sandbox is true or false: why it needs isolation, or why it is safe to trust. Never inferred or enforced; surfaced verbatim by explain/context/manifest. |
| `routes.*.coveredElsewhere` | object | no | minProperties: 1 | Audit-only waiver: methods of this route whose normal-response fixture is provided by other tests (for example stateful create/update/delete). Each method needs a non-empty reason and must be one of the route's methods. audit lists waived pairs with their reasons under waivedRouteMethods and still requires the route to have another normally covered method; it never hides a function route that only serves errors. Project file only: there is no CLI flag. |
| `routes.*.coveredElsewhere.*` | string | no | minLength: 1; maxLength: 500 | Why this method is tested elsewhere. |
| `routes.*.expires` | string | no | — | — |
| `routes.*.description` | string | no | maxLength: 1024 | — |
| `routes.*.parameters` | array | no | maxItems: 64 | — |
| `routes.*.parameters[]` | object | no | unknown keys rejected | — |
| `routes.*.parameters[].name` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_-]*$" | — |
| `routes.*.parameters[].in` | string | yes | enum: ["path","query","header"] | — |
| `routes.*.parameters[].required` | boolean | no | — | — |
| `routes.*.parameters[].schema` | object | yes | unknown keys rejected | — |
| `routes.*.parameters[].schema.type` | string | yes | enum: ["string","integer","number","boolean","array"] | — |
| `routes.*.parameters[].schema.enum` | array | no | minItems: 1; uniqueItems: true | — |
| `routes.*.parameters[].schema.enum[]` | string / number / boolean | no | — | — |
| `routes.*.parameters[].schema.default` | string / number / boolean / array | no | — | — |
| `routes.*.parameters[].schema.default[]` | string / number / boolean | no | — | — |
| `routes.*.parameters[].schema.minLength` | integer | no | minimum: 0; maximum: 8192 | — |
| `routes.*.parameters[].schema.maxLength` | integer | no | minimum: 0; maximum: 8192 | — |
| `routes.*.parameters[].schema.minimum` | number | no | — | — |
| `routes.*.parameters[].schema.maximum` | number | no | — | — |
| `routes.*.parameters[].schema.pattern` | string | no | minLength: 1; maxLength: 128 | — |
| `routes.*.parameters[].schema.format` | string | no | enum: ["uuid"] | — |
| `routes.*.parameters[].schema.items` | object | no | unknown keys rejected | — |
| `routes.*.parameters[].schema.items.type` | string | yes | enum: ["string","integer","number","boolean"] | — |
| `routes.*.parameters[].schema.maxItems` | integer | no | minimum: 0; maximum: 100 | — |
| `routes.*.env` | object | no | — | — |
| `routes.*.env.*` | one of the shapes below | no | — | — |
| `routes.*.env.* (option 1)` | object | no | unknown keys rejected | — |
| `routes.*.env.* (option 1).value` | string | yes | — | — |
| `routes.*.env.* (option 2)` | object | no | unknown keys rejected | — |
| `routes.*.env.* (option 2).env` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" | — |
| `routes.*.env.* (option 2).default` | string | no | — | — |
| `routes.*.secrets` | object | no | — | — |
| `routes.*.secrets.*` | object | no | unknown keys rejected | — |
| `routes.*.secrets.*.secret` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" | — |
| `routes.*.request` | object | no | unknown keys rejected | — |
| `routes.*.request.body` | object | no | unknown keys rejected | — |
| `routes.*.request.body.required` | boolean | no | — | — |
| `routes.*.request.body.maxBytes` | integer | no | minimum: 0; maximum: 1048576 | — |
| `routes.*.request.body.contentTypes` | array | no | minItems: 1; maxItems: 16; uniqueItems: true | — |
| `routes.*.request.body.contentTypes[]` | string | no | pattern: "^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$" | — |
| `routes.*.request.body.format` | string | no | enum: ["text","json"] | — |
| `routes.*.request.body.schema` | object | no | — | A JSON Schema subset checked after parsing (requires format: json); a body that breaks it answers 422. Supported keywords: type (object, array, string, integer, number, boolean, null), properties, required, additionalProperties (true or false), items, enum (scalar values), minLength, maxLength, pattern (needs maxLength of at most 128 on the same node), format (uuid only), minimum, maximum, minItems, maxItems. Anything else, including $ref, oneOf, default and format: email, fails activation. At most 6 levels, 128 nodes and 64 properties per object. |
| `routes.*.response` | object | no | unknown keys rejected | — |
| `routes.*.response.headers` | object | no | maxProperties: 64 | — |
| `routes.*.response.headers.*` | one of the shapes below | no | — | — |
| `routes.*.response.headers.* (option 1)` | string | no | maxLength: 4096 | — |
| `routes.*.response.headers.* (option 2)` | array | no | minItems: 1; maxItems: 16 | — |
| `routes.*.response.headers.* (option 2)[]` | string | no | maxLength: 4096 | — |
| `routes.*.policies` | object | no | unknown keys rejected | Optional host-enforced behavior around routes. Every key is off unless declared. Route policies merge over project policies; false disables one. |
| `routes.*.policies.profile` | string | no | pattern: "^[a-z][a-z0-9-]{0,63}$" | Built-in (hardened) or a name under top-level profiles |
| `routes.*.policies.throttle` | one of the shapes below | no | — | — |
| `routes.*.policies.throttle (option 1)` | constant | no | const: false | — |
| `routes.*.policies.throttle (option 2)` | object | no | unknown keys rejected | Per-client request budget expressed like the IETF RateLimit-Policy field: quota requests per window seconds. quota and window are required once project and route layers are merged. |
| `routes.*.policies.throttle (option 2).quota` | integer | no | minimum: 1; maximum: 1000000 | — |
| `routes.*.policies.throttle (option 2).window` | integer | no | minimum: 1; maximum: 86400 | Seconds |
| `routes.*.policies.throttle (option 2).partition` | string | no | enum: ["client","route","client-route"]; default: "client" | — |
| `routes.*.policies.throttle (option 2).status` | integer | no | default: 429; minimum: 400; maximum: 599 | — |
| `routes.*.policies.throttle (option 2).mode` | string | no | enum: ["enforce","report"]; default: "enforce" | — |
| `routes.*.policies.throttle (option 2).maxKeys` | integer | no | default: 100000; minimum: 1000; maximum: 10000000 | — |
| `routes.*.policies.agents` | one of the shapes below | no | — | — |
| `routes.*.policies.agents (option 1)` | constant | no | const: false | — |
| `routes.*.policies.agents (option 2)` | object | no | unknown keys rejected | User-Agent policy. Named lists ship with the runtime; project-relative .json files in the same schema supply your own. |
| `routes.*.policies.agents (option 2).deny` | array | no | maxItems: 32; uniqueItems: true | — |
| `routes.*.policies.agents (option 2).deny[]` | string | no | minLength: 1; maxLength: 1024 | — |
| `routes.*.policies.agents (option 2).allow` | array | no | maxItems: 32; uniqueItems: true | — |
| `routes.*.policies.agents (option 2).allow[]` | string | no | minLength: 1; maxLength: 1024 | — |
| `routes.*.policies.agents (option 2).denyPatterns` | array | no | maxItems: 256; uniqueItems: true | — |
| `routes.*.policies.agents (option 2).denyPatterns[]` | string | no | minLength: 1; maxLength: 256 | — |
| `routes.*.policies.agents (option 2).allowPatterns` | array | no | maxItems: 256; uniqueItems: true | — |
| `routes.*.policies.agents (option 2).allowPatterns[]` | string | no | minLength: 1; maxLength: 256 | — |
| `routes.*.policies.agents (option 2).denyEmpty` | boolean | no | default: false | Deny requests that send no User-Agent |
| `routes.*.policies.agents (option 2).status` | integer | no | default: 403; minimum: 400; maximum: 599 | — |
| `routes.*.policies.agents (option 2).mode` | string | no | enum: ["enforce","report"]; default: "enforce" | — |
| `routes.*.policies.security` | one of the shapes below | no | — | — |
| `routes.*.policies.security (option 1)` | constant | no | const: false | — |
| `routes.*.policies.security (option 2)` | object | no | unknown keys rejected | Response security headers. Profiles follow the OWASP Secure Headers Project; set overrides or adds individual headers; unset removes one from the profile. |
| `routes.*.policies.security (option 2).headers` | string | no | enum: ["oshp","oshp-no-csp","off"]; default: "oshp" | — |
| `routes.*.policies.security (option 2).set` | object | no | maxProperties: 32 | — |
| `routes.*.policies.security (option 2).set.*` | string | no | maxLength: 4096 | — |
| `routes.*.policies.security (option 2).unset` | array | no | maxItems: 32; uniqueItems: true | — |
| `routes.*.policies.security (option 2).unset[]` | string | no | minLength: 1; maxLength: 128 | — |
| `routes.*.policies.compression` | one of the shapes below | no | — | — |
| `routes.*.policies.compression (option 1)` | constant | no | const: false | — |
| `routes.*.policies.compression (option 2)` | object | no | unknown keys rejected | Content-coding negotiation per RFC 9110. Assets are precompressed at snapshot time; other bodies compress on the request path. |
| `routes.*.policies.compression (option 2).encodings` | array | no | default: ["br","gzip"]; minItems: 1; uniqueItems: true | — |
| `routes.*.policies.compression (option 2).encodings[]` | string | no | enum: ["br","gzip","deflate","zstd"] | — |
| `routes.*.policies.compression (option 2).minBytes` | integer | no | default: 1024; minimum: 0; maximum: 1048576 | — |
| `routes.*.policies.compression (option 2).types` | array | no | maxItems: 64; uniqueItems: true | — |
| `routes.*.policies.compression (option 2).types[]` | string | no | minLength: 1; maxLength: 128 | — |
| `routes.*.policies.compression (option 2).level` | integer | no | minimum: 1; maximum: 11 | — |
| `routes.*.policies.compression (option 2).allowWithSecrets` | boolean | no | default: false | — |
| `routes.*.policies.cache` | one of the shapes below | no | — | — |
| `routes.*.policies.cache (option 1)` | constant | no | const: false | — |
| `routes.*.policies.cache (option 2)` | object | no | unknown keys rejected | Named HTTP caching strategy per RFC 9111/5861/8246/9213; explicit fields override what the strategy implies. strategy is required once project and route layers are merged. |
| `routes.*.policies.cache (option 2).strategy` | string | no | enum: ["no-store","revalidate","public","immutable","swr","sie","micro","cdn-only","private"] | — |
| `routes.*.policies.cache (option 2).maxAge` | integer | no | minimum: 0; maximum: 31536000 | Seconds |
| `routes.*.policies.cache (option 2).staleWhileRevalidate` | integer | no | minimum: 0; maximum: 31536000 | — |
| `routes.*.policies.cache (option 2).staleIfError` | integer | no | minimum: 0; maximum: 31536000 | — |
| `routes.*.policies.cache (option 2).cdnMaxAge` | integer | no | minimum: 0; maximum: 31536000 | — |
| `routes.*.policies.cache (option 2).originTtl` | integer | no | minimum: 0; maximum: 86400 | Seconds an origin memory cache may serve a stored response |
| `routes.*.policies.cache (option 2).vary` | array | no | maxItems: 8; uniqueItems: true | — |
| `routes.*.policies.cache (option 2).vary[]` | string | no | minLength: 1; maxLength: 128 | — |
| `routes.*.policies.cache (option 2).statuses` | array | no | maxItems: 16; uniqueItems: true | — |
| `routes.*.policies.cache (option 2).statuses[]` | integer | no | minimum: 200; maximum: 599 | — |
| `routes.*.policies.cache (option 2).maxBytes` | integer | no | minimum: 0; maximum: 16777216 | Largest body the origin cache stores |
| `routes.*.policies.cache (option 2).maxEntries` | integer | no | minimum: 1; maximum: 1000000 | — |
| `routes.*.policies.cache (option 2).force` | boolean | no | default: false | Allow immutable on a path without a content hash |
| `routes.*.policies.extensions` | one of the shapes below | no | — | — |
| `routes.*.policies.extensions (option 1)` | constant | no | const: false | — |
| `routes.*.policies.extensions (option 2)` | object | no | maxProperties: 16 | — |
| `routes.*.policies.extensions (option 2).*` | one of the shapes below | no | — | — |
| `routes.*.policies.extensions (option 2).* (option 1)` | constant | no | const: false | — |
| `routes.*.policies.extensions (option 2).* (option 2)` | object | no | — | — |
| `routes.*.match` | object | no | minProperties: 1; unknown keys rejected | — |
| `routes.*.match.query` | object | no | minProperties: 1; maxProperties: 16 | — |
| `routes.*.match.query.*` | string | no | maxLength: 1024 | — |
| `routes.*.match.headers` | object | no | minProperties: 1; maxProperties: 16 | — |
| `routes.*.match.headers.*` | string | no | maxLength: 1024 | — |
| `routes.*.match.cookies` | object | no | minProperties: 1; maxProperties: 16 | — |
| `routes.*.match.cookies.*` | string | no | maxLength: 1024 | — |
| `routes.*.match.host` | string | no | maxLength: 255 | — |
| `routes.*.match.method` | string | no | enum: ["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"] | — |
| `routes.*.auth` | one of the shapes below | no | — | Short form for a route protected by the declared auth extension. true or an object expands to policies.extensions.auth with the same keys minus required; required: false emits no policy. Refused without an extensions.auth declaration or alongside policies.extensions.auth. |
| `routes.*.auth (option 1)` | constant | no | const: true | — |
| `routes.*.auth (option 2)` | object | no | unknown keys rejected | Keys other than required mirror the auth extension's policy schema; the installed extension validates the expanded requirement. |
| `routes.*.auth (option 2).required` | boolean | no | default: true | — |
| `routes.*.auth (option 2).role` | string | no | minLength: 1; maxLength: 64 | — |
| `routes.*.auth (option 2).permission` | string | no | minLength: 1; maxLength: 128 | — |
| `routes.*.auth (option 2).verified` | boolean | no | — | — |
| `routes.*.auth (option 2).freshWithinSeconds` | integer | no | minimum: 1; maximum: 3600 | — |
| `routes.*.auth (option 2).onDeny` | number / string | no | enum: [401,403,404,"sign-in"] | — |
| `routes.*.cache` | object | no | unknown keys rejected | Named HTTP caching strategy per RFC 9111/5861/8246/9213; explicit fields override what the strategy implies. strategy is required once project and route layers are merged. |
| `routes.*.cache.strategy` | string | no | enum: ["no-store","revalidate","public","immutable","swr","sie","micro","cdn-only","private"] | — |
| `routes.*.cache.maxAge` | integer | no | minimum: 0; maximum: 31536000 | Seconds |
| `routes.*.cache.staleWhileRevalidate` | integer | no | minimum: 0; maximum: 31536000 | — |
| `routes.*.cache.staleIfError` | integer | no | minimum: 0; maximum: 31536000 | — |
| `routes.*.cache.cdnMaxAge` | integer | no | minimum: 0; maximum: 31536000 | — |
| `routes.*.cache.originTtl` | integer | no | minimum: 0; maximum: 86400 | Seconds an origin memory cache may serve a stored response |
| `routes.*.cache.vary` | array | no | maxItems: 8; uniqueItems: true | — |
| `routes.*.cache.vary[]` | string | no | minLength: 1; maxLength: 128 | — |
| `routes.*.cache.statuses` | array | no | maxItems: 16; uniqueItems: true | — |
| `routes.*.cache.statuses[]` | integer | no | minimum: 200; maximum: 599 | — |
| `routes.*.cache.maxBytes` | integer | no | minimum: 0; maximum: 16777216 | Largest body the origin cache stores |
| `routes.*.cache.maxEntries` | integer | no | minimum: 1; maximum: 1000000 | — |
| `routes.*.cache.force` | boolean | no | default: false | Allow immutable on a path without a content hash |
| `routes.*.use` | string | no | pattern: "^[a-z][a-z0-9-]{0,63}$" | Name of a top-level shared block whose request and response.headers this route inherits. A key the route declares itself replaces the shared block as a whole; there is no deep merge. |

## Handler: redirect

See [redirects](yaml/redirects.md) for examples.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `routes.*.redirect` | object | no | unknown keys rejected | HTTP redirect. The route path may end in /** to redirect a whole subtree (literal prefix, one terminal **, no path placeholders, no conditional); no other wildcard is accepted. |
| `routes.*.redirect.url` | string | yes | maxLength: 8192 | — |
| `routes.*.redirect.status` | number | no | enum: [301,302,303,307,308] | — |
| `routes.*.redirect.query` | object | no | unknown keys rejected | — |
| `routes.*.redirect.query.pass` | one of the shapes below | no | — | — |
| `routes.*.redirect.query.pass (option 1)` | constant | no | const: false | — |
| `routes.*.redirect.query.pass (option 2)` | array | no | uniqueItems: true | — |
| `routes.*.redirect.query.pass (option 2)[]` | string | no | — | — |
| `routes.*.redirect.query.map` | object | no | — | — |
| `routes.*.redirect.query.map.*` | object | no | unknown keys rejected | — |
| `routes.*.redirect.query.map.*.from` | string | yes | enum: ["path","query","header"] | — |
| `routes.*.redirect.query.map.*.name` | string | yes | — | — |

## Handler: function

See [functions, inputs and methods](yaml/functions.md) for examples.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `routes.*.function` | one of the shapes below | no | — | — |
| `routes.*.function (option 1)` | string | no | minLength: 1; maxLength: 1024 | — |
| `routes.*.function (option 2)` | object | no | unknown keys rejected | — |
| `routes.*.function (option 2).source` | string | yes | maxLength: 1024 | — |
| `routes.*.function (option 2).export` | string | no | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" | — |
| `routes.*.function (option 2).args` | object | no | — | — |
| `routes.*.function (option 2).args.*` | one of the shapes below | no | — | — |
| `routes.*.function (option 2).args.* (option 1)` | string / number / boolean | no | — | — |
| `routes.*.function (option 2).args.* (option 2)` | object | no | unknown keys rejected | — |
| `routes.*.function (option 2).args.* (option 2).from` | string | yes | enum: ["path","query","header"] | — |
| `routes.*.function (option 2).args.* (option 2).name` | string | yes | — | — |
| `routes.*.function (option 2).args.* (option 3)` | object | no | unknown keys rejected | — |
| `routes.*.function (option 2).args.* (option 3).env` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" | — |
| `routes.*.function (option 2).args.* (option 4)` | object | no | unknown keys rejected | — |
| `routes.*.function (option 2).args.* (option 4).secret` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" | — |

## Handler: page, static, download

See [pages, static folders and downloads](yaml/assets.md) for examples.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `routes.*.page` | object | no | unknown keys rejected | — |
| `routes.*.page.file` | string | yes | minLength: 1; maxLength: 1024 | — |
| `routes.*.page.contentType` | string | no | maxLength: 128; pattern: "^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$" | — |
| `routes.*.page.cacheControl` | string | no | enum: ["no-cache","no-store","public, max-age=3600","public, max-age=31536000, immutable"] | — |
| `routes.*.download` | object | no | unknown keys rejected | — |
| `routes.*.download.file` | string | yes | minLength: 1; maxLength: 1024 | — |
| `routes.*.download.contentType` | string | no | maxLength: 128; pattern: "^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$" | — |
| `routes.*.download.cacheControl` | string | no | enum: ["no-cache","no-store","public, max-age=3600","public, max-age=31536000, immutable"] | — |
| `routes.*.download.filename` | string | no | minLength: 1; maxLength: 255 | — |
| `routes.*.static` | object | no | unknown keys rejected | Serve a project directory. The route path must end in a terminal /* (for example /assets/*); a static route without it is rejected. |
| `routes.*.static.directory` | string | yes | minLength: 1; maxLength: 1024 | — |
| `routes.*.static.contentType` | string | no | maxLength: 128; pattern: "^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$" | — |
| `routes.*.static.cacheControl` | string | no | enum: ["no-cache","no-store","public, max-age=3600","public, max-age=31536000, immutable"] | — |
| `routes.*.static.index` | string | no | pattern: "^[A-Za-z0-9_-]+\\.html$" | — |

## Handler: respond

See [declared responses, headers and cookies](yaml/responses.md) for examples.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `routes.*.respond` | object | no | unknown keys rejected | — |
| `routes.*.respond.status` | integer | no | minimum: 200; maximum: 599 | — |
| `routes.*.respond.text` | string | no | maxLength: 1048576 | — |
| `routes.*.respond.json` | any JSON value | no | — | — |

## Middleware

See [middleware before and after a handler](yaml/middleware.md) for examples.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `routes.*.middleware` | array | no | maxItems: 16 | — |
| `routes.*.middleware[]` | one of the shapes below | no | — | — |
| `routes.*.middleware[] (option 1)` | string | no | minLength: 1; maxLength: 1024 | — |
| `routes.*.middleware[] (option 2)` | object | no | unknown keys rejected | — |
| `routes.*.middleware[] (option 2).source` | string | yes | maxLength: 1024 | — |
| `routes.*.middleware[] (option 2).export` | string | no | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" | — |

## Handler: conditional

See [enable, disable and expire](yaml/conditions.md) for examples.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `routes.*.conditional` | object | no | unknown keys rejected | — |
| `routes.*.conditional.cases` | array | yes | minItems: 1; maxItems: 16 | — |
| `routes.*.conditional.cases[]` | object | no | unknown keys rejected | — |
| `routes.*.conditional.cases[].redirect` | object | no | unknown keys rejected | — |
| `routes.*.conditional.cases[].redirect.url` | string | yes | maxLength: 8192 | — |
| `routes.*.conditional.cases[].redirect.status` | number | no | enum: [301,302,303,307,308] | — |
| `routes.*.conditional.cases[].redirect.query` | object | no | unknown keys rejected | — |
| `routes.*.conditional.cases[].redirect.query.pass` | one of the shapes below | no | — | — |
| `routes.*.conditional.cases[].redirect.query.pass (option 1)` | constant | no | const: false | — |
| `routes.*.conditional.cases[].redirect.query.pass (option 2)` | array | no | uniqueItems: true | — |
| `routes.*.conditional.cases[].redirect.query.pass (option 2)[]` | string | no | — | — |
| `routes.*.conditional.cases[].redirect.query.map` | object | no | — | — |
| `routes.*.conditional.cases[].redirect.query.map.*` | object | no | unknown keys rejected | — |
| `routes.*.conditional.cases[].redirect.query.map.*.from` | string | yes | enum: ["path","query","header"] | — |
| `routes.*.conditional.cases[].redirect.query.map.*.name` | string | yes | — | — |
| `routes.*.conditional.cases[].respond` | object | no | unknown keys rejected | — |
| `routes.*.conditional.cases[].respond.status` | integer | no | minimum: 200; maximum: 599 | — |
| `routes.*.conditional.cases[].respond.text` | string | no | maxLength: 1048576 | — |
| `routes.*.conditional.cases[].respond.json` | any JSON value | no | — | — |
| `routes.*.conditional.cases[].match` | object | yes | minProperties: 1; unknown keys rejected | — |
| `routes.*.conditional.cases[].match.query` | object | no | minProperties: 1; maxProperties: 16 | — |
| `routes.*.conditional.cases[].match.query.*` | string | no | maxLength: 1024 | — |
| `routes.*.conditional.cases[].match.headers` | object | no | minProperties: 1; maxProperties: 16 | — |
| `routes.*.conditional.cases[].match.headers.*` | string | no | maxLength: 1024 | — |
| `routes.*.conditional.cases[].match.cookies` | object | no | minProperties: 1; maxProperties: 16 | — |
| `routes.*.conditional.cases[].match.cookies.*` | string | no | maxLength: 1024 | — |
| `routes.*.conditional.cases[].match.host` | string | no | maxLength: 255 | — |
| `routes.*.conditional.cases[].match.method` | string | no | enum: ["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"] | — |
| `routes.*.conditional.fallback` | object | no | unknown keys rejected | — |
| `routes.*.conditional.fallback.redirect` | object | no | unknown keys rejected | — |
| `routes.*.conditional.fallback.redirect.url` | string | yes | maxLength: 8192 | — |
| `routes.*.conditional.fallback.redirect.status` | number | no | enum: [301,302,303,307,308] | — |
| `routes.*.conditional.fallback.redirect.query` | object | no | unknown keys rejected | — |
| `routes.*.conditional.fallback.redirect.query.pass` | one of the shapes below | no | — | — |
| `routes.*.conditional.fallback.redirect.query.pass (option 1)` | constant | no | const: false | — |
| `routes.*.conditional.fallback.redirect.query.pass (option 2)` | array | no | uniqueItems: true | — |
| `routes.*.conditional.fallback.redirect.query.pass (option 2)[]` | string | no | — | — |
| `routes.*.conditional.fallback.redirect.query.map` | object | no | — | — |
| `routes.*.conditional.fallback.redirect.query.map.*` | object | no | unknown keys rejected | — |
| `routes.*.conditional.fallback.redirect.query.map.*.from` | string | yes | enum: ["path","query","header"] | — |
| `routes.*.conditional.fallback.redirect.query.map.*.name` | string | yes | — | — |
| `routes.*.conditional.fallback.respond` | object | no | unknown keys rejected | — |
| `routes.*.conditional.fallback.respond.status` | integer | no | minimum: 200; maximum: 599 | — |
| `routes.*.conditional.fallback.respond.text` | string | no | maxLength: 1048576 | — |
| `routes.*.conditional.fallback.respond.json` | any JSON value | no | — | — |

## Handler: proxy and signals

See [bounded egress](EGRESS.md) for examples.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `routes.*.proxy` | object | no | unknown keys rejected | — |
| `routes.*.proxy.url` | string | yes | maxLength: 8192 | — |
| `routes.*.proxy.headers` | object | no | maxProperties: 32 | — |
| `routes.*.proxy.headers.*` | one of the shapes below | no | — | — |
| `routes.*.proxy.headers.* (option 1)` | string | no | maxLength: 4096 | — |
| `routes.*.proxy.headers.* (option 2)` | object | no | unknown keys rejected | — |
| `routes.*.proxy.headers.* (option 2).secret` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" | — |
| `routes.*.proxy.query` | array | no | maxItems: 32; uniqueItems: true | — |
| `routes.*.proxy.query[]` | string | no | minLength: 1; maxLength: 128 | — |
| `routes.*.proxy.requestHeaders` | array | no | maxItems: 32; uniqueItems: true | — |
| `routes.*.proxy.requestHeaders[]` | string | no | minLength: 1; maxLength: 128 | — |
| `routes.*.proxy.responseHeaders` | array | no | maxItems: 32; uniqueItems: true | — |
| `routes.*.proxy.responseHeaders[]` | string | no | minLength: 1; maxLength: 128 | — |
| `routes.*.signals` | array | no | minItems: 1; maxItems: 8 | — |
| `routes.*.signals[]` | object | no | unknown keys rejected | — |
| `routes.*.signals[].url` | string | yes | maxLength: 8192 | — |
| `routes.*.signals[].headers` | object | no | maxProperties: 32 | — |
| `routes.*.signals[].headers.*` | one of the shapes below | no | — | — |
| `routes.*.signals[].headers.* (option 1)` | string | no | maxLength: 4096 | — |
| `routes.*.signals[].headers.* (option 2)` | object | no | unknown keys rejected | — |
| `routes.*.signals[].headers.* (option 2).secret` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" | — |

## Handler: extension mount

See [extensions](EXTENSIONS.md) for examples.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `routes.*.extension` | string | no | pattern: "^[a-z][a-z0-9-]{0,63}$" | — |

## Policies and profiles

See [policies and profiles](yaml/policies.md) for examples.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `policies` | object | no | unknown keys rejected | Optional host-enforced behavior around routes. Every key is off unless declared. Route policies merge over project policies; false disables one. |
| `policies.profile` | string | no | pattern: "^[a-z][a-z0-9-]{0,63}$" | Built-in (hardened) or a name under top-level profiles |
| `policies.throttle` | one of the shapes below | no | — | — |
| `policies.throttle (option 1)` | constant | no | const: false | — |
| `policies.throttle (option 2)` | object | no | unknown keys rejected | Per-client request budget expressed like the IETF RateLimit-Policy field: quota requests per window seconds. quota and window are required once project and route layers are merged. |
| `policies.throttle (option 2).quota` | integer | no | minimum: 1; maximum: 1000000 | — |
| `policies.throttle (option 2).window` | integer | no | minimum: 1; maximum: 86400 | Seconds |
| `policies.throttle (option 2).partition` | string | no | enum: ["client","route","client-route"]; default: "client" | — |
| `policies.throttle (option 2).status` | integer | no | default: 429; minimum: 400; maximum: 599 | — |
| `policies.throttle (option 2).mode` | string | no | enum: ["enforce","report"]; default: "enforce" | — |
| `policies.throttle (option 2).maxKeys` | integer | no | default: 100000; minimum: 1000; maximum: 10000000 | — |
| `policies.agents` | one of the shapes below | no | — | — |
| `policies.agents (option 1)` | constant | no | const: false | — |
| `policies.agents (option 2)` | object | no | unknown keys rejected | User-Agent policy. Named lists ship with the runtime; project-relative .json files in the same schema supply your own. |
| `policies.agents (option 2).deny` | array | no | maxItems: 32; uniqueItems: true | — |
| `policies.agents (option 2).deny[]` | string | no | minLength: 1; maxLength: 1024 | — |
| `policies.agents (option 2).allow` | array | no | maxItems: 32; uniqueItems: true | — |
| `policies.agents (option 2).allow[]` | string | no | minLength: 1; maxLength: 1024 | — |
| `policies.agents (option 2).denyPatterns` | array | no | maxItems: 256; uniqueItems: true | — |
| `policies.agents (option 2).denyPatterns[]` | string | no | minLength: 1; maxLength: 256 | — |
| `policies.agents (option 2).allowPatterns` | array | no | maxItems: 256; uniqueItems: true | — |
| `policies.agents (option 2).allowPatterns[]` | string | no | minLength: 1; maxLength: 256 | — |
| `policies.agents (option 2).denyEmpty` | boolean | no | default: false | Deny requests that send no User-Agent |
| `policies.agents (option 2).status` | integer | no | default: 403; minimum: 400; maximum: 599 | — |
| `policies.agents (option 2).mode` | string | no | enum: ["enforce","report"]; default: "enforce" | — |
| `policies.security` | one of the shapes below | no | — | — |
| `policies.security (option 1)` | constant | no | const: false | — |
| `policies.security (option 2)` | object | no | unknown keys rejected | Response security headers. Profiles follow the OWASP Secure Headers Project; set overrides or adds individual headers; unset removes one from the profile. |
| `policies.security (option 2).headers` | string | no | enum: ["oshp","oshp-no-csp","off"]; default: "oshp" | — |
| `policies.security (option 2).set` | object | no | maxProperties: 32 | — |
| `policies.security (option 2).set.*` | string | no | maxLength: 4096 | — |
| `policies.security (option 2).unset` | array | no | maxItems: 32; uniqueItems: true | — |
| `policies.security (option 2).unset[]` | string | no | minLength: 1; maxLength: 128 | — |
| `policies.compression` | one of the shapes below | no | — | — |
| `policies.compression (option 1)` | constant | no | const: false | — |
| `policies.compression (option 2)` | object | no | unknown keys rejected | Content-coding negotiation per RFC 9110. Assets are precompressed at snapshot time; other bodies compress on the request path. |
| `policies.compression (option 2).encodings` | array | no | default: ["br","gzip"]; minItems: 1; uniqueItems: true | — |
| `policies.compression (option 2).encodings[]` | string | no | enum: ["br","gzip","deflate","zstd"] | — |
| `policies.compression (option 2).minBytes` | integer | no | default: 1024; minimum: 0; maximum: 1048576 | — |
| `policies.compression (option 2).types` | array | no | maxItems: 64; uniqueItems: true | — |
| `policies.compression (option 2).types[]` | string | no | minLength: 1; maxLength: 128 | — |
| `policies.compression (option 2).level` | integer | no | minimum: 1; maximum: 11 | — |
| `policies.compression (option 2).allowWithSecrets` | boolean | no | default: false | — |
| `policies.cache` | one of the shapes below | no | — | — |
| `policies.cache (option 1)` | constant | no | const: false | — |
| `policies.cache (option 2)` | object | no | unknown keys rejected | Named HTTP caching strategy per RFC 9111/5861/8246/9213; explicit fields override what the strategy implies. strategy is required once project and route layers are merged. |
| `policies.cache (option 2).strategy` | string | no | enum: ["no-store","revalidate","public","immutable","swr","sie","micro","cdn-only","private"] | — |
| `policies.cache (option 2).maxAge` | integer | no | minimum: 0; maximum: 31536000 | Seconds |
| `policies.cache (option 2).staleWhileRevalidate` | integer | no | minimum: 0; maximum: 31536000 | — |
| `policies.cache (option 2).staleIfError` | integer | no | minimum: 0; maximum: 31536000 | — |
| `policies.cache (option 2).cdnMaxAge` | integer | no | minimum: 0; maximum: 31536000 | — |
| `policies.cache (option 2).originTtl` | integer | no | minimum: 0; maximum: 86400 | Seconds an origin memory cache may serve a stored response |
| `policies.cache (option 2).vary` | array | no | maxItems: 8; uniqueItems: true | — |
| `policies.cache (option 2).vary[]` | string | no | minLength: 1; maxLength: 128 | — |
| `policies.cache (option 2).statuses` | array | no | maxItems: 16; uniqueItems: true | — |
| `policies.cache (option 2).statuses[]` | integer | no | minimum: 200; maximum: 599 | — |
| `policies.cache (option 2).maxBytes` | integer | no | minimum: 0; maximum: 16777216 | Largest body the origin cache stores |
| `policies.cache (option 2).maxEntries` | integer | no | minimum: 1; maximum: 1000000 | — |
| `policies.cache (option 2).force` | boolean | no | default: false | Allow immutable on a path without a content hash |
| `policies.extensions` | one of the shapes below | no | — | — |
| `policies.extensions (option 1)` | constant | no | const: false | — |
| `policies.extensions (option 2)` | object | no | maxProperties: 16 | — |
| `policies.extensions (option 2).*` | one of the shapes below | no | — | — |
| `policies.extensions (option 2).* (option 1)` | constant | no | const: false | — |
| `policies.extensions (option 2).* (option 2)` | object | no | — | — |
| `profiles` | object | no | maxProperties: 32 | Reusable named policy sets selectable with policies.profile. A name shadows a built-in profile of the same name. |
| `profiles.*` | object | no | unknown keys rejected | — |
| `profiles.*.throttle` | one of the shapes below | no | — | — |
| `profiles.*.throttle (option 1)` | constant | no | const: false | — |
| `profiles.*.throttle (option 2)` | object | no | unknown keys rejected | Per-client request budget expressed like the IETF RateLimit-Policy field: quota requests per window seconds. quota and window are required once project and route layers are merged. |
| `profiles.*.throttle (option 2).quota` | integer | no | minimum: 1; maximum: 1000000 | — |
| `profiles.*.throttle (option 2).window` | integer | no | minimum: 1; maximum: 86400 | Seconds |
| `profiles.*.throttle (option 2).partition` | string | no | enum: ["client","route","client-route"]; default: "client" | — |
| `profiles.*.throttle (option 2).status` | integer | no | default: 429; minimum: 400; maximum: 599 | — |
| `profiles.*.throttle (option 2).mode` | string | no | enum: ["enforce","report"]; default: "enforce" | — |
| `profiles.*.throttle (option 2).maxKeys` | integer | no | default: 100000; minimum: 1000; maximum: 10000000 | — |
| `profiles.*.agents` | one of the shapes below | no | — | — |
| `profiles.*.agents (option 1)` | constant | no | const: false | — |
| `profiles.*.agents (option 2)` | object | no | unknown keys rejected | User-Agent policy. Named lists ship with the runtime; project-relative .json files in the same schema supply your own. |
| `profiles.*.agents (option 2).deny` | array | no | maxItems: 32; uniqueItems: true | — |
| `profiles.*.agents (option 2).deny[]` | string | no | minLength: 1; maxLength: 1024 | — |
| `profiles.*.agents (option 2).allow` | array | no | maxItems: 32; uniqueItems: true | — |
| `profiles.*.agents (option 2).allow[]` | string | no | minLength: 1; maxLength: 1024 | — |
| `profiles.*.agents (option 2).denyPatterns` | array | no | maxItems: 256; uniqueItems: true | — |
| `profiles.*.agents (option 2).denyPatterns[]` | string | no | minLength: 1; maxLength: 256 | — |
| `profiles.*.agents (option 2).allowPatterns` | array | no | maxItems: 256; uniqueItems: true | — |
| `profiles.*.agents (option 2).allowPatterns[]` | string | no | minLength: 1; maxLength: 256 | — |
| `profiles.*.agents (option 2).denyEmpty` | boolean | no | default: false | Deny requests that send no User-Agent |
| `profiles.*.agents (option 2).status` | integer | no | default: 403; minimum: 400; maximum: 599 | — |
| `profiles.*.agents (option 2).mode` | string | no | enum: ["enforce","report"]; default: "enforce" | — |
| `profiles.*.security` | one of the shapes below | no | — | — |
| `profiles.*.security (option 1)` | constant | no | const: false | — |
| `profiles.*.security (option 2)` | object | no | unknown keys rejected | Response security headers. Profiles follow the OWASP Secure Headers Project; set overrides or adds individual headers; unset removes one from the profile. |
| `profiles.*.security (option 2).headers` | string | no | enum: ["oshp","oshp-no-csp","off"]; default: "oshp" | — |
| `profiles.*.security (option 2).set` | object | no | maxProperties: 32 | — |
| `profiles.*.security (option 2).set.*` | string | no | maxLength: 4096 | — |
| `profiles.*.security (option 2).unset` | array | no | maxItems: 32; uniqueItems: true | — |
| `profiles.*.security (option 2).unset[]` | string | no | minLength: 1; maxLength: 128 | — |
| `profiles.*.compression` | one of the shapes below | no | — | — |
| `profiles.*.compression (option 1)` | constant | no | const: false | — |
| `profiles.*.compression (option 2)` | object | no | unknown keys rejected | Content-coding negotiation per RFC 9110. Assets are precompressed at snapshot time; other bodies compress on the request path. |
| `profiles.*.compression (option 2).encodings` | array | no | default: ["br","gzip"]; minItems: 1; uniqueItems: true | — |
| `profiles.*.compression (option 2).encodings[]` | string | no | enum: ["br","gzip","deflate","zstd"] | — |
| `profiles.*.compression (option 2).minBytes` | integer | no | default: 1024; minimum: 0; maximum: 1048576 | — |
| `profiles.*.compression (option 2).types` | array | no | maxItems: 64; uniqueItems: true | — |
| `profiles.*.compression (option 2).types[]` | string | no | minLength: 1; maxLength: 128 | — |
| `profiles.*.compression (option 2).level` | integer | no | minimum: 1; maximum: 11 | — |
| `profiles.*.compression (option 2).allowWithSecrets` | boolean | no | default: false | — |
| `profiles.*.cache` | one of the shapes below | no | — | — |
| `profiles.*.cache (option 1)` | constant | no | const: false | — |
| `profiles.*.cache (option 2)` | object | no | unknown keys rejected | Named HTTP caching strategy per RFC 9111/5861/8246/9213; explicit fields override what the strategy implies. strategy is required once project and route layers are merged. |
| `profiles.*.cache (option 2).strategy` | string | no | enum: ["no-store","revalidate","public","immutable","swr","sie","micro","cdn-only","private"] | — |
| `profiles.*.cache (option 2).maxAge` | integer | no | minimum: 0; maximum: 31536000 | Seconds |
| `profiles.*.cache (option 2).staleWhileRevalidate` | integer | no | minimum: 0; maximum: 31536000 | — |
| `profiles.*.cache (option 2).staleIfError` | integer | no | minimum: 0; maximum: 31536000 | — |
| `profiles.*.cache (option 2).cdnMaxAge` | integer | no | minimum: 0; maximum: 31536000 | — |
| `profiles.*.cache (option 2).originTtl` | integer | no | minimum: 0; maximum: 86400 | Seconds an origin memory cache may serve a stored response |
| `profiles.*.cache (option 2).vary` | array | no | maxItems: 8; uniqueItems: true | — |
| `profiles.*.cache (option 2).vary[]` | string | no | minLength: 1; maxLength: 128 | — |
| `profiles.*.cache (option 2).statuses` | array | no | maxItems: 16; uniqueItems: true | — |
| `profiles.*.cache (option 2).statuses[]` | integer | no | minimum: 200; maximum: 599 | — |
| `profiles.*.cache (option 2).maxBytes` | integer | no | minimum: 0; maximum: 16777216 | Largest body the origin cache stores |
| `profiles.*.cache (option 2).maxEntries` | integer | no | minimum: 1; maximum: 1000000 | — |
| `profiles.*.cache (option 2).force` | boolean | no | default: false | Allow immutable on a path without a content hash |
| `profiles.*.extensions` | one of the shapes below | no | — | — |
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
| `site.robots.disallow` | array | no | maxItems: 1024; uniqueItems: true | — |
| `site.robots.disallow[]` | string | no | minLength: 1; maxLength: 2048 | — |
| `site.robots.allow` | array | no | maxItems: 1024; uniqueItems: true | — |
| `site.robots.allow[]` | string | no | minLength: 1; maxLength: 2048 | — |
| `site.robots.sitemap` | boolean | no | — | Append a Sitemap line built from the public origin (--origin); omitted when no origin is known. |
| `site.robots.extra` | array | no | maxItems: 1024 | — |
| `site.robots.extra[]` | string | no | maxLength: 2048 | — |
| `site.sitemap` | one of the shapes below | no | — | Generates /sitemap.xml (sitemaps.org 0.9) from active literal GET routes serving HTML. Requires --origin. |
| `site.sitemap (option 1)` | constant | no | const: true | — |
| `site.sitemap (option 2)` | object | no | unknown keys rejected | — |
| `site.sitemap (option 2).exclude` | array | no | maxItems: 1024; uniqueItems: true | — |
| `site.sitemap (option 2).exclude[]` | string | no | minLength: 1; maxLength: 2048 | — |
| `site.sitemap (option 2).changefreq` | string | no | enum: ["always","hourly","daily","weekly","monthly","yearly","never"] | — |
| `site.sitemap (option 2).priority` | number | no | minimum: 0; maximum: 1 | — |
| `site.favicon` | string | no | minLength: 1; maxLength: 1024 | Project-relative .ico, .svg or .png served at /favicon.ico. |
| `site.securityTxt` | object | no | unknown keys rejected | Generates /.well-known/security.txt (RFC 9116). |
| `site.securityTxt.contact` | array | yes | minItems: 1; maxItems: 64 | — |
| `site.securityTxt.contact[]` | string | no | minLength: 1; maxLength: 2048 | — |
| `site.securityTxt.expires` | string | yes | pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$" | — |
| `site.securityTxt.policy` | array | no | maxItems: 64 | — |
| `site.securityTxt.policy[]` | string | no | maxLength: 2048; pattern: "^https://" | — |
| `site.securityTxt.acknowledgments` | array | no | maxItems: 64 | — |
| `site.securityTxt.acknowledgments[]` | string | no | maxLength: 2048; pattern: "^https://" | — |
| `site.securityTxt.preferredLanguages` | array | no | minItems: 1; maxItems: 64 | — |
| `site.securityTxt.preferredLanguages[]` | string | no | minLength: 2; maxLength: 35 | — |
| `site.securityTxt.canonical` | array | no | maxItems: 64 | — |
| `site.securityTxt.canonical[]` | string | no | maxLength: 2048; pattern: "^https://" | — |
| `site.securityTxt.encryption` | array | no | maxItems: 64 | — |
| `site.securityTxt.encryption[]` | string | no | minLength: 1; maxLength: 2048 | — |
| `site.llms` | string | no | minLength: 1; maxLength: 1024 | Project-relative text file served at /llms.txt. |
| `site.notFound` | string | no | minLength: 1; maxLength: 1024; pattern: "\\.[hH][tT][mM][lL]?$" | Project-relative .html file served with status 404 and text/html for a GET or HEAD that matches no route. Generated as a page route at /404.html, which is also the object name static hosting uses. |

## Extensions (top-level)

See [extensions](EXTENSIONS.md) for examples.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `extensions` | object | no | maxProperties: 16 | Versioned logical extension configurations. Requires explicit external operator registrations pinned to the project revision; never loads project code. |
| `extensions.*` | object | no | unknown keys rejected | — |
| `extensions.*.version` | constant | yes | const: "1" | — |
| `extensions.*.config` | object | yes | — | — |
