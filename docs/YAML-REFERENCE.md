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
| `routes.*.function` | object | no | unknown keys rejected |
| `routes.*.function.source` | string | yes | maxLength: 1024 |
| `routes.*.function.export` | string | no | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" |
| `routes.*.function.args` | object | no | — |
| `routes.*.function.args.*` | one of the shapes below | no | — |
| `routes.*.function.args.* (option 1)` | string / number / boolean | no | — |
| `routes.*.function.args.* (option 2)` | object | no | unknown keys rejected |
| `routes.*.function.args.* (option 2).from` | string | yes | enum: ["path","query","header"] |
| `routes.*.function.args.* (option 2).name` | string | yes | — |
| `routes.*.function.args.* (option 3)` | object | no | unknown keys rejected |
| `routes.*.function.args.* (option 3).env` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" |
| `routes.*.function.args.* (option 4)` | object | no | unknown keys rejected |
| `routes.*.function.args.* (option 4).secret` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" |
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
| `routes.*.middleware[]` | object | no | unknown keys rejected |
| `routes.*.middleware[].source` | string | yes | maxLength: 1024 |
| `routes.*.middleware[].export` | string | no | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" |
| `routes.*.link` | object | no | unknown keys rejected |
| `routes.*.link.collection` | string | yes | pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" |
| `routes.*.link.code` | object | yes | unknown keys rejected |
| `routes.*.link.code.from` | constant | yes | const: "path" |
| `routes.*.link.code.name` | string | yes | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" |
| `includes` | array | no | maxItems: 256; uniqueItems: true |
| `includes[]` | string | no | maxLength: 1024 |
| `dynamicLinks` | boolean | no | default: false |
