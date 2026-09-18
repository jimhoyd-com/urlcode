# YAML field reference

Generated from the bundled JSON Schema by `npm run docs:reference`. Required
means required within its containing object, not that the object itself must be
present. `routes.*` means a route path; other `*` markers mean user-selected
keys. `[]` means an array item. Option rows describe union alternatives.

Read the [YAML guide](YAML-GUIDE.md) for examples and [specification](SPECIFICATION.md)
for semantic validation beyond JSON Schema. Exactly one handler is required per
route; respond.text/respond.json are mutually exclusive. Runtime defaults include
GET/HEAD, redirect 302, respond 200, default module export, and asset no-cache.
Only Set-Cookie accepts response header arrays. This table does not imply all
schema-valid combinations activate successfully.

| Field | Type | Required | Schema constraints |
|---|---|---|---|
| `version` | constant | yes | const: "1" |
| `routes` | object | yes | maxProperties: 100000 |
| `routes.*` | object | no | unknown keys rejected |
| `routes.*.methods` | array | no | default: ["GET","HEAD"]; minItems: 1; uniqueItems: true |
| `routes.*.methods[]` | string | no | enum: ["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"] |
| `routes.*.enabled` | boolean | no | — |
| `routes.*.expires` | string | no | — |
| `routes.*.description` | string | no | maxLength: 1024 |
| `routes.*.parameters` | array | no | maxItems: 64 |
| `routes.*.parameters[]` | object | no | unknown keys rejected |
| `routes.*.parameters[].name` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_-]*$" |
| `routes.*.parameters[].in` | string | yes | enum: ["path","query","header"] |
| `routes.*.parameters[].required` | boolean | no | — |
| `routes.*.parameters[].schema` | object | yes | unknown keys rejected |
| `routes.*.parameters[].schema.type` | string | yes | enum: ["string","integer","number","boolean","array"] |
| `routes.*.parameters[].schema.enum` | array | no | minItems: 1; uniqueItems: true |
| `routes.*.parameters[].schema.enum[]` | string / number / boolean | no | — |
| `routes.*.parameters[].schema.default` | string / number / boolean / array | no | — |
| `routes.*.parameters[].schema.default[]` | string / number / boolean | no | — |
| `routes.*.parameters[].schema.minLength` | integer | no | minimum: 0; maximum: 8192 |
| `routes.*.parameters[].schema.maxLength` | integer | no | minimum: 0; maximum: 8192 |
| `routes.*.parameters[].schema.minimum` | number | no | — |
| `routes.*.parameters[].schema.maximum` | number | no | — |
| `routes.*.parameters[].schema.items` | object | no | unknown keys rejected |
| `routes.*.parameters[].schema.items.type` | string | yes | enum: ["string","integer","number","boolean"] |
| `routes.*.parameters[].schema.maxItems` | integer | no | minimum: 0; maximum: 100 |
| `routes.*.redirect` | object | no | unknown keys rejected |
| `routes.*.redirect.url` | string | yes | maxLength: 8192 |
| `routes.*.redirect.status` | number | no | enum: [301,302,303,307,308] |
| `routes.*.redirect.query` | object | no | unknown keys rejected |
| `routes.*.redirect.query.pass` | one of the shapes below | no | — |
| `routes.*.redirect.query.pass (option 1)` | constant | no | const: false |
| `routes.*.redirect.query.pass (option 2)` | array | no | uniqueItems: true |
| `routes.*.redirect.query.pass (option 2)[]` | string | no | — |
| `routes.*.redirect.query.map` | object | no | — |
| `routes.*.redirect.query.map.*` | object | no | unknown keys rejected |
| `routes.*.redirect.query.map.*.from` | string | yes | enum: ["path","query","header"] |
| `routes.*.redirect.query.map.*.name` | string | yes | — |
| `routes.*.function` | one of the shapes below | no | — |
| `routes.*.function (option 1)` | string | no | minLength: 1; maxLength: 1024 |
| `routes.*.function (option 2)` | object | no | unknown keys rejected |
| `routes.*.function (option 2).source` | string | yes | maxLength: 1024 |
| `routes.*.function (option 2).export` | string | no | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" |
| `routes.*.function (option 2).args` | object | no | — |
| `routes.*.function (option 2).args.*` | one of the shapes below | no | — |
| `routes.*.function (option 2).args.* (option 1)` | string / number / boolean | no | — |
| `routes.*.function (option 2).args.* (option 2)` | object | no | unknown keys rejected |
| `routes.*.function (option 2).args.* (option 2).from` | string | yes | enum: ["path","query","header"] |
| `routes.*.function (option 2).args.* (option 2).name` | string | yes | — |
| `routes.*.function (option 2).args.* (option 3)` | object | no | unknown keys rejected |
| `routes.*.function (option 2).args.* (option 3).env` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" |
| `routes.*.function (option 2).args.* (option 4)` | object | no | unknown keys rejected |
| `routes.*.function (option 2).args.* (option 4).secret` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" |
| `routes.*.env` | object | no | — |
| `routes.*.env.*` | one of the shapes below | no | — |
| `routes.*.env.* (option 1)` | object | no | unknown keys rejected |
| `routes.*.env.* (option 1).value` | string | yes | — |
| `routes.*.env.* (option 2)` | object | no | unknown keys rejected |
| `routes.*.env.* (option 2).env` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" |
| `routes.*.secrets` | object | no | — |
| `routes.*.secrets.*` | object | no | unknown keys rejected |
| `routes.*.secrets.*.secret` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" |
| `routes.*.page` | object | no | unknown keys rejected |
| `routes.*.page.file` | string | yes | minLength: 1; maxLength: 1024 |
| `routes.*.page.contentType` | string | no | maxLength: 128; pattern: "^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$" |
| `routes.*.page.cacheControl` | string | no | enum: ["no-cache","no-store","public, max-age=3600","public, max-age=31536000, immutable"] |
| `routes.*.download` | object | no | unknown keys rejected |
| `routes.*.download.file` | string | yes | minLength: 1; maxLength: 1024 |
| `routes.*.download.contentType` | string | no | maxLength: 128; pattern: "^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$" |
| `routes.*.download.cacheControl` | string | no | enum: ["no-cache","no-store","public, max-age=3600","public, max-age=31536000, immutable"] |
| `routes.*.download.filename` | string | no | minLength: 1; maxLength: 255 |
| `routes.*.static` | object | no | unknown keys rejected |
| `routes.*.static.directory` | string | yes | minLength: 1; maxLength: 1024 |
| `routes.*.static.contentType` | string | no | maxLength: 128; pattern: "^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$" |
| `routes.*.static.cacheControl` | string | no | enum: ["no-cache","no-store","public, max-age=3600","public, max-age=31536000, immutable"] |
| `routes.*.static.index` | string | no | pattern: "^[A-Za-z0-9_-]+\\.html$" |
| `routes.*.request` | object | no | unknown keys rejected |
| `routes.*.request.body` | object | no | unknown keys rejected |
| `routes.*.request.body.required` | boolean | no | — |
| `routes.*.request.body.maxBytes` | integer | no | minimum: 0; maximum: 1048576 |
| `routes.*.request.body.contentTypes` | array | no | minItems: 1; maxItems: 16; uniqueItems: true |
| `routes.*.request.body.contentTypes[]` | string | no | pattern: "^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$" |
| `routes.*.request.body.format` | string | no | enum: ["text","json"] |
| `routes.*.response` | object | no | unknown keys rejected |
| `routes.*.response.headers` | object | no | maxProperties: 64 |
| `routes.*.response.headers.*` | one of the shapes below | no | — |
| `routes.*.response.headers.* (option 1)` | string | no | maxLength: 4096 |
| `routes.*.response.headers.* (option 2)` | array | no | minItems: 1; maxItems: 16 |
| `routes.*.response.headers.* (option 2)[]` | string | no | maxLength: 4096 |
| `routes.*.respond` | object | no | unknown keys rejected |
| `routes.*.respond.status` | integer | no | minimum: 200; maximum: 599 |
| `routes.*.respond.text` | string | no | maxLength: 1048576 |
| `routes.*.respond.json` | any JSON value | no | — |
| `routes.*.middleware` | array | no | maxItems: 16 |
| `routes.*.middleware[]` | one of the shapes below | no | — |
| `routes.*.middleware[] (option 1)` | string | no | minLength: 1; maxLength: 1024 |
| `routes.*.middleware[] (option 2)` | object | no | unknown keys rejected |
| `routes.*.middleware[] (option 2).source` | string | yes | maxLength: 1024 |
| `routes.*.middleware[] (option 2).export` | string | no | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" |
| `routes.*.link` | object | no | unknown keys rejected |
| `routes.*.link.collection` | string | yes | pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" |
| `routes.*.link.code` | object | yes | unknown keys rejected |
| `routes.*.link.code.from` | constant | yes | const: "path" |
| `routes.*.link.code.name` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" |
| `routes.*.policies` | object | no | unknown keys rejected |
| `routes.*.policies.profile` | string | no | pattern: "^[a-z][a-z0-9-]{0,63}$" |
| `routes.*.policies.throttle` | one of the shapes below | no | — |
| `routes.*.policies.throttle (option 1)` | constant | no | const: false |
| `routes.*.policies.throttle (option 2)` | object | no | unknown keys rejected |
| `routes.*.policies.throttle (option 2).quota` | integer | no | minimum: 1; maximum: 1000000 |
| `routes.*.policies.throttle (option 2).window` | integer | no | minimum: 1; maximum: 86400 |
| `routes.*.policies.throttle (option 2).partition` | string | no | enum: ["client","route","client-route"]; default: "client" |
| `routes.*.policies.throttle (option 2).status` | integer | no | default: 429; minimum: 400; maximum: 599 |
| `routes.*.policies.throttle (option 2).mode` | string | no | enum: ["enforce","report"]; default: "enforce" |
| `routes.*.policies.throttle (option 2).maxKeys` | integer | no | default: 100000; minimum: 1000; maximum: 10000000 |
| `routes.*.policies.agents` | one of the shapes below | no | — |
| `routes.*.policies.agents (option 1)` | constant | no | const: false |
| `routes.*.policies.agents (option 2)` | object | no | unknown keys rejected |
| `routes.*.policies.agents (option 2).deny` | array | no | maxItems: 32; uniqueItems: true |
| `routes.*.policies.agents (option 2).deny[]` | string | no | minLength: 1; maxLength: 1024 |
| `routes.*.policies.agents (option 2).allow` | array | no | maxItems: 32; uniqueItems: true |
| `routes.*.policies.agents (option 2).allow[]` | string | no | minLength: 1; maxLength: 1024 |
| `routes.*.policies.agents (option 2).denyPatterns` | array | no | maxItems: 256; uniqueItems: true |
| `routes.*.policies.agents (option 2).denyPatterns[]` | string | no | minLength: 1; maxLength: 256 |
| `routes.*.policies.agents (option 2).allowPatterns` | array | no | maxItems: 256; uniqueItems: true |
| `routes.*.policies.agents (option 2).allowPatterns[]` | string | no | minLength: 1; maxLength: 256 |
| `routes.*.policies.agents (option 2).denyEmpty` | boolean | no | default: false |
| `routes.*.policies.agents (option 2).status` | integer | no | default: 403; minimum: 400; maximum: 599 |
| `routes.*.policies.agents (option 2).mode` | string | no | enum: ["enforce","report"]; default: "enforce" |
| `routes.*.policies.security` | one of the shapes below | no | — |
| `routes.*.policies.security (option 1)` | constant | no | const: false |
| `routes.*.policies.security (option 2)` | object | no | unknown keys rejected |
| `routes.*.policies.security (option 2).headers` | string | no | enum: ["oshp","oshp-no-csp","off"]; default: "oshp" |
| `routes.*.policies.security (option 2).set` | object | no | maxProperties: 32 |
| `routes.*.policies.security (option 2).set.*` | string | no | maxLength: 4096 |
| `routes.*.policies.security (option 2).unset` | array | no | maxItems: 32; uniqueItems: true |
| `routes.*.policies.security (option 2).unset[]` | string | no | minLength: 1; maxLength: 128 |
| `routes.*.policies.compression` | one of the shapes below | no | — |
| `routes.*.policies.compression (option 1)` | constant | no | const: false |
| `routes.*.policies.compression (option 2)` | object | no | unknown keys rejected |
| `routes.*.policies.compression (option 2).encodings` | array | no | default: ["br","gzip"]; minItems: 1; uniqueItems: true |
| `routes.*.policies.compression (option 2).encodings[]` | string | no | enum: ["br","gzip","deflate","zstd"] |
| `routes.*.policies.compression (option 2).minBytes` | integer | no | default: 1024; minimum: 0; maximum: 1048576 |
| `routes.*.policies.compression (option 2).types` | array | no | maxItems: 64; uniqueItems: true |
| `routes.*.policies.compression (option 2).types[]` | string | no | minLength: 1; maxLength: 128 |
| `routes.*.policies.compression (option 2).level` | integer | no | minimum: 1; maximum: 11 |
| `routes.*.policies.compression (option 2).allowWithSecrets` | boolean | no | default: false |
| `routes.*.policies.cache` | one of the shapes below | no | — |
| `routes.*.policies.cache (option 1)` | constant | no | const: false |
| `routes.*.policies.cache (option 2)` | object | no | unknown keys rejected |
| `routes.*.policies.cache (option 2).strategy` | string | no | enum: ["no-store","revalidate","public","immutable","swr","sie","micro","cdn-only","private"] |
| `routes.*.policies.cache (option 2).maxAge` | integer | no | minimum: 0; maximum: 31536000 |
| `routes.*.policies.cache (option 2).staleWhileRevalidate` | integer | no | minimum: 0; maximum: 31536000 |
| `routes.*.policies.cache (option 2).staleIfError` | integer | no | minimum: 0; maximum: 31536000 |
| `routes.*.policies.cache (option 2).cdnMaxAge` | integer | no | minimum: 0; maximum: 31536000 |
| `routes.*.policies.cache (option 2).originTtl` | integer | no | minimum: 0; maximum: 86400 |
| `routes.*.policies.cache (option 2).vary` | array | no | maxItems: 8; uniqueItems: true |
| `routes.*.policies.cache (option 2).vary[]` | string | no | minLength: 1; maxLength: 128 |
| `routes.*.policies.cache (option 2).statuses` | array | no | maxItems: 16; uniqueItems: true |
| `routes.*.policies.cache (option 2).statuses[]` | integer | no | minimum: 200; maximum: 599 |
| `routes.*.policies.cache (option 2).maxBytes` | integer | no | minimum: 0; maximum: 16777216 |
| `routes.*.policies.cache (option 2).maxEntries` | integer | no | minimum: 1; maximum: 1000000 |
| `routes.*.policies.cache (option 2).force` | boolean | no | default: false |
| `routes.*.policies.extensions` | one of the shapes below | no | — |
| `routes.*.policies.extensions (option 1)` | constant | no | const: false |
| `routes.*.policies.extensions (option 2)` | object | no | maxProperties: 16 |
| `routes.*.policies.extensions (option 2).*` | one of the shapes below | no | — |
| `routes.*.policies.extensions (option 2).* (option 1)` | constant | no | const: false |
| `routes.*.policies.extensions (option 2).* (option 2)` | object | no | — |
| `routes.*.match` | object | no | minProperties: 1; unknown keys rejected |
| `routes.*.match.query` | object | no | minProperties: 1; maxProperties: 16 |
| `routes.*.match.query.*` | string | no | maxLength: 1024 |
| `routes.*.match.headers` | object | no | minProperties: 1; maxProperties: 16 |
| `routes.*.match.headers.*` | string | no | maxLength: 1024 |
| `routes.*.match.cookies` | object | no | minProperties: 1; maxProperties: 16 |
| `routes.*.match.cookies.*` | string | no | maxLength: 1024 |
| `routes.*.match.host` | string | no | maxLength: 255 |
| `routes.*.match.method` | string | no | enum: ["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"] |
| `routes.*.conditional` | object | no | unknown keys rejected |
| `routes.*.conditional.cases` | array | yes | minItems: 1; maxItems: 16 |
| `routes.*.conditional.cases[]` | object | no | unknown keys rejected |
| `routes.*.conditional.cases[].redirect` | object | no | unknown keys rejected |
| `routes.*.conditional.cases[].redirect.url` | string | yes | maxLength: 8192 |
| `routes.*.conditional.cases[].redirect.status` | number | no | enum: [301,302,303,307,308] |
| `routes.*.conditional.cases[].redirect.query` | object | no | unknown keys rejected |
| `routes.*.conditional.cases[].redirect.query.pass` | one of the shapes below | no | — |
| `routes.*.conditional.cases[].redirect.query.pass (option 1)` | constant | no | const: false |
| `routes.*.conditional.cases[].redirect.query.pass (option 2)` | array | no | uniqueItems: true |
| `routes.*.conditional.cases[].redirect.query.pass (option 2)[]` | string | no | — |
| `routes.*.conditional.cases[].redirect.query.map` | object | no | — |
| `routes.*.conditional.cases[].redirect.query.map.*` | object | no | unknown keys rejected |
| `routes.*.conditional.cases[].redirect.query.map.*.from` | string | yes | enum: ["path","query","header"] |
| `routes.*.conditional.cases[].redirect.query.map.*.name` | string | yes | — |
| `routes.*.conditional.cases[].respond` | object | no | unknown keys rejected |
| `routes.*.conditional.cases[].respond.status` | integer | no | minimum: 200; maximum: 599 |
| `routes.*.conditional.cases[].respond.text` | string | no | maxLength: 1048576 |
| `routes.*.conditional.cases[].respond.json` | any JSON value | no | — |
| `routes.*.conditional.cases[].match` | object | yes | minProperties: 1; unknown keys rejected |
| `routes.*.conditional.cases[].match.query` | object | no | minProperties: 1; maxProperties: 16 |
| `routes.*.conditional.cases[].match.query.*` | string | no | maxLength: 1024 |
| `routes.*.conditional.cases[].match.headers` | object | no | minProperties: 1; maxProperties: 16 |
| `routes.*.conditional.cases[].match.headers.*` | string | no | maxLength: 1024 |
| `routes.*.conditional.cases[].match.cookies` | object | no | minProperties: 1; maxProperties: 16 |
| `routes.*.conditional.cases[].match.cookies.*` | string | no | maxLength: 1024 |
| `routes.*.conditional.cases[].match.host` | string | no | maxLength: 255 |
| `routes.*.conditional.cases[].match.method` | string | no | enum: ["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"] |
| `routes.*.conditional.fallback` | object | no | unknown keys rejected |
| `routes.*.conditional.fallback.redirect` | object | no | unknown keys rejected |
| `routes.*.conditional.fallback.redirect.url` | string | yes | maxLength: 8192 |
| `routes.*.conditional.fallback.redirect.status` | number | no | enum: [301,302,303,307,308] |
| `routes.*.conditional.fallback.redirect.query` | object | no | unknown keys rejected |
| `routes.*.conditional.fallback.redirect.query.pass` | one of the shapes below | no | — |
| `routes.*.conditional.fallback.redirect.query.pass (option 1)` | constant | no | const: false |
| `routes.*.conditional.fallback.redirect.query.pass (option 2)` | array | no | uniqueItems: true |
| `routes.*.conditional.fallback.redirect.query.pass (option 2)[]` | string | no | — |
| `routes.*.conditional.fallback.redirect.query.map` | object | no | — |
| `routes.*.conditional.fallback.redirect.query.map.*` | object | no | unknown keys rejected |
| `routes.*.conditional.fallback.redirect.query.map.*.from` | string | yes | enum: ["path","query","header"] |
| `routes.*.conditional.fallback.redirect.query.map.*.name` | string | yes | — |
| `routes.*.conditional.fallback.respond` | object | no | unknown keys rejected |
| `routes.*.conditional.fallback.respond.status` | integer | no | minimum: 200; maximum: 599 |
| `routes.*.conditional.fallback.respond.text` | string | no | maxLength: 1048576 |
| `routes.*.conditional.fallback.respond.json` | any JSON value | no | — |
| `routes.*.proxy` | object | no | unknown keys rejected |
| `routes.*.proxy.url` | string | yes | maxLength: 8192 |
| `routes.*.proxy.headers` | object | no | maxProperties: 32 |
| `routes.*.proxy.headers.*` | one of the shapes below | no | — |
| `routes.*.proxy.headers.* (option 1)` | string | no | maxLength: 4096 |
| `routes.*.proxy.headers.* (option 2)` | object | no | unknown keys rejected |
| `routes.*.proxy.headers.* (option 2).secret` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" |
| `routes.*.proxy.query` | array | no | maxItems: 32; uniqueItems: true |
| `routes.*.proxy.query[]` | string | no | minLength: 1; maxLength: 128 |
| `routes.*.proxy.requestHeaders` | array | no | maxItems: 32; uniqueItems: true |
| `routes.*.proxy.requestHeaders[]` | string | no | minLength: 1; maxLength: 128 |
| `routes.*.proxy.responseHeaders` | array | no | maxItems: 32; uniqueItems: true |
| `routes.*.proxy.responseHeaders[]` | string | no | minLength: 1; maxLength: 128 |
| `routes.*.signals` | array | no | minItems: 1; maxItems: 8 |
| `routes.*.signals[]` | object | no | unknown keys rejected |
| `routes.*.signals[].url` | string | yes | maxLength: 8192 |
| `routes.*.signals[].headers` | object | no | maxProperties: 32 |
| `routes.*.signals[].headers.*` | one of the shapes below | no | — |
| `routes.*.signals[].headers.* (option 1)` | string | no | maxLength: 4096 |
| `routes.*.signals[].headers.* (option 2)` | object | no | unknown keys rejected |
| `routes.*.signals[].headers.* (option 2).secret` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" |
| `routes.*.extension` | string | no | pattern: "^[a-z][a-z0-9-]{0,63}$" |
| `routes.*.auth` | one of the shapes below | no | — |
| `routes.*.auth (option 1)` | constant | no | const: true |
| `routes.*.auth (option 2)` | object | no | unknown keys rejected |
| `routes.*.auth (option 2).required` | boolean | no | default: true |
| `routes.*.auth (option 2).role` | string | no | minLength: 1; maxLength: 64 |
| `routes.*.auth (option 2).permission` | string | no | minLength: 1; maxLength: 128 |
| `routes.*.auth (option 2).verified` | boolean | no | — |
| `routes.*.auth (option 2).freshWithinSeconds` | integer | no | minimum: 1; maximum: 3600 |
| `routes.*.auth (option 2).onDeny` | number / string | no | enum: [401,403,404,"sign-in"] |
| `includes` | array | no | maxItems: 256; uniqueItems: true |
| `includes[]` | string | no | maxLength: 1024 |
| `dynamicLinks` | boolean | no | default: false |
| `policies` | object | no | unknown keys rejected |
| `policies.profile` | string | no | pattern: "^[a-z][a-z0-9-]{0,63}$" |
| `policies.throttle` | one of the shapes below | no | — |
| `policies.throttle (option 1)` | constant | no | const: false |
| `policies.throttle (option 2)` | object | no | unknown keys rejected |
| `policies.throttle (option 2).quota` | integer | no | minimum: 1; maximum: 1000000 |
| `policies.throttle (option 2).window` | integer | no | minimum: 1; maximum: 86400 |
| `policies.throttle (option 2).partition` | string | no | enum: ["client","route","client-route"]; default: "client" |
| `policies.throttle (option 2).status` | integer | no | default: 429; minimum: 400; maximum: 599 |
| `policies.throttle (option 2).mode` | string | no | enum: ["enforce","report"]; default: "enforce" |
| `policies.throttle (option 2).maxKeys` | integer | no | default: 100000; minimum: 1000; maximum: 10000000 |
| `policies.agents` | one of the shapes below | no | — |
| `policies.agents (option 1)` | constant | no | const: false |
| `policies.agents (option 2)` | object | no | unknown keys rejected |
| `policies.agents (option 2).deny` | array | no | maxItems: 32; uniqueItems: true |
| `policies.agents (option 2).deny[]` | string | no | minLength: 1; maxLength: 1024 |
| `policies.agents (option 2).allow` | array | no | maxItems: 32; uniqueItems: true |
| `policies.agents (option 2).allow[]` | string | no | minLength: 1; maxLength: 1024 |
| `policies.agents (option 2).denyPatterns` | array | no | maxItems: 256; uniqueItems: true |
| `policies.agents (option 2).denyPatterns[]` | string | no | minLength: 1; maxLength: 256 |
| `policies.agents (option 2).allowPatterns` | array | no | maxItems: 256; uniqueItems: true |
| `policies.agents (option 2).allowPatterns[]` | string | no | minLength: 1; maxLength: 256 |
| `policies.agents (option 2).denyEmpty` | boolean | no | default: false |
| `policies.agents (option 2).status` | integer | no | default: 403; minimum: 400; maximum: 599 |
| `policies.agents (option 2).mode` | string | no | enum: ["enforce","report"]; default: "enforce" |
| `policies.security` | one of the shapes below | no | — |
| `policies.security (option 1)` | constant | no | const: false |
| `policies.security (option 2)` | object | no | unknown keys rejected |
| `policies.security (option 2).headers` | string | no | enum: ["oshp","oshp-no-csp","off"]; default: "oshp" |
| `policies.security (option 2).set` | object | no | maxProperties: 32 |
| `policies.security (option 2).set.*` | string | no | maxLength: 4096 |
| `policies.security (option 2).unset` | array | no | maxItems: 32; uniqueItems: true |
| `policies.security (option 2).unset[]` | string | no | minLength: 1; maxLength: 128 |
| `policies.compression` | one of the shapes below | no | — |
| `policies.compression (option 1)` | constant | no | const: false |
| `policies.compression (option 2)` | object | no | unknown keys rejected |
| `policies.compression (option 2).encodings` | array | no | default: ["br","gzip"]; minItems: 1; uniqueItems: true |
| `policies.compression (option 2).encodings[]` | string | no | enum: ["br","gzip","deflate","zstd"] |
| `policies.compression (option 2).minBytes` | integer | no | default: 1024; minimum: 0; maximum: 1048576 |
| `policies.compression (option 2).types` | array | no | maxItems: 64; uniqueItems: true |
| `policies.compression (option 2).types[]` | string | no | minLength: 1; maxLength: 128 |
| `policies.compression (option 2).level` | integer | no | minimum: 1; maximum: 11 |
| `policies.compression (option 2).allowWithSecrets` | boolean | no | default: false |
| `policies.cache` | one of the shapes below | no | — |
| `policies.cache (option 1)` | constant | no | const: false |
| `policies.cache (option 2)` | object | no | unknown keys rejected |
| `policies.cache (option 2).strategy` | string | no | enum: ["no-store","revalidate","public","immutable","swr","sie","micro","cdn-only","private"] |
| `policies.cache (option 2).maxAge` | integer | no | minimum: 0; maximum: 31536000 |
| `policies.cache (option 2).staleWhileRevalidate` | integer | no | minimum: 0; maximum: 31536000 |
| `policies.cache (option 2).staleIfError` | integer | no | minimum: 0; maximum: 31536000 |
| `policies.cache (option 2).cdnMaxAge` | integer | no | minimum: 0; maximum: 31536000 |
| `policies.cache (option 2).originTtl` | integer | no | minimum: 0; maximum: 86400 |
| `policies.cache (option 2).vary` | array | no | maxItems: 8; uniqueItems: true |
| `policies.cache (option 2).vary[]` | string | no | minLength: 1; maxLength: 128 |
| `policies.cache (option 2).statuses` | array | no | maxItems: 16; uniqueItems: true |
| `policies.cache (option 2).statuses[]` | integer | no | minimum: 200; maximum: 599 |
| `policies.cache (option 2).maxBytes` | integer | no | minimum: 0; maximum: 16777216 |
| `policies.cache (option 2).maxEntries` | integer | no | minimum: 1; maximum: 1000000 |
| `policies.cache (option 2).force` | boolean | no | default: false |
| `policies.extensions` | one of the shapes below | no | — |
| `policies.extensions (option 1)` | constant | no | const: false |
| `policies.extensions (option 2)` | object | no | maxProperties: 16 |
| `policies.extensions (option 2).*` | one of the shapes below | no | — |
| `policies.extensions (option 2).* (option 1)` | constant | no | const: false |
| `policies.extensions (option 2).* (option 2)` | object | no | — |
| `profiles` | object | no | maxProperties: 32 |
| `profiles.*` | object | no | unknown keys rejected |
| `profiles.*.throttle` | one of the shapes below | no | — |
| `profiles.*.throttle (option 1)` | constant | no | const: false |
| `profiles.*.throttle (option 2)` | object | no | unknown keys rejected |
| `profiles.*.throttle (option 2).quota` | integer | no | minimum: 1; maximum: 1000000 |
| `profiles.*.throttle (option 2).window` | integer | no | minimum: 1; maximum: 86400 |
| `profiles.*.throttle (option 2).partition` | string | no | enum: ["client","route","client-route"]; default: "client" |
| `profiles.*.throttle (option 2).status` | integer | no | default: 429; minimum: 400; maximum: 599 |
| `profiles.*.throttle (option 2).mode` | string | no | enum: ["enforce","report"]; default: "enforce" |
| `profiles.*.throttle (option 2).maxKeys` | integer | no | default: 100000; minimum: 1000; maximum: 10000000 |
| `profiles.*.agents` | one of the shapes below | no | — |
| `profiles.*.agents (option 1)` | constant | no | const: false |
| `profiles.*.agents (option 2)` | object | no | unknown keys rejected |
| `profiles.*.agents (option 2).deny` | array | no | maxItems: 32; uniqueItems: true |
| `profiles.*.agents (option 2).deny[]` | string | no | minLength: 1; maxLength: 1024 |
| `profiles.*.agents (option 2).allow` | array | no | maxItems: 32; uniqueItems: true |
| `profiles.*.agents (option 2).allow[]` | string | no | minLength: 1; maxLength: 1024 |
| `profiles.*.agents (option 2).denyPatterns` | array | no | maxItems: 256; uniqueItems: true |
| `profiles.*.agents (option 2).denyPatterns[]` | string | no | minLength: 1; maxLength: 256 |
| `profiles.*.agents (option 2).allowPatterns` | array | no | maxItems: 256; uniqueItems: true |
| `profiles.*.agents (option 2).allowPatterns[]` | string | no | minLength: 1; maxLength: 256 |
| `profiles.*.agents (option 2).denyEmpty` | boolean | no | default: false |
| `profiles.*.agents (option 2).status` | integer | no | default: 403; minimum: 400; maximum: 599 |
| `profiles.*.agents (option 2).mode` | string | no | enum: ["enforce","report"]; default: "enforce" |
| `profiles.*.security` | one of the shapes below | no | — |
| `profiles.*.security (option 1)` | constant | no | const: false |
| `profiles.*.security (option 2)` | object | no | unknown keys rejected |
| `profiles.*.security (option 2).headers` | string | no | enum: ["oshp","oshp-no-csp","off"]; default: "oshp" |
| `profiles.*.security (option 2).set` | object | no | maxProperties: 32 |
| `profiles.*.security (option 2).set.*` | string | no | maxLength: 4096 |
| `profiles.*.security (option 2).unset` | array | no | maxItems: 32; uniqueItems: true |
| `profiles.*.security (option 2).unset[]` | string | no | minLength: 1; maxLength: 128 |
| `profiles.*.compression` | one of the shapes below | no | — |
| `profiles.*.compression (option 1)` | constant | no | const: false |
| `profiles.*.compression (option 2)` | object | no | unknown keys rejected |
| `profiles.*.compression (option 2).encodings` | array | no | default: ["br","gzip"]; minItems: 1; uniqueItems: true |
| `profiles.*.compression (option 2).encodings[]` | string | no | enum: ["br","gzip","deflate","zstd"] |
| `profiles.*.compression (option 2).minBytes` | integer | no | default: 1024; minimum: 0; maximum: 1048576 |
| `profiles.*.compression (option 2).types` | array | no | maxItems: 64; uniqueItems: true |
| `profiles.*.compression (option 2).types[]` | string | no | minLength: 1; maxLength: 128 |
| `profiles.*.compression (option 2).level` | integer | no | minimum: 1; maximum: 11 |
| `profiles.*.compression (option 2).allowWithSecrets` | boolean | no | default: false |
| `profiles.*.cache` | one of the shapes below | no | — |
| `profiles.*.cache (option 1)` | constant | no | const: false |
| `profiles.*.cache (option 2)` | object | no | unknown keys rejected |
| `profiles.*.cache (option 2).strategy` | string | no | enum: ["no-store","revalidate","public","immutable","swr","sie","micro","cdn-only","private"] |
| `profiles.*.cache (option 2).maxAge` | integer | no | minimum: 0; maximum: 31536000 |
| `profiles.*.cache (option 2).staleWhileRevalidate` | integer | no | minimum: 0; maximum: 31536000 |
| `profiles.*.cache (option 2).staleIfError` | integer | no | minimum: 0; maximum: 31536000 |
| `profiles.*.cache (option 2).cdnMaxAge` | integer | no | minimum: 0; maximum: 31536000 |
| `profiles.*.cache (option 2).originTtl` | integer | no | minimum: 0; maximum: 86400 |
| `profiles.*.cache (option 2).vary` | array | no | maxItems: 8; uniqueItems: true |
| `profiles.*.cache (option 2).vary[]` | string | no | minLength: 1; maxLength: 128 |
| `profiles.*.cache (option 2).statuses` | array | no | maxItems: 16; uniqueItems: true |
| `profiles.*.cache (option 2).statuses[]` | integer | no | minimum: 200; maximum: 599 |
| `profiles.*.cache (option 2).maxBytes` | integer | no | minimum: 0; maximum: 16777216 |
| `profiles.*.cache (option 2).maxEntries` | integer | no | minimum: 1; maximum: 1000000 |
| `profiles.*.cache (option 2).force` | boolean | no | default: false |
| `profiles.*.extensions` | one of the shapes below | no | — |
| `profiles.*.extensions (option 1)` | constant | no | const: false |
| `profiles.*.extensions (option 2)` | object | no | maxProperties: 16 |
| `profiles.*.extensions (option 2).*` | one of the shapes below | no | — |
| `profiles.*.extensions (option 2).* (option 1)` | constant | no | const: false |
| `profiles.*.extensions (option 2).* (option 2)` | object | no | — |
| `site` | object | no | unknown keys rejected |
| `site.robots` | object | no | unknown keys rejected |
| `site.robots.disallow` | array | no | maxItems: 1024; uniqueItems: true |
| `site.robots.disallow[]` | string | no | minLength: 1; maxLength: 2048 |
| `site.robots.allow` | array | no | maxItems: 1024; uniqueItems: true |
| `site.robots.allow[]` | string | no | minLength: 1; maxLength: 2048 |
| `site.robots.sitemap` | boolean | no | — |
| `site.robots.extra` | array | no | maxItems: 1024 |
| `site.robots.extra[]` | string | no | maxLength: 2048 |
| `site.sitemap` | one of the shapes below | no | — |
| `site.sitemap (option 1)` | constant | no | const: true |
| `site.sitemap (option 2)` | object | no | unknown keys rejected |
| `site.sitemap (option 2).exclude` | array | no | maxItems: 1024; uniqueItems: true |
| `site.sitemap (option 2).exclude[]` | string | no | minLength: 1; maxLength: 2048 |
| `site.sitemap (option 2).changefreq` | string | no | enum: ["always","hourly","daily","weekly","monthly","yearly","never"] |
| `site.sitemap (option 2).priority` | number | no | minimum: 0; maximum: 1 |
| `site.favicon` | string | no | minLength: 1; maxLength: 1024 |
| `site.securityTxt` | object | no | unknown keys rejected |
| `site.securityTxt.contact` | array | yes | minItems: 1; maxItems: 64 |
| `site.securityTxt.contact[]` | string | no | minLength: 1; maxLength: 2048 |
| `site.securityTxt.expires` | string | yes | pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$" |
| `site.securityTxt.policy` | array | no | maxItems: 64 |
| `site.securityTxt.policy[]` | string | no | maxLength: 2048; pattern: "^https://" |
| `site.securityTxt.acknowledgments` | array | no | maxItems: 64 |
| `site.securityTxt.acknowledgments[]` | string | no | maxLength: 2048; pattern: "^https://" |
| `site.securityTxt.preferredLanguages` | array | no | minItems: 1; maxItems: 64 |
| `site.securityTxt.preferredLanguages[]` | string | no | minLength: 2; maxLength: 35 |
| `site.securityTxt.canonical` | array | no | maxItems: 64 |
| `site.securityTxt.canonical[]` | string | no | maxLength: 2048; pattern: "^https://" |
| `site.securityTxt.encryption` | array | no | maxItems: 64 |
| `site.securityTxt.encryption[]` | string | no | minLength: 1; maxLength: 2048 |
| `site.llms` | string | no | minLength: 1; maxLength: 1024 |
| `extensions` | object | no | maxProperties: 16 |
| `extensions.*` | object | no | unknown keys rejected |
| `extensions.*.version` | constant | yes | const: "1" |
| `extensions.*.config` | object | yes | — |
