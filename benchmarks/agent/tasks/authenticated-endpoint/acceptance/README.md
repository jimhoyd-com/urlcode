# Acceptance: authenticated endpoint

`requests.json` is run unchanged against both arms. `API_TOKEN` comes from
the task's `environment` (a benchmark constant, not a secret): the
conventional server reads it from the process environment, the URLCode
project binds it with `{env: API_TOKEN}` and the harness grants exactly
what `urlcode permissions` requests.
