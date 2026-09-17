# Operator-granted egress example

This executable schema example uses reserved example destinations. Replace them
with HTTPS endpoints you own before attempting requests. No test or authoring
inspection needs network access.

Generate the requested permission document with the CLI `permissions` command,
review it and save it **outside this project**, then pass it with `--policy` when
starting the runtime. The generated hash pins these routes and function sources;
regenerate and review grants after changing declarations. Keep proxy and signal
origin grants separate. An origin grant authorizes the declared destination and
its explicit path/query/header behavior; it is not a guest fetch capability.

`GET /proxy/hello?page=2` proxies to the declared items endpoint. Incoming cookies,
Authorization and unlisted query values are not forwarded. `GET /event` returns
its native response and schedules a best-effort webhook with route pattern,
method and status only. HEAD and generated readiness probes do not emit signals.
There is no retry, queue or delivery guarantee.

See [egress contract](../../docs/EGRESS.md). Integration tests execute this example
with trusted fake transport and public-address fixtures, never by allowing private
network destinations in production.
