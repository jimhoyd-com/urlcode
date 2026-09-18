# Dynamic links: Persistence, bounds, recovery and events

Part of [dynamic links](../DYNAMIC-LINKS.md), which indexes every page.

## Persistence, bounds and recovery

SQLite operations use separate reader and writer pools, outside the HTTP event
loop and function workers. Default: two read-only worker connections plus one
writer for writable stores; public serving opens readers only. Reads and writes
have independent 32-operation admission limits and 5-second deadlines including
waiting. Lock wait is one second. Excess work returns 503. Failed connections
are excluded from selection and readiness degrades; surviving readers can still
serve requests. Plain YAML redirects remain independent.

Startup and established-worker failures recover differently.

* **Startup failure.** A connection that never reports ready is terminated and its
  error is returned to the caller: `openLinkStore` rejects and activation fails
  closed. Nothing is retried behind the operator's back, so a `serve` or `links api`
  process that cannot open the store does not start, and a reload that cannot open
  it keeps the last-good runtime.
* **Established-worker failure.** A connection that had been serving and then
  errors, exits or misses an operation deadline is replaced automatically.
  In-flight operations on it reject with 503, the connection is marked unhealthy
  and excluded from selection, and a replacement worker is launched after an
  exponential backoff from 250 ms up to 30 seconds. Each attempt emits a
  `link_store_worker` event with `status: "restarting"`, the attempt number and the
  delay; a replacement that serves an operation resets the backoff, and one that
  starts but dies on every operation keeps backing off instead of spinning. Close
  cancels a pending replacement.

While a pool member is down the pool is degraded, not off: `readHealthy`,
`writeHealthy` and `healthy` report false and readiness degrades, but surviving
readers keep answering and a recovered writer resumes accepting mutations with no
operator action. Records live on disk, so a replaced connection loses no committed
data.

Restart the process when recovery cannot help: an unsuitable Node/SQLite build,
missing or invalid revision metadata, an incompatible schema, a store file that was
replaced, moved or symlinked under a running connection, or a host-level fault such
as a full or read-only disk. Those fail activation rather than reconnecting, and
the replacement worker will keep failing until the underlying cause is fixed.

Automatic connection recovery does not make writes idempotent. A mutation whose
reply was lost to a worker failure or deadline may still have committed, and the
records it touched carry versions that advance globally. Callers must therefore
re-read the record and decide again instead of blindly retrying a write; the
optimistic-version rules under *Update, disable, expire, list and delete* apply
unchanged. Recovery behavior is covered by the `acknowledged writes survive abrupt
writer exit and pagination retains records`, `a blocked writer does not occupy read
connections and recovers after lock release` and `stores with missing revision
metadata fail activation` cases in `test/links.test.ts`.

The initial store has a 100,000-record cap across collections and an 8,192-byte
normalized destination limit. WAL + FULL synchronous commits provide transactional
persistence subject to the disk/filesystem's guarantees. The format has an
application identifier and schema version; incompatible databases fail activation.
Use trusted local storage and a protected parent directory. Do not replace,
symlink or move an open database or its WAL/SHM files. The database and token must
be outside the project; keep them outside public directories, Git and artifacts.

An acknowledged mutation is committed. If a caller loses the response or receives
a timeout, the write may nevertheless have committed: inspect state before retry.
For retryable creation, choose a stable code and resolve conflicts; automatic
code generation cannot give exactly-once semantics after a lost response.

`links export` gives a consistent logical copy of the records while the store keeps
serving; it does not replace a file backup, which is what preserves the audit
journal and the exact record versions. For offline backups, stop management writers and all readers, then copy the
database together with any remaining WAL file as one consistent stopped set,
preserving their matching basenames. Restore into a separate private directory
while no connection is open. Do not discard a WAL just because the app stopped.
For online backups, use SQLite-aware tooling rather than copying only the live
main file. SQLite's [WAL documentation](https://www.sqlite.org/wal.html) explains why
committed state may still be in the WAL. Test restores on a separate closed store.
Restoring an older database also restores older record versions: discard old
management ETags and re-read records after restore. This is not a replication or
point-in-time recovery system. Define retention, RPO/RTO and disk limits yourself.

