# @jimhoyd/urlcode-audit

## Unreleased

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
