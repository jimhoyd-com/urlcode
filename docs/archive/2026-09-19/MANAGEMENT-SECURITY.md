# Historical record

Archived 2026-09-19. This records an earlier implementation or proposal, not
current instructions. See the [current roadmap](../../../ROADMAP.md),
[current contract](../../SPECIFICATION.md) and [open decisions](../../OPEN-DECISIONS.md).
Remaining acceptance work is not declared complete by archiving this record.

<!-- trust-model-prose: historical-file -->
<!-- guidance-claims: ignore-file -->

# Private management and durable mutation audit

> **Retired.** This page describes the management API and mutation audit of
> core's native link store. That store, its `urlcode links` CLI and this
> management listener were removed from core when `link` was extracted, and the
> `urlcode-dynamic-link` package that received them has since been retired and
> unpublished. Nothing in the current runtime exposes this surface. The page is
> kept because the security reasoning — loopback-only binding, operator-owned
> credential policy, transactional mutation audit — is referenced by
> the then-current internal security audit and applies to any component that
> reintroduces a management listener.

Management binds only `127.0.0.1` or `::1`. Use an authenticated private tunnel
(e.g. SSH/VPN with loopback forwarding); never publish its port through a public
proxy or container port mapping. This is operator management, not an end-user
account service. Browser Origin requests remain rejected.

## Individual credentials

Use `urlcode links api --project ./my-links --store /operator/links.sqlite
--auth-file /operator/management.json --host 127.0.0.1 --port 3001` (one line).
The policy is operator-owned, outside the application, at most 64 KiB and mode
600 on POSIX. Protect its parent directory and apply equivalent Windows ACLs.
It is not YAML and must never be placed in the application or Git.

Generate each token with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`
on a trusted operator machine. Deliver it through your secret manager. Hash the
raw token using SHA-256 without a newline; the server expects `Authorization:
Bearer <token>`. Tokens must contain 43–256 base64url characters. Never use a
human password as a token. This synthetic policy illustrates the shape; replace
the hash with the real token hash and choose a short operational expiry:

```json
{
  "version": 1,
  "credentials": [{
    "id": "operator-alice",
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
    "expires": "2026-10-01T00:00:00Z",
    "collections": ["links"],
    "actions": ["get", "list", "create", "update", "delete"]
  }]
}
```

At most 128 credentials; unique IDs and hashes; explicit collection and action
allowlists with no wildcards. Readers should receive only `get` and `list`.
An expired, removed or `"revoked": true` credential gets 401; a valid credential
outside its scope gets 403. The entire policy is validated on every authenticated
request. Malformed/unreadable policy fails closed with 503, without retaining an
old permissive copy. Write a replacement file with mode 600 and atomically rename
it over the policy. No restart is needed. Requests already authorized may finish;
revocation does not cancel an in-flight transaction. Credential administration is
an operator filesystem action, never exposed through this HTTP API.

Legacy `--token-file` remains available for local compatibility, with full access
to that listener's collection and actor `legacy-shared`. Prefer `--auth-file` for
attribution, expiry and revocation. They are mutually exclusive. These bearer
credentials do not establish verified human identity, MFA, SSO or session login.
Host administrators and custom embedding code remain trusted operators.

## Audit durability and recovery

The built-in SQLite writer creates an additive `urlcode_link_audit` table when
opening a store. Every successful create/update/delete (including CLI and embedded
store calls) records revision, UTC timestamp, actor, request ID, collection,
action and SHA-256 of the short code in the **same transaction** as the mutation.
The default local CLI actor is `local-operator`. Scoped HTTP management requires
an adapter explicitly declaring atomic audit support; the built-in store provides it.

An audit insert failure rolls back both mutation and revision. Conditional-write
conflicts and rejected requests produce no successful-mutation row. HTTP request
logs still describe failed/aborted requests and remain best effort. A client timeout
may follow a committed transaction: reconcile the revision and request ID before
retrying. A lost HTTP reply is not evidence that the transaction was rolled back.

Inspect the journal with an operator-only SQLite client, for example:

```sql
SELECT revision, timestamp, actor, request_id, collection, action, code_sha256
FROM urlcode_link_audit WHERE revision > 0 ORDER BY revision LIMIT 100;
```

No token, URL, request body or raw short code is stored in the journal. Code hashes
are correlatable and guessable for short codes; restrict access accordingly.
This is a durable local transaction journal, **not tamper-evident external storage**.
An administrator with database access can change it. Export ordered revisions to
your protected collector/backup system and monitor lag, gaps and disk/WAL growth.
There is no automatic pruning: define retention and verify archival before any
operator purge. Keep audit records in backups. User_version remains 1 because
this table is additive; older readers work, but older writers do not emit audit
rows. Never roll a management writer back to an unaudited revision.
