# Dynamic links: The management API

Part of [dynamic links](../DYNAMIC-LINKS.md), which indexes every page.

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
[security review](../SECURITY-AUDIT.md) for remaining controls.

## Management hardening baseline

Management is now restricted to literal loopback addresses. Prefer `--auth-file`
for individual expiring, revocable credentials with collection/action scopes.
Every successful built-in store mutation has an atomic, durable SQLite audit row;
HTTP request logs remain best effort. See [management security](../MANAGEMENT-SECURITY.md)
for policy examples, compatibility, archival and rollback requirements, and
[operational proof](../OPERATIONAL-PROOF.md) for executable recovery drills.
