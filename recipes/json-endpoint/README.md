# Declarative JSON endpoint

Run `urlcode validate --local --project .`, `urlcode test --project .` and
`urlcode audit --project . --expect-routes 2`.

Start here for a JSON endpoint whose answer does not depend on code. There are
no functions:

- `GET /api/status` answers fixed JSON declared with `respond.json`.
- `POST /api/signups` declares its fields in `request.body.schema`: `email`
  and `name` are required, `plan` must be `free` or `team`, and
  `additionalProperties: false` refuses anything else. The runtime answers 422
  when a body breaks a rule, 400 for malformed JSON and 415 for another content
  type, all before `respond` answers `202 {"accepted":true}`.

The 422 names the first failing field and never echoes what the client sent
([HTTP](../../docs/HTTP.md#body-schema-and-input-patterns) describes the
format). The schema is JSON Schema 2020-12 in a bounded profile: besides
`type`, `properties`, `required`, `additionalProperties`, `items`, scalar
`enum`/`const` and the length, count and number bounds, it takes local
`$defs`/`$ref`, type lists such as `[string, "null"]` and
`anyOf`/`oneOf`/`allOf`/`not`. A `pattern` needs `maxLength` of at most 128 on
the same field. Anything outside the profile, such as `format: email`, a remote
`$ref` or `if`/`then`, fails activation naming the keyword.

The runtime's own errors here are text lines by default (`Method not allowed`
for a POST to `/api/status`, `Unsupported media type`). When the API's clients
expect JSON errors, declare them instead of writing a function that repeats the
method check:

```yaml
site:
  errors:
    format: json
    paths: [/api/*]
```

Every runtime error under `/api` then answers
`{"error":{"code":"METHOD_NOT_ALLOWED","message":"Method not allowed"}}` (405,
`Allow` kept), `NOT_FOUND` for an undeclared path and so on, and the 422 moves
into the same envelope with its `issues`. A single route can use
`errors: {format: json}` instead. See [error format](../../docs/HTTP.md#error-format);
static hosting refuses it.

Because every route is native, the project activates on the self-hosted, AWS,
Vercel and Cloudflare targets. This endpoint accepts the sign-up but keeps
nothing: add a `signals` entry to notify a hook (see the `contact-form`
recipe), or mount the store extension to persist records (`store-crud`). Reach
for a `function` only for behavior YAML cannot express, such as the signature
check in `webhook-receiver`.
