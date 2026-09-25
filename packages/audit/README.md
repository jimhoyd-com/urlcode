# @jimhoyd/urlcode-audit

Durable, bounded audit log other extensions record privileged actions into.

`audit` serves no routes. It owns one SQLite file, `data/audit.sqlite`, and
shares `AuditExports` (contract version 1) with the extensions that read it
through `ctx.get('audit')`:

- **Producers** keep a transactional outbox of audit events next to their own
  data and let audit drain it: auth (always) and store collections that declare
  `audit: true`.
- **Direct recorders** call `record()` for an action that changes no producer
  data, such as an admin audit export, before they release anything.
- **Readers** call `query()`: admin's Audit screen and export, and
  `npx urlcode-audit list`.

The delivery guarantee is normative and lives in [SECURITY.md](SECURITY.md).
It is trusted operator code that runs in the host process, like every other
package under `packages/`. Released with core and installed with
`urlcode extensions add audit` (auth pulls it in, because auth requires it).

## Declare it

`urlcode extensions add audit` writes the configuration and no routes:

```yaml
version: "1"
extensions:
  audit:
    version: "1"
    config:
      retention: 100000   # newest events kept, 1000..10000000
```

A route with `extension: audit` is refused at activation ("audit serves no
routes"). There is no other project configuration: producers, readers and
permissions belong to the extensions that use audit.

## Host file

```js
// host.mjs (trusted operator code, outside the project)
import { composeHost } from '@jimhoyd/urlcode/host';
import audit from '@jimhoyd/urlcode-audit/extension';
export default await composeHost(import.meta.url, [audit()]);
```

`audit({...})` takes three optional operator choices:

| Option | Default | Meaning |
|---|---|---|
| `database` | `<site>/data/audit.sqlite` | Absolute path, outside `app/`. Created with mode 0600; a symlink, a hard-linked file or a file readable by group or others is refused. |
| `onPruned(removed)` | none | Called after a commit that pruned events past `retention`. Best effort. |
| `onDeliveryError(source, error)` | one line on stderr | Called when a drain round fails (it retries) or when audit stops draining a producer that broke the contract. |

Audit targets Node only (`node:sqlite`); other targets are refused before
serving. The SQLite linked into Node must carry the fixes auth also requires
(3.44.6, 3.50.7, 3.51.3 or newer).

## The exports

```ts
import type { AuditExports, AuditEvent } from '@jimhoyd/urlcode-audit';
const audit = ctx.get<AuditExports>('audit');   // in your host(); declare requires: ['audit'] or uses: ['audit']
```

| Member | Contract |
|---|---|
| `version` | `1`. |
| `active` | `true` once the runtime activated `extensions.audit`. `record`, `query` and `flush` refuse with `503 audit_inactive` until then. |
| `validate(value)` | Pure; the same function as the exported `validateAuditEvent`. Returns a frozen copy or throws `AuditError(400, 'invalid_audit_event')`. |
| `record(events)` | 1..100 valid events; resolves after a durable commit; idempotent on `id`. |
| `attach(producer)` | Registers an outbox; callable from `host()` before activation. A second producer with the same `source` throws. Returns `{notify(), close()}`. |
| `flush()` | Resolves once every event pending in an attached producer when it was called is stored; rejects `503 audit_flush_timeout` after 2000 ms, or `503 audit_unavailable` when a producer was stopped. |
| `query(filter?)` | One page, see below. |

An event is `{id, source, action, actor, subject, at, reason?, metadata?}`:

| Field | Bound |
|---|---|
| `id` | Lowercase UUID v4 the producer assigns (`crypto.randomUUID()`); the idempotency key. |
| `source` | The producing extension, `/^[a-z][a-z0-9-]{0,63}$/`. |
| `action` | `/^[a-z][a-z0-9_.-]{0,127}$/`, for example `session.login` or `store.record.created`. |
| `actor` | 1..256 characters, no C0 control or DEL: a principal id, `anonymous`, `operator` or `system`. |
| `subject` | 0..512 characters, no C0 control or DEL. |
| `at` | The producer's event time, epoch ms, a safe integer. |
| `reason` | Optional, 0..1024 characters, no C0 control or DEL; stored as `''` when absent. |
| `metadata` | Optional plain JSON object: depth at most 3, at most 16 keys per object, at most 4096 bytes serialized. Field names and counts, never secrets or submitted values. |

`AuditError` carries `status` (400 or 503) and `code`: `invalid_audit_event`,
`invalid_audit_query`, `audit_inactive`, `audit_unavailable`,
`audit_flush_timeout` or `audit_backlog`. Messages name a field, never a value.

`auditPermissions` is `['audit.read', 'audit.export']`: the conventional
permission names a consumer checks before it shows or exports audit data.
Audit itself enforces no permission; the API carries no authorization and has
no update or delete.

### Query

`query({source, actor, subject, action, actionPrefix, from, to, after, limit, order})`
matches every given filter:

- `actionPrefix: 'admin'` matches `admin` and every action starting `admin.`,
  but not `administrator` or `admin_x`.
- `from` and `to` are inclusive bounds on `at`.
- `limit` is 1..100 (default 50); a larger value is refused, not capped.
- `order` is `asc` (ingest order, default) or `desc` (newest first).
- The page is `{events, next?, oldest?}`. Each stored event adds `seq` (an
  opaque decimal ingest cursor), `recordedAt` and `metadata` (`null` when
  absent). Pass `next` back as `after` with the same filter and order for the
  next page. `oldest` is the lowest retained `seq` at query time, so a range
  exporter can tell when retention pruned events mid-export.

## Being a producer

A producer owns atomic capture; audit owns delivery.

1. Validate each event with `audit.validate()` (or `validateAuditEvent` where
   there is no exports object, such as a worker) **before** writing it, so no
   invalid event reaches the outbox.
2. Write the event into your outbox in the **same** transaction as the change it
   describes. At your cap (`auditOutboxLimits`: auth 10000 events, store 1000
   per collection) refuse the change with `new AuditError(503, 'audit_backlog')`
   or your own error with that status and code, and apply nothing.
3. Attach once from `host()`:
   `const attachment = audit.attach({source, peek, ack})`. `peek(limit)` returns
   at most `limit` events, oldest first, all with your `source`; `ack(ids)`
   deletes them and ignores unknown ids.
4. Call `attachment.notify()` after a commit that wrote outbox rows; without it
   the loop still polls every second.
5. In your host `close()`, call `await attachment.close()` before you release
   your storage. It waits for a batch in flight.

The loop peeks at most 100 events, validates them, stores them with
`INSERT OR IGNORE` on `id` in one transaction and only then acks them. A failed
peek, store or ack is reported and retried with backoff (100 ms doubling to
5 s); no event is skipped. An invalid event or a foreign `source` is a producer
bug: audit stops draining that producer and never acks it, so the outbox fills
and the producer fails closed; `flush()` then rejects `audit_unavailable`.

## Retention

Each store transaction deletes the events more than `retention` behind the
newest `seq`, and `onPruned` reports the count. Retention is the only deletion.

## Command line

`urlcode-audit` reads bounded JSON (at most 64 KiB) on stdin, never argv:

```sh
echo '{"database":"'"$PWD"'/data/audit.sqlite","query":{"order":"desc","limit":20}}' | npx urlcode-audit list
echo '{"database":"'"$PWD"'/data/audit.sqlite","destination":"/abs/backups/audit.sqlite","projectRoot":"'"$PWD"'/app"}' | npx urlcode-audit backup
echo '{"backup":"/abs/backups/audit.sqlite","destination":"/abs/restore/audit.sqlite","projectRoot":"'"$PWD"'/app"}' | npx urlcode-audit restore
```

- `list` opens the database read-only and prints one page (the `query`
  contract). It never creates or writes the database; SQLite may leave empty
  `-wal`/`-shm` files beside a WAL database it read.
- `backup` takes a consistent online snapshot (format `urlcode-audit-sqlite-v1`)
  to a new file in a private directory outside the project; an existing
  destination is refused.
- `restore` copies a backup to a new isolated path only. Stop the host, then
  move it into place yourself.

Back audit up **after** auth: events auth has not delivered yet are still in
auth's outbox, so they travel in the auth backup and are drained again, once,
after a restore.

Requires the matching `@jimhoyd/urlcode` core as a peer. Apache-2.0.
