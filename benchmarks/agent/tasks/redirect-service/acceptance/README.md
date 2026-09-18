# Acceptance: redirect service

`requests.json` is run unchanged against both arms. The URLCode arm runs it
as the project's `tests/requests.json` through `urlcode test`; the
conventional arm is started with the run's reported start command, `PORT`
set to a free port, and the same cases are sent to `127.0.0.1:$PORT` with
the same pass rule (status, expected headers and expected body must all
match). Redirect targets are literal; no network access is needed.
