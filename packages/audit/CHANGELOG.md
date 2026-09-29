# @jimhoyd/urlcode-audit

## Unreleased

The first activation joins a host lease, a new `audit_servers` table in `audit.sqlite` (heartbeat every 5 s, live 20 s), held until the audit host closes, and is refused while a live peer runs on another host (another Linux boot id, or another hostname when either has none), with or without the store (#941). `activate` is now asynchronous. The network filesystem check and the lease are core's (`refuseNetworkFilesystem`, `joinHostLease` in `@jimhoyd/urlcode/extensions`), so the audit package no longer exports its own `NETWORK_FILESYSTEMS`, `FilesystemProbe` or `refuseNetworkFilesystem`; `openAuditStore` and `createAudit` take a `probe` test seam.

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
