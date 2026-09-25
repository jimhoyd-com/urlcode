# Security boundary

`audit` is trusted operator code that runs in the host process. It is not a
sandbox or a multi-tenant boundary. Project configuration chooses only
`retention`; it cannot select the database file, a module or a secret. The
extension refuses to register without the operator-reviewed project revision
(`context.projectSha256`), like every other package under `packages/`.

## Delivery guarantee (normative)

Audit uses a **transactional outbox in each producer, drained by audit**.
A post-commit `record()` would lose the event on a crash between the change and
the audit write, and an audit handle inside a producer's own transaction cannot
be atomic across two SQLite files in WAL mode. Given a producer that follows the
contract in the [README](README.md#being-a-producer):

1. **Atomic capture.** A producer change commits if and only if its audit
   events are committed in the same storage transaction (auth: the same SQLite
   `BEGIN IMMEDIATE`; store: the same atomic file replace).
2. **Durable delivery, stored once.** Every captured event reaches
   `audit.sqlite` at least once. Ingest is `INSERT OR IGNORE` keyed on the
   producer-assigned event `id`, so it is stored exactly once. A crash at any
   point (after the producer commits, after ingest, or before the producer's
   ack) loses nothing and duplicates nothing. One exception: an event already
   pruned by retention could be stored again if its ack was lost. That needs
   about `retention` newer events between the ingest and the redelivery, and it
   is accepted.
3. **Fail closed on backlog.** Each producer caps its outbox (auth 10000
   events; store 1000 per collection; `auditOutboxLimits`). At the cap a new
   auditable change is refused with 503 `audit_backlog` and not applied. When
   audit is down, privileged actions stop; they never go unaudited.
4. **Bounded visibility lag.** When healthy, the lag is one drain round: a
   notify from the producer's commit, or a 1 s poll at worst. A reader that
   needs completeness, such as an admin export, calls `flush()` first. It
   resolves once every event pending at call time is stored, and fails with 503
   (`audit_flush_timeout` after 2000 ms, or `audit_unavailable` when a producer
   was stopped).
5. **Disclosures without a producer transaction.** An action that changes no
   producer data, such as an admin audit export, calls `await record([event])`
   before it releases anything. `record` resolves only after a durable commit
   (`synchronous=FULL`). If it rejects, the action answers 503 and releases
   nothing.

A producer that writes an invalid event or an event with another `source` has
broken the contract: audit stops draining it, reports it through
`onDeliveryError`, and acks nothing, so that producer fills its outbox and
fails closed rather than losing events.

## Retention and bounds

The log keeps the newest `retention` events (default 100000, 1000..10000000).
Each ingest transaction prunes the rest and reports the count through
`onPruned`; pruning is the only deletion, and the API has no update or delete.
Size is bounded by the event bounds: each event is at most about 7 KiB of text
(actor 256, subject 512, reason 1024 characters and 4096 bytes of metadata).
Batches and pages are at most 100 events and every query is indexed.

Retention is a capacity bound, not a legal retention policy: export what you
must keep before it ages out.

Retention is one count across every producer, so any producer's events can
age out another's, including auth's privileged events. A producer must not
record events that clients can cause without credentials: the store audits
only collections behind a principal-providing policy and never audits a
short-link click. Size `retention` for the busiest audited traffic.

## Storage

- One SQLite file, `<site>/data/audit.sqlite` by default, opened on the main
  thread with `journal_mode=WAL`, `synchronous=FULL`, `busy_timeout=2000`,
  `trusted_schema=OFF` and no extension loading. An fsync stalls the event loop
  for its duration; every statement is bounded, so this is accepted until
  measured otherwise.
- The file is created with mode 0600 (and `data/` with 0700 by default). A
  symlink, a hard-linked file, a file with any group or other permission bit, a
  database inside `app/` or a database of another application is refused.
- The host refuses an unpatched SQLite (older than 3.44.6, 3.50.7 or 3.51.3 in
  their lines), the same rule auth applies.

## What the log contains

Producers decide the content. The contract forbids secrets and submitted values
in `metadata` (field names only); `actor` and `subject` are identifiers. Auth
currently puts an email address in the `subject` of `registration.duplicate`
and `registration.invited`, so treat the log as personal data: keep `data/`
private and grant `audit.read`/`audit.export` only to roles that need them.
Audit enforces no permission itself; its readers (admin) check them.

## Backup

`urlcode-audit backup` takes a consistent online snapshot into a new private
file outside the project; `restore` writes only a new path. Back audit up after
auth, so undelivered events travel in auth's outbox.

Passing tests does not establish independent security assessment, hostile
multi-tenant readiness, production abuse resistance, or delivery guarantees
beyond the ones stated above. Report suspected vulnerabilities through the
repository's private reporting channel described in the root SECURITY.md.
