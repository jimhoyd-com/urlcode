# Acceptance: admin backend

`requests.json` is run unchanged against both arms. The credentials are
the task's `environment` (benchmark constants, not secrets), encoded as
`admin:benchmark-admin-password`. The conventional server reads them from
the process environment; the URLCode project binds them with `{env: ...}`
and the harness grants what `urlcode permissions` requests. The dashboard
body is not compared, only its status and content type.
