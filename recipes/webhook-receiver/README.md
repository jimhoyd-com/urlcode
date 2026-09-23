# Webhook receiver

`POST /webhook` accepts at most 64 KiB of `application/json` from a sender that
signs each body with a shared key, and answers
`202 {"received":true,"event":...,"id":...}`.

Most of the checking is declared, so it happens before any code runs:

- the `X-Webhook-Event` and `X-Webhook-Signature` header parameters, with a
  `pattern` each (400 when missing or malformed);
- `request.body.schema`: an object with a string `id` (422 otherwise);
- the method (405), content type (415), size (413) and JSON syntax (400).

`functions/receive.mjs` does the one thing YAML cannot: it recomputes the
HMAC-SHA256 of the raw body with the granted key, using `node:crypto`, and
compares it in constant time (401 on a mismatch). The route runs trusted, the
default, and records why in `sandboxReason`: a `sandbox: true` route has no
crypto API, so it could not verify the signature. A third-party payload is
untrusted input, but untrusted input alone is not a reason to sandbox; the
header parameters and the body schema are what handle it (see
[AI authoring](../../docs/AI-AUTHORING.md)).

The key is a secret binding. The route declares
`secrets: {WEBHOOK_SECRET: {secret: WEBHOOK_SIGNING_SECRET}}`, an operator
grants that name in a revision-pinned policy kept outside the project, and the
process supplies the value. The bundled fixtures are signed with the key
`recipe-test-secret`:

```sh
urlcode permissions --project . > /operator/webhook-policy.json   # review it
WEBHOOK_SIGNING_SECRET=recipe-test-secret urlcode test --project . --policy /operator/webhook-policy.json
WEBHOOK_SIGNING_SECRET=recipe-test-secret urlcode audit --project . --expect-routes 1 --policy /operator/webhook-policy.json
```

Without the grant or the value, activation refuses the project. Editing any
file changes the project hash, so regenerate and re-review the policy. Use a
real key from your sender in production and re-sign the fixtures with it, or
keep a separate test key.

Adapt the signature check to your sender: the header name, the encoding and
what is signed differ between providers. This recipe does not reject replays;
if the sender signs a timestamp, verify it and refuse old events.
Keep the body limit as small as the sender allows.
