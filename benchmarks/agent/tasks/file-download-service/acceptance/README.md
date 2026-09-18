# Acceptance: file and download service

`requests.json` is run unchanged against both arms. The file contents are
fixed by the task, so bodies, lengths and content ranges are compared
exactly. The ETag value is implementation-defined, so the 304 path is left
to each arm's own tests; the suite checks that an `ETag` header exists
only indirectly, through the range case.