Multiple same-host processes can share the local file; a distributed deployment
needs another adapter. The trusted embedding API accepts
`linkStores: {links: adapter}` where `get(collection, code)` resolves to null or a
record with url/status/enabled/expires. The caller owns adapter shutdown and must
provide bounded operations, validation and consistency. Optional `healthy=false`
makes readiness fail. `openLinkStore` provides the built-in implementation plus
create/update/delete/list/exportSnapshot/close methods. Adapter code is operator code, never
loaded from route YAML. No remote provider adapter ships in this release.

## Opt-in completed-redirect events

Default request logs stay minimal: they carry status and timing, and with
`--request-log detailed` the method and the configured route pattern. They never
carry a short code or a request target. Counting store lookups is not a substitute
either, because a lookup cannot tell a completed redirect from a HEAD probe, an
error or a client that disconnected.

A trusted operator embedding the runtime can instead enable a post-response
observer. It is explicitly enabled in operator code, off by default, and there is no
`serve` flag and no YAML setting for it: route YAML cannot name a callback, and no
untrusted code is ever loaded as one.

```js
import {startServer} from '@jimhoyd/urlcode';

await startServer({
  project: './links',
  linkStore: {collection: 'links', file: '/absolute/links.sqlite'},
  linkEvents: {
    observe: event => collector.record(event),  // operator code, awaited off the request path
    includeCode: false,   // set true to disclose the short code to this collector
    maxQueue: 256,        // 1–4096 events; excess is dropped and counted
    timeoutMs: 1000,      // 1–10000 ms budget per observer call
  },
});
```

In TypeScript the collector's argument is `LinkEvent` and the option block is
`LinkObserverOptions`, both exported from `urlcode` beside `LinkStore`,
`LinkRow`, `LinkStoreOptions`, `LinkApi` and `LinkApiOptions`; the declarations
ship with the package:

```ts
import { startServer, type LinkEvent, type LinkObserverOptions } from '@jimhoyd/urlcode';

const linkEvents: LinkObserverOptions = {
  observe: (event: LinkEvent) => collector.record(event),  // event.code is null for an invalid code
  includeCode: false,
};
await startServer({ project: './links', linkStore: { collection: 'links', file: '/absolute/links.sqlite' }, linkEvents });
```

Each event is `{event: 'link_request', requestId, collection, route, method, status,
outcome, durationMs}`, plus `code` only when `includeCode` is true. `route` is the
configured route pattern, never the request target. Nothing else from the request is
included: no token, destination URL, query string, headers, body, cookie or client
IP address, and no stored record. Only stored-link routes produce events; a plain
YAML redirect never does. Disclosing a short code identifies a link, so treat a
collector that receives one as holding operational data and keep it off public logs.

| `outcome` | Meaning |
|---|---|
| `completed` | The redirect response finished. With `method: "GET"` this is the closest thing to a click; `HEAD` is a probe, not a click |
| `aborted` | A redirect was produced but the response never finished, because the peer disconnected |
| `missing` | No record for that code |
| `disabled` | The record exists but is disabled |
| `expired` | The record exists but its expiry has passed |
| `invalid_code` | The code failed route input validation |
| `invalid_record` | The stored record failed validation |
| `unavailable` | The store was unavailable or over its admission budget |

Nothing here is a human click count. Bots, prefetchers, proxies and repeat requests
all produce `completed` events, the runtime does not deduplicate, and browser and
proxy caches mean a real navigation may produce no request at all. Do the
interpretation in your own collector.

**The observer cannot affect a redirect.** Events are enqueued after the response
finishes or the connection closes, never before, so an observer cannot delay,
rewrite or fail a redirect. Delivery is sequential and bounded: at most `maxQueue`
events are held, each call gets `timeoutMs` and a slow or hung collector is
abandoned rather than allowed to pin the queue, and a call that throws is counted
instead of propagated. Drops and failures are counted, reported through
`link_observer` events on the normal log and readable at any time through
`app.linkEventStats()` as `{queued, delivered, dropped, failed, timedOut, closed}`.
An overloaded collector loses events, by design, instead of growing memory.

Shutdown closes the observer after the server's connections are gone, drains what
was already accepted within one bounded deadline, drops the rest and emits a final
`link_observer` event with `status: "closed"` and those totals. Events are
best-effort operational signals, not durable analytics or an audit record: the
durable, atomic record of mutations remains the store's audit journal.

Tests cover GET and HEAD, completed and aborted responses, missing, disabled and
expired records, default redaction and opt-in code disclosure, a failing collector,
a hung collector hitting its budget, queue overflow with counted drops, and drain on
shutdown.
