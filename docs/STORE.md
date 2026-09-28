# Data store extension and CRUD recipe

`@jimhoyd/urlcode-store` is an operator-installed extension (see
[extensions](EXTENSIONS.md)) that serves declared collections as a bounded JSON
CRUD API. It is not core: the project declares collections and mounts, the
operator installs the package and chooses where the data lives, and application
data stays in the operator's systems. A Todo app needs no handler code.

Why it is an extension: core has no persistence handler. Trusted by default
([direction](PROJECT-DIRECTION.md)) lets core stay small while data-owning
features ship as extensions the operator reviews and pins.

Tools that need the store configuration shape without loading operator code can
add the inert `store-schema` artifact (`urlcode artifacts add store-schema`;
see [artifacts](EXTENSIONS.md#artifacts)). Its schema is generated from this
extension's definition, so it always matches the store released beside it. MCP
`get_extension_artifacts` lists it and `get_extension_artifact` reads one
bounded schema/example/README file. It neither installs nor activates the store
extension; `urlcode extensions add store` does that.

## Recipe: a Todo API in three steps

```sh
npx @jimhoyd/urlcode init todo-site --with store --example --ack store:public-write   # or --with ui,auth,store --example: see below
cd todo-site
```

In an existing site, `urlcode extensions add store --example` does the same.
Without `--example` the store installs as a capability only: an empty
`collections` block, no mount and no acknowledgement, ready for your own
collection. With it, `add` installs
`@jimhoyd/urlcode-store` at the version core pins, adds `store()` to `host.mjs`,
and writes the collection into `app/urlcode.yaml` and its mount into
`app/routes/store.yaml`:

```yaml
version: "1"
extensions:
  store:
    version: "1"
    config:
      collections:
        todos:
          mount: /api/todos
          fields:
            title: {type: string, required: true, minLength: 1, maxLength: 200}
            done: {type: boolean, default: false}
          maxRecords: 1000
          maxRecordBytes: 4096
```

```yaml
# app/routes/store.yaml
version: "1"
routes:
  /api/todos/*:
    extension: store
    methods: [GET, HEAD, POST, PUT, PATCH, DELETE]
```

Records live in one SQLite database, `data/store.sqlite` beside `host.mjs` (or
`STORE_DATABASE`), outside `app/`. Review the project, put the revision the command printed in the
operator policy as its `projectSha256` (or set `PROJECT_SHA256` to it), and
serve; `--policy` with `--host-file` pins the host automatically
([the revision pin](EXTENSIONS.md#the-revision-pin)):

```sh
npx urlcode extensions --host-file host.mjs    # inspect schemas
npx urlcode serve --host-file host.mjs --policy /etc/urlcode/policy.json --origin https://todo.example.com
curl -X POST -H 'Content-Type: application/json' -d '{"title":"first"}' https://todo.example.com/api/todos
```

With `auth` installed (`--with ui,auth,store --example` in any order, or `urlcode
extensions add auth` before `store --example`) the example adds `auth: true` to
the API mount and to the screen, so only signed-in callers reach either, and
declares the `todos` collection `ownership: owner`, so each signed-in user sees
and changes only their own todos ([per-record ownership](#per-record-ownership));
no acknowledgement is needed. `auth: true` admits the API's JSON writes with the
session cookie and same-origin provenance, and refuses a cross-origin write with
`403`. When `audit` is installed too, the example collection also declares
`audit: true` ([audited writes](#audited-writes)). Without `auth` the example
collection stays shared, because there is no principal to own a record.

Without `auth` the mount would be a public writable endpoint, so adding `store`
(with or without `ui`) refuses, rolls back, and names the two ways forward: add
`auth` first, or re-run the exact command it prints, which ends in `--ack
store:public-write`, when public writes are really intended. Core's generic
`--ack <extension>:<id>` flag (see [extensions](EXTENSIONS.md)) is visible in
command history and rejected when no scaffold consumes it; the command's
output and a comment in `app/routes/store.yaml` then state the access model as
public write. That is an acknowledgement, not a
control: it is not rate limiting, abuse protection or multi-tenant isolation
(the store keeps only its record and size bounds and the origin and CSRF checks).
The flag is rejected when it would have no effect (auth installed, or no `store`).
A hand-authored public mount, as in the YAML above, stays supported.

## HTTP contract

| Request | Answer |
|---|---|
| `GET /api/todos?limit=&cursor=` | `200 {items, total, next?}` in creation order; `limit` is capped at the collection `pageSize`, `cursor` is the offset from `next` |
| `GET /api/todos?sort=-priority&kind=a&cursor=` | the same shape, sorted and filtered as [declared](#sorting-and-filtering); `total` counts the matches and `cursor` is the opaque `next` of a sorted page |
| `POST /api/todos` | `201` and the record, `Location: /api/todos/<id>` |
| `GET /api/todos/<id>` | `200` record, or `404` |
| `PUT /api/todos/<id>` | replaces every declared field (omitted fields take their default), `200` |
| `PATCH /api/todos/<id>` | updates the supplied fields and removes those set to `null` ([clearing a field](#clearing-a-field)), `200` |
| `DELETE /api/todos/<id>` | `204` |
| `POST /api/todos/<id>/<transition>` | runs a [declared transition](#conditional-transitions-and-result-aware-retries), `200` |

Every record carries a server-assigned UUID `id`, `createdAt` and `updatedAt`
(ISO 8601). Clients cannot set them. On an
[owned](#per-record-ownership) collection every request is scoped to the
caller's principal: another principal's record is a `404`, and a request with
no principal is `401`. Writes need `Content-Type:
application/json` (`415` otherwise); an `Origin` header on a write that is
neither `--origin` nor an operator
[alias origin](EXTENSIONS.md#site-origins-and-same-origin-checks) is refused
(`403`). Errors are `{error: {code, message, fields?}}` where
`fields` maps field names to fixed messages; submitted values are never echoed.
Status codes: `400` invalid record or JSON, `403` `own_record_refused` (a
`by: others` transition on the caller's own record), `404`, `405` with
`Allow`, `409` `collection_full` (or `owner_quota_exceeded` on an
[owned collection with a per-owner limit](#per-owner-record-limit), or
`transition_conflict`), `412` stale `If-Match`, `413` body or record too
large, `415`, `422` `idempotency_key_reused`, `503`
`storage_unavailable` when the database write failed or another process held its
lock past the busy timeout (nothing is written), `500` for anything unexpected
(no cause in the body).

## Bounded keyed transitions

Collections can opt into three deliberately small state primitives. They are
not a general transaction language, do not run project code, and do not select a
database or provider. The operator still supplies the database path in the host
file; the project only declares the bounded behavior it needs.

```yaml
extensions:
  store:
    version: "1"
    config:
      collections:
        links:
          mount: /api/links
          key: code
          increments: [clicks]
          idempotency: {maxKeys: 1000}
          fields:
            code: {type: string, required: true, minLength: 1, maxLength: 32}
            destination: {type: string, required: true, format: http-url, maxLength: 2048}
            clicks: {type: integer, default: 0, minimum: 0}
      shortLinks:
        public:
          mount: /go
          collection: links
          destination: destination
          clicks: clicks
routes:
  /api/links/*: {extension: store, methods: [GET, HEAD, POST, PUT, PATCH, DELETE]}
  /go/*: {extension: store, methods: [GET, HEAD]}
```

- `key` names one required string field, capped at 128 characters. A create
  atomically claims that caller-supplied value; a duplicate is `409 key_exists`.
  Updating a key is allowed only when the replacement is unused. Keys remain
  collection-local; they are not routing or authorization principals.
- `increments` lists numeric fields with numeric defaults. `POST
  /api/links/<uuid>/increment/clicks` increases exactly one declared field by
  one in one database transaction. It refuses undeclared counters and an
  increment that would violate the field's declared finite/integer/minimum or
  maximum limits. There is no caller-provided delta, conditional expression or
  multi-record operation.
- `idempotency: {maxKeys: N}` enables an optional `Idempotency-Key` header on
  a collection's `POST`, `PUT`, `PATCH`, `DELETE`, increment and
  [transition](#conditional-transitions-and-result-aware-retries) endpoints.
  A key is 1–128 characters with no control character. The store claims it,
  with the request's fingerprint and its result, in the same database
  transaction as the accepted mutation. A retry with the same key and the same
  request replays the first answer's status with the record as it is now
  (`Idempotency-Replayed: true`); the same key on a different request is
  `422 idempotency_key_reused`. Refused and failed mutations claim nothing. The
  collection retains its newest `N` distinct keys, across all callers, so an
  evicted key is intentionally no longer protected and its retry runs again.
  Supplying the header to a collection that did not enable idempotency is
  `400 idempotency_not_enabled`, rather than silently offering a false
  guarantee. A key is scoped to the request principal, or to the network
  client when the request has none. The full contract is in
  [result-aware retries](#result-aware-retries).

`format: http-url` applies only to string fields and accepts an absolute
HTTP(S) URL without credentials or ASCII whitespace/control characters. A `shortLinks` entry combines a collection's
unique key, one such **required** destination field (declaring it without
`required: true` refuses activation), and one declared counter. `GET
/go/<code>` atomically increments the counter and answers `302 Location:` with
the stored destination; a missing key is `404`, and so is a record whose
destination is unset (only reachable from data written before the field
became required). `HEAD /go/<code>` resolves and answers the same `302`
without counting a click — only `GET` does. Its public redirect mount is
separate from the private CRUD mount, so protect either mount according to the
application's own access model. No function is required for the create,
invalid-destination, redirect, missing-code or click-count flow. The click
counter keeps incrementing even when the collection is declared `readOnly`:
that flag closes the public create/update/delete/increment surface on the
CRUD mount, not the redirect's own bookkeeping, so a link collection can be
`readOnly` for callers while still counting its own clicks ([#552]).

## Clearing a field

`PATCH` changes only the fields its body names. A field set to `null` is
removed from the record, so an optional field can be emptied after it was
saved (#738):

```http
PATCH /api/todos/<id>
Content-Type: application/json

{"priority": null, "done": true}
```

- Only an optional field can be cleared. `null` for a `required` field is
  `400 invalid_record` with the field error `is required and cannot be
  cleared`, and for an `increments` field `is an increment field and cannot be
  cleared`; nothing is written.
- A field with a `default` is optional, so it can be cleared too: the record
  then has no value for it. The default applies again only on a later `PUT`.
- A body that only clears fields is a change, even when they were already
  absent: `updatedAt` and the `ETag` move.
- `If-Match`, ownership scoping and validation of the other fields apply
  exactly as to any `PATCH`.
- `PUT` is unchanged: it replaces the record from values only, and `null` is
  refused as the field's wrong type.

## Conditional writes

A single-record `GET`/`HEAD` on a collection's own CRUD mount returns a
strong `ETag`, as does the response to a `POST`, `PUT` or `PATCH`. Send that
value back as `If-Match` on a later `PUT`, `PATCH` or `DELETE` to make the
write conditional: it applies only if the record has not changed since, and
otherwise answers `412` without writing anything — useful when two callers
might update the same record concurrently and the loser should not silently
overwrite the winner's change. `If-Match` is optional; omitting it keeps the
default last-write-wins behavior unchanged. A malformed `If-Match` (not this
store's own quoted hex format) is `400`, not a silent bypass. The ETag is
derived from the record's `id` and `updatedAt`, and every write moves
`updatedAt` by at least one millisecond, so two writes in the same millisecond
still give two ETags: of concurrent writes holding the same `If-Match`,
exactly one applies and the rest answer `412`. A
[declared transition](#conditional-transitions-and-result-aware-retries) honours
`If-Match` the same way.

An idempotency claim is a durable *state/delivery decision*, not delivery
itself: the store does not send webhooks, provide an outbox, retry a remote
request or prove that another system received anything. It is suitable for a
webhook handler to record exactly one accepted transition before its own
operator-owned delivery mechanism; external side effects still need their own
idempotency protocol.

## Conditional transitions and result-aware retries

[#835](https://github.com/jimhoyd-com/urlcode/issues/835) asks for the
smallest store-owned contract behind a reviewed conditional mutation with an
expected revision and result-aware retries. It has three parts, each bounded:

1. **Declared transitions**: a named change of one record from exact field
   values to constant ones, served by the store with no project code, and
   optionally gated by a [membership collection](#membership-gates-and-cross-owner-reads).
2. **Result-aware retries**: a retried `Idempotency-Key` answers what the first
   request committed instead of `409`.
3. **Host transactions**: trusted extension code runs several store operations
   as one database transaction, for contracts a declaration cannot express.

This is not a transaction language, an expression language or a workflow
engine. The first concrete fixture is the owner/reviewer approval of
[#843](https://github.com/jimhoyd-com/urlcode/issues/843):

```yaml
collections:
  reviewers:                       # who may review: principal ids, maintained by the operator
    membership: true
    key: userId
    fields:
      userId: {type: string, required: true, maxLength: 128}
  requests:
    mount: /api/requests
    ownership: owner
    idempotency: {maxKeys: 1000}
    fields:
      title: {type: string, required: true, maxLength: 120}
      status: {type: string, enum: [pending, approved, withdrawn], default: pending, transitionOnly: true}
      reviewedBy: {type: string, maxLength: 128, transitionOnly: true}
      reviewedAt: {type: string, maxLength: 32, transitionOnly: true}
    transitions:
      approve:                     # POST /api/approvals/<id>
        from: {status: pending}
        set: {status: approved}
        stamp: {reviewedBy: actor, reviewedAt: now}
        by: others                 # any principal except the record's owner
        members: reviewers         # ...who is also a member of reviewers
        mount: /api/approvals
      withdraw:                    # POST /api/requests/<id>/withdraw, owner only
        from: {status: pending}
        set: {status: withdrawn}
    readers: {mount: /api/review, members: reviewers}   # GET /api/review?status=pending
routes:
  /api/requests/*: {extension: store, methods: [GET, HEAD, POST, PUT, PATCH, DELETE], auth: true}
  /api/approvals/*: {extension: store, methods: [POST], auth: true}
  /api/review/*: {extension: store, methods: [GET, HEAD], auth: true}
```

### Declared transitions

- `from` names 1 to 8 declared fields and the exact value each must hold now;
  `set` names 1 to 8 fields and the constant each gets; `stamp` names up to 4
  string fields the store fills with `actor` (the principal's id, or
  `anonymous`) or `now` (the commit time, equal to the new `updatedAt`).
  Activation checks every value against its field, refuses `set` or `stamp` on
  the collection `key`, a field both set and stamped, a stamp field that could
  not hold its value (a string with no enum or format, `maxLength` at least 128
  for `actor` and 24 for `now`), and the name `increment`.
- `POST <mount>/<id>/<name>` takes no body (`400 body_not_allowed`), an
  optional `If-Match` and an optional `Idempotency-Key`, and answers `200` with
  the record and its new `ETag`. It is a write: the same-origin rule,
  `readOnly`, `maxRecordBytes` and `audit: true` apply exactly as to `PATCH`.
  An audited transition is recorded as `store.record.transitioned` with the
  transition's name and the changed field names.
- On an owned collection `by` chooses who may run it. `owner` (the default) is
  the record's owner, on the collection mount, scoped like every other write.
  `others` is any principal **except** the owner: the transition is served only
  as `POST <transition mount>/<id>`, a separate route that must carry a
  principal-providing policy, so the operator guards it independently of the
  collection. Without `members`, anyone that route admits may run it; with
  `members` only a member of that
  [membership collection](#membership-gates-and-cross-owner-reads) may. On a
  shared collection `by` is refused, since records have no owner to compare,
  and anyone who can reach the mount may run the transition unless it names
  `members`.
- A field declared `transitionOnly: true` changes only through a transition's
  `set` or `stamp`: a create stores its default (or leaves it unset), `PUT`
  keeps its current value, and any body naming it is `400` with the field error
  `is changed only by a transition`. Without it, the owner in the example could
  `PATCH` `status: approved` and skip the review. Activation refuses it with
  `required`, on the key or an increment field, and when no transition sets or
  stamps it. A [screen](#a-screen-for-the-collection) over such a collection
  is refused until screens can show transitions.

### Membership gates and cross-owner reads

Identity comes from the principal-providing policy (with `auth`, the Better
Auth user id); permission is application data keyed by that id, in the store
itself ([#863](https://github.com/jimhoyd-com/urlcode/issues/863)). The store
still has no roles, and `auth` gains none.

- **A membership collection** declares `membership: true` and a `key`: one
  record per member, whose key field holds the member's principal id (a value
  that is not a principal id is `400 must be a principal id`). It reuses the
  unique-key machinery instead of a new table, so membership is one indexed
  lookup inside the request's own transaction. It has **no mount and no HTTP
  API**: a membership list served on a collection mount would let anyone the
  route admits add themselves or enumerate members. Activation therefore
  refuses it with `mount`, and with `ownership`, `transitions`, `readers`,
  `increments`, `idempotency`, `sortable`, `filterable`, `readOnly` or
  `audit`, and refuses a screen over it.
- **Maintaining it** reuses the operator paths the store already has, not a new
  admin surface. The operator calls `addMember`, `removeMember` and
  `listMembers` from `@jimhoyd/urlcode-store` (each one transaction on its own
  connection, safe while the server is serving, validated against the
  project's declared collections like `reassignOwner`; `addMember` creates the
  database for a site that has not served yet). Trusted extension code uses
  [`StoreExports`](#using-a-collection-from-another-extension):
  `records('reviewers').create(null, {userId})`, and `remove` inside a
  [host transaction](#host-transactions).
- **A gated transition** adds `members: <membership collection>`. The order is
  principal (`401`), then membership (`403 membership_required`), then
  everything in [the ordering below](#design-decisions), starting with the
  retained `Idempotency-Key`. The membership check is the first statement of
  the write transaction, before any record of the collection is read. A
  non-member therefore gets the same `403` for an existing id and a missing
  one, and a removed member's retry is refused rather than replayed.
  `by: others` still refuses the owner, member or not (`403
  own_record_refused`). Host transactions pass the same gate.
- **Cross-owner reads.** An owned collection may declare
  `readers: {mount, members}`. Members then list and read **every** owner's
  records, read-only, on that separate mount: `GET <mount>` takes the
  collection's `limit`, `cursor`, `sort` and filters (so `?status=pending` is
  a review queue), and `GET <mount>/<id>` reads one record with its `ETag`.
  Any other method is `405`. The mount needs its own route with a
  principal-providing policy. The principal and membership come first, in the
  same read transaction as the read, before the query is parsed or any record
  is read. A non-member gets one `403` for the list, an existing id, a missing
  id and a malformed one. Records with no owner are left out, the stored owner
  is never shown, and owners keep their own view on the collection mount.
- **Changes apply immediately.** Membership is read inside each gated
  request's transaction, so an addition or removal committed before a request
  begins applies to it; there is no cache. Of concurrent approvals by members
  exactly one commits, as for any transition.
- **Activation** refuses a `members` naming a collection that is not declared
  or is not a membership collection, and `readers` on a shared collection or
  on a mount that another store mount already uses.
- **Why this shape.** Only `members` on a transition, `readers` on a
  collection and `membership: true` are new. Richer rules (roles with
  hierarchies, per-record sharing, a reader scope narrower than "every
  owner") would be an authorization language; this is one named set per gate.
  `urlcode-store reassign` moves owned records and does not rewrite
  membership keys: a principal that changes id needs `removeMember` and
  `addMember`.

### Result-aware retries

- **Scope.** The stored key is the SHA-256 of the header value and the caller:
  the request principal when there is one (so a signed-in client's retry from
  another network address still replays, and another principal's identical key
  never collides), otherwise the network client the runtime attributed the
  request to. Keys are per collection. An anonymous mount has no stronger
  caller identity than the network client.
- **Fingerprint.** The SHA-256 of the method, the path and the body as
  canonical JSON (object keys sorted, so key order does not matter; empty for a
  request without one). `If-Match` is not part of it: it is a precondition of
  the first attempt, and a committed attempt's retry replays whatever
  `If-Match` it carries.
- **Replay.** A retry with a retained key and the same fingerprint writes
  nothing and answers the first answer's status (`201` with `Location`, `200`,
  or `204`) with the record **as it is now** and its current `ETag`, plus
  `Idempotency-Replayed: true`. A record since deleted, or moved out of the
  caller's scope, is the ordinary `404`, never recreated. This is the "current
  entity" replay #835 asks for, chosen over replaying a snapshot of the first
  response because the claim then holds no record values (a delete deletes the
  data; nothing is left in the claim table to leak or to size), and because the
  `ETag` a client gets from a replay is one its next `If-Match` can use. The
  cost: a retry after a later change sees the later state, not the first
  response body.
- **Reuse.** The same key with a different fingerprint is
  `422 idempotency_key_reused`; nothing is written.
- **Races.** The claim is read and written inside the write's `BEGIN
  IMMEDIATE` transaction, so of racing requests with one key exactly one runs
  the mutation and every other replays it, in one process and across
  connections to the same file.
- Only committed successes are retained. A refused request (`400`, `404`,
  `409`, `412`) or a failed one (`503`) claims nothing, so its retry is
  evaluated again against the current state.

### Host transactions

`ctx.get('store').transaction(work)` runs `work(tx)` inside one `BEGIN
IMMEDIATE` transaction and returns its result. `tx.records(name)` offers
`create`, `get`, `update`, `remove`, `transition` and `list` with exactly the
records export's rules (ownership scope by the principal passed, field
validation, quotas, `ifMatch`, `transitionOnly`, audit), synchronously. Every
write and its audit events commit together or not at all.

```js
// Moves value between two account records; the total never changes.
store.transaction(tx => {
  const accounts = tx.records('accounts');
  const from = accounts.get(null, fromId), to = accounts.get(null, toId);
  accounts.update(null, fromId, { available: from.record.available - amount }, { ifMatch: from.etag }); // minimum: 0 refuses an overdraft
  accounts.update(null, toId, { available: to.record.available + amount }, { ifMatch: to.etag });
});
```

- `work` must be synchronous. A returned promise is refused and everything it
  did is rolled back; `tx` refuses every call once `work` has returned, so a
  handle kept across an `await` cannot write outside the transaction.
  Transactions do not nest, and the ordinary records export cannot be used
  inside one.
- A `StoreError` thrown inside (a `412`, a `409`, a field error) or the caller's
  own error rolls everything back and is rethrown unchanged; a SQLite failure
  becomes `503 storage_unavailable`.
- It is trusted host code: reachable only from an operator-installed extension
  that requires the store, never from a route `function`, `middleware` or a
  `sandbox: true` route. `work` runs unsandboxed with full Node access, and the
  principals it passes are taken as given.
- It takes no `Idempotency-Key`: a host extension that serves retries keeps its
  own key, or uses a declared transition.

### Design decisions

**Authorization ordering.** The route's policies run first (for example
`auth: true` sets the principal). Then the store answers, in order: `401` on an
owned collection, a `by: others` transition or a gated one without a
principal; `403` for a
cross-origin write; `400` for a malformed `Idempotency-Key` or `If-Match`, a
key on a collection without `idempotency`, or a body problem it can see before
the database (JSON syntax, a body on a transition); `405` on a `readOnly`
collection. Inside the write transaction: for a gated transition the
membership check (`403 membership_required`); the retained key (`422` or a
replay); the record in the caller's scope (`404`, so another owner's record is
a missing one); for `by: others` the owner check (`403 own_record_refused`);
`If-Match` (`412`); the transition's `from` values
(`409 transition_conflict`); field validation (`400`); quotas (`409`); then
the write, the claim and the audit event.

**Conflict and no-mutation behavior.** Every refusal is thrown inside the
transaction before or instead of its writes and rolls it back: no record, no
claim and no audit event. Of concurrent transitions on one record exactly one
finds the `from` values and commits; the others answer `409`. Of concurrent
writes with one `If-Match`, exactly one commits; the others answer `412`.

**Persistence failure.** A failure at any statement (a full disk, a lock
another process held past the 2 second busy timeout, an injected trigger)
rolls back the record, the claim and the audit event together and answers
`503 storage_unavailable` with no detail. The tests inject the failure after
the record write, as a SQLite trigger on the claim and on a second record.

**Retention and migration.** A collection keeps its newest `maxKeys` claims (at
most 1000), evicted by count and never by time: an evicted key's retry runs
again. A claim is a fixed-size row (two hashes, a status, a record id), never
record values, and backups carry the retry history with the records. Schema
version 2 drops version 1 claims, which have no fingerprint. Transitions are
declarations: changing one changes the project revision and needs a new pin,
and changes no stored data.

**Operator capabilities.** The operator chooses the database path, pins the
revision that declares every transition, guards each `by: others` transition
and readers mount with its own route policy, maintains the membership
collections and installs the extensions that may call `transaction`. The store
adds no roles and no command to edit claims; `urlcode-store reassign` leaves
claims and membership keys as they are.

**One process and several.** Every guarantee here is a SQLite `BEGIN
IMMEDIATE` transaction on one database file, so it holds for every connection
to that file: the tests race retries and approvals from separate threads, each
with its own connection, as separate processes would. The supported deployment
is still one serving process (see [storage](#storage-and-concurrency-what-it-does-and-does-not-guarantee));
several hosts, network filesystems and clustered workers are unsupported, and
nothing spans the store and another database.

**Sandbox and targets.** The store declares `targets: ['node']`, so the aws
and vercel targets refuse it before serving. Transitions and retries are
served by the store itself and need no project code. `transaction` is trusted
extension code as described above; it is not offered to sandboxed code, and
nothing about it is sandboxed.

### What is not covered

The #835 counterexamples, and what serves each:

| Contract | Served by | Not built |
|---|---|---|
| Approval of another owner's pending request ([#843](https://github.com/jimhoyd-com/urlcode/issues/843)) | a `by: others` transition with `transitionOnly` state, gated by a membership collection; a readers mount for the pending list across owners ([the proof](../proofs/private-requests/README.md) has no application code) | audit of membership changes (a membership collection refuses `audit`); a CLI command for `addMember`/`removeMember` |
| Scheduling: exclusive half-open intervals, expected revision, rejected move keeps its slot | a host transaction (list, check overlap, create or `update` with `ifMatch`) | a declarative non-overlap constraint; an interval index (the check reads the caller's records, at most `maxRecords`) |
| Simulated credits: hold, commit, cancel across records, conserving the total | a host transaction (`minimum: 0` refuses an overdraft and rolls the whole transfer back) | a declarative transfer; `Idempotency-Key` on host transactions |
| Consent/capture coordination | a host transaction | cancelling pending records on a membership change declaratively |


## Field schema

Fields are typed `string`, `integer`, `number` or `boolean`, each optionally
`required`, with a `default` (not both), and per type: `minLength`/`maxLength`
(strings, hard cap 65,536), `minimum`/`maximum` (numbers), `enum`. The store owns
this schema and does not depend on request-body validation in core ([#254]).
Unknown fields are rejected. `id`, `createdAt` and `updatedAt` are reserved.

Limits per collection: up to 64 fields, `maxRecords` up to 10,000 (default
1,000), on an owned collection `maxRecordsPerOwner` up to `maxRecords`
([per-owner record limit](#per-owner-record-limit)), `maxRecordBytes` up to 65,536 (default 4,096), `pageSize` up to 200
(default 50), at most 32 collections per project, `readOnly: true` to refuse
writes through the record API — the store's own short-link click counter is
the one exception, described above. The request body is refused above
`maxRecordBytes` plus 4 KiB.

## Sorting and filtering

A collection opts in per field with two lists in its declaration:

```yaml
sortable: [title, priority]      # sort=<field> or sort=-<field> (descending)
filterable: [kind, done]         # <field>=<value>, equality only
```

- Every name must be a declared field (not `id`, `createdAt` or `updatedAt`),
  at most 8 per list, no repeats. A `string` field must have `maxLength` of at
  most 256 or an `enum`, so a value stays small enough to compare and to carry
  in a cursor. A field named `limit`, `cursor` or `sort` cannot be filterable.
  A bad declaration refuses activation.
- One sort field per request. Records order by that field, then by `id`, so the
  order is total and stable. `-` reverses the whole order, ties included.
  Numbers compare numerically, booleans `false` before `true`, strings by UTF-16
  code unit (not by locale). A record with no value for the field (an optional
  field never set) comes after every record that has one when ascending, and
  first when descending.
- Filters are exact equality on the declared type: `done=true`, `priority=3`
  (integers and numbers are parsed strictly, so `3.0` matches 3 and `0x10`
  does not parse), `kind=a`. At most 3 filters per request, each given once;
  a record without a value never matches. Filters combine with AND and with
  `sort`; `total` is the number of matches.
- Anything else is `400 invalid_query` with `fields` naming the key: an
  undeclared sort or filter name, a repeated key, a value that does not parse,
  an unrelated parameter such as `q`, more than 16 parameters. Names that are
  not plain identifiers are reported as `(unsupported name)`, and values are
  never echoed. Unknown query parameters are therefore refused rather than
  ignored on every collection, declared or not. There are no ranges,
  operators, text search, OR, nested paths or arbitrary expressions.
- A sorted page returns an opaque `next` cursor holding the sort field and
  direction and the position (value and `id`) of the page's last record. The
  next page is "the records after that position", so records inserted, deleted
  or edited between requests never make a page repeat a record or skip one that
  stayed put. A cursor works only with the sort that issued it (`400`
  otherwise). Without `sort`, `cursor` stays the numeric offset in creation
  order, filtered or not; there a delete between pages can shift later records
  up by one.
- An unsorted, unfiltered page is one counted `LIMIT`/`OFFSET` query. A sorted
  or filtered page reads the `id` and only the named fields of every record in
  scope (bounded by `maxRecords`, at most 10,000), orders and filters those in
  memory by the rules above, and then reads the page's records. On a shared
  collection sorting and filtering apply to every record; on an
  [owned](#per-record-ownership) one they apply to the caller's own records
  only, and `total` and cursors count only those.

## Per-record ownership

By default a collection is **shared**: every caller who reaches its mount lists,
reads and (unless `readOnly`) changes every record. A collection that holds
per-user data declares `ownership: owner` ([#331](https://github.com/jimhoyd-com/urlcode/issues/331)):

```yaml
extensions:
  store:
    version: "1"
    config:
      collections:
        notes:
          mount: /api/notes
          ownership: owner          # shared (the default) | owner
          fields:
            title: {type: string, required: true, maxLength: 200}
routes:
  /api/notes/*:
    extension: store
    methods: [GET, HEAD, POST, PUT, PATCH, DELETE]
    auth: true                     # required: a principal-providing policy
```

The owner is the request's **principal**: an opaque, stable id that a
principal-providing extension on the mount's route sets from its `authorize()`
([request principal](EXTENSIONS.md#request-principal)). With `auth` that is the
signed-in user's Better Auth id. The store never reads a
cookie, header or auth table itself, and it compares the id for equality only.

On an owned collection:

- `POST` stamps the caller's principal on the new record. The owner is stored in
  the database's `owner` column and never appears in a response; a body naming
  `_owner` is `400` like any undeclared field, and `PUT`/`PATCH` keep the stored
  owner. There is no transfer through the API; the operator can
  [move records](#moving-records-to-another-principal).
- `GET` lists only the caller's records: `total`, `limit`, `cursor`, sorting and
  filtering all work over that set, so a caller learns nothing about how many
  records other principals hold.
- A single-record `GET`/`HEAD`, `PUT`, `PATCH`, `DELETE` or increment on another
  principal's record answers exactly the `404 not_found` a missing id does,
  checked before `If-Match` and before the body, so neither a `412` nor a
  validation error confirms that it exists.
- A request with no principal is `401 principal_required` before any data is
  read, for every method. With `auth: true` auth itself answers first; this
  covers a policy that allowed the request without setting one.
- `Idempotency-Key` retention is scoped by principal, and a replay reads the
  record in the caller's scope.
- Activation refuses the collection when its mount's route carries no
  principal-providing policy (for example no `auth: true`), and refuses `key`
  (and so short links) on it: a collection-wide unique key would tell one
  owner that another already used a value, and a public short link cannot serve
  an owned record.

Limits that stay true on an owned collection: `maxRecords` still caps the whole
collection, and `409 collection_full` still tells any caller that it is full
(with or without `maxRecordsPerOwner`, enough principals together can fill it,
so size `maxRecords` for them); all owners' records share
one database and its one-writer-at-a-time transactions; the store is still trusted operator
code on one host, not a hostile multi-tenant boundary; and backups copy every
owner's records together. Read-only access for designated principals to every
owner's records is a [readers mount](#membership-gates-and-cross-owner-reads);
write access by an operator or support role is not modelled.

### Per-owner record limit

`maxRecords` caps the whole collection, so without more one principal could fill
an owned collection and every create would then answer `409 collection_full`
for everyone. An owned collection can also cap each principal
([#731](https://github.com/jimhoyd-com/urlcode/issues/731)):

```yaml
notes:
  mount: /api/notes
  ownership: owner
  maxRecords: 5000           # the whole collection (default 1,000)
  maxRecordsPerOwner: 100    # each principal
  fields:
    title: {type: string, required: true, maxLength: 200}
```

- A `POST` by a principal that already holds `maxRecordsPerOwner` records
  answers `409 owner_quota_exceeded` with a fixed message that states no count,
  no limit and no collection total. Deleting one of its own records frees a
  slot for that principal only.
- `maxRecords` stays the ceiling: a principal under its own limit still gets
  `409 collection_full` once the collection as a whole is full. A principal at
  its own limit is told `owner_quota_exceeded` first.
- `maxRecordsPerOwner` must be at most the collection's `maxRecords` (or its
  default of 1,000). Activation refuses it on a shared collection, where there
  is no owner to count.
- Only a create adds a record, and the limit is counted in the same database
  transaction as the create, so concurrent creates cannot overshoot it. A
  replayed `Idempotency-Key` answers the first create before anything is
  counted.
- The counts are an indexed count of the principal's rows at create time;
  nothing extra is stored. Records with no owner (see below) count toward the
  collection but toward no principal.
  `ownerless-assign` can leave a principal above its limit, and lowering the
  limit can too: the store still activates, the principal's existing records
  stay readable and changeable, and it cannot create more until it is back
  under the limit.

### Making an existing collection owned

Records written while a collection was shared carry no owner. After the
collection is declared `ownership: owner` they are served to **nobody**: they
are not listed, read, changed or deleted through the API, but they still count
toward `maxRecords`. The store never guesses an owner. The operator reports
them and then assigns them to one principal or deletes them. Each command is one
transaction on its own connection to the database, so it may run while the
server serves, which sees the change on its next request:

```sh
npx urlcode-store ownerless --database /srv/site/data/store.sqlite --collection notes
npx urlcode-store ownerless-assign --database /srv/site/data/store.sqlite --collection notes --owner <principal id>
npx urlcode-store ownerless-delete --database /srv/site/data/store.sqlite --collection notes
```

Each prints `{collection, records, ownerless, ids}` as JSON. `--owner` takes a
principal id exactly as the provider sets it (for auth, the user's Better Auth
id). The same operations are exported
from the package as `reportOwnerless`, `assignOwnerless` and `deleteOwnerless`.

Going back is refused: a collection declared shared whose database rows carry
an owner fails activation, because serving them shared would hand every user's
records to every caller. Clear the `owner` column deliberately (SQL, server
stopped) if that is really intended.

### Moving records to another principal

Records belong to the principal that created them. When that principal is
replaced, for example a user account that is recreated under a new id, its
records stay in the database but nobody can reach them. The operator moves them
([#732](https://github.com/jimhoyd-com/urlcode/issues/732)); run `--dry-run`
first to see the counts:

```sh
npx urlcode-store reassign --database /srv/site/data/store.sqlite --project /srv/site/app \
  --from <old principal id> --to <new principal id> --dry-run
npx urlcode-store reassign --database /srv/site/data/store.sqlite --project /srv/site/app \
  --from <old principal id> --to <new principal id>
```

- `--from` and `--to` are principal ids exactly as the provider sets them (for
  auth, a user's Better Auth id), validated
  with the same pattern core applies to a principal. The two must differ.
- `--project` is the site's route project (the `app/` directory). The command
  reads it through core's project loader to learn which collections are
  declared `ownership: owner` and each one's `maxRecordsPerOwner`; only those
  collections are touched. `--collection <name>` limits the move to one of them
  (a shared or undeclared name is refused). A declared collection that holds no
  records yet has nothing to move and is left out of the report.
- Only each record's owner changes. Records owned by anyone else, and records
  with no owner (see below), are left alone.
- It prints `{from, to, dryRun, moved, collections: [{collection, moved,
  toBefore, toAfter, maxRecordsPerOwner}]}` as JSON. `--dry-run` counts and
  writes nothing.
- **The per-owner limit is respected.** When moving would leave `--to` holding
  more than a collection's `maxRecordsPerOwner`, the whole command is refused,
  naming the collection and the counts, and no collection is changed (a dry run
  is refused the same way). Delete or move some of `--to`'s records first, or
  raise the limit. `maxRecords` is unaffected, since no record is added.
- It is one database transaction across every affected collection: all counts
  are checked, then every collection moves, and a failure part-way (a full disk,
  a lock held past the busy timeout) rolls all of them back. Like the
  `ownerless` commands it may run while the server serves.
- It does not touch `Idempotency-Key` retention, which is scoped by principal: a
  retry by `--to` with a key `--from` used is a new request, and a retry by
  `--from` of a write to a moved record replays as `404`.

The same operation is exported as `reassignOwner(database, {from, to,
collections, collection?, dryRun?})`, where `collections` is the declared
`extensions.store.config.collections`.

## Audited writes

A collection that declares `audit: true` records every write in the
[audit log](EXTENSIONS.md#audit-log). It needs the `audit` extension installed
and declared (the store `uses` it); without it, activation refuses:
`collection <name> declares audit: true; install the audit extension (urlcode
extensions add audit)`.

Audit's retention is one count shared by every audited collection, so writes
that need no credentials must not be able to fill it. An audited collection's
mount must therefore be guarded by a principal-providing policy (for example
`auth: true`), or activation refuses: `Collection <name>: audit: true
needs route <mount>/* guarded by a principal-providing policy`. A short-link
click is never audited: it is anonymous and unthrottled, and the counter it
bumps is not a privileged change.

```yaml
extensions:
  audit: {version: "1", config: {}}
  store:
    version: "1"
    config:
      collections:
        todos:
          mount: /api/todos
          ownership: owner
          audit: true
          fields:
            title: {type: string, required: true, maxLength: 200}
```

| Write | Action |
|---|---|
| `POST` | `store.record.created` |
| `PUT` | `store.record.replaced` |
| `PATCH` | `store.record.updated` |
| `DELETE` | `store.record.deleted` |
| increment (a keyed transition; never a short-link click) | `store.record.incremented` |

Each event's subject is `<collection>/<id>` and its actor the request
principal's id, or `anonymous` when the guarding policy set none. Its
metadata is `{collection, fields}`: the names of the declared fields the write
stored or changed, never their values, cut with `truncated: true` when the list
would exceed audit's metadata bound.

The event is inserted into the store database's outbox table
(`store_audit_outbox`) in the same transaction as the record, and audit drains
it into its log while the host runs (oldest first across collections, deleted
once audit has committed it). So a record and its event are stored together or
not at all, and an event survives a crash until it is delivered. Audit keeps its
own database: the store's transaction ends at its outbox, and delivery into the
audit log is a separate, idempotent step (audit ignores an id it already
holds). When 1000 events wait undelivered in one collection, the next write
answers `503 audit_backlog` and changes nothing until audit catches up. Turning
`audit` off keeps any undelivered events in the outbox. The operator's
`urlcode-store` ownership commands keep the outbox and add no event.

## Storage and concurrency: what it does and does not guarantee

- One SQLite database per site, through Node's built-in `node:sqlite`:
  `store({database})` in `host.mjs`, else `STORE_DATABASE`, else
  `data/store.sqlite` beside `host.mjs`. It must be outside the project
  (checked after symlink resolution). Its directory is created `0700` and the
  file `0600`; a symlinked, hard-linked or group- or other-readable file is
  refused. The store requires a SQLite with the fixes audit and abuse require
  too (3.44.6, 3.50.7, 3.51.3 or newer) and is Node only: its registration
  declares `targets: ['node']`, so the aws and vercel targets refuse it before
  serving.
- Every collection lives as rows of three shared tables, keyed by the
  collection name: `store_records` (one row per record; the declared fields are
  one JSON object, beside the `id`, timestamps, owner and unique key columns),
  `store_idempotency` (retained `Idempotency-Key` claims: the scoped key hash,
  the request fingerprint, the status and the record id, never record values) and
  `store_audit_outbox` (undelivered audit events). Collections are rows, not
  tables, so declaring, changing or removing a collection never changes the
  schema; the rows of a collection that is no longer declared stay untouched.
- The schema only moves forward. An empty file is initialized in one
  transaction; opening an up-to-date database changes nothing; a later release
  that changes the schema adds a step, and each step runs in its own
  transaction with the new version (`PRAGMA user_version`). A file that is not
  a store database (`PRAGMA application_id`) or comes from a newer release
  refuses activation. The JSON data files of earlier releases are not read or
  imported. Version 2 replaced the claim table for result-aware retries: claims
  a version 1 database retained carry no fingerprint and are dropped by the
  upgrade, so a retry of a request made before it runs again.
- Write-ahead log with `synchronous=FULL`: a write is answered only after a
  durable commit, and a crash leaves the last committed transaction.
- Every write is one `BEGIN IMMEDIATE` transaction that reads what it checks
  and writes everything it changes: the record, its unique key, the
  `Idempotency-Key` claim and eviction, and the audit event. Any failure rolls
  all of it back. `If-Match`, key uniqueness, `maxRecords`,
  `maxRecordsPerOwner`, increment bounds, retained keys and the audit backlog
  are therefore checked against committed state and cannot be overshot by
  concurrent requests. Statements are synchronous: within the process no other
  request runs between a transaction's checks and its commit, and each commit's
  fsync blocks the event loop while it runs.
- Nothing is cached in memory: every read queries the database. Activation
  still validates every stored record against the declaration and refuses a
  database that no longer matches it rather than serving bad data.
- **One process serves the database.** That is the supported and tested
  deployment. SQLite's file locks keep any other connection from corrupting it:
  the `urlcode-store` operator commands and an online backup run beside the
  server, reads are never blocked by a writer, and a write that finds another
  process holding the write lock waits up to 2 seconds (`busy_timeout`, blocking
  the server's event loop meanwhile) and then answers `503 storage_unavailable`
  with nothing written. Nothing refuses a second server over the same database,
  but that is not tested and not supported (the audit drain, for one, is woken
  only in the process that wrote the event). Network filesystems, several hosts
  and clustered workers are unsupported.
- Transactions span collections of this one database (`urlcode-store reassign`
  and [host transactions](#host-transactions) use that), but each HTTP request
  changes exactly one record: there is no multi-record or cross-collection
  operation in the HTTP API. Nothing is atomic across the store and another
  extension's database (auth, audit); none is claimed. There is no query language beyond paginated listing with declared
  sorting and equality filtering, and no history. Omitting `If-Match` remains
  last-write-wins for `PUT`/`PATCH`.
- This is durable local state, not a distributed exactly-once or
  external-delivery guarantee.
- Backups are the operator's. Either stop the server and copy `store.sqlite`
  (the last connection to close folds the write-ahead log into it), or take a
  consistent copy while it serves through SQLite's online backup API (for
  example `sqlite3 data/store.sqlite ".backup /backups/store.sqlite"`, or
  `backup()` from `node:sqlite`). Copying the file with ordinary tools while the
  server runs is not a consistent backup.

Errors never contain record values, SQL or filesystem paths.

### Reload

`urlcode dev` hot reloads by activating the edited project's runtime while the
running one keeps serving, and a rejected edit keeps the running one serving
(core's [reload hand-off](EXTENSIONS.md#reload-hand-off), issue #777). The
store's registration holds one database connection, opened by its first
activation and closed with its last, so it needs no hand-off:

- The replacement activation of the same registration is one more view over the
  same connection. Both read and write the same rows, so each sees the other's
  writes at once and there is never a second writer.
- If the reload fails, even in another extension after the store activated,
  the replacement's close drops only its reference: the serving store keeps the
  connection, its data and its records export. If the reload succeeds, the
  retired runtime's close drops only its reference. The connection closes with
  the last activation (shutdown).
- A changed collection declaration reloads too: the replacement validates every
  stored record against its new declaration (a record that no longer matches
  refuses the reload, as it would refuse a restart), and a changed `key`
  recomputes the stored key column in one transaction. While the retiring
  runtime finishes in-flight requests, a record it writes that the new
  declaration cannot represent makes the new view answer
  `503 storage_unavailable` for requests that read it instead of serving or
  overwriting it; restart to recover.
- Changing the host's `database` option needs a restart.

## Trust and operation

The store is trusted operator code. It is not sandboxed and is not a
multi-tenant boundary: every caller who can reach a shared collection's mount
sees the whole collection, so restrict the mount with `auth` (or another
policy) and keep per-user data in an [owned](#per-record-ownership) collection,
never a shared one. Changing collections or mounts changes the project revision and needs a new
operator pin. The mount responses are `no-store`.

## Catalog recipe

`urlcode recipes search "crud store persist"` finds `store-crud`
([recipes](RECIPES.md)), the same collection as above with ordered fixtures for
the whole create, read, update, delete lifecycle. It does not install anything:
`urlcode extensions add store` (or `init --with ui,auth,store`) installs the
extension and wires `host.mjs`; add `--example` for the `todos` collection.
Without `auth` the example needs `--ack store:public-write`.

## A screen for the collection

`npx @jimhoyd/urlcode init todo-site --with ui,auth,store --example` (or `--with ui,store --example --ack store:public-write`) also serves `/todos`, a
list with a create form, inline edit and delete. The store owns the screen: it
is declared under `extensions.store.config.screens`, next to the collection it
shows, so a Todo app declares its fields once and gets both the API and the
screen (per user when `auth` is installed, since the example collection is then
owned); add a field, re-review and re-pin, and it appears on both. The store
example writes the entry and the screen's route when `ui` is installed:

```yaml
extensions:
  store:
    version: "1"
    config:
      collections:
        todos: {mount: /api/todos, fields: {title: {type: string, required: true}}}
      screens:
        /todos: {collection: todos, title: Todos}
routes:
  /todos/*: {extension: ui, methods: [GET, HEAD]}
```

The `ui` extension renders it without reading the store's configuration: the
store's definition contributes a screen source to ui (`contributes.ui.screens`),
which resolves each screen to a generic `{title, collection: {mount, fields,
...}, columns?}` description when ui activates. A screen naming a collection the
store does not declare refuses at activation, and so does a screen path with no
`extension: ui` route. `ui` is an optional peer of the store: without it the
`screens` block is accepted but nothing serves it. `title` defaults to the
collection name.

The page is server-rendered escaped shell only; the browser loads the records
from the store's own `/api/todos` with the kit's `crud` script, served
content-hashed and loaded with the page nonce, under a strict CSP (`connect-src
'self'`, no inline script). Record values are only ever written as text. An
edit in progress survives a reload of the list, and a checkbox toggle that the
server refuses is rolled back. With `auth` composed, the screen route carries
`auth: true` like the API mount, which gates who can *reach* it — not who owns
which record. The screen is multi-user-safe **only for an
[owned](#per-record-ownership) collection**: it reads and writes through the
store's own API with the signed-in caller's session, so on a collection with
`ownership: owner` each user sees, edits and deletes only their own records. On
a shared collection (the default, and the `--example` `todos` when `auth` is
not installed) every
signed-in caller sees and edits the whole collection through this screen, so
it is a single-user or trusted-group surface; do not read `auth` on the route
as record-level access control there. Text
fields become inputs (a textarea above 200
characters), enums selects, numbers number inputs and booleans checkboxes;
labels come from the field names unless the screen sets `columns`
(`columns: [title, {field: done, label: Finished}]`) to choose, order and
relabel the fields shown. Details and limits are in the
[ui package README](../packages/ui/README.md#data-bound-screens).

## Using a collection from another extension

An extension that `requires: [store]` reaches declared collections through the
store's typed export, `ctx.get('store')` in its definition's `host()`
(`StoreExports`, contract version 1, #529), never by reading
`extensions.store.config`. Once the store is active (declare it first under
`extensions`), `records('<collection>')` returns the collection's `ownership`,
`readOnly` and declared `fields`, and four calls that take the request
principal (`request.principal`):

- `create(principal, values)` stamps the principal as owner on an owned
  collection;
- `get(principal, id)` returns a record in the principal's scope;
- `update(principal, id, patch, {ifMatch})` is a partial update (PATCH): a
  field set to `null` is [cleared](#clearing-a-field);
- `list(principal, {limit, cursor})` returns one page of the principal's scope
  in creation order, `{items, total, next?, previous?}`: `limit` is capped at
  the collection's `pageSize`, and `next` and `previous` are the cursors of
  the adjacent pages (a malformed cursor is `400 invalid_query`).

- `transition(principal, id, name, {ifMatch})` runs a
  [declared transition](#conditional-transitions-and-result-aware-retries)
  exactly as its HTTP endpoint does, without an `Idempotency-Key`, and
  through the same membership gate.

A [membership collection](#membership-gates-and-cross-owner-reads) has no
mount, so this export (and the operator's `addMember`) is how code maintains
it: `create(null, {userId})` adds a member.

`create`, `get`, `update` and `transition` return `{record, etag}` (a record
never includes its owner) and
applies exactly the JSON API's rules: another owner's record and a missing id
are the same `404`, no principal on an owned collection is `401`, field
errors are `400` with field names, `maxRecords` is `409 collection_full`, and
a stale `ifMatch` is `412`. Failures are `StoreError`s with the same status and
code as the HTTP answer. The export performs no request admission of its own:
the consumer handles CSRF and origins for the requests it serves.
[form-records](../packages/form-records/README.md) uses it to save a declared
form into an owned collection, with a confirmation, a constrained edit page
and an optional per-user list page. `transaction(work)` runs several of these
operations as one database transaction: see
[host transactions](#host-transactions).

## Not built yet

SQL ordering for sorted lists, a declarative interval (non-overlap)
constraint, a declarative multi-record transfer, roles beyond a
[membership collection](#membership-gates-and-cross-owner-reads) and screen
controls for transitions are not built
([#835](https://github.com/jimhoyd-com/urlcode/issues/835); the
[transition design](#what-is-not-covered) lists what each needs). Recorded in
[open decisions](OPEN-DECISIONS.md): ranges and text search, and richer screens beyond the first slice ([#262]): labels,
columns, sort and filter controls have all shipped
([#330](https://github.com/jimhoyd-com/urlcode/issues/330)). Owned collections
([#331](https://github.com/jimhoyd-com/urlcode/issues/331)) are owner-only apart from
[readers mounts](#membership-gates-and-cross-owner-reads): sharing one record with chosen principals and write access for managers or support are not
built.
