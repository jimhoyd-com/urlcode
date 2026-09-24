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

The 422 names the failing fields and never echoes what the client sent
([HTTP](../../docs/HTTP.md#body-schema-and-input-patterns) describes the
format). The schema accepts a subset of JSON Schema: `type`, `properties`,
`required`, `additionalProperties` (true or false), `items`, scalar `enum`,
`minLength`/`maxLength`, `pattern` (with `maxLength` of at most 128 on the same
field), `format: uuid`, `minimum`/`maximum` and `minItems`/`maxItems`. Anything
else, such as `format: email`, `$ref` or `oneOf`, fails activation.

Because every route is native, the project activates on the self-hosted, AWS,
Vercel and Cloudflare targets. This endpoint accepts the sign-up but keeps
nothing: add a `signals` entry to notify a hook (see the `contact-form`
recipe), or mount the store extension to persist records (`store-crud`). Reach
for a `function` only for behavior YAML cannot express, such as the signature
check in `webhook-receiver`.
