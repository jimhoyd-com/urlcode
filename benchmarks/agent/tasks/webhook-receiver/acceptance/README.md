# Acceptance: webhook receiver

`requests.json` is run unchanged against both arms. Both arms receive
`WEBHOOK_TOKEN` from the task's `environment`; the conventional server
reads it from its process environment, the URLCode project binds it with
`{env: WEBHOOK_TOKEN}` and the harness, playing the operator, grants exactly
what `urlcode permissions` requests. The value is a benchmark constant, not
a secret.
