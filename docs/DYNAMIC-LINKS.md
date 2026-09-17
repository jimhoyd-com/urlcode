# Dynamic short links without reloads

## Node build requirement

Live links need a Node build carrying the patched SQLite WAL fix: SQLite 3.51.3
or newer, 3.50.7 or 3.44.6. Node bundles SQLite, so this is a property of the
build, not something you can install separately, and some current releases on a
supported Node line ship an unpatched version. Run `urlcode doctor` and check
`liveLinks`; activation fails closed and names the detected version when the
build is unsuitable. Everything except live links works on any supported Node.

Available in URLCode 0.1.0. Define a stable route once; create, update and delete
short-code records while `serve` keeps running. No YAML rewrite, route snapshot
rebuild, Git commit or public-server restart is needed for record changes.

This first adapter uses optional SQLite storage on one host. Multiple processes
on that host can share it. No database is required for ordinary YAML-defined
routes. Network filesystems, multi-host replication and serverless ephemeral disks
are not supported by this adapter. SQLite WAL requires processes on the same
host; see [SQLite WAL](https://www.sqlite.org/wal.html).

## Behavior in YAML, data outside Git

```yaml
version: "1"
dynamicLinks: true
routes:
  /r/{code}:
    parameters:
      - name: code
        in: path
        required: true
        schema: {type: string, minLength: 1, maxLength: 128}
    link:
      collection: links
      code: {from: path, name: code}
```

`link` is a seventh primary handler, exclusive with `function`, `redirect`,
`respond`, `page`, `static` and `download`. Its `code` is a declared path-input
reference. `collection` is a logical name, not a filesystem path. GET and HEAD
are supported; normal route precedence, lifecycle and input validation apply.
An exact YAML route can intentionally shadow a stored code's URL.

The operator binds `links` to a database outside the project. YAML cannot choose
a database file or grant itself storage. The built-in public binding opens it
read-only. It performs an indexed database lookup for each request, with no
application cache or negative cache. Requests starting after an acknowledged
mutation can see it immediately; an already-running request can finish with an
older result. Browser/proxy caches remain outside that guarantee.

Missing or disabled record: 404. Expired record: 410. Unavailable/overloaded
store: 503. Invalid code syntax: 404 after route input validation. Redirects
default to 302 and no-store. Query strings are not forwarded. A record's URL is
literal HTTP(S), with no embedded credentials, control characters or interpolation.
It is a redirect, not a server-side fetch. The store does not verify destination
ownership, safety or availability; application abuse prevention remains necessary.

## Run the included example

From the runtime checkout, choose a private data directory **outside the app**.
Its parent directory must already exist. The following POSIX-shell example uses
an operator-created directory; on Windows use an absolute local drive path.

```sh
mkdir -p ../urlcode-data
URLCODE_DATA="$(cd ../urlcode-data && pwd)"
node src/cli.js links init --store "$URLCODE_DATA/links.sqlite"
node src/cli.js links create --store "$URLCODE_DATA/links.sqlite" \
  --code demo --destination https://example.com/demo
node src/cli.js serve --project examples/live-links \
  --link-store "links=$URLCODE_DATA/links.sqlite" --port 3000
```

Open `/r/demo`. In a second terminal, run another `links create` with an unused
code against the same absolute file; its URL works immediately. Omit `--code`
to generate a cryptographically random 16-character base64url code. Codes allow
1–128 letters, digits, underscores and hyphens; collection names begin with a
letter and contain at most 64 letters/digits/underscores/hyphens.

The CLI defaults to collection `links`; specify `--collection` to manage another.
Serving currently accepts one `--link-store collection=/absolute/file` binding;
embedded applications may supply multiple adapters. Commands do not copy records
into YAML or create route definitions automatically.

## Update, disable, expire, list and delete

```sh
urlcode links get --store /absolute/links.sqlite --code demo
urlcode links list --store /absolute/links.sqlite --limit 100
urlcode links list --store /absolute/links.sqlite --limit 100 --after last-code
urlcode links update --store /absolute/links.sqlite --code demo \
  --if-version 1 --destination https://example.com/new --enabled false
urlcode links delete --store /absolute/links.sqlite --code demo --if-version 2
```

Replace illustrative versions with the actual returned `version`. Update is a
**full replacement**: omitted status becomes 302, enabled becomes true, and expiry
becomes null. Use `--status 307` or `--expires 2030-01-01T00:00:00Z` as needed.
Allowed status codes match ordinary redirects. Disabled/expired records remain
stored and reserve the code until explicitly deleted.

Create is insert-only: an existing code returns conflict, never an overwrite.
Updates/deletes require a matching positive version. Every mutation uses a
transaction; revisions advance globally within that database, including deletion,
so a stale edit cannot silently affect a deleted-and-recreated code. Competing
writers receive a conflict. Read the latest record before making a new decision;
do not blindly retry a stale update. Listing is ordered by code, at most 100 per
page, within one collection. Pagination is not a snapshot across concurrent writes.

CLI commands print record data intentionally; treat output as operational data.
Do not store secrets in destinations or capture output into public logs.
`urlcode add` remains the separate command for adding a Git/YAML-defined redirect.

## Consistent operator export and restore

Listing pages one after another is not a snapshot: inserts, updates and deletes
between pages can produce a logically inconsistent copy. `links export` instead
holds one SQLite read transaction for the whole export, so every record it writes
comes from a single point in time.

```sh
umask 077
urlcode links export --store /absolute/links.sqlite > /absolute/backups/links-export.ndjson
urlcode links import --store /absolute/restored.sqlite --input /absolute/backups/links-export.ndjson
```

Export is an operator command on the operator's own database. It is not reachable
from the public redirect server, from route YAML, from guest function code or from
the management HTTP API, and it grants guest code no storage capability. The
output is operational data: write it somewhere only operators can read, keep it out
of the project, Git and build artifacts, and treat it like the database itself.

**Consistency contract.** The export reflects the database exactly as of the moment
the snapshot is pinned, which is the first read after the transaction opens. Writers
are never blocked and keep committing; none of their later commits appear in the
export, and no record appears twice or is skipped. The header line carries
`format`, `schemaVersion`, `applicationId`, the store `revision` at that instant and
`generatedAt`, so a restored copy can be identified and ordered against others. This
is a consistent logical copy, not a point-in-time recovery system: it has no
continuous log and cannot reconstruct a moment between two exports.

**Contents.** Every record in the store, or in one `--collection`, including
enabled, disabled and expired records, with `collection`, `code`, `url`, `status`,
`enabled`, `expires` and `version`. Disabled and expired records are exported
because they still reserve their codes. The output is NDJSON: a
`link-export-begin` header line, one `{"record": {...}}` line per record ordered by
collection and code, and a `link-export-complete` line carrying the record count
and a SHA-256 digest over every preceding line. A stream without that final line is
truncated, and `links import` rejects it.

**Restore semantics.** `links import` replays the records into the target store and
refuses to touch a collection that already holds records, so a restore never
overwrites live data. It verifies the format, schema version, store identity, record
count and digest before it commits the last record. Codes, destinations, statuses,
enabled flags and expiries are restored exactly. **Versions are not.** The target
assigns its own revisions, which is why the report sets `versionsReassigned: true`:
management ETags taken against the exported database are stale after a restore, so
discard them and re-read records before the next conditional write, exactly as after
restoring an older database file.

**Audit journal.** The export carries records only. The mutation audit journal stays
in the source database and is not part of an export, so a store restored from one
starts a fresh journal covering only mutations made after the restore. Keep the
journal by backing up the database file itself, as described under *Persistence,
bounds and recovery*; that file backup, not the export, is the archival copy of who
changed what. See [management security](MANAGEMENT-SECURITY.md) for retention.

**Bounds.** One export runs at a time per store and a second is rejected with 409.
It pins exactly one reader connection and holds that reader's admission for its whole
life, so it can never exceed the pool's read budget or starve redirects of every
reader — run it against a management store or size `--link-readers` accordingly.
Pages are at most 100 records (`--page-size`), each page carries the usual
five-second operation deadline, and the export as a whole has a 60-second default
deadline after which it fails and releases the reader. A consumer that fails or a
process that stops ends the read transaction rather than leaving it open. Because
the transaction pins a WAL read mark, a long export delays WAL checkpointing: keep
exports short and do not leave one running against a busy store.

Embedders call the same mechanism directly:

```js
await store.exportSnapshot({collection: 'links', pageSize: 100, deadlineMs: 60000}, {
  onHeader: header => sink.write(header),
  onRecords: records => sink.write(records),
});
```

`onRecords` is awaited, so a slow sink applies backpressure to the export instead of
buffering the store in memory; anything it throws aborts the export and releases the
reader. `stats()` reports `exporting` while one is in flight.

## A separate authenticated management API

For a web product, your trusted backend calls the management API after applying
its own user authentication, authorization, quotas and abuse rules. The API is an
operator interface, not a public anonymous link-creation endpoint. Never put its
shared token in browser JavaScript. It is not available on the public route server.

Generate a private token file outside the application (POSIX-compatible Node example):

```sh
node --input-type=module -e 'import {writeFileSync} from "node:fs"; import {randomBytes} from "node:crypto"; writeFileSync(process.argv[1],randomBytes(32).toString("base64url"),{mode:0o600,flag:"wx"})' /absolute/link-admin.token
urlcode links api --store /absolute/links.sqlite --collection links \
  --token-file /absolute/link-admin.token --host 127.0.0.1 --port 3001
```

Use a securely generated token, at least 43 base64url characters. File permissions
must exclude group/other access on POSIX; protect Windows files with operator ACLs.
The API reads the token at startup; rotate by replacing it and restarting this
management process. This does not require restarting public resolution.

Every request needs `Authorization: Bearer <token>`. Authenticate before body
processing. Use application/json for POST/PUT, with no compression; max body is
16 KiB. Browser Origin-bearing requests are rejected. No CORS, cookies, user
accounts, per-user scopes, JWT system or automatic rate limiter is provided.
Keep it on a private network/loopback behind authenticated TLS ingress as needed.
If changing `--host`, protect it before exposing it; no built-in HTTPS exists.

| Request | Result |
|---|---|
| `POST /v1/links` with `{ "code": "demo", "url": "https://example.com/demo" }` | 201 with record and ETag; code optional |
| `GET /v1/links/demo` | 200 with record and ETag, or 404 |
| `GET /v1/links?limit=100&after=demo` | `{items, nextAfter}`; nextAfter null on a short page |
| `PUT /v1/links/demo`, `If-Match: "VERSION"`, complete record fields | Replace and return new record/ETag |
| `DELETE /v1/links/demo`, `If-Match: "VERSION"` | 204 |

POST accepts optional `code` plus `url`, optional `status`, `enabled`, `expires`.
PUT accepts the same record fields except code, which is immutable. `expires`
may be null. Responses include collection, code, url, status, enabled, expires,
version. Missing precondition: 428; stale version or duplicate code: 409;
invalid input: 400; authentication failure: 401; unsupported media: 415;
record limit: 507; store failure/capacity: 503. Error messages omit credentials,
submitted URLs and SQL details. A full page can return a cursor even when the
next page will be empty. No bulk mutation API is implemented, and the management
API exposes no export: sequential list pages are not a snapshot, so use the
operator `links export` command above for a consistent copy.

A token authorizes its configured collection, not all collections. There are no
per-end-user permissions: those belong to your backend. The API can also list
inactive records for management. The public `/r/{code}` route never exposes
management JSON, token files or a mutation endpoint.

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
metadata fail activation` cases in `test/links.test.js`.

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

## Middleware, sandbox and tests

Middleware may wrap a successful link response; the usual native metadata/body
rules apply. Lookup/missing/disabled/expiry errors happen before middleware. The
handler does not make database objects available to guest code. Functions still
have no filesystem, SQL, fetch, storage broker or management token capability.
Link changes do not alter configuration/source digests or invalidate unrelated
function-binding grants. Changing YAML still does.

`routes` and `audit --expect-routes` count definitions, not stored records. Link
routes require explicit successful GET/HEAD fixtures; there is no assumed fixture
for live data. Seed a disposable test database, then pass `--link-store` to
validate/test/audit/benchmark. Do not run mutation tests against production.

```sh
node src/cli.js test --project examples/live-links --link-store links=/absolute/test-links.sqlite
node src/cli.js audit --project examples/live-links --link-store links=/absolute/test-links.sqlite --expect-routes 2
```

The example expects `demo -> https://example.com/demo` and an unused `not-created`
code. Tests cover create/update/delete visibility without reload, persistence,
concurrent conflicts, expiry/disabled semantics, scope, public/admin separation,
body/token boundaries, overload and acknowledged writes after abrupt writer exit.
Production durability, sustained load and recovery drills still require validation
on your actual storage. General application state, WebRTC sessions, user-account
APIs and arbitrary runtime code registration remain separate future work.

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
import {startServer} from 'urlcode';

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

## Shutdown and management defaults

`links api` defaults to private address `127.0.0.1:3001`; public serving defaults
to port 3000. Endpoint method errors return 405 with an `Allow` header.
Store shutdown rejects new work, drains accepted operations within each connection and
then closes SQLite. Repeated `close()` calls share completion. Existing operation
deadlines still apply: a timeout can leave a mutation outcome unknown, so read
the record before retrying. Missing/invalid revision metadata rejects startup.

## Explicit project opt-in

Only the entry `urlcode.yaml` may set `dynamicLinks: true`. It defaults to false;
the starter writes `dynamicLinks: false` explicitly. Included route files cannot
set or override it. Any `link` handler, including a disabled route, or runtime
link-store binding requires the opt-in. This flag means live stored-link records,
not parameterized redirects, custom functions, middleware or development reload.

`validate`, `routes`, `audit` and `scaffold` reports expose `dynamicLinks` as a
boolean. Enabling it grants no storage access to guest code and starts no
management endpoint. The operator still supplies the external store binding;
management remains a separate authenticated service. Standalone `links` CRUD/API
commands operate the operator's store independently of this public-runtime flag.

Migration: existing live-link projects must add `dynamicLinks: true` to their
entry file. Refresh revision-pinned function policies for those projects using
the normal operator review flow; enabling the capability changes the approval
digest. Projects that omit it or explicitly set false retain their prior digest.
To disable, remove `link` declarations and serving-store bindings, then set false
and validate/redeploy. Editing the flag alone does not stop an already running
production process or management API. Invalid reloads retain the last-good state.

## Separate reader and writer pools

Pool sizes are operator infrastructure settings, not portable behavior YAML.
`dynamicLinks: true` and logical collection names stay the same across targets.

```sh
urlcode serve --project ./my-links \
  --link-store links=/absolute/links.sqlite \
  --link-readers 4 --link-read-limit 32

urlcode links api --project ./my-links \
  --store /absolute/links.sqlite --token-file /absolute/link-admin.token \
  --link-readers 2 --link-read-limit 16 --link-write-limit 8
```

| Control | Default | Meaning |
|---|---|---|
| `--link-readers` / JS `readers` | 2 | 1–8 read-only connections per store instance |
| `--link-read-limit` / JS `maxReads` | 32 | 1–32 admitted reads across all readers, not per reader |
| `--link-write-limit` / JS `maxWrites` | 32 | 1–32 admitted mutations across the single writer |

`get` and `list` use the least-busy healthy reader. `create`, `update` and `delete`
use the writer. Each worker serializes its own accepted operations. There is no
additional unbounded acquisition queue. A read flood cannot take writer admission
and a mutation backlog cannot take reader admission. CPU, disk, database locks
and the event loop remain shared resources: separation is not an isolation SLA.
A write response resolves after commit; a subsequent awaited read sees committed
data on the same database. Reads started before the commit may see the old value.
There is no replica lag or application cache in this adapter.

`openLinkStore({file, project, readOnly, readers, maxReads, maxWrites})` exposes
`stats()` with separate read/write connection counts, healthy counts, in-flight
counts, limits, completed/failed/rejected totals and cumulative durationMs. These
process-local counters reset at restart and are for trusted operator monitoring;
there is no public metrics endpoint/exporter yet. `readHealthy` and `writeHealthy`
are separate. Public runtime readiness uses `readHealthy` when available; management
operators must monitor writer health separately. A read-only pool has zero writers
and rejects mutations. Shutdown drains both groups and rejects new admission.

Do not multiply connection counts blindly across processes: N public replicas at
R readers use N×R connections, plus management readers/writers. Each connection
has its own worker and memory budget. Measure mixed load and lock contention;
adding readers can reduce performance on an already saturated disk.

SQLite WAL supports simultaneous readers and a single active writer across the
database. Multiple writer connections cannot create parallel write throughput.
All connections must access the same local database on one host; never mount it
across hosts over a network filesystem. See [SQLite WAL](https://www.sqlite.org/wal.html).
We require a Node build with SQLite 3.51.3+ or patched branches 3.50.7+/3.44.6+
to avoid the documented [WAL-reset concurrency bug](https://www.sqlite.org/wal.html#the_wal_reset_bug).
Live-link initialization checks this before opening files and verifies WAL mode.
Use `urlcode doctor` to inspect the bundled SQLite version; upgrade Node when
rejected. Static YAML projects do not require SQLite.

For multi-host scaling, a future server-database adapter must provide distinct
read/write credentials and pool budgets, connect/acquire/query deadlines,
transactional version checks, primary-read or explicit replica consistency,
replica-lag monitoring, migration coordination, backup/restore and failover drills.
These are adapter acceptance requirements, not implemented PostgreSQL support.
Keep writes on the primary and avoid automatic retries of ambiguous commits.
The existing operator adapter boundary remains available, but deploying a custom
adapter requires its own conformance/load/recovery evidence.

## Management HTTP and audit safeguards

The private API admits up to 32 in-flight HTTP requests through response finish
or disconnect, returning 503 on overload. A 10-second socket inactivity timeout
closes stalled peers; this is not a total response deadline. The embedding API
accepts `maxInFlightRequests` (1–64) and `socketTimeoutMs` (100–60,000). Existing
connection/body/header and database admission limits still apply. Noncanonical
dot-segment/backslash path normalization is rejected.

JSON `management_request` events go to stdout by default and include timestamp,
request ID, collection, action, authentication result, status and finish/abort
outcome. No token, code, destination, URL, headers or body is logged. Embedders
can supply `log(event)`; failed sinks cannot crash request handling. These are
best-effort operational events, not durable per-actor audit records. Aborted
mutations may have committed: re-read state before retrying. See the
[security review](SECURITY-AUDIT.md) for remaining controls.

## Management hardening baseline

Management is now restricted to literal loopback addresses. Prefer `--auth-file`
for individual expiring, revocable credentials with collection/action scopes.
Every successful built-in store mutation has an atomic, durable SQLite audit row;
HTTP request logs remain best effort. See [management security](MANAGEMENT-SECURITY.md)
for policy examples, compatibility, archival and rollback requirements, and
[operational proof](OPERATIONAL-PROOF.md) for executable recovery drills.
