# Auth backup and restore platform guarantees

`createBackup({database,destination,projectRoot})` and
`restoreBackup({backup,destination,projectRoot})` use SQLite's online backup API
in a bounded worker. They include committed WAL pages, validate integrity and
foreign keys, and publish to a new path without overwriting an existing file.
Both source and destination must remain outside the served project. See the
[auth operator commands](../packages/auth/README.md#operations-and-recovery).

The completed snapshot is flushed through a writable file handle before it is
linked into its destination. Windows requires write access for this flush;
opening the snapshot read-only fails with `EPERM`. File flush errors fail the
operation rather than being ignored.

On POSIX systems the containing directory is also flushed after publication.
Node's filesystem API does not provide the equivalent directory-handle flush
used here on Windows, so Windows does not receive that extra directory-entry
crash-durability guarantee. A successful Windows backup verifies and flushes
file contents; it is not proof that the new filename survives abrupt power
loss. Verify the backup exists and perform an isolated restore rehearsal before
depending on it. CI does not simulate power loss.

POSIX directory/file modes are checked where supported. Windows operators must
restrict the operator data and backup directories with filesystem ACLs; POSIX
mode bits cannot establish Windows privacy. Keep encryption and CSRF keys and
reviewed configuration separately backed up. Restore to an isolated new path,
and review restored sessions and revocation state before reopening traffic.

## Audit and abuse data

Audit events wait in auth's outbox (inside `data/auth.sqlite`) until the audit
extension drains them, so back up the audit log **after** the auth database:
events not yet drained then travel in the auth backup, and nothing falls
between the two. `npx urlcode-audit backup` takes JSON
`{"database","destination","projectRoot"}` on stdin and uses the same online
backup rules; `restore` writes only a new path. See the
[audit package](../packages/audit/README.md#command-line).

`data/abuse.sqlite` holds only rate counters, so backing it up is optional.
Keep `data/abuse.key` private: the counters are keyed by an HMAC under it, and
losing the key only resets them. The mail outbox (`data/outbox/`, loopback
development only) holds messages, not state; nothing reads it back.

## Service start

A failed auth service initialization waits for its SQLite worker to terminate
before rejecting. After a configuration rejection, callers can retry or clean up
the database without racing that failed opener's file handle. Configuration
identity checks and their error codes are unchanged.
