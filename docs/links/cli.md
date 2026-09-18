# Dynamic links: CLI: create, update, export and restore

Part of [dynamic links](../DYNAMIC-LINKS.md), which indexes every page.

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
changed what. See [management security](../MANAGEMENT-SECURITY.md) for retention.

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
