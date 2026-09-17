# Permanent documentation redirect

Run `urlcode validate --local --project .` and `urlcode serve --project .`.
`/docs?campaign=launch&private=discarded` redirects to
`https://example.com/documentation?campaign=launch` with status 301.
Replace the example destination before deploying. Incoming query parameters are
not forwarded unless explicitly allowlisted.
