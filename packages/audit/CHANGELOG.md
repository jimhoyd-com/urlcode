# @jimhoyd/urlcode-audit

## Unreleased

`urlcode-audit` input is decoded as strict UTF-8 and refuses a string or key holding an unpaired UTF-16 surrogate escape (`"\ud800"` alone), exiting 1 (#1021). Neither could be stored, but a `database`, `backup` or `destination` path holding one named a different file, with U+FFFD in its name.

The host lease's write check (`verify()`, core's `joinHostLease`) reads the lease table under the write lock on every write and no longer skips that read while the process's own clock says its last heartbeat is under 10 s old (#1010). A suspended VM's monotonic clock stops with it, so a holder paused just after a heartbeat could resume after another host took over and keep writing until its next heartbeat. The read costs about 2 µs per write.

The host lease (core's `joinHostLease`) never compares two hosts' clocks (#978): each renewal writes a larger `heartbeat_at`, and a process judges another host's row by whether it advances, timed on its own monotonic clock. A joiner watches another host's row for up to 20 s, refusing if it advances and deleting it if it stays silent, so a joiner whose clock runs ahead no longer evicts a live holder and a crashed host whose clock ran ahead blocks a restart for 20 s, not for the skew. Every heartbeat re-checks the table: a process that finds another host's row loses the lease, deletes its own row, logs it, does not re-insert it, and rejoins by itself once no other host holds one. A failed heartbeat is logged. Every ingest checks the lease inside its transaction, so a process that lost it stores nothing (`503 audit_unavailable`) and producers keep their events until it holds it again. A close that races a first activation's lease join releases the lease (#979).

The first activation joins a host lease, a new `audit_servers` table in `audit.sqlite` (heartbeat every 5 s, live 20 s), held until the audit host closes, and is refused while a live peer runs on another host (another Linux boot id, or another hostname when either has none), with or without the store (#941). `activate` is now asynchronous. The network filesystem check and the lease are core's (`refuseNetworkFilesystem`, `joinHostLease` in `@jimhoyd/urlcode/extensions`), so the audit package no longer exports its own `NETWORK_FILESYSTEMS`, `FilesystemProbe` or `refuseNetworkFilesystem`; `openAuditStore` and `createAudit` take a `probe` test seam.

In a hermetic run (`urlcode test`, `audit`, `benchmark`; `HostContext.hermetic`, #930) the audit log is a fresh database in the run's data directory, whatever `database` names.

Opening the audit database refuses a directory on a network filesystem by its Linux `statfs` type (NFS, SMB, SMB2, CIFS, FUSE, 9P, Ceph, AFS), the list the store refuses (#927); the check is skipped on macOS and Windows. `openAuditStore` takes an optional filesystem probe, a test seam.

The definition declares its deployment targets (node), which `npm run build:addons` writes into `urlcode.json` as `targets` (#859); core refuses a registration whose targets differ, and the capability preflight refuses a recipe or plan that uses this extension on any other target.

First release: the audit log leaves `@jimhoyd/urlcode-auth` and becomes its own
extension, `audit`, which auth requires. It serves no routes and shares
`AuditExports` (contract version 1): `validate`, `record`, `attach`, `flush` and
`query`, with `AuditError`, `validateAuditEvent`, `auditOutboxLimits` and
`auditPermissions` (`audit.read`, `audit.export`).

- Producers keep a transactional outbox and audit drains it (at-least-once,
  stored once on the event `id`, fail closed at the producer's cap with
  `503 audit_backlog`). The guarantee is in SECURITY.md.
- Events are `{id, source, action, actor, subject, at, reason?, metadata?}`
  with explicit bounds; `metadata` is structured JSON, where auth used to put
  JSON text in `reason`.
- Queries filter by source, actor, subject, action, action prefix and time, in
  either order, with a `next` cursor and the `oldest` retained `seq`.
- `config.retention` (default 100000) bounds the log; `onPruned` reports pruning.
- `urlcode-audit list|backup|restore` (bounded JSON on stdin; `list` is
  read-only; backup format `urlcode-audit-sqlite-v1`).
- There is no migration from auth's old `auth_audit` table: export anything
  you want to keep with the previous auth release before upgrading.
