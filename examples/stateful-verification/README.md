# Verify a handler that holds state

`urlcode.yaml` says which requests reach `functions/channel.mjs`. It cannot say
what that code must guarantee, so `urlcode audit` reports this project `ready`
on the fixtures alone. This example writes the guarantees down as checks, in the
two places they can live. Copy it with
`urlcode examples add stateful-verification --out stateful-verification`, then
from that directory:

```sh
urlcode test --project .               # tests/requests.json: one request at a time, in order
node --test tests/in-flight.test.mjs   # an ordinary test; needs @jimhoyd/urlcode installed
```

| Expectation (the application's own) | Where it is checked |
|---|---|
| The owner can revoke a credential when the event log is full by count, and by bytes | fixtures 2 and 3 |
| Revoking a credential ends the credentials derived from it; a derived credential cannot revoke its parent | fixture 4 |
| Channels, revocations and idempotency keys survive a restart; a replayed key publishes nothing | fixture 5 |
| Cancel and delete answer as declared | fixture 6 |
| A read pending at revocation ends refused and delivers nothing published afterwards | `in-flight.test.mjs` |
| Publishes sent together get distinct sequence numbers and stop at capacity; one key sent together publishes once | `in-flight.test.mjs` |
| Cleanup that fails after the delete answer is reported `failed`, never `done`, and can be repeated | `in-flight.test.mjs` |
| Cancelling a job ends the process it started and that process's own child | `in-flight.test.mjs` |

The job starts its tool process detached, as runners that launch tools commonly
do, so the tool outlives the job on every platform unless the handler ends it.
Without `detached`, Windows ends a Node process's children together with it and
the orphan would never appear there.

A fixture sends one request, waits for the answer and sends the next, so it
cannot hold a request open, send two at once, wait for work done after an
answer, break the data directory or look at a process. Those checks are an
ordinary `node:test` file against `startServer`; no fixture syntax exists for
them. See the [verification matrix][docs/READINESS.md#stateful-handler-verification].

`DEFECTS` in `urlcode.yaml` is `none`. Set it, in a copy, to one of
`capacity-rollback`, `derived-survives`, `late-wait`, `lost-update`,
`cleanup-silent` or `orphan-process` and the checks written for it fail while
the others keep passing: a check that cannot fail proves nothing, and an
application passes its build and its happy-path tests with such a defect in it.
`late-wait`, `lost-update`, `cleanup-silent` and `orphan-process` fail no
fixture at all. All data is synthetic.

<!-- urlcode-current-version:start -->
[docs/READINESS.md#stateful-handler-verification]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.6/docs/READINESS.md#stateful-handler-verification
<!-- urlcode-current-version:end -->
