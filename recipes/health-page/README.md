# Health and status

Run `urlcode validate --local --project .`, `urlcode test --project .` and
`urlcode audit --project . --expect-routes 2`.

`/health` answers `ok` as text and `/status` answers a small JSON document. Both
are native `respond` routes with `Cache-Control: no-store`, so no project code runs
and every target supports them. Change `service` in `urlcode.yaml` to your
service name.

These routes report that the runtime is serving this revision; they do not
check databases or upstreams, because native routes run no code. Operators who
want process-level detail use the runtime's own metrics endpoint instead.
