# Contact form to a signal

`POST /contact` takes a JSON object with `name`, `email` and `message` and
answers `202 {"accepted":true}`, then emits the declared signal to
`https://hooks.example.com/contact`. Replace that URL with an endpoint you own
before use.

There is no project code. `request.body.schema` holds the field rules (`name`
1-100 characters with at least one non-space, `email` shaped like an address
and at most 128 characters, `message` 10-4000 characters), and the runtime
answers 422 when a body breaks one of them, before `respond` builds the reply.
The 422 names the failing fields and never echoes what the client sent
([HTTP](../../docs/HTTP.md#body-schema-and-input-patterns) describes its
format). Edit the schema to change a rule; a `pattern` needs a `maxLength` of
at most 128 on the same field.

Signals are self-hosted egress and need a revision-pinned operator grant. The
policy file must live outside the project:

```sh
urlcode permissions --project . > /operator/contact-policy.json   # review it
urlcode validate --local --project . --policy /operator/contact-policy.json
urlcode test --project . --policy /operator/contact-policy.json
urlcode audit --project . --expect-routes 1 --policy /operator/contact-policy.json
```

Without the grant, activation refuses the project. Editing any file changes the
project hash, so regenerate and re-review the policy afterwards.

A signal carries a fixed payload (route, method, status), not the submitted
message, and is best effort: drops are counted, never retried. Test and audit
probes do not fire it. See [egress](../../docs/EGRESS.md).

This minimal recipe demonstrates declarative validation and a metadata-only
notification; it does not deliver or keep the message. Nothing downstream can
recover it either: request logs and events never carry a request body or field
value ([privacy guarantees](../../docs/OBSERVABILITY.md#privacy-guarantees)).
To act on what was submitted, use the declarative extensions instead of this
route:

- Delivery: a [forms](../../packages/forms/README.md) flow with
  [`notify`](../../packages/forms/README.md#notifications-notify) sends one
  plain-text email per valid submission through the
  [mail](../../packages/mail/README.md) extension, to a recipient the operator
  names in `host.mjs`.
- Persistence: [form-records](../../packages/form-records/README.md) saves a
  forms flow into an owned [store](../../packages/store/README.md) collection
  for a signed-in user.

Both are operator-installed (`urlcode extensions add forms`, `urlcode
extensions add form-records`) and take an HTML form's URL-encoded body rather
than this route's JSON.
