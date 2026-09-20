# Security boundary

The store is trusted operator code. It runs in the host process, is not sandboxed and is not a multi-tenant boundary. Every caller who can reach a mount can read and (unless `readOnly`) change every record in that collection, so protect mounts with the auth extension or another policy and never put one user's private data in a collection another user can reach.

The data directory belongs to the operator: keep it outside the project, on local disk, readable only by the server user. The store creates it `0700` and its files `0600`, takes an exclusive lock and supports one server process per directory. Do not share it over a network filesystem. Protect backups like the data itself.

Requests are bounded (body, record, page and quota limits), validated against the declared field schema, and JSON-only for writes with a same-origin check on the `Origin` header. Errors return fixed messages and field names; they never echo submitted values, file contents or paths. Passing tests do not establish independent assessment or behavior under crash or disk-full conditions on every filesystem.

This package follows the [core URLCode security policy](../../SECURITY.md) for reporting. Never post real data or credentials in public issues.
