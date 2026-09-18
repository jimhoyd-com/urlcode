# Acceptance: URL shortener

`requests.json` is run unchanged against both arms (see the redirect
service note for the mechanics). Registration is checked by its response
only: nothing is read back after a POST, because URLCode functions hold no
cross-request state and the benchmark measures the plumbing around a link
table, not a database.
