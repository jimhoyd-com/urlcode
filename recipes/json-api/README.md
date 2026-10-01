# JSON echo API

Run `urlcode validate --local --project .` and `urlcode serve --project .`.
POST JSON with `Content-Type: application/json` to `/echo`. The function returns
`{"received": ...}`. Other methods are refused with 405 and `Allow`; add
`errors: {format: json}` to the route when clients expect that refusal as a
JSON envelope ([error format][docs/HTTP.md#error-format]). Do not submit credentials to an
echo endpoint. This recipe grants no network or filesystem access.

<!-- urlcode-current-version:start -->
[docs/HTTP.md#error-format]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.6/docs/HTTP.md#error-format
<!-- urlcode-current-version:end -->
