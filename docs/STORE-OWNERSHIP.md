# Store record ownership: design recommendation

Status: **recommendation, not implemented behavior.** Nothing here changes the
runtime, the store or auth. It answers [#331](https://github.com/jimhoyd-com/urlcode/issues/331)
and records the decisions the maintainer must make before code is written. The
current, shipped behavior is in the [store guide](STORE.md); this page is the
proposal for the "per-record ownership" item that guide lists as not built.

Every claim about existing code cites `file:line` from the tree this was written
against. Anything not verified is marked **Unverified**.

## Problem

`@jimhoyd/urlcode-store` serves each collection as one shared list. `dispatch`
looks up the collection by mount and calls `list`, `get`, `create`, `update` or
`remove` with no notion of who is asking ([store.ts:106-129](../packages/store/src/store.ts),
[collection.ts:166-206](../packages/store/src/collection.ts)). `auth: true` on the
mount only decides whether a caller may reach the mount at all. So with auth
composed, any signed-in user can list, read, overwrite and delete every other
user's records. The guide already says so and tells operators to keep per-user
data out of shared collections ([STORE.md:126-131](STORE.md)). The UI CRUD screen
sits directly on that API ([#262](https://github.com/jimhoyd-com/urlcode/issues/262)),
which makes "a Todo app with sign-in" look multi-user safe when it is not.

There is no seam to fix this inside the store alone: the request object the
store receives carries method, path, query, headers, body, origin, route, mount
and client address, and no identity
([src/extensions.ts:25-29](../src/extensions.ts)). The only thing the store could
do today is read the `cookie` header and interpret auth's session itself, which is
the coupling this design rules out.

## What exists today (verified)

- Auth's gate is `authorize(requirement, request)`. It reads the session from the
  request, calls `service.authenticate`, checks role, permission, verification and
  freshness, verifies the CSRF token on writes, and returns either `undefined`
  (allowed) or a denial response ([packages/auth/src/auth.ts:200-215](../packages/auth/src/auth.ts)).
  The principal it computed is discarded; the hook can return only a denial.
- Core calls `authorize` for every protected route before the handler
  ([src/runtime.ts:238-249](../src/runtime.ts)) and builds the `ExtensionRequest`
  immediately before that, at [src/runtime.ts:237](../src/runtime.ts). Core, not the
  extension, owns that object.
- Auth already has the identity shape a handoff would need. `AuthPrincipal` holds
  `id`, `email`, `emailVerified`, `roles`, `permissions`, `sessionId`,
  `authenticatedAt`, optional `restrictions` and optional `impersonatorId`
  ([packages/auth/src/auth-core.ts:49-58](../packages/auth/src/auth-core.ts)). It is
  built so that a user with pending restrictions gets empty roles and permissions,
  and an impersonation session loses `*`, `auth.*` and `admin.*`
  ([auth-core.ts:870](../packages/auth/src/auth-core.ts)). `hasPermission` and
  `AuthPrincipal` are public exports ([packages/auth/src/index.ts:2-3](../packages/auth/src/index.ts)).
- Auth records an audit trail with `actor`, `action`, `subject`, `created` and
  `reason` ([auth-core.ts:105-112](../packages/auth/src/auth-core.ts)), which admin
  reads and exports (`packages/admin/src/admin-audit-export.ts`).
- The store's persistence: one array per collection mirrored to one JSON file, each
  mutation applied to a copy, written, fsynced, renamed, then swapped in, serialized
  by a promise chain ([collection.ts:91-164](../packages/store/src/collection.ts));
  one process per directory via a pid lock file ([store.ts:30-48](../packages/store/src/store.ts)).
  Startup revalidates every record against the declared fields and refuses to
  activate on a mismatch ([collection.ts:104-122](../packages/store/src/collection.ts)).
- The scaffold adds `auth: true` to the mount when `auth` is composed
  ([packages/store/src/scaffold.ts:21](../packages/store/src/scaffold.ts)).
- Not found: any principal, owner or cross-user field or test in the store package
  (`grep` for owner, principal and identity over `packages/store/src` finds
  nothing; `packages/store/test/store.test.ts` was searched for "owner", "cross-user"
  and "other user" with no match). **Unverified:** the store tests were not read in
  full, so a test that exercises two callers by other names is not ruled out.

## Recommendation

1. **A generic principal handoff in core, not a store-to-auth integration.** An
   extension that authenticates may return an opaque identity from a new optional
   hook; core validates its shape, freezes it and attaches it to the
   `ExtensionRequest` for later extensions on that route. The store consumes it
   only when a collection declares an ownership policy.
2. **The principal is a small stable subject plus named capabilities**, not the
   auth object. The store never learns what an email, session or role is.
3. **Four declared modes**, chosen per collection, default unchanged:
   `shared` (today), `owner` (private per subject), `owner-write` (owner writes,
   anyone permitted reads) and `managed` (a capability may act on any record,
   audited).
4. **Ownership is enforced inside the store's collection layer**, so list, cursors
   and totals are computed over the caller's visible set, and a record the caller
   may not see answers `404`, identical to a missing id.
5. **Do not call the CRUD screen multi-user safe** until the cross-user denial
   suite in [Tests required](#tests-required-before-anyone-claims-multi-user-safety)
   passes on the file backend and the limits under
   [Multi-user safety on the file backend](#multi-user-safety-on-the-file-backend)
   are documented next to the claim.

## The principal contract

### Shape

```ts
// Proposed, in src/extensions.ts (core). Not implemented.
interface ExtensionPrincipal {
  readonly subject: string;            // stable, opaque, 1-128 chars, [A-Za-z0-9._~:-]
  readonly issuer: string;             // extension name that vouched for it, set by core
  readonly capabilities: readonly string[]; // names, max 32 x 64 chars; no values
  readonly actingFor?: string;         // opaque subject an operator is acting as (audit only)
}
```

- `subject` is a stable identifier that never changes for one person. For auth it
  would be `AuthPrincipal.id` ([auth-core.ts:51](../packages/auth/src/auth-core.ts)),
  never the email, which can change and is personal data.
- `issuer` is written by core from the extension that returned the identity. A
  consumer can require a specific issuer; it can never be supplied by a client.
- `capabilities` is a list of names the issuing extension chooses to release, for
  example `store.admin`. The store's policy says which name grants management; the
  principal does not carry roles, permissions, email, session id, freshness or
  device data.
- `actingFor` exists only so an audit line can say "operator X, acting as user Y".
  Whether an impersonated session may write at all is an
  [open question](#open-questions-for-the-maintainer); auth today already narrows
  such a session's permissions ([auth-core.ts:870](../packages/auth/src/auth-core.ts)).

### Who validates, and why it is opaque

- **The issuing extension validates.** Auth already authenticates the session,
  rejects enrollment-required accounts and verifies CSRF on writes inside
  `authorize` ([auth.ts:204-210](../packages/auth/src/auth.ts)). The handoff
  reuses that one decision: a principal is produced only on the allowed path, in the
  same call, so there is no second parse of the cookie and no window between
  "authorized" and "identified".
- **Core validates the shape and owns the transport.** Core checks lengths and
  characters, freezes the object, stamps `issuer`, and stores it on the request it
  built. It is never derived from request headers, so a client cannot present one,
  and an extension cannot mint a principal on behalf of another extension.
- **The store validates nothing about identity.** It compares `subject` for
  equality and checks `capabilities` membership. That is the whole surface.
- **Opaque on purpose.** Because the store sees only a string it compares, auth can
  change its session format, add providers (OIDC, passkeys), or be replaced by
  another operator-installed authenticator without any store change. The store
  package needs no auth dependency, keeps the direction "core never imports
  packages" ([AGENTS.md](../AGENTS.md)), and cannot be tricked into interpreting
  auth cookies, tables or tokens. The `cookie`, `authorization` and CSRF headers
  are already declared credential headers that auth owns
  ([auth.ts:74](../packages/auth/src/auth.ts), [src/extensions.ts:292-296](../src/extensions.ts));
  the handoff means the store need not see them and a cache or log layer has no
  reason to.
- **Fail closed.** A collection with an ownership mode other than `shared` on a
  route with no principal source refuses activation (config validation, not a
  runtime 500). A request that reaches the store without a principal on such a
  collection answers `401`, never falls back to shared.

### How auth provides it (proposed, not implemented)

Two additive core pieces, both optional so existing extensions are unaffected:

1. `ExtensionInstance.identify?(requirement, request)` returns
   `ExtensionPrincipal | undefined` and is called only after `authorize` allowed the
   request (or, more simply, `authorize` may return `{ allow: principal }`; which
   spelling is smaller is an [open question](#open-questions-for-the-maintainer)).
2. `ExtensionRequest.principal?: ExtensionPrincipal`, set by core, readable by every
   extension after the identity provider in route order.

Auth implements the hook by mapping `AuthPrincipal` to `subject` and, per an
operator-visible map, a few role/permission names to capabilities.
**Unverified:** whether `middleware()` ([src/extensions.ts:46](../src/extensions.ts))
can carry this instead, with no new core surface. It is wrap semantics, runs after
`authorize`, and could in principle set a field before calling `next`, but
`ExtensionRequest` is currently a plain object built once per request
([runtime.ts:237](../src/runtime.ts)); whether extension `handle` receives the same
object a middleware mutated was not traced.

## Ownership modes and how a collection declares one

A collection declares one `ownership` block. Absent means `shared`, exactly
today's behavior, so no existing project changes and no re-pin surprise: adding the
block changes the project revision like any collection change ([STORE.md:131-133](STORE.md)).

```yaml
collections:
  todos:
    mount: /api/todos
    fields: {title: {type: string, required: true}, done: {type: boolean, default: false}}
    ownership:
      mode: owner            # shared | owner | owner-write | managed
      manage: store.admin    # capability name; only with managed, or optional admin override
```

| Mode | List/read | Create | Update/delete | Notes |
|---|---|---|---|---|
| `shared` (default) | everyone who reaches the mount | anyone who reaches it | anyone who reaches it | today; for team or public data. Records carry no owner. |
| `owner` | only own records | any principal; owner stamped by the store | only own records | private per-user data, the Todo case |
| `owner-write` | everyone who reaches the mount | any principal; owner stamped | only the owner | published-by-author data; "public read" is a route decision (an unauthenticated read mount needs its own route, see below) |
| `managed` | own records, plus all with the capability | any principal | own, plus all with the capability | admin-managed moderation or support access, audited |

Design rules:

- **Owner is stamped by the store, never accepted from a body.** It is a new
  reserved field beside `id`, `createdAt`, `updatedAt`
  ([collection.ts:6](../packages/store/src/collection.ts)); an `owner` key in a
  request body is rejected the same way an unknown field is
  ([collection.ts:127](../packages/store/src/collection.ts)). It is set once on
  create and cannot be changed by PUT or PATCH, so there is no "transfer".
- **The owner is stored as the opaque subject.** No email, so an account rename does
  not orphan records and the file holds no contact data.
- **Public read of an owner-write collection** needs an unauthenticated GET. The
  simple rule: the mount is not `auth: true`, and the store itself rejects a
  non-`GET`/`HEAD` request without a principal. That keeps the gate in the store
  (the enforcement point) rather than relying on route splitting. This means the
  store, not the route, must treat "no principal" as read-only anonymous; mark as an
  [open question](#open-questions-for-the-maintainer) whether anonymous reads
  should be allowed at all in the first release.
- **Modes are per collection, not per record.** No per-record ACLs, groups or
  sharing lists. See [non-goals](#non-goals).
- **Read-only collections** keep `readOnly` ([collection.ts:164](../packages/store/src/collection.ts)) and combine with any mode.

## Enforcement per operation

All checks live in `Collection`, not in `dispatch`, so a future non-file backend
inherits them ([#336](https://github.com/jimhoyd-com/urlcode/issues/336) asks that the
store stay the enforcement adapter). `Collection` methods gain a `principal`
argument; a mode other than `shared` with a missing principal is an error before any
data access.

| Operation | Rule |
|---|---|
| **List** | Filter to the visible set first, then page. `total`, `next` and the cursor are all computed over the visible set. A caller never learns that other users' records exist or how many. |
| **Read** | Look up by id, then check visibility. Missing and not-visible both throw the same `404 not_found`. |
| **Create** | Stamp `owner = principal.subject`. `maxRecords` stays a whole-collection cap ([collection.ts:178](../packages/store/src/collection.ts)); see the quota note below. |
| **Update (PUT/PATCH)** | Lookup, visibility, then owner-or-manager check, all before validating the body, so a non-owner learns nothing from a validation error. Owner is preserved. |
| **Delete** | Same check as update. `204` on success. |

**Cursors and totals.** Today the cursor is an integer offset into the whole array
and `total` is the array length ([collection.ts:167-170](../packages/store/src/collection.ts),
[store.ts:100-104](../packages/store/src/store.ts)). Under ownership the offset must
index the caller's filtered view. Two problems follow: an offset cursor is not stable
if the caller's own set changes between pages (the same weakness as today, no worse),
and an offset computed over the global array would leak record counts and positions.
Recommendation: keep the integer offset (no client contract change) but define it
over the visible set, and never expose an unfiltered `total`. **Unverified:** whether
any shipped UI code assumes `total` is collection-wide
([packages/ui](../packages/ui) was not searched for it).

**404, not 403.** Returning 403 for another user's record confirms it exists and
turns the id space into an oracle. Ids are random UUIDs
([collection.ts:179](../packages/store/src/collection.ts)) so guessing is
impractical, but ids leak through logs, URLs and screenshots, so existence must not
be confirmable. Missing and forbidden are byte-identical responses, including
timing to the extent the in-memory lookup allows (both are one `Map` lookup and a
comparison). The one exception is `405` for a read-only collection, which is
independent of the record. A caller who lacks a principal altogether gets `401`,
because that reveals nothing about any record.

**Per-user quota.** `maxRecords` limiting the whole collection means one user can
fill it and lock everyone out (`409 collection_full`, [collection.ts:178](../packages/store/src/collection.ts)).
Recommend an optional `ownership.maxPerOwner` (default a fraction of `maxRecords`;
value is an [open question](#open-questions-for-the-maintainer)). Without it, `owner`
mode is private but not fair.

## Existing ownerless records and schema changes

Records written before ownership have no `owner`. They are the dangerous case:
silently treating them as shared would expose them, and treating them as owned by
nobody would hide them forever.

- **Activation refuses, it does not guess.** Turning `ownership` on for a collection
  whose file holds ownerless records fails activation with a message naming the
  collection and the count, the same posture as a record that no longer matches its
  fields ([collection.ts:118](../packages/store/src/collection.ts)).
- **The operator resolves it explicitly, offline.** A one-shot, reviewed migration
  (a separate operator command, not a request path) that either assigns all ownerless
  records to a named subject, marks them `orphaned` for `managed` collections, or
  exports and empties them. The choice is the operator's; the store does not pick an
  owner. Whether the migration is a CLI subcommand or a documented script is an
  [open question](#open-questions-for-the-maintainer).
- **Orphaned records** (owner subject whose account is later deleted) stay owned by
  that subject. In `managed` mode the capability holder can reach them; in `owner`
  mode nobody can, and that is stated behavior. Auth account deletion does not reach
  into the store (no data crosses); an operator process handles orphans.
- **Downgrade.** Switching an owned collection back to `shared` would expose every
  user's records to everyone. Activation refuses unless the file carries no owners
  or the operator passes an explicit acknowledged flag in host code (never YAML).
- **Mode changes between owned modes** (`owner` to `owner-write`, etc.) only widen
  or narrow rules over the same stamped field, so they need a re-pin but no data
  rewrite. `owner` to `owner-write` widens read access and should warn.
- **Field schema changes** keep today's rule: records must match declared fields at
  startup, else refuse ([collection.ts:104-122](../packages/store/src/collection.ts)).
  `owner` is reserved and outside the declared fields, so it never collides.
- **File format.** The file header is `version: 1` ([collection.ts:114](../packages/store/src/collection.ts)).
  Adding `owner` to records is backward-compatible for readers that ignore it but a
  version-1 reader would reject an unexpected key today only if `check` saw it;
  `load` runs `check(item, false)` which flags undeclared keys ([collection.ts:127](../packages/store/src/collection.ts)),
  so an older store loading a newer file fails closed. That is the desired
  direction. Bump to `version: 2` when owners are written, so the failure is explicit
  rather than a per-record field error. Rollback is therefore one-way and must be
  documented.

## Multi-user safety on the file backend

The file backend is honest and good for a single-operator, single-process app. What
it does not provide bears directly on multi-user claims:

- **Whole-collection rewrite.** Every write serializes and renames the entire
  collection ([collection.ts:148-158](../packages/store/src/collection.ts)). One
  user's write cost grows with every other user's data. With ownership on, a single
  hot user cannot be isolated from the cost they impose on others. The caps
  (10,000 records, 64 KiB each, [collection.ts:7](../packages/store/src/collection.ts))
  bound this to roughly the low hundreds of MB worst case (computed from the caps;
  **Unverified** by measurement).
- **Single writer.** One process per directory, enforced by a pid lock that is
  explicitly a mistake guard, not a distributed lock, and unsafe on network
  filesystems ([store.ts:29-48](../packages/store/src/store.ts), [STORE.md:98-105](STORE.md)).
  Multi-user safety here means multi-user on one process. Horizontal scale is out
  of scope for the file backend.
- **No transactions.** Two updates to one record are serialized but last-write-wins;
  no optimistic concurrency ([STORE.md:106-111](STORE.md)). Ownership does not make
  this worse, since only the owner (or a manager) can write, but two tabs of one
  user, or a manager and a user, can still clobber each other. A version or
  `updatedAt` precondition is a separate follow-up, not part of this work.
- **Serialization is the only isolation.** Ownership checks must happen inside the
  serialized section for writes ([collection.ts:143-147](../packages/store/src/collection.ts)),
  after the record is looked up, so a delete-then-update race cannot act on a record
  whose owner changed. Since owner is immutable this is a defense in depth, but the
  check must not be moved outside the `serialize` closure in a refactor.
- **Data at rest is one file, readable by anyone with the operator's shell.** Per-user
  privacy here is application-level access control, not encryption or per-tenant
  storage. It is not hostile multi-tenant isolation, and the project already says it
  does not claim that ([AGENTS.md](../AGENTS.md)).
- **Backups and export** copy every user's data together. Per-user export or
  deletion (privacy requests) is an operator script over the file; not solved here.

Conclusion: the file backend with ownership is acceptable for a small number of
mutually trusting-but-separated users on one machine. It must not be described as a
multi-tenant store, and the docs should carry the limits verbatim next to the mode
descriptions.

## Admin management and audit

`managed` mode means a capability holder can read and change records they do not own.
That power needs a trail that the store does not currently keep (no history,
[STORE.md:106-111](STORE.md)) and must not build ad hoc.

- Every request where access was granted **only because of the management
  capability** (not ownership) emits one audit event through a small, generic
  `audit` callback the operator supplies in host code (`storeExtension({ audit })`),
  carrying `actor` (the principal subject), `action` (`store.read|update|delete|list`),
  `subject` (collection name plus record id), `actingFor` if any, and time. No record
  values. The shape mirrors auth's audit event so the operator can forward it into
  the same sink ([auth-core.ts:105-112](../packages/auth/src/auth-core.ts)).
- The store does **not** write into auth's audit tables. It emits; the operator wires
  the sink. That preserves the rule that no auth data moves and the store touches no
  auth storage.
- **Fail closed on audit:** if the audit callback throws, the managed access is
  refused (`503`), so an admin cannot act unrecorded.
- List by a manager is one event per request, not one per record.
- Whether admin console (`packages/admin`) should surface store-management events in
  its audit screen is an [open question](#open-questions-for-the-maintainer);
  **Unverified:** how `packages/admin` would consume a non-auth event source
  (`admin-audit-export.ts` was not read in detail).
- Impersonation: an impersonated session (`impersonatorId`,
  [auth-core.ts:870](../packages/auth/src/auth-core.ts)) is where `actingFor` matters.
  Recommendation: an impersonating operator's store writes are refused unless the
  collection explicitly allows it, and reads are audited.

## Tests required before anyone claims multi-user safety

These belong in `packages/store/test` and, for the handoff, a core test and an auth
integration test. All use two distinct subjects, A and B, plus a capability holder M,
plus an anonymous caller. "Denied" for a record means byte-identical to a missing id.

Per mode, on every one of list, read, create, update (PUT and PATCH) and delete:

1. **B cannot list A's records.** A creates records; B lists and gets none of them, a
   `total` that excludes them, and no `next` derived from them. Page through with
   `limit=1` and confirm no A record appears on any page.
2. **B cannot read A's record by id:** `404`, and the response body and headers equal
   the response for a random valid UUID.
3. **B cannot update (PUT or PATCH) A's record:** `404`, and A's record is unchanged
   on disk (re-read the file), including `updatedAt`.
4. **B cannot delete A's record:** `404`, record still present after restart.
5. **Body cannot claim ownership:** a body containing `owner` (any casing variant that
   maps to the reserved field) is `400`; PUT/PATCH cannot change the stamped owner.
6. **Anonymous caller** gets `401` in `owner`, `owner-write` writes and `managed`,
   never data; anonymous read behaves as decided in the open question.
7. **`owner-write`:** B can read A's record and cannot write it (`404`, not `403`,
   unless the maintainer chooses otherwise).
8. **`managed`:** M can read and change A's record, an audit event is emitted for
   exactly those accesses and none for A's own; a throwing audit callback refuses the
   access and leaves data unchanged.
9. **Cursor and quota:** offset cursors index the caller's view; one owner filling
   `maxPerOwner` cannot block another owner's create.
10. **Persistence:** repeat the denial checks after a restart (owners survive a write,
    a reload and a rewrite of the collection by another user).
11. **Concurrency:** interleaved writes by A and B in one process do not lose either
    write and do not cross ownership.
12. **Fail-closed configuration:** ownership on a mount with no principal source
    refuses activation; ownerless records refuse activation with a count and no
    values; downgrading to `shared` refuses.

Handoff tests (core and auth):

13. A client cannot forge a principal: a request carrying `x-principal`, or any header
    or cookie value, produces no `ExtensionRequest.principal`.
14. A principal appears only when the issuing extension's `authorize` allowed the
    request; a denied, unauthenticated, enrollment-required or expired session yields
    none.
15. `subject` is `AuthPrincipal.id`, never email; the principal object carries no
    field beyond the declared shape, is frozen, and `issuer` is core-stamped.
16. A revoked session stops working on the next request (no principal cached across
    requests).
17. The store package imports nothing from `@jimhoyd/urlcode-auth` and core imports
    no package (the existing dependency rule, [AGENTS.md](../AGENTS.md)).

Until 1 to 12 pass on the file backend, the docs, the scaffold and the CRUD screen
must not say "multi-user safe". Passing them is evidence about the tested code paths
only; it is not an independent security review and not hostile multi-tenant
isolation.

## Alternatives rejected

1. **Store reads the auth cookie or session table.** Fastest, and exactly what #331
   forbids: it ties the store to auth's storage and session format, duplicates
   session validation (a second place that can be wrong), forces the store to hold
   credential-adjacent code, and breaks with any other authenticator.
2. **Operator glue only: `storeExtension({ identify: req => authService... })` in
   `host.mjs`, no core change.** Attractive as a first spike and needs no core work,
   but auth's identity would be resolved a second time per request outside the
   `authorize` decision (a window in which the session state can differ), every
   operator must write and get right the security-critical wiring, `init --with`
   scaffolds would have to generate it, and it gives non-auth extensions no shared
   contract. Kept as a possible throwaway prototype to shake out the store side, not
   as the shipped design.
3. **Pass the principal through headers, signed or not** (a JWT or `x-user`). A
   forgeable header is a bypass if any path skips the stripping; a signed token needs
   key management and rotation for something in-process. The request object is a
   stronger, simpler channel.
4. **Let the client send `owner`.** Trivially spoofed; the store must stamp it.
5. **Per-user files or directories, or a collection per user.** Gives filesystem-level
   separation but multiplies files and locks, breaks a global `maxRecords`, cannot
   express `owner-write` or `managed`, and turns a schema declaration into a runtime
   naming scheme.
6. **Add ownership to core routes (`auth: {owner: true}`).** Core does not know what
   a record is; it would put data-model policy in the portable core and violate the
   extension boundary ([AGENTS.md](../AGENTS.md)).
7. **Ship a SQLite or SQL backend first so the database enforces rows.** A larger
   change, and it moves the ownership predicate into queries that still need this
   same principal contract. The contract is the prerequisite either way; a backend is
   an independent, later choice ([#336](https://github.com/jimhoyd-com/urlcode/issues/336)).
8. **Return `403` for another user's record.** Simpler to explain and debug, but
   confirms existence; rejected for the oracle reason above.
9. **Per-record ACLs or sharing lists.** Real product surface, real complexity, and
   easy to get subtly wrong; see non-goals.
10. **Do nothing and only warn.** Cheapest, and the honest interim (the guide already
    warns), but leaves the most common "todo app with sign-in" unsafe by default.

## Non-goals

- No auth data moves into the store: no users, sessions, credentials, tokens, email
  addresses or roles are stored or read by the store. The store keeps one opaque
  subject string per record.
- No identity-provider, OIDC or auth configuration in the store's YAML, and no
  provider infrastructure settings in route YAML
  ([AGENTS.md](../AGENTS.md)). Capability names in `ownership.manage` are labels the
  operator maps in host code; they are not provider settings.
- The store does not authenticate, issue or renew anything, and does not call auth.
- No per-record ACLs, sharing lists, groups, teams, transfer of ownership or
  hierarchical tenancy.
- No hostile multi-tenant isolation claim, no encryption at rest, no per-tenant keys.
- No change to the retired stored short-link path or to the sandbox model.
- No new backend, filtering or sorting in this work
  ([#330](https://github.com/jimhoyd-com/urlcode/issues/330) is separate; the two
  interact and should share the same visible-set rule).

## Open questions for the maintainer

1. **Core surface.** Is a new optional hook plus `ExtensionRequest.principal` (or
   `authorize` returning an allow-with-principal) acceptable in core, given "core
   never imports packages"? Which spelling is smaller and easier to keep portable
   under [RUNTIME-IMPLEMENTATION.md](RUNTIME-IMPLEMENTATION.md)? **Unverified** for
   other runtime targets; the store and auth both declare `targets: ['node']`
   ([store.ts:63](../packages/store/src/store.ts), [auth.ts:74](../packages/auth/src/auth.ts)).
2. **One identity provider per route?** If two extensions could issue a principal on
   one route, which wins, or is that a configuration error?
3. **Capability mapping.** Who maps auth roles or permissions to a capability name
   such as `store.admin`: auth's config, the host file, or the collection's
   `ownership.manage` referring to an auth permission name directly?
4. **Anonymous reads.** May `owner-write` serve unauthenticated `GET` in the first
   release, or must every mode require a principal until a later slice?
5. **Impersonation.** May an impersonated session write to `owner` collections, and
   are its reads audited as the operator, the user, or both?
6. **Per-owner quota.** Ship `maxPerOwner` in the first slice, and what default?
7. **Ownerless migration.** A CLI subcommand, a documented one-off script, or
   activation flags in host code? Who chooses the default owner for legacy records?
8. **Orphans.** Should the store expose any "orphaned subject" listing, or is that
   entirely an operator concern?
9. **Audit sink.** Callback in host code (proposed), or should `packages/admin`
   receive store events natively?
10. **Version bump.** Is a file `version: 2` and one-way rollback acceptable, or must
    the first release remain readable by the current store?
11. **Scaffold default.** Should `init --with auth,store` default the mount to
    `ownership.mode: owner` once this ships (a behavior change to a starter that is
    not yet on npm, [#323](https://github.com/jimhoyd-com/urlcode/issues/323))?
12. **Naming.** `owner`/`managed` versus other names; the `store.admin` capability
    convention; and whether the reserved record field is `owner` or `_owner`.

## Phased implementation plan

Sizes: S is under a day of focused work, M a few days, L about a week or more,
each including tests and docs. These are estimates by the author, not measured.

| Phase | Work | Size | Exit criterion |
|---|---|---|---|
| 0 | Maintainer answers the open questions; decision recorded in [open decisions](OPEN-DECISIONS.md). Optional throwaway host-glue prototype (rejected alternative 2) to find store-side surprises. | S | Decisions 1, 2, 3, 4 and 12 settled |
| 1 | **Core handoff.** Optional identity hook or `authorize` result, `ExtensionRequest.principal`, shape validation, freeze and `issuer` stamping, spec and `RUNTIME-IMPLEMENTATION.md` card, fixture. Handoff tests 13-14, 17. | M | Core tests green; no package imported by core |
| 2 | **Auth side.** Implement the hook in `authExtension`, `AuthPrincipal` to `subject` and capability mapping, tests 15-16, docs in the auth guide. Does not change what `authorize` decides. | S | Existing auth suite unchanged and green |
| 3 | **Store enforcement.** `ownership` schema and normalization, reserved `owner` field, `Collection` methods take a principal, list/cursor/total over visible set, uniform 404, fail-closed activation, `version: 2`. Tests 1-7, 9-12. | L | Cross-user denial suite green on the file backend |
| 4 | **Managed mode and audit.** Capability check, audit callback, fail-closed audit, impersonation rule. Test 8. | M | Audit emitted exactly for capability-only access |
| 5 | **Migration for ownerless data.** The offline operator step, downgrade refusal, docs. | M | Round-trip of a legacy file on a fixture |
| 6 | **Docs and claims.** Update STORE.md, the store and UI READMEs, the recipe and scaffold, `llms-full.txt`; only now may docs say a collection is multi-user safe, with the file-backend limits stated beside it. UI screen sends no owner and tolerates 404. | S | `check:docs` green; wording reviewed by the maintainer |
| 7 | Independent review of the handoff and the enforcement before any external "multi-user" statement. | M (calendar time, not effort) | Reviewer sign-off; not claimed before |

Phases 1 and 2 are independent of the store and are useful to any future data
extension. Phase 3 cannot ship without 1 and 2. Stop after any phase without leaving
a half-safe state, because each mode defaults to today's `shared` behavior until a
collection opts in.

## Related

- [Store guide](STORE.md), [extensions](EXTENSIONS.md), [project direction](PROJECT-DIRECTION.md)
- [#253](https://github.com/jimhoyd-com/urlcode/issues/253) store extension,
  [#262](https://github.com/jimhoyd-com/urlcode/issues/262) data-bound screen,
  [#330](https://github.com/jimhoyd-com/urlcode/issues/330) filtering and sorting,
  [#336](https://github.com/jimhoyd-com/urlcode/issues/336) keep store as the adapter
  UI consumes, [#331](https://github.com/jimhoyd-com/urlcode/issues/331) this proposal
