# JSON echo API

Run `urlcode validate --local --project .` and `urlcode serve --project .`.
POST JSON with `Content-Type: application/json` to `/echo`. The function returns
`{"received": ...}`. Other methods are refused. Do not submit credentials to an
echo endpoint. This recipe grants no network or filesystem access.
