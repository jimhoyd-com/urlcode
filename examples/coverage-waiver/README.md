# Audit coverage waiver

`urlcode audit --project .`, run in a copy made with `urlcode examples add coverage-waiver --out coverage-waiver`, reports `ready: true` although
`POST /notes` has no fixture, because the route declares `coveredElsewhere` for
that method with a reason. The pair is still listed under `waivedRouteMethods`.
A waiver is honored only when the route has another passing normal-response
fixture (here `GET`). See
[readiness][docs/READINESS.md#waive-a-method-covered-elsewhere].

<!-- x-release-please-start-version -->
[docs/READINESS.md#waive-a-method-covered-elsewhere]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/READINESS.md#waive-a-method-covered-elsewhere
<!-- x-release-please-end -->
