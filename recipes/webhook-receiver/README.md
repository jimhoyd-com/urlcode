# Webhook receiver

Run `urlcode validate --local --project .`, `urlcode test --project .` and
`urlcode audit --project . --expect-routes 1`.

`POST /webhook` accepts at most 64 KiB of `application/json`. The runtime
rejects other methods (405), other content types (415), oversized bodies (413)
and malformed JSON (400) before the sandbox runs. The route declares
`sandbox: true`: functions/middleware run trusted by default, but a
third-party sender's payload is exactly the input a project doesn't fully
trust, so this recipe isolates parsing it (docs/FUNCTION-SECURITY.md). The
function then requires an
`X-Webhook-Event` header and a JSON object carrying a string `id`, and answers
`202 {"received":true,...}`.

This recipe verifies shape, not origin. Nothing here checks a signature: the
guest has no crypto API and no network access, so signed webhooks belong behind
an operator-installed extension or a trusted host in front of this route. Edit
`functions/receive.mjs` to check the fields your sender guarantees, and keep
the body limit as small as the sender allows.
