# Acceptance: CRUD backend

`requests.json` is run unchanged against both arms and never reads back
what it wrote: URLCode functions hold no cross-request state, and the
benchmark measures the plumbing around a resource, not a database. The
cases are ordered so that an in-memory conventional implementation and a
stateless one produce the same responses.
