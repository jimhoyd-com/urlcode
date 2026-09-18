# Contact form to a signal

`POST /contact` takes a JSON object with `name`, `email` and `message`, answers
`202 {"accepted":true}` or `422` with field errors, and then emits the declared
signal to `https://hooks.example.com/contact`. Replace that URL with an endpoint
you own before use.

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
probes do not fire it. To deliver the message itself, put a store or mailer
behind the hook that reads the request log, or serve this route behind an
operator extension. See [egress](../../docs/EGRESS.md).
