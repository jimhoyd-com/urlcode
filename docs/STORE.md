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
npx @jimhoyd/urlcode init todo-site --with store --example --ack store:public-write   # or --with auth,store --example: see below
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
          schema:
            type: object
            additionalProperties: false
            required: [title]
            properties:
              title: {type: string, minLength: 1, maxLength: 200}
              done: {type: boolean}
          defaults: {done: false}
          maxRecords: 1000
          maxRecordBytes: 4096
```

`schema` is the collection's [record schema](#record-schema): a JSON Schema
2020-12 object schema, validated by the same validator as a route's request
body schema.

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

With `auth` installed (`--with auth,store --example` in any order, or `urlcode
extensions add auth` before `store --example`) the example adds `auth: true` to
the API mount, so only signed-in callers reach it, and
declares the `todos` collection `ownership: owner`, so each signed-in user sees
and changes only their own todos ([per-record ownership](#per-record-ownership));
no acknowledgement is needed. `auth: true` admits the API's JSON writes with the
session cookie and same-origin provenance, and refuses a cross-origin write with
`403`. When `audit` is installed too, the example collection also declares
`audit: true` ([audited writes](#audited-writes)). Without `auth` the example
collection stays shared, because there is no principal to own a record.

Without `auth` the mount would be a public writable endpoint, so adding `store`
refuses, rolls back, and names the two ways forward: add
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
| `GET /api/todos?limit=&cursor=` | `200 {items, total, next?, may, etags}` in creation order; `limit` is capped at the collection `pageSize`, `cursor` is the offset from `next`, `may` maps each listed record's `id` to the [transitions the caller may run on it now](#what-the-caller-may-run), and `etags` maps it to its current [`ETag`](#conditional-writes) |
| `GET /api/todos?sort=-priority&kind=a&cursor=` | the same shape, sorted and filtered as [declared](#sorting-and-filtering); `total` counts the matches and `cursor` is the opaque `next` of a sorted page |
| `POST /api/todos` | `201` and the record, `Location: /api/todos/<id>` |
| `GET /api/todos/<id>` | `200` record with `ETag` and `Allow-Transitions` ([`may`](#what-the-caller-may-run) for that record), or `404` |
| `PUT /api/todos/<id>` | replaces every property (omitted ones take their default; `readOnly` ones keep their value), `200` |
| `PATCH /api/todos/<id>` | updates the named properties and removes those set to `null` ([clearing a property](#clearing-a-property)), `200` |
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
(`403`). Errors are `{error: {code, message, issues?, fields?, conflict?}}`; submitted
values are never echoed. A route's own body-schema `422` has the same
`{error: {code, message, issues}}` shape only when the site sets
`errors: {format: json}` for its path (code `UNPROCESSABLE_CONTENT`); otherwise
it is `{error: "body_validation_failed", message, issues}`. See
[one parser for runtime and store errors](HTTP.md#error-format). A record that breaks the [record schema](#record-schema)
is `422 invalid_record` with `issues`, the same bounded issue list (pointer,
keyword, message, `expected`, `property`) a route's body schema answers
([body schema](HTTP.md#body-schema-and-input-patterns)); like it, the validator
stops at the first failure. A list query is `400 invalid_query` with `fields`
mapping each offending parameter to a fixed message.
Status codes: `400` malformed JSON, header or query, `403` `own_record_refused` (a
`by: others` transition on the caller's own record), `404`, `405` with
`Allow`, `409` `collection_full` (or `owner_quota_exceeded` on an
[owned collection with a per-owner limit](#per-owner-record-limit),
`transition_conflict`, or `interval_conflict` with
[declared intervals](#non-overlapping-intervals)), `412` stale `If-Match`, `413` body or record too
large, `415`, `422` `invalid_record` or `idempotency_key_reused`, `503`
`storage_unavailable` when the database write failed, another process held its
lock past the busy timeout or a newer activation redeclared the collection
([fence](#several-serving-processes-on-one-host); nothing is written), `500` for anything unexpected
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
          schema:
            type: object
            additionalProperties: false
            required: [code, destination]
            properties:
              code: {type: string, minLength: 1, maxLength: 32}
              destination: {type: string, format: uri}
              clicks: {type: integer, minimum: 0}
          defaults: {clicks: 0}
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

- `key` names one required string property whose schema caps it at 128
  characters (`maxLength`), with no default and not in `readOnlyProperties`. A create
  atomically claims that caller-supplied value; a duplicate is `409 key_exists`.
  Updating a key is allowed only when the replacement is unused. Keys remain
  collection-local; they are not routing or authorization principals.
- `increments` lists numeric properties with numeric defaults. `POST
  /api/links/<uuid>/increment/clicks` increases exactly one declared property
  by one in one database transaction. It refuses undeclared counters, and an
  increment the property's schema refuses (its `maximum`, `multipleOf` and so
  on) is `409 increment_limit` with the schema issue. There is no caller-provided delta, conditional expression or
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

A `shortLinks` entry combines a collection's unique key, one **required**
string destination property with `format: uri` (anything else refuses
activation), and one declared counter. `format: uri` admits any scheme, so the
short link adds its own rule to every write of the destination, from every
path: an absolute HTTP(S) URL without credentials or ASCII whitespace/control
characters, `422 invalid_record` otherwise. `GET
/go/<code>` atomically increments the counter and answers `302 Location:` with
the stored destination; a missing key is `404`, and so is a record whose
destination is unset or not such a URL (only reachable from data written before
the short link was declared). `HEAD /go/<code>` resolves and answers the same `302`
without counting a click — only `GET` does. Its public redirect mount is
separate from the private CRUD mount, so protect either mount according to the
application's own access model. No function is required for the create,
invalid-destination, redirect, missing-code or click-count flow. The click
counter keeps incrementing even when the collection is declared `readOnly`:
that flag closes the public create/update/delete/increment surface on the
CRUD mount, not the redirect's own bookkeeping, so a link collection can be
`readOnly` for callers while still counting its own clicks ([#552]).

## Clearing a property

`PATCH` changes only the properties its body names. A property set to `null`
is removed from the record, so an optional one can be emptied after it was
saved (#738):

```http
PATCH /api/todos/<id>
Content-Type: application/json

{"priority": null, "done": true}
```

- The record left after the patch must satisfy the schema, so clearing a
  `required` property is `422 invalid_record` with the `required` issue
  (`is missing required property <name>`). `null` for an `increments`
  property is `422` with `is an increment property and cannot be cleared`, and
  `null` for an undeclared name is the `additionalProperties` issue. Nothing is
  written.
- A property with a `default` that is not `required` can be cleared too: the
  record then has no value for it. The default applies again only on a later
  `PUT`.
- A body that only clears properties is a change, even when they were already
  absent: `updatedAt` and the `ETag` move. An empty body is `422` (`must set or
  clear at least one property`).
- `If-Match`, ownership scoping and the schema apply exactly as to any `PATCH`.
- `PUT` is unchanged: it replaces the record from values only, and `null` is
  refused as the property's wrong type.

## Conditional writes

A single-record `GET`/`HEAD` on a collection's own CRUD mount returns a
strong `ETag`, as does the response to a `POST`, `PUT` or `PATCH`. A list
(on the collection mount or a [readers mount](#membership-gates-and-cross-owner-reads))
carries the same value for each listed record in `etags`, keyed by `id`, so a
client can make a write conditional on the version it listed without reading
each record first. Send that
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

1. **Declared transitions**: a named change of one record from exact property
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
    schema:
      type: object
      additionalProperties: false
      required: [userId]
      properties:
        userId: {type: string, maxLength: 128}
  requests:
    mount: /api/requests
    ownership: owner
    idempotency: {maxKeys: 1000}
    schema:
      type: object
      additionalProperties: false
      required: [title]
      properties:
        title: {type: string, maxLength: 120}
        status: {type: string, enum: [pending, approved, withdrawn]}
        reviewedBy: {type: string, maxLength: 128}
        reviewedAt: {type: string, maxLength: 32}
    defaults: {status: pending}
    readOnlyProperties: [status, reviewedBy, reviewedAt]
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
    readers:
      review: {mount: /api/review, members: reviewers}   # GET /api/review?status=pending
routes:
  /api/requests/*: {extension: store, methods: [GET, HEAD, POST, PUT, PATCH, DELETE], auth: true}
  /api/approvals/*: {extension: store, methods: [POST], auth: true}
  /api/review/*: {extension: store, methods: [GET, HEAD], auth: true}
```

### Declared transitions

- `from` names 1 to 8 declared properties and the exact value each must hold
  now; `set` names 1 to 8 properties and the constant each gets; `stamp` names
  up to 4 string properties the store fills with `actor` (the principal's id,
  or `anonymous`) or `now` (the commit time, equal to the new `updatedAt`).
  Activation checks every value against its property's schema, refuses `set`
  or `stamp` on the collection `key`, a property both set and stamped, a stamp
  property that could not hold its value (a string with `maxLength` at least
  128 for `actor` and 24 for `now`, and no `enum`, `const`, `pattern`,
  `format`, `multipleOf` or composition keyword), and the name `increment`.
- `POST <mount>/<id>/<name>` takes no body (`400 body_not_allowed`), an
  optional `If-Match` and an optional `Idempotency-Key`, and answers `200` with
  the record and its new `ETag`. It is a write: the same-origin rule,
  `readOnly`, `maxRecordBytes` and `audit: true` apply exactly as to `PATCH`.
  An audited transition is recorded as `store.record.transitioned` with the
  transition's name and the changed property names.
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
- A property the collection lists in `readOnlyProperties` (published as the
  standard JSON Schema `readOnly` annotation: the value is managed by the
  store) changes only through a transition's `set` or `stamp`: a create stores
  its default (or leaves it unset), `PUT` keeps its current value, and any body
  naming it is `422 invalid_record` with the issue `is changed only by a
  transition` (keyword `readOnly`). Without it, the owner in the example could
  `PATCH` `status: approved` and skip the review. Activation refuses it on the
  key or an increment property, when it is `required` without a default, and
  when no transition sets or stamps it.

### Edit and delete states

`readOnlyProperties` keeps the state itself out of a body, but the owner could
still change the rest of the record: after approval, `PATCH` `{"amount":
99999}` left the record `approved` with its reviewer's stamp, vouching for an
amount nobody reviewed, and `DELETE` erased the decision
([#952](https://github.com/jimhoyd-com/urlcode/issues/952)). A collection
declares the states in which a body may change a record and in which it may be
deleted:

```yaml
requests:
  mount: /api/requests
  ownership: owner
  schema:
    type: object
    additionalProperties: false
    required: [title, amount, status]
    properties:
      title: {type: string, minLength: 1, maxLength: 120}
      amount: {type: integer, minimum: 1, maximum: 100000}
      status: {type: string, enum: [draft, pending, approved, rejected]}
      reviewedBy: {type: string, maxLength: 128}
      reviewedAt: {type: string, maxLength: 32}
  defaults: {status: draft}
  readOnlyProperties: [status, reviewedBy, reviewedAt]
  editable: {status: draft}                  # PUT and PATCH only while a draft
  deletable: {status: [draft, rejected]}     # DELETE only a draft or a rejected request
  transitions:
    submit: {from: {status: draft}, set: {status: pending}}
    withdraw: {from: {status: pending}, set: {status: draft}}
    approve: {from: {status: pending}, set: {status: approved}, stamp: {reviewedBy: actor, reviewedAt: now}, by: others, mount: /api/approve, members: reviewers}
    reject: {from: {status: pending}, set: {status: rejected}, stamp: {reviewedBy: actor, reviewedAt: now}, by: others, mount: /api/reject, members: reviewers}
```

- **The shape** is a transition's `from`: each named property and the value it
  must hold, or a list of values it may hold (`{status: [draft, rejected]}`);
  with several properties the record must match every one. Activation
  requires each property to be listed in `readOnlyProperties`, so only a
  transition moves a record into or out of the state (a body could otherwise
  unlock the record, or lock itself), and each value to satisfy its schema.
  Not on a membership collection or a `readOnly` one.
- **The refusal.** Outside `editable`, `PUT` and `PATCH` answer
  `409 record_locked`; outside `deletable`, `DELETE` does. Nothing is written.
  The check reads the record inside the write's `BEGIN IMMEDIATE`
  transaction, after the scope (`404`) and `If-Match` (`412`) and before the
  body, so a transition committing first always wins and the answer names no
  state. It applies to every path that edits or deletes a record: HTTP,
  `StoreExports.update`, and a host transaction's `update` and `remove` (which
  roll the whole transaction back).
- **What it leaves alone.** A create takes every writable property as before
  (the state comes from `defaults`), and transitions, increments and transfers
  have their own rules: a transfer still moves a locked wallet's balance, and
  `submit`/`withdraw` are how the owner leaves and re-enters `draft`. The
  operator's `urlcode-store ownerless-delete` is not gated.
- **The hint.** On a collection declaring either, a record's `GET`/`HEAD` and
  the answer to its `PUT`/`PATCH` carry `Allow` with the methods it takes now
  (`GET, HEAD, PUT, PATCH, DELETE` for a draft, `GET, HEAD` once approved), and
  a list on the collection mount carries `allow: {<id>: [methods]}` beside
  `may`, so a client hides Edit and Delete for a locked record. Like `may`, it
  is a hint the write checks again under its lock.

`If-Match` on `approve` protects a reviewer from approving a version they did
not read; `editable` is what keeps the approved version as it was.

The [`store-approval` recipe](../recipes/store-approval/README.md)
(`urlcode recipes add store-approval`) is this collection with a reviewers
queue on a readers mount (`showOwner: true`) and fixtures for the whole
workflow, YAML only.

### Membership gates and cross-owner reads

Identity comes from the principal-providing policy (with `auth`, the Better
Auth user id); permission is application data keyed by that id, in the store
itself ([#863](https://github.com/jimhoyd-com/urlcode/issues/863)). The store
still has no roles, and `auth` gains none.

- **A membership collection** declares `membership: true` and a `key`: one
  record per member, whose key property holds the member's principal id (a
  value that is not a principal id is `422 invalid_record`, `must be a
  principal id`). It reuses the
  unique-key machinery instead of a new table, so membership is one indexed
  lookup inside the request's own transaction. It has **no mount and no HTTP
  API**: a membership list served on a collection mount would let anyone the
  route admits add themselves or enumerate members. Activation therefore
  refuses it with `mount`, and with `ownership`, `transitions`, `readers`,
  `increments`, `idempotency`, `sortable`, `filterable` or `readOnly`. A member is added and removed, never renamed: an
  update that changes the key property is `422 invalid_record`.
- **Maintaining it** reuses the operator paths the store already has, not a new
  admin surface. The operator runs `urlcode-store members` (below), or calls
  `addMember`, `removeMember` and `listMembers` from `@jimhoyd/urlcode-store`.
  Each is one transaction on its own connection, safe while the server is
  serving, and validated against the project's declared collections like
  `reassignOwner`; adding creates the database for a site that has not served
  yet. Trusted extension code uses
  [`StoreExports`](#using-a-collection-from-another-extension):
  `records('reviewers').create(null, {userId})`, and `remove` inside a
  [host transaction](#host-transactions).

  ```sh
  npx urlcode-store members add --database /srv/site/data/store.sqlite \
    --project /srv/site/app --collection reviewers --principal <user id>
  npx urlcode-store members remove ... --principal <user id>
  npx urlcode-store members list --database /srv/site/data/store.sqlite \
    --project /srv/site/app --collection reviewers
  ```

  Each prints JSON: `{collection, principal, changed}` (`changed` is `false`
  when the principal already was, or was not, a member) or
  `{collection, members}` in the order they were added. `--principal` must be
  a principal id exactly as the principal provider sets it (for auth, the user
  id; for a bearer key, `apikey:<key id>`); anything else is refused and not
  echoed. For an auth user, `npx urlcode-auth find-user --email <email>` in the
  site prints that id (`{"event":"user-found","id",…}`), including for a user
  who signed themselves up.
- **In tests** the members come from the project's `tests/seed.json`, written
  as `members add` writes them before the first fixture of every `urlcode test`
  and `audit` run, on that run's own fresh database:
  `{"store": {"members": {"reviewers": ["alice"]}}}` (principal ids by
  membership collection; a collection that is not `membership: true` is
  refused). See [test data and seeds](READINESS.md#test-data-and-seeds).
- **Membership changes are evidence** ([#866](https://github.com/jimhoyd-com/urlcode/issues/866)).
  A membership collection may declare `audit: true`. Then every added member
  is recorded as `store.membership.added` and every removed one as
  `store.membership.removed`, with subject `<collection>/<principal id>`,
  metadata `{collection}` and the actor of the change: `operator` (or the
  command's [`--actor`](#operator-attribution)) for `urlcode-store members`
  and `reassign`, or the principal a `StoreExports` caller passed
  (`anonymous` for `null`). Whichever path makes the change, the
  event is inserted into the outbox **in the same transaction** as the member
  row, so a grant or revocation and its event commit or roll back together; at
  the backlog cap the change is refused with `503 audit_backlog`. The operator
  command validates the event with audit's own validator and needs the audit
  package installed beside the store; the serving process's audit drain picks
  the event up on its next poll (within a second), because nothing in the CLI
  can wake it. *Why this shape:* the audited-write path already guarantees
  "the change and its event together", and every path that changes membership
  (the CLI, the library functions and `StoreExports`) goes through it. Having
  only the CLI write events would miss changes made by trusted extension code
  and would need a second, separate atomicity argument. An unaudited
  membership collection records nothing, as before; declare `audit: true` on
  every membership list whose history you need.
- **A gated transition** adds `members: <membership collection>`. The order is
  principal (`401`), then membership (`403 membership_required`), then
  everything in [the ordering below](#design-decisions), starting with the
  retained `Idempotency-Key`. The membership check is the first statement of
  the write transaction, before any record of the collection is read. A
  non-member therefore gets the same `403` for an existing id and a missing
  one, and a removed member's retry is refused rather than replayed.
  `by: others` still refuses the owner, member or not (`403
  own_record_refused`). Host transactions pass the same gate.
- **A gated create** ([#929](https://github.com/jimhoyd-com/urlcode/issues/929))
  declares `create: {members: <membership collection>}` on the collection.
  `POST <mount>` then needs a principal (`401 principal_required`, a shared
  collection included) and a member: the membership check is the first
  statement of the write transaction, before the body is judged, the retained
  `Idempotency-Key` is read or any record is counted, so a non-member's `403
  membership_required` is the same whatever the body, and a removed member's
  retry is refused rather than replayed. `StoreExports` (`records(name).create`)
  and a host transaction's `create` pass the same gate with the principal they
  are given. It gates creating only: reading, updating and deleting stay what
  ownership and the route's policy make them. Not on a membership collection
  or a `readOnly` one.

  ```yaml
  collections:
    staff: {membership: true, key: userId, schema: {type: object, additionalProperties: false, required: [userId], properties: {userId: {type: string, maxLength: 128}}}}
    bookings:
      mount: /api/bookings
      ownership: owner
      create: {members: staff}   # a signed-in non-member gets 403 and nothing is written
      schema: {type: object, additionalProperties: false, required: [title], properties: {title: {type: string, maxLength: 80}}}
  ```
- **Cross-owner reads.** An owned collection may declare named readers
  mounts, `readers: {<name>: {mount, members}}`. Members then list and read
  **every** owner's records, read-only, on that separate mount: `GET <mount>` takes the
  collection's `limit`, `cursor`, `sort` and filters (so `?status=pending` is
  a review queue), and `GET <mount>/<id>` reads one record with its `ETag`.
  Any other method is `405`. The mount needs its own route with a
  principal-providing policy. The principal and membership come first, in the
  same read transaction as the read, before the query is parsed or any record
  is read. A non-member gets one `403` for the list, an existing id, a missing
  id and a malformed one. Records with no owner are left out, and owners keep
  their own view on the collection mount. The stored owner is not shown unless
  the mount declares `showOwner: true` (below).
- **Seeing the requester.** With `readers: {review: {mount, members, showOwner: true}}`,
  every record the readers mount answers carries `_owner`: the owner's
  principal id, the same opaque id the store stamped on create (for auth, the
  Better Auth user id; never an email or a name). It is shown on the readers
  mount only. The owner's own mount, transition answers (the `by: others`
  approval included) and `StoreExports` never show it, and a non-member still
  gets the `403` before anything is read. It is off by default: a member who
  can list every owner's records already sees their content, and `showOwner`
  adds a stable cross-record link to one account. To show something a reviewer
  can act on (a display name, a team), keep it in an ordinary declared property
  that the owner writes; see [the store's security notes](../packages/store/SECURITY.md).
- **A projection, and a directory.** A readers mount's
  `properties: [<property>, ...]`
  ([#929](https://github.com/jimhoyd-com/urlcode/issues/929)) narrows that
  mount to what it lists. Each record is answered as `id`, the listed
  properties and (with `showOwner`) `_owner`: no `createdAt`, `updatedAt` or
  unlisted property. Sort and filters take only listed properties; any other is
  `400 invalid_query`, even when the collection declares it `sortable` or
  `filterable`, because an order or a match would disclose it. `may` lists only
  transitions whose `from` names listed properties only. The `ETag` (and each
  `etags` entry) is the hash of what the mount shows, so it changes only when a
  shown property does; it is not the record's own `ETag`, which moves on every
  write, a transfer included, and would tell every reader when a hidden
  balance moved. With `properties`, `members` may be left out: then every
  principal the mount's route admits reads the projection (`401` without one).
  That is the directory a transfer needs:

  ```yaml
  # snippet: partial -- one collection, the rest as in declared transfers
  wallets:
    mount: /api/wallets
    ownership: owner
    filterable: [name]
    # ...schema, defaults, readOnlyProperties and transfers as in declared transfers below
    readers:
      directory: {mount: /api/directory, properties: [name]}   # GET /api/directory?name=bob -> {items: [{id, name}]}
  # and the route: /api/directory/*: {extension: store, methods: [GET, HEAD], auth: true}
  ```

  A sender finds the recipient's wallet id by name and pays it; no balance,
  timestamp or other property of anyone's wallet is shown, and a balance moving
  does not change the directory's answer. It still shows the listed values, how
  many owned records exist (`total`) and which ids exist, to every signed-in
  principal; list only what every user may know, and add `members` when that
  is too much. *Why this shape:* it reuses the readers mount (one read path,
  one gate, the same query rules) rather than adding a second kind of mount,
  and it keeps transfers addressed by record id, so a transfer never has to
  resolve an owner or a handle inside its transaction. A readers mount
  with neither `members` nor `properties` is refused: an ungated mount must say
  what it shows.
- **Several mounts, one collection.** `readers` is a map of named mounts
  ([#944](https://github.com/jimhoyd-com/urlcode/issues/944)), each with its
  own `mount`, `members`, `showOwner` and `properties`, so a collection can
  serve a directory to everyone and whole records to a few:

  ```yaml
  # snippet: partial -- one collection, the rest as in declared transfers
  wallets:
    mount: /api/wallets
    ownership: owner
    filterable: [name]
    sortable: [name, balance]
    readers:
      directory: {mount: /api/directory, properties: [name]}           # every signed-in principal: id and name
      audit: {mount: /api/audit, members: treasurers, showOwner: true}  # treasurers: whole records and owners
  # routes: /api/directory/* and /api/audit/*, each {extension: store, methods: [GET, HEAD], auth: true}
  ```

  Each mount keeps its own rules: its gate is checked first on it alone, a
  projection's sort, filters, `may` and `ETag` are its own (the directory above
  refuses `?sort=balance` while the audit mount takes it), and a whole-record
  mount answers the record's own `ETag`. Two readers of one collection may not
  share a mount, and no readers mount may be the collection's, a transition's
  or another store mount. The name identifies the mount in activation errors
  and OpenAPI schema names; it is not part of any URL. *Why a map rather than a
  list:* a name gives every mount a stable identity in diagnostics and in the
  declaration fingerprint without depending on order, as `transitions` and
  `transfers` already do.
- **Changes apply immediately.** Membership is read inside each gated
  request's transaction, so an addition or removal committed before a request
  begins applies to it; there is no cache. Of concurrent approvals by members
  exactly one commits, as for any transition.
- **Activation** refuses a `members` (on a transition, a transfer, `create` or
  a readers mount) naming a collection that is not declared or is not a
  membership collection, `readers` on a shared collection, a readers mount on a
  mount that another store mount (another readers mount included) already
  uses, and a readers mount's `properties` naming an undeclared property. The
  message names the mount (`readers audit: ...`).
- **Why this shape.** Only `members` on a transition, a transfer and `create`,
  `readers` on a collection and `membership: true` are new. Richer rules (roles with
  hierarchies, per-record sharing, a reader scope narrower than "every
  owner") would be an authorization language; this is one named set per gate.
  [`urlcode-store reassign`](#moving-records-to-another-principal) moves a
  principal's membership together with its owned records.

### What the caller may run

Every HTTP answer that carries records says which declared transitions the
caller may run on each of them right now, so a client offers only what the
store would accept:

- **A list** (the collection mount or a readers mount) carries
  `may: {<id>: [transition names]}`, with an entry for every listed record
  (an empty array when none applies) and nothing for records off the page.
- **One record** (`GET`/`HEAD <mount>/<id>`, a readers mount's
  `GET <mount>/<id>`, and the answer to a create, `PUT`, `PATCH`, increment or
  transition) carries the same list in the `Allow-Transitions` header, beside
  its `ETag`: the names separated by `, `, and an empty value when none
  applies. A write's answer is computed for the record as the write left it.
  A `204` (a delete) carries neither.
- **What decides it** is what the transition itself checks, read in the same
  transaction as the records: the record holds every `from` value; `by: owner`
  needs the caller to own it; `by: others` needs it to be someone else's (so
  a reviewer's own request never lists `approve`); a `members` gate needs the
  caller in that membership collection; a `readOnly` collection runs none.
  The names are the collection's whole set, whichever mount serves each one, so
  a member's own record on a readers mount lists its `by: owner` transitions.
  A [projected](#membership-gates-and-cross-owner-reads) readers mount leaves out
  a transition whose `from` names a property it does not show.
- **Bounded.** The caller's membership is looked up at most once per distinct
  gate per answer, and only when some listed record could take a gated
  transition, never once per record. The answer grows with the page (at most
  `pageSize` records times 16 transitions).
- **Privacy.** Only the caller's own membership is read, and the answer never
  names a gate, a membership collection or another principal. What a caller
  learns is whether they themselves are in a gate, which the `403` of the
  transition already tells them. A caller with no principal (a shared
  collection on an unauthenticated mount) is offered only transitions that
  need none: an ungated transition of a shared collection. No gate is
  evaluated for them.
- **A hint, not a grant.** A membership change or another caller's write can
  make it stale a moment later; the transition still checks everything again
  in its own transaction. Trusted code (`StoreExports`) does not get `may`.
- **Edits and deletes** are not transitions: with
  [`editable` or `deletable`](#edit-and-delete-states) a record's `Allow`
  header and a list's `allow` name the methods it takes now.

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
  `409`, `412`, `422`) or a failed one (`503`) claims nothing, so its retry is
  evaluated again against the current state.

### Host transactions

`ctx.get('store').transaction(work)` runs `work(tx)` inside one `BEGIN
IMMEDIATE` transaction and returns its result. `tx.records(name)` offers
`create`, `get`, `update`, `remove`, `transition`, `transfer` and `list` with
exactly the records export's rules (ownership scope by the principal passed, the record
schema, quotas, `ifMatch`, `readOnly` properties, audit), synchronously. Every
write and its audit events commit together or not at all. The example below
is the shape of such code; moving value between two records of one collection
needs none, since a [declared transfer](#declared-transfers) does it.

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
- A `StoreError` thrown inside (a `412`, a `409`, a `422` schema issue) or the caller's
  own error rolls everything back and is rethrown unchanged; a SQLite failure
  becomes `503 storage_unavailable`.
- It is trusted host code: reachable only from an operator-installed extension
  that requires the store, never from a route `function`, `middleware` or a
  `sandbox: true` route. `work` runs unsandboxed with full Node access, and the
  principals it passes are taken as given.
- **Retries** ([#902](https://github.com/jimhoyd-com/urlcode/issues/902)).
  `transaction(work, {idempotencyKey, fingerprint})` makes it retry-safe, the
  way `Idempotency-Key` makes an HTTP write retry-safe:

  ```js
  // POST /transfers with an Idempotency-Key header, served by a host extension.
  let ran = false;
  const result = store.transaction(tx => { ran = true; /* the transfer, as above */ return { from: fromId, to: toId, amount }; },
    { idempotencyKey: `transfers:${principal.id}:${headerKey}`, fingerprint: canonicalBody });
  // ran === false: a replay; answer it with Idempotency-Replayed: true.
  ```

  - The claim is read under the transaction's write lock, so of racing calls
    with one key exactly one runs `work`, in one process and across
    connections to the same file.
  - A committed call keeps, in the same transaction, the SHA-256 of the key,
    the SHA-256 of the fingerprint (absent is the empty string) and `work`'s
    return value as JSON. A later call with the key and the same fingerprint
    returns a copy of that value without running `work` or writing anything
    (no record, no audit event); a different fingerprint is
    `422 idempotency_key_reused`.
  - The value is a **snapshot**, unlike the HTTP replay's current record: a
    host transaction can return anything, so there is no one record to read
    again. It must be a JSON value (or `undefined`) that JSON keeps exactly (a
    `Date`, a `Map`, `NaN` or a class instance is refused) and at most 16 KiB
    serialized (`TRANSACTION_RETRIES.resultBytes`); otherwise the call throws
    and nothing it did is committed. Return ids and the values the caller
    must see again, not whole records: a kept result outlives a later change
    or delete of the records it names.
  - A call that throws (a `StoreError`, the caller's own error, a `503`)
    keeps nothing, so its retry runs again.
  - Keys are one namespace for the whole store database, not per collection:
    prefix a key with the caller's own scope (the extension, the principal),
    as the HTTP API scopes a header value to the principal. The newest 1000
    keys are kept (`TRANSACTION_RETRIES.keys`), evicted by count; an evicted
    key's retry runs again. Claims survive a restart and are carried by a
    backup (schema version 4, table `store_transaction_results`).

### Design decisions

**Authorization ordering.** The route's policies run first (for example
`auth: true` sets the principal). Then the store answers, in order: `401` on an
owned collection, a `by: others` transition, a gated one or a gated create
without a principal; `403` for a
cross-origin write; `400` for a malformed `Idempotency-Key` or `If-Match`, a
key on a collection without `idempotency`, or a body problem it can see before
the database (JSON syntax, a body on a transition); `405` on a `readOnly`
collection. Inside the write transaction: for a gated transition or create the
membership check (`403 membership_required`); the retained key (`422` or a
replay); the record in the caller's scope (`404`, so another owner's record is
a missing one); for `by: others` the owner check (`403 own_record_refused`);
`If-Match` (`412`); the transition's `from` values
(`409 transition_conflict`), or for `PUT`, `PATCH` and `DELETE` the
[edit and delete states](#edit-and-delete-states) (`409 record_locked`); the record schema and the interval rules
(`422 invalid_record`); quotas and [unique values](#a-directory-by-a-unique-handle) (`409`); the
[interval check](#non-overlapping-intervals) (`409 interval_conflict`); then
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
the record write, as a SQLite trigger on the claim and on a second record, and
fill the database and the filesystem
([the disk-full tests](#what-the-disk-full-tests-prove)).

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
claims as they are and moves membership with the owned records.

**One process and several.** Every guarantee here is a SQLite `BEGIN
IMMEDIATE` transaction on one database file, so it holds for every connection
to that file: the tests race retries and approvals from separate threads, each
with its own connection, run the declaration fence across real child
processes, and race idempotency, a transition, transfers and intervals across
three real `urlcode serve` processes over HTTP
([the harness](#what-the-multi-process-harness-proves)). Several serving processes on one host, on one release, are
supported ([several serving processes](#several-serving-processes-on-one-host));
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
| Approval of another owner's pending request ([#843](https://github.com/jimhoyd-com/urlcode/issues/843)) | a `by: others` transition with `readOnly` state, gated by a membership collection; [`editable` and `deletable`](#edit-and-delete-states) keep the owner from changing or deleting what was approved (maintained with `urlcode-store members`, audited with `audit: true`); a readers mount for the pending list across owners, showing the requester's id with `showOwner` ([the proof](../proofs/private-requests/README.md) has no application code) | a requester reference other than the opaque principal id (a display name stays an application field) |
| Scheduling: exclusive half-open intervals, expected revision, rejected move keeps its slot | a declared [`intervals`](#non-overlapping-intervals) constraint checked through an index, across owners on an owned collection, with `If-Match` and transitions (cancel, reopen); fixed-length, aligned slots with `length` and `step` (and `origin` for a fixed-offset local grid); members-only booking with `create.members`; no application code | recurring intervals, capacity above one per slot |
| Simulated credits: move value between records, conserving the total | a [declared transfer](#declared-transfers) (`409 insufficient_balance` below its floor, `If-Match`, `Idempotency-Key`, both records audited in one transaction; a members-gated issuer brings value in); the recipient's id from a [projected readers mount](#membership-gates-and-cross-owner-reads) that shows no balance, looked up by a [unique handle](#a-directory-by-a-unique-handle); no application code | holds (a second property on the same record, settled later) still need a [host transaction](#host-transactions), retry-safe with an idempotency key |
| Consent/capture coordination | a host transaction | cancelling pending records on a membership change declaratively |

[#902](https://github.com/jimhoyd-com/urlcode/issues/902) tracked this contract;
sorted lists are ordered in SQL since
[#951](https://github.com/jimhoyd-com/urlcode/issues/951), and the plumbing the
declared intervals and transfers save is
[measured in the framework guide](FRAMEWORK.md#plumbing-removed-by-intervals-and-transfers).
A `SIGKILL` and a full disk have their evidence
([the harness](#what-the-multi-process-harness-proves),
[the disk-full tests](#what-the-disk-full-tests-prove)).


## Non-overlapping intervals

A collection may declare that its records hold intervals that must not overlap
([#902](https://github.com/jimhoyd-com/urlcode/issues/902)): room bookings,
appointment slots, shifts. The store checks it inside every write's
transaction, through an index, with no application code. It replaces the host
transaction the scheduling counterexample of #835 needed, which could only
see the caller's own records.
The [`store-booking` recipe](../recipes/store-booking/README.md)
(`urlcode recipes add store-booking`) is this declaration with one-hour
`length` and `step`, a staff-only `create: {members: …}` and fixtures.

```yaml
collections:
  bookings:
    mount: /api/bookings
    ownership: owner
    schema:
      type: object
      additionalProperties: false
      required: [room, start, end]
      properties:
        room: {type: string, maxLength: 40}
        start: {type: string, format: date-time}
        end: {type: string, format: date-time}
        status: {type: string, enum: [booked, cancelled]}
    defaults: {status: booked}
    readOnlyProperties: [status]
    intervals:
      start: start
      end: end
      within: [room]            # a room's bookings conflict with each other only
      when: {status: booked}    # a cancelled booking frees its slot
      length: PT1H              # every booking is exactly one hour...
      step: PT1H                # ...and starts on the hour (UTC, unless origin moves the grid)
    transitions:
      cancel: {from: {status: booked}, set: {status: cancelled}}
      reopen: {from: {status: cancelled}, set: {status: booked}}
```

- **The rule.** Among the records holding every `when` value (all records
  without `when`), no two in the same scope with equal `within` values may
  hold overlapping half-open intervals `[start, end)`. An interval that ends
  exactly where another starts does not overlap it. A create, `PUT`, `PATCH`
  or transition that would break it answers `409 interval_conflict` and writes
  nothing, no `Idempotency-Key` claim or audit event either. A move that would
  overlap therefore keeps the record where it was, and a record may move over
  its own old interval. A transition is checked like any write, so `reopen`
  above is refused while another booking holds the slot.
- **Scope.** `scope: collection` (the default) constrains every record against
  every other, **across owners** on an owned collection: another owner's
  booking blocks the slot. `scope: owner` (owned collections only) constrains
  each owner's records among themselves, such as a personal calendar.
- **Privacy.** The `409` body is `{error: {code: "interval_conflict", message,
  conflict?: {id}}}`. `conflict.id` names the conflicting record only when the
  caller may read it: any record on a shared collection, and on an owned one
  only the caller's own. Another owner's booking is never named, and nothing
  about it (its owner, its interval, its other fields) is returned. The caller
  still learns that the slot is taken, which is the point of the constraint;
  on an owned collection with `scope: collection`, that is what one owner learns
  about another's records. The same rule applies to `StoreExports`, by the
  principal the caller passes.
- **Bounds.** `start` and `end` are required properties, both
  `type: string` with `format: date-time` or both `integer`/`number`; the
  `within` properties are required too, and none of them may be an increment.
  A date-time bound must be UTC, written with `Z`, with at most millisecond
  precision (`2026-10-01T09:00:00Z`, `2026-10-01T09:00:00.250Z`), and bounds
  compare as instants, so `10:00:00Z` and `10:00:00.000Z` are the same.
  Anything else (an offset such as `+01:00`, a lower-case `z`, microseconds)
  and an `end` not after its `start` are `422 invalid_record` with the keyword
  `intervals`. *Why require `Z` rather than normalize:* the store never
  rewrites a value the caller sent, and a UTC-only bound sorts and filters
  the same way everywhere; converting a local time is the client's job, where
  the time zone is known.
- **Length and step** ([#929](https://github.com/jimhoyd-com/urlcode/issues/929)).
  `length` fixes every interval's length: `end` must be exactly `start` plus
  `length`. `step` puts both bounds on a grid: each must be a whole multiple of
  `step`, counted from `origin` (below; by default 1970-01-01T00:00:00Z for
  date-times, so `PT1H` is on the hour and `PT15M` on the quarter hour, in
  UTC, and 0 for integers). Alone, `step` makes every
  interval a whole number of steps (one-hour slots booked one or more at a
  time); with both, `length` must be a multiple of `step`, or activation
  refuses the declaration. For date-time bounds each is an ISO 8601 duration
  in whole days, hours, minutes and seconds (`PT1H`, `PT30M`, `P1DT12H`; a day
  is 24 hours, since bounds are UTC; no years, months or fractions); for
  `integer` bounds, a positive integer in the bounds' own units. A `number`
  bound takes neither, since a fraction has no exact multiple. A write that
  breaks either is `422 invalid_record` with keyword `intervals` and a message
  naming the declaration (`must be exactly PT1H after start`, `must be a whole
  multiple of PT1H from 1970-01-01T00:00:00Z`), never the submitted value. The
  rule applies to every record, whatever `when` says, on every write path
  (create, `PUT`, `PATCH`, a transition, `StoreExports` and host
  transactions), and activation refuses stored records that break it.
- **A grid with an origin** ([#945](https://github.com/jimhoyd-com/urlcode/issues/945)).
  `origin` says where the `step` grid counts from: an RFC 3339 date-time for
  date-time bounds, which may carry a fixed offset, or an integer for integer
  bounds. It needs `step`. A bound is on the grid when `bound - origin` is a
  whole multiple of `step`, before or after the origin, so only the origin's
  position within one step matters and the check stays exact.

  ```yaml
  # snippet: partial -- the intervals of a clinic at UTC+05:30
  intervals:
    start: start
    end: end
    within: [room]
    length: PT1H
    step: PT1H
    origin: 1970-01-01T00:00:00+05:30   # 09:00 local is 03:30Z: slots start at :30 past, UTC
  ```

  With `step: P1D` the same origin is local midnight (18:30Z). Record bounds
  stay UTC with `Z`; only the declaration names the offset, and a `422`
  names the declared origin (`must be a whole multiple of PT1H from
  1970-01-01T00:00:00+05:30`). Changing `origin` changes the declaration, and
  activation refuses stored records the new grid would not hold.
  *Daylight saving is not followed.* `origin` is a fixed offset, not a time
  zone. A zone's rules would need time-zone data in the write path, where the
  result of a check could then depend on the tz database each process
  loaded (two processes on one database could disagree), and a local grid has
  no exact answer in a daylight-saving gap or overlap, where a local hour does
  not exist or happens twice. The grid stays exact arithmetic on instants
  instead. For a grid of an hour or less, a whole-hour daylight-saving change
  does not move it (UTC+10:30 and UTC+09:30 both put `PT1H` at :30 past), so
  only daily and longer grids in zones that change their offset are affected:
  there, local midnight moves by an hour for part of the year. Convert on the
  client, or use integer bounds in local units, when that matters.
- **Cost.** The declaration builds one partial SQLite index over the records
  it applies to, keyed by owner (with `scope: owner`), the `within` values and
  the start instant. Because stored intervals in one scope never overlap, the
  only record that can conflict with a new interval is the one in its scope
  that starts last before the new one ends, so the check is one descending
  step of that index (`ORDER BY start DESC LIMIT 1`), not a scan. Measured with
  `npm run bench:store -- --intervals` (Apple M4 Pro, Node 26.10, SQLite
  3.53.4, 20 rooms of back-to-back bookings owned by 50 principals): at 10,000
  records the check query takes 2.4 µs at the median (1.8 µs at 1,000), the
  same query without the index 3.2 ms, and reading one room's records to
  compare them in JavaScript, as the host transaction did, 197 µs. A whole
  accepted create with `synchronous=FULL` took 184 µs with the constraint and
  180 µs without it; the check is not what a write pays for.
- **Activation and operator commands.** Activation refuses stored records that
  break the rules or overlap, naming the two record ids, rather than serving
  them. With `scope: owner`, `urlcode-store ownerless-assign` and
  `urlcode-store reassign` (dry runs included) refuse, before anything is
  written, a move that would give the target principal overlapping intervals.
  Changing the declaration changes the index: activation builds the new one
  and drops the one nobody declares any more.
- **Races.** The check reads committed state under the write lock, so of
  concurrent bookings of one slot exactly one commits, in one process and
  across connections to the same file (the tests race both).
- **Not covered.** One booking per slot (no capacity above one), no recurring
  intervals, no open-ended interval (both bounds are required), no grid in
  local time or with an offset from the epoch, and no suggestion of a free
  slot. Not on a membership collection.

## Declared transfers

A collection may declare transfers: a whole amount moved from one record's
balance to another's in one transaction, so the sum over the collection never
changes ([#902](https://github.com/jimhoyd-com/urlcode/issues/902)). It
replaces the host transaction the simulated-credit counterexample of #835
needed, with no application code.

```yaml
collections:
  treasurers:                  # who may issue: principal ids, maintained by the operator
    membership: true
    key: userId
    schema:
      type: object
      additionalProperties: false
      required: [userId]
      properties:
        userId: {type: string, maxLength: 128}
  wallets:
    mount: /api/wallets
    ownership: owner
    idempotency: {maxKeys: 1000}
    audit: true
    schema:
      type: object
      additionalProperties: false
      required: [name, balance]
      properties:
        name: {type: string, maxLength: 40}
        balance: {type: integer}   # in cents: a transfer moves whole numbers only
    defaults: {balance: 0}
    readOnlyProperties: [balance]  # only a transfer changes it
    transfers:
      pay: {amount: balance}       # POST /api/wallets/transfers/pay; never below 0
      issue: {amount: balance, min: -100000000, members: treasurers}
routes:
  /api/wallets/*: {extension: store, methods: [GET, HEAD, POST, PUT, PATCH, DELETE], auth: true}
```

```http
POST /api/wallets/transfers/pay
Content-Type: application/json
Idempotency-Key: 5f0c...

{"from": "<my wallet id>", "to": "<their wallet id>", "amount": 1250}
```

- **The request.** `POST <mount>/transfers/<name>` takes the JSON body
  `{from, to, amount}` and nothing else: two record ids of the collection and
  a positive whole number, at most 2^53 − 1. The schema is generated by the
  store, not declared; a body that breaks it, and a `to` equal to `from`, is
  `422 invalid_transfer` with the body-validation `issues`. The same-origin
  rule, `readOnly` (`405`), `Idempotency-Key` and an optional `If-Match` apply
  as to any write. `If-Match` is the `from` record's `ETag`: it guards what the
  caller read before spending. The credit needs no precondition, since adding
  to a balance does not depend on what it was.
- **The effect.** In one `BEGIN IMMEDIATE` transaction the store reads both
  records, subtracts `amount` from `from`'s `amount` property, adds it to
  `to`'s and writes both with a new `updatedAt` (so both `ETag`s change), with
  one audit event per record and the `Idempotency-Key` claim. Everything
  commits or nothing does, so the sum over the collection is the same after
  every transfer, whatever runs concurrently.
- **Whole numbers only.** The `amount` property must be a required `integer`.
  There is no decimal amount: count a currency in its minor units (cents), so
  no transfer ever rounds. A fraction is refused, never rounded.
- **Only a transfer changes it.** Activation refuses an amount property that
  is not listed in `readOnlyProperties`, whose default is not `0`, that a
  transition sets or stamps, that is an increment or that `intervals` names:
  each would add or remove value outside a transfer
  ([#928](https://github.com/jimhoyd-com/urlcode/issues/928)). So every record
  is created at `0`, `POST`, `PUT` and `PATCH` bodies naming the property are
  `422`, and `PUT` keeps the stored balance.
- **Deleting.** A record still holding a nonzero amount cannot be deleted:
  `DELETE`, a host transaction's `remove` (the records export has no
  delete) and the operator's `urlcode-store ownerless-delete` all answer
  `409 balance_not_zero` and delete nothing (the operator command refuses as a
  whole if any ownerless record holds a balance). The message names no amount.
  Transfer the balance to another record first; a record at `0` is deleted as
  usual. Together with the rules above, the sum over the collection is the
  same after every write, not only after every transfer.
- **The floor.** `min` (default `0`) is the lowest value the debited record may
  be left holding: a transfer that would go below it answers
  `409 insufficient_balance` and writes nothing, so `pay` above never
  overdraws. The new values must also satisfy the property's own schema and
  stay safe integers, or the answer is `409 transfer_limit`; that refusal
  carries no issue list and no value, because on an owned collection it would
  describe another owner's balance.
- **The answer.** `200 {from, to?}`: each record as the transfer left it, with
  `from`'s `ETag`. `to` is included only when the caller may read it: always on
  a shared collection, and on an owned one only when the caller owns it (a
  move between two of its own wallets). A replayed `Idempotency-Key` answers
  both records as they are now, with `Idempotency-Replayed: true`, like any
  [replay](#result-aware-retries); nothing moves twice.
- **Funding.** Nothing creates value: a record opens at `0`, a transfer only
  moves value and a record leaves only at `0`. To bring value in, declare a
  members-gated issuer: `issue` above lets a member of `treasurers` debit their
  own wallet down to `min: -100000000`. That wallet's negative balance is the
  supply outstanding, and the sum over the collection stays zero, as in
  double-entry bookkeeping. An issuer's own negative record is refused
  deletion like any nonzero one, so the outstanding supply cannot be written
  off by deleting it.

The [`store-credits` recipe](../recipes/store-credits/README.md)
(`urlcode recipes add store-credits`) declares these wallets with an issuer,
[a directory by a unique handle](#a-directory-by-a-unique-handle), and
fixtures that fund, look a recipient up, pay, refuse an overdraft and close
wallets at `0`.

### Who may debit whom

| Collection | Debit (`from`) | Credit (`to`) |
|---|---|---|
| `ownership: owner` | only a record the caller owns (another owner's is the `404` of a missing id) | any owned record, the caller's or another owner's (a record with no owner is `404`) |
| shared | any record | any other record |
| with `members` | as above, and only for a member of that [membership collection](#membership-gates-and-cross-owner-reads) (`403 membership_required`, checked before any record is read) | as above |

- **Owned.** Paying someone is the point, so the credited record may be
  anyone's; spending is not, so the debited record must be the caller's. The
  caller needs the recipient's record id, which the recipient shares, like an
  account number, or which a
  [projected readers mount](#membership-gates-and-cross-owner-reads) lists
  (`readers: {directory: {mount: /api/directory, properties: [name]}}`: every signed-in
  principal finds a wallet's id by its name, and sees no balance). Ids are
  random UUIDs and never listed on the collection mount to other owners. The
  store checks the floor before it looks up the credited record, so a caller
  cannot learn whether an id exists without the funds to move; a transfer that
  goes through tells the payer the id exists and nothing else about it.
  `transfer_limit` does reveal that the recipient's balance is near its
  property's `maximum`, so leave the amount property without a `maximum`
  unless that is acceptable (the safe-integer bound still applies).
- **Shared.** Anyone who reaches the mount may move value between any two
  records, as anyone may run a shared collection's transition. Guard the route
  (`auth: true` and a policy) or name `members`.
- **`members`** narrows who may run the transfer; it does not widen whose
  record may be debited. A treasurer still debits only their own record on an
  owned collection. There is no transfer that debits another owner's record.
- **Trusted code.** `StoreExports` passes the principal it is given:
  `records(name).transfer(principal, name, {from, to, amount}, {ifMatch})` and
  the same call on a [host transaction](#host-transactions)'s
  `tx.records(name)`, which commits or rolls back with the transaction's other
  writes. Both return `{from, to?}` with the same visibility rule.

### A directory by a unique handle

A directory by `name` is spoofable: each owner names their own wallet, so
another user can open a wallet named `bob` and appear in the same lookup
([#953](https://github.com/jimhoyd-com/urlcode/issues/953)). `unique` keeps a
string property unique across every record, across owners on an owned
collection (where `key` is refused), so a lookup by it names exactly one
wallet:

```yaml
wallets:
  mount: /api/wallets
  ownership: owner
  schema:
    type: object
    additionalProperties: false
    required: [handle, balance]
    properties:
      handle: {type: string, pattern: '^[a-z0-9_]{3,20}$', maxLength: 20}
      balance: {type: integer}
  defaults: {balance: 0}
  readOnlyProperties: [balance]
  unique: [handle]              # one wallet per handle, whoever owns it
  filterable: [handle]
  readers:
    directory: {mount: /api/directory, properties: [handle]}   # GET /api/directory?handle=bob
  transfers:
    pay: {amount: balance}
```

- **The check.** A create, `PUT`, `PATCH` or host transaction write that would
  give a unique property a value another record holds answers
  `409 value_taken`, with one issue naming the property
  (`{pointer: '/handle', keyword: 'unique'}`), never the value, the other
  record or its owner, and writes nothing. It runs inside the write's
  `BEGIN IMMEDIATE` transaction through a partial expression index the
  declaration builds (dropped by the next activation that no longer declares
  it), so of two racing creates exactly one commits. A record keeping its own
  value, and a record without the property, claim nothing new. Activation
  refuses stored records that already share a value.
- **The property** is a string with `maxLength` at most 128, no default (a
  second record would collide with it), not in `readOnlyProperties`, not the
  collection's `key` and not set or stamped by a transition (a constant cannot
  be unique twice). Up to four per collection; not on a membership collection.
- **Exact values.** `Bob` and `bob` are different values. A handle people read
  should have a `pattern` that makes look-alikes impossible to register, such
  as lower case only, as above.
- **Privacy.** Uniqueness across owners leaks existence: anyone who may create
  (or edit) a record learns, from the `409`, that some record holds a value,
  and can probe values one request at a time. That is what a public handle
  is for, and the directory shows the handles anyway. Never declare `unique`
  on an email, a phone number or anything a user would not publish; bound
  probing with a throttle policy on the mount. The `409` never says whose
  record holds the value.

### Order of checks

After the principal (`401` on an owned collection or a gated transfer), the
origin (`403`), the headers (`400`), `readOnly` (`405`) and the body (`422
invalid_transfer`), inside the write transaction: the membership gate (`403`);
the retained `Idempotency-Key` (a replay, or `422 idempotency_key_reused`);
`from` in the caller's scope (`404`); `If-Match` (`412`); the floor
(`409 insufficient_balance`); `to` (`404`); the property's schema and the
safe integers (`409 transfer_limit`); the record size (`413`); then the two
writes, the two audit events and the claim. A stored record without a whole
balance (written before the property was declared) is
`409 transfer_conflict`. Every refusal writes nothing.

- **Audit.** On an audited collection each record gets a
  `store.record.transferred` event (subject `<collection>/<id>`, the caller as
  actor) with metadata `{collection, transfer, side: from|to, counterpart:
  <the other record's id>, fields: [<amount property>]}`: names and ids, never
  the amount or a balance. Both events are in the transfer's transaction; a
  failure after the first (the tests inject one on the credited record) rolls
  back the debit and its event.
- **Races.** Of concurrent transfers from one record, those the balance covers
  commit and the rest answer `409 insufficient_balance`; the tests run 200
  interleaved transfers among four accounts in one process and across four
  connections and check the total and the floor after both.
- **Not covered.** Holds (moving part of a balance to a second property on the
  same record, then settling it to another record) and transfers between
  collections or between properties still need a
  [host transaction](#host-transactions). One amount property per transfer, one
  pair of records per request, and no fees, limits per period or scheduled
  transfers.

## Record schema

A collection's `schema` is a JSON Schema 2020-12 object schema in the same
bounded profile as a route's [`request.body.<METHOD>.schema`](HTTP.md#body-schema-and-input-patterns)
([#861](https://github.com/jimhoyd-com/urlcode/issues/861)). The store hands it
to core's own compiler (`@jimhoyd/urlcode/body-schema`): the same keyword
allowlist, formats, regex admission and limits, the same Ajv options, and the
same bounded issue list in a refusal. There is no second, store-private value
checker.

```yaml
# snippet: partial -- one collection's schema and its store layer
schema:
  $schema: https://json-schema.org/draft/2020-12/schema   # optional
  title: Ticket
  type: object
  additionalProperties: false
  required: [code, priority]
  properties:
    code: {type: string, pattern: "^[A-Z]{2}-[0-9]+$", maxLength: 12}
    due: {type: string, format: date}
    priority: {type: integer, minimum: 1, maximum: 3}
    channel: {type: string, anyOf: [{const: web}, {const: mail}]}
    state: {type: string, enum: [open, closed]}
defaults: {priority: 2, state: open}
readOnlyProperties: [state]
```

What the store adds to the profile, and why:

- **A flat record.** The root is `type: object` with `properties` (1 to 64),
  optional `required`, optional `$schema`, `title`, `description` and
  `$comment`, and `additionalProperties: false` written out, so the schema
  says what the store enforces: a body naming an undeclared property is
  refused. Each property has exactly one scalar `type` (`string`, `integer`,
  `number` or `boolean`); any other profile keyword may sit beside it
  (`minLength`, `pattern` with `maxLength`, `format`, `enum`, `const`,
  `minimum`, `exclusiveMaximum`, `multipleOf`, `anyOf` and so on). Records
  stay scalars because sorting, equality filters, transitions, keys and
  counters compare scalar values. `id`, `createdAt` and `updatedAt` are
  reserved and store-owned; a body may carry them (a record read back) and
  they are ignored.
- **Value shape only.** The schema is exactly a request body schema, so the
  profile's refusal of `default` and `readOnly` holds here too: a property
  carrying either is refused at activation with a message naming the
  collection key to use instead.
- **Store-owned facts stay beside the schema** and name its properties:
  `defaults` (stored on create when the body omits the property, and on
  `PUT`; each value must satisfy the property's own schema),
  `readOnlyProperties` (only a declared [transition](#declared-transitions)
  changes them), `key`, `increments`, `sortable`, `filterable`,
  `transitions`, `ownership`, `readers`, `membership`, and the short link's
  destination. They are behavior over records (stored values, uniqueness,
  atomic counters, scoping, state changes), not value constraints, so they are
  not JSON Schema keywords. A name one of them gives that the schema does not
  declare is refused at activation.

*Why one place for defaults and read-only markers.* The store used to read
`default` and `readOnly` from the record schema's properties and strip them
before compiling. That made a record schema a dialect of the request profile:
it could not be a [named schema](HTTP.md#named-schemas) that a route body or
an MCP tool also names, since the profile refuses both keywords there, and a
collection naming a shared schema would have needed a second place for them
anyway. With both on the collection, for an inline and a named schema alike,
a record schema is one thing everywhere, and a default is always something the
store does rather than a claim about the value.

### A named schema as the record schema

`schema` may name one of the project's [named schemas](HTTP.md#named-schemas)
(the top-level `schemas:` map) instead of writing one inline. One schema is
then the collection's record shape, a route's request body and an MCP tool's
arguments, compiled once by core, and all three refuse the same invalid input
with the same issue at the same pointer (the store as `422 invalid_record`
with `issues`, the route as its body-validation `422`, the tool as an
`Invalid arguments` result):

```yaml
version: "1"
schemas:
  Ticket:
    type: object
    additionalProperties: false
    required: [title]
    properties:
      title: {type: string, minLength: 1, maxLength: 80}
      email: {type: string, format: email}
      status: {type: string, enum: [open, closed]}
extensions:
  store:
    version: "1"
    config:
      collections:
        tickets:
          mount: /api/tickets
          schema: Ticket
          defaults: {status: open}
          readOnlyProperties: [status]
          transitions:
            close: {from: {status: open}, set: {status: closed}}
routes:
  /api/tickets/*: {extension: store, methods: [GET, HEAD, POST, PUT, PATCH, DELETE], auth: true}
  /tickets:
    methods: [POST]
    request:
      body:
        POST: {format: json, required: true, schema: Ticket}
    respond: {status: 201, json: {ok: true}}
```

The named schema must satisfy every restriction above: a flat object of
scalar properties with `additionalProperties: false` written out, and only the
root keywords listed. A schema file that references another file is bundled
with `$defs`, which a flat record has no use for, so it is refused. Activation
refuses a schema the store cannot hold, naming the collection, the schema and
the pointer (`Collection tickets: schema Ticket (top-level schemas:) cannot be
a record schema: /properties/address/type must be one of string, integer,
number, boolean`), and an unknown name (`Collection tickets: schema names
Tikcet, which the project does not declare under schemas`). The store's
[OpenAPI](#openapi) description references the named component rather than
copying it. `packages/store/test/named-schema.test.ts` runs one schema through
a collection, a route and an MCP tool.

A write is judged as the record it would leave: a create is the defaults plus
the body, a `PUT` the defaults, the body and the stored read-only values, a
`PATCH` the stored record with the named properties set or removed. The
first failure is `422 invalid_record` with `issues` in the body-schema shape;
the store's own rules on a named property (a read-only property in a body, an
increment cleared, a membership key that is not a principal id, a short-link
destination that is not an HTTP(S) URL) are issues in the same shape. Stored
rows are judged without `required` when they are read and at activation, so
adding a required property does not stop a collection that already holds
records without it; such a record's next write must supply it. A row that
breaks any other rule refuses activation (and a request that meets one answers
`503`).

*Why a declared schema rather than a derived one.* The alternative was to keep
the store's own `fields:` vocabulary and derive an equivalent profile schema
from it. Declaring the schema adds no mechanism (the store calls core's
compiler either way) and removes one: there is no private vocabulary to learn,
document and translate, every profile keyword is available to a record without
the store naming it, and the schema a reader writes is the one `urlcode
openapi` publishes and a generated client uses. What it costs is a little
verbosity (`type: object` and `additionalProperties: false` are written out)
and the store's layer (`defaults`, `readOnlyProperties`) beside it.

Limits per collection: up to 64 properties, `maxRecords` up to 10,000 (default
1,000), on an owned collection `maxRecordsPerOwner` up to `maxRecords`
([per-owner record limit](#per-owner-record-limit)), `maxRecordBytes` up to 65,536 (default 4,096), `pageSize` up to 200
(default 50), at most 32 collections per project, `readOnly: true` to refuse
writes through the record API — the store's own short-link click counter is
the one exception, described above. The request body is refused above
`maxRecordBytes` plus 4 KiB.

## Sorting and filtering

A collection opts in per property with two lists in its declaration:

```yaml
# snippet: partial -- two keys of one collection
sortable: [title, priority]      # sort=<property> or sort=-<property> (descending)
filterable: [kind, done]         # <property>=<value>, equality only
```

- Every name must be a declared property (not `id`, `createdAt` or
  `updatedAt`), at most 8 per list, no repeats. A `string` property's schema
  must bound it to 256 characters (`maxLength` of at most 256, an `enum` or a
  `const`), so a value stays small enough to compare and to carry in a cursor.
  A property named `limit`, `cursor` or `sort` cannot be filterable. A bad
  declaration refuses activation.
- One sort property per request. Records order by it, then by `id`, so the
  order is total and stable. `-` reverses the whole order, ties included.
  Numbers compare numerically, booleans `false` before `true`, strings by UTF-16
  code unit (not by locale). A record with no value for the property (an
  optional one never set) comes after every record that has one when ascending, and
  first when descending.
- Filters are exact equality on the declared type: `done=true`, `priority=3`
  (integers and numbers are parsed strictly, so `3.0` matches 3 and `0x10`
  does not parse), `kind=a`. At most 3 filters per request, each given once;
  a record without a value never matches. Filters combine with AND and with
  `sort`; `total` is the number of matches.
- Anything else is `400 invalid_query` with `fields` naming the key: an
  undeclared sort or filter name, a repeated key, a value that does not parse
  as the property's type, a value the property can never hold, an unrelated
  parameter such as `q`, more than 16 parameters. A value the property can
  never hold is one its schema refuses, judged by the same validator a write
  uses: outside its `enum` (`must be one of the declared values`), below its
  `minimum` or above its `maximum` (`must be at least 1`), shorter than its
  `minLength` or longer than its `maxLength` (`must be at most 4
  characters`), not matching its `pattern` or `format`. It is refused rather
  than answered with an empty page, on an owner's mount and a readers mount
  alike, with the message of the schema issue a write gets. Names that are
  not plain identifiers are reported as `(unsupported name)`, and values are
  never echoed. Unknown query parameters are therefore refused rather than
  ignored on every collection, declared or not. There are no ranges,
  operators, text search, OR, nested paths or arbitrary expressions.
- A sorted page returns an opaque `next` cursor holding the sort property and
  direction and the position (value and `id`) of the page's last record. The
  next page is "the records after that position", so records inserted, deleted
  or edited between requests never make a page repeat a record or skip one that
  stayed put. A cursor works only with the sort that issued it (`400`
  otherwise). Without `sort`, `cursor` stays the numeric offset in creation
  order, filtered or not; there a delete between pages can shift later records
  up by one.
- An unsorted, unfiltered page is one counted `LIMIT`/`OFFSET` query. A sorted
  or filtered page is one counted keyset query in SQL
  ([#951](https://github.com/jimhoyd-com/urlcode/issues/951)): the page after
  the cursor's position, read in order through an index. On a shared
  collection sorting and filtering apply to every record; on an
  [owned](#per-record-ownership) one they apply to the caller's own records
  only, and `total` and cursors count only those. At the 10,000-record maximum such
  a page took about 0.6 ms, as long as an unsorted one, in
  [one local measurement](CAPACITY.md#measured-sorted-lists-in-sql-951).
- Each `sortable` or `filterable` property gets an index, derived from the
  declaration and built when it activates (on an owned collection, one on the
  owner and the property, and with readers mounts a second on the property
  alone); an index nobody declares any more is dropped. Every write updates each
  one, so declare only the properties requests use. The index keys a string so
  that SQLite's byte order is the UTF-16 code unit order above (UTF-8 byte order
  differs from it only between U+E000–U+FFFF and the code points above U+FFFF),
  and a number, integer or boolean as a double, compared exactly as
  JavaScript compares them. A stored value that key cannot order exactly, a
  string holding a lone surrogate or a value of another type than declared (a
  row written under another declaration), is found through one more index that
  holds only such rows; while the collection holds one, its sorted and filtered
  pages are ordered in memory instead, with the same results and cursors, and
  cost what they did before #951.

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
          schema:
            type: object
            additionalProperties: false
            required: [title]
            properties:
              title: {type: string, maxLength: 200}
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
  `_owner` is `422 invalid_record` like any undeclared property, and `PUT`/`PATCH` keep the stored
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
  (and so short links) on it: a public short link cannot serve an owned
  record. A value no two owners may share is
  [`unique`](#a-directory-by-a-unique-handle), which tells one owner that
  another already uses a value, so it is for public handles only.

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
  schema:
    type: object
    additionalProperties: false
    required: [title]
    properties:
      title: {type: string, maxLength: 200}
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
npx urlcode-store ownerless-assign --database /srv/site/data/store.sqlite --project /srv/site/app \
  --collection notes --owner <principal id>
npx urlcode-store ownerless-delete --database /srv/site/data/store.sqlite --project /srv/site/app \
  --collection notes
```

Each prints `{collection, records, ownerless, ids}` as JSON. `--owner` takes a
principal id exactly as the provider sets it (for auth, the user's Better Auth
id). Assigning and deleting read `--project` (the route project, as for
`reassign`): the collection must be declared `ownership: owner`, and on an
[audited](#audited-writes) collection each record they change is recorded
(`store.record.reassigned` with metadata `{collection, to}`, or
`store.record.deleted` with `{collection, ownerless: true}`), in the same
transaction and within the [backlog](#operator-changes-in-the-audit-log). The
same operations are exported from the package as
`reportOwnerless(database, collection)`,
`assignOwnerless(database, {collections, collection, owner, actor?})` and
`deleteOwnerless(database, {collections, collection, actor?})`.

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
  declared `ownership: owner` (with each one's `maxRecordsPerOwner`) or
  `membership: true`; only those collections are touched. `--collection <name>`
  limits the move to one of them (a shared or undeclared name is refused). A
  declared owned collection that holds no records yet has nothing to move and
  is left out of the report.
- Only each record's owner changes. Records owned by anyone else, and records
  with no owner (see below), are left alone.
- **Membership moves too** ([#866](https://github.com/jimhoyd-com/urlcode/issues/866)).
  In every [membership collection](#membership-gates-and-cross-owner-reads)
  that lists `--from`, its entry becomes `--to`'s (the key property and its
  index together, in its original place), or is removed when `--to` already
  is a member. On an audited membership collection this is recorded as
  `--from` removed and, unless it already was a member, `--to` added. It
  happens in the same transaction as the record moves.
- **Record moves are audited** ([#875](https://github.com/jimhoyd-com/urlcode/issues/875)).
  On an owned collection declared `audit: true`, every moved record is
  recorded as `store.record.reassigned`, subject `<collection>/<id>`, metadata
  `{collection, from, to}`, in the same transaction as the move. See
  [operator changes in the audit log](#operator-changes-in-the-audit-log).
- It prints `{from, to, dryRun, moved, auditEvents, collections: [{collection,
  moved, toBefore, toAfter, maxRecordsPerOwner}], memberships: [{collection,
  toWasMember}]}` as JSON. `auditEvents` is how many audit events the move
  records (or would). `--dry-run` counts and writes nothing.
- **The per-owner limit is respected.** When moving would leave `--to` holding
  more than a collection's `maxRecordsPerOwner`, the whole command is refused,
  naming the collection and the counts, and no collection is changed (a dry run
  is refused the same way). Delete or move some of `--to`'s records first, or
  raise the limit. `maxRecords` is unaffected, since no record is added.
- It is one database transaction across every affected collection: all counts
  and the audit backlog are checked, then every collection moves, and a failure
  part-way (a full disk, a lock held past the busy timeout) rolls all of them
  back, membership and every event included. Like the
  `ownerless` commands it may run while the server serves.
- It does not touch `Idempotency-Key` retention, which is scoped by principal: a
  retry by `--to` with a key `--from` used is a new request, and a retry by
  `--from` of a write to a moved record replays as `404`.

The same operation is exported as `reassignOwner(database, {from, to,
collections, collection?, dryRun?, actor?})`, where `collections` is the
declared `extensions.store.config.collections`.

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
          schema:
            type: object
            additionalProperties: false
            required: [title]
            properties:
              title: {type: string, maxLength: 200}
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
metadata is `{collection, fields}`: the names of the declared properties the write
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
`audit` off keeps any undelivered events in the outbox.

### Operator changes in the audit log

The `urlcode-store` commands that change records record them on an audited
collection too ([#866](https://github.com/jimhoyd-com/urlcode/issues/866),
[#875](https://github.com/jimhoyd-com/urlcode/issues/875)):

| Command | Action, per record | Metadata |
|---|---|---|
| `members add` / `members remove` | `store.membership.added` / `removed` (subject `<collection>/<principal id>`) | `{collection}` |
| `reassign` (owned collection) | `store.record.reassigned` | `{collection, from, to}` |
| `reassign` (membership collection) | `store.membership.removed`, then `added` unless `--to` already was a member | `{collection}` |
| `ownerless-assign` | `store.record.reassigned` (no `from`: the record had no owner) | `{collection, to}` |
| `ownerless-delete` | `store.record.deleted` | `{collection, ownerless: true}` |

`from` and `to` are the opaque principal ids the provider set (never an email
or a name), the same ids a request-made event carries as its actor and a
membership event as its subject. They are the evidence of a move: who lost the
records and who gained them.

- **One event per record, bounded by the backlog.** Each command counts its
  events before it writes anything. When they would take a collection past its
  1000 undelivered events, the whole command is refused with the same
  `503 audit_backlog` (on the command line, the message names the collection,
  the events it needs and how many are waiting), a `--dry-run` included, and
  nothing changes. So one command changes at most 1000 records of one audited
  collection; with events already waiting, fewer. Wait for the serving
  process's audit drain to deliver them and run it again.
- **In the same transaction.** The records, the memberships and every event
  commit or roll back together.
- **Delivered by the serving process.** The CLI writes into the outbox; the
  audit drain of a server running with audit delivers the events on its next
  poll. While no such server runs, they wait in the outbox (and count toward
  the backlog).
- **Reported, with a warning when nothing is draining.** A command that
  records events adds three fields to its JSON report: `undeliveredEvents`,
  the events waiting in each audited collection it touched (its own
  included); `lastAuditDrain`, when a serving process's drain last kept up
  with the outbox (it acked events or found none waiting), or `null` if no
  drain ever has; and `warning` when events are waiting and no drain has kept
  up in the last 60 seconds. The drain records that time in the database at
  most every 10 seconds, so a live server never trips the warning. A dry run,
  and a collection without `audit: true`, add none of them. The warning is a
  hint for the operator, not a delivery guarantee: start the server (or check
  it is running) and its drain delivers the events.

### Operator attribution

Every command that changes records (`members add`, `members remove`,
`reassign`, `ownerless-assign`, `ownerless-delete`) takes `--actor <principal
id>`: the actor of the events it records. It defaults to `operator` and is
validated like any principal id (1 to 128 ASCII letters, digits, `.`, `_`, `:`
or `-`), refused unechoed otherwise; the library functions take it as
`actor`. It is **operator-asserted, not authenticated**: whoever can run the
command against the database can write any id there, so it records who the
operator says made the change, not proof of it. Commands that change nothing
(`ownerless`, `members list`, `backup`) refuse it.

## Storage and concurrency: what it does and does not guarantee

- One SQLite database per site, through Node's built-in `node:sqlite`:
  `store({database})` in `host.mjs`, else `STORE_DATABASE`, else
  `data/store.sqlite` beside `host.mjs`. `urlcode test`, `audit` and
  `benchmark`, and a `--local-review` `validate` or `routes` with no operator
  pin, ignore all three and use a fresh database of their own per run
  ([test data and seeds](READINESS.md#test-data-and-seeds)). It must be outside the project
  (checked after symlink resolution). Its directory is created `0700` and the
  file `0600`; a symlinked, hard-linked or group- or other-readable file is
  refused. The store requires a SQLite with the fixes audit requires
  too (3.44.6, 3.50.7, 3.51.3 or newer) and is Node only: its registration
  declares `targets: ['node']`, so the aws and vercel targets refuse it before
  serving.
- Every collection lives as rows of three shared tables, keyed by the
  collection name: `store_records` (one row per record; the declared properties are
  one JSON object, beside the `id`, timestamps, owner and unique key columns),
  `store_idempotency` (retained `Idempotency-Key` claims: the scoped key hash,
  the request fingerprint, the status and the record id, never record values) and
  `store_audit_outbox` (undelivered audit events), plus the one-row
  `store_audit_drain` (when the audit drain last kept up, schema version 3;
  and which process holds the drain's lease, schema version 5),
  `store_transaction_results` (retained
  [host transaction](#host-transactions) keys and results; schema version 4),
  `store_declarations` (the [declaration fence](#several-serving-processes-on-one-host):
  each collection's served declaration fingerprint; schema version 5) and
  `store_servers` (one lease row per serving process; schema version 5).
  Collections are rows, not
  tables, so declaring, changing or removing a collection never changes the
  tables; the rows of a collection that is no longer declared stay untouched.
  The one derived object is the partial index a declared
  [`intervals`](#non-overlapping-intervals) reads through: activation builds
  it, and drops an interval index no live activation declares any more.
- The schema only moves forward. An empty file is initialized in one
  transaction; opening an up-to-date database changes nothing; a later release
  that changes the schema adds a step, and each step runs in its own
  transaction with the new version (`PRAGMA user_version`). A file that is not
  a store database (`PRAGMA application_id`) or comes from a newer release
  refuses activation. The JSON data files of earlier releases are not read or
  imported. Version 2 replaced the claim table for result-aware retries: claims
  a version 1 database retained carry no fingerprint and are dropped by the
  upgrade, so a retry of a request made before it runs again.
- Write-ahead log with `synchronous=FULL` by default: a write is answered
  only after a durable commit, and a crash, power loss included, leaves the
  last committed transaction. See [durability](#durability) for the one
  operator setting that trades that for faster commits.
- Every write is one `BEGIN IMMEDIATE` transaction that reads what it checks
  and writes everything it changes: the record, its unique key, the
  `Idempotency-Key` claim and eviction, and the audit event. Any failure rolls
  all of it back. `If-Match`, key uniqueness, `maxRecords`,
  `maxRecordsPerOwner`, increment bounds, declared intervals, retained keys
  and the audit backlog are therefore checked against committed state and cannot be overshot by
  concurrent requests. Statements are synchronous: within the process no other
  request runs between a transaction's checks and its commit, and each commit's
  fsync blocks the event loop while it runs. [Capacity](CAPACITY.md#measured-the-sqlite-store)
  records one local measurement of what that costs.
- Nothing is cached in memory: every read queries the database. Activation
  still validates every stored record against the declaration and refuses a
  database that no longer matches it rather than serving bad data.
- **Several serving processes on one host** may share the database; see
  [below](#several-serving-processes-on-one-host) for what that supports and
  what the store refuses. SQLite's file locks keep every connection from
  corrupting it: the `urlcode-store` operator commands and an online backup run
  beside the servers, reads are never blocked by a writer, and a write that
  finds another process holding the write lock waits up to 2 seconds
  (`busy_timeout`, blocking the server's event loop meanwhile) and then answers
  `503 storage_unavailable` with nothing written.
- Transactions span collections of this one database (`urlcode-store reassign`
  and [host transactions](#host-transactions) use that), but each HTTP request
  changes exactly one record: there is no multi-record or cross-collection
  operation in the HTTP API. Nothing is atomic across the store and another
  extension's database (auth, audit); none is claimed. There is no query language beyond paginated listing with declared
  sorting and equality filtering, and no history. Omitting `If-Match` remains
  last-write-wins for `PUT`/`PATCH`.
- This is durable local state, not a distributed exactly-once or
  external-delivery guarantee.
- Backups are the operator's. `urlcode-store backup` takes one while the
  server serves:

  ```sh
  npx urlcode-store backup --database /srv/site/data/store.sqlite \
    --destination /srv/backups/store-2026-09-28.sqlite
  ```

  It copies through SQLite's online backup API (`backup()` from `node:sqlite`,
  Node 22.16 or newer), so every committed write, including those still in the
  write-ahead log, is in the copy, and the server keeps serving meanwhile. Both
  paths are absolute. It refuses a source that is not a private store database
  of a schema this release understands, and a destination that already exists;
  it writes the copy `0600` in a private temporary directory beside the
  destination, checks that it opens with the store's `application_id`, the
  source's `user_version` and a clean `integrity_check`, and only then links it
  into place. It prints `{format, schemaVersion, bytes, destination}`. Keep
  backups outside `app/` and off the host. To restore, stop the server, put the
  copy in place as the database (mode `0600`) and start it again; a release
  older than the copy's `schemaVersion` refuses it. Stopping the server and
  copying `store.sqlite` also works (the last connection to close folds the
  write-ahead log into it), but copying the file with ordinary tools while the
  server runs is not a consistent backup.

Errors never contain record values, SQL or filesystem paths.

### Several serving processes on one host

The supported topology is N `urlcode serve` processes or containers on **one
host**, on distinct ports behind a proxy, all on **one release**, with the
database on **local disk**. Every guarantee above is one `BEGIN IMMEDIATE`
transaction, so it holds across processes. The tests race the invariants
from threads, each with its own connection, run the declaration fence and
the host lease across real `node` child processes, and run the race suites
across real `urlcode serve` processes
([below](#what-the-multi-process-harness-proves)). More processes do not add write throughput:
SQLite takes one writer at a time, and each commit's fsync blocks its
process ([capacity](CAPACITY.md#measured-the-sqlite-store)). `node:cluster`
workers, several hosts and network filesystems stay unsupported.

**The declaration fence.** Each activation records, per collection, a
fingerprint of its normalized declaration (the record schema with a named
schema resolved, defaults, `readOnlyProperties`, key, increments, limits,
ownership, audit, transitions, membership, readers, intervals, transfers,
idempotency and mounts) and the store schema version, in
`store_declarations`. The newest activation wins: it replaces what any
earlier activation, in this process or another, recorded. Every write
transaction (HTTP writes, increments, transitions, transfers, short-link
clicks, `StoreExports` writes and each collection a host `transaction()`
writes) first reads, under the write lock and through the primary key, the
recorded fingerprint and version and the file's `user_version`. When any of
them differs from its own, the write answers `503 storage_unavailable` with
the fixed message `The collection was redeclared by another process` and
writes nothing. Reads keep working. So an older process, whether it runs the
previous declaration or a previous release whose schema a newer one migrated,
cannot keep writing rows the newer declaration forbids. Two processes on the
same declaration both write. A retiring process never becomes current again
by itself: to roll back, restart (or reload) the previous release, whose
activation records its declaration again.

The operator commands carry the project's declaration rather than an
activation's. A `urlcode-store` command that writes (`members add|remove`,
`reassign`, `ownerless-assign`, `ownerless-delete`) is refused when a live
server has recorded a different declaration of a collection it touches, and
proceeds when none is recorded or no server holds a live lease.

**Refused setups.** Opening the database (serving, or an operator command)
refuses a database directory on a network filesystem, by the `statfs` type
on Linux: NFS (`0x6969`), SMB (`0x517b`), SMB2 (`0xfe534d42`), CIFS
(`0xff534d42`), FUSE (`0x65735546`, which includes sshfs, s3fs and Docker
Desktop's gRPC FUSE file sharing), 9P (`0x01021997`, WSL2's `/mnt` drives),
Ceph (`0x00c36400`) and AFS (`0x5346414f`). On macOS and Windows Node exposes
no filesystem type the check can trust, so it is skipped there. The auth and
audit extensions refuse the same list for `auth.sqlite` and `audit.sqlite`.
A serving process also
joins `store_servers`: a lease row with its instance id, hostname, Linux boot
id (`/proc/sys/kernel/random/boot_id`, when readable) and pid, renewed every
5 seconds. A peer on another host is one that reports a different boot id
(or, when either side has none, a different hostname). Containers on one host
have their own hostnames and share the boot id, so they are accepted. When an
activation finds a live peer on this host, it logs one `extension_warning`:
throttle policies and origin caches are per process, so each process applies
its own limits and keeps its own cache.

The lease never compares two hosts' clocks
([#978](https://github.com/jimhoyd-com/urlcode/issues/978)). Each renewal
writes a larger `heartbeat_at` than the last, and a process judges another
row by whether that value changes, timed on its own monotonic clock:

- **Joining.** A row of another host makes activation wait and watch it, for
  up to 20 seconds, and log one line saying so. If its heartbeat advances,
  activation is refused. If it stays unchanged for 20 seconds, the process
  deletes it and joins. So a crashed host blocks a restart for 20 seconds
  whatever its clock said, and a joiner whose clock runs ahead never evicts a
  live holder. A row of this host (one kernel, one clock) is also dropped once
  its `expires_at` has passed.
- **Serving.** Every heartbeat reads the table again. If it finds a row of
  another host, whether or not its own row is still there, the lease is lost:
  the process deletes its row, logs a line naming that host, and does not
  re-insert it. Every store write checks the lease first, inside its own
  transaction. While the lease is lost, or not renewed for 10 seconds and its
  row cannot be confirmed under the write lock, the write answers
  `503 storage_unavailable` and writes nothing. Reads keep working.
- **Recovering.** A process that lost the lease keeps watching. Once no
  other host holds a row (that host closed, or its row stayed unchanged for
  20 seconds), it rejoins at its next heartbeat and writes again.

So a holder that stalled for longer than the TTL (a suspended VM, `SIGSTOP`,
a blocked event loop) and resumes after another host took over refuses its
writes. It does not rejoin beside that host. A failed heartbeat is logged once
and retried every 5 seconds.

**One audit drainer.** With the audit extension every process has a drain
loop, but only the holder of the drain lease (`holder` and `lease_until` in
`store_audit_drain`, 10 seconds, renewed once half is left) peeks and acks
the outbox; another process peeks nothing. A peer takes the drain over once
the lease expires, or at its next poll when the holder closes and releases
it. Delivery stays at least once and stored once: audit inserts by event id
and ignores a duplicate, and a holder that lost its lease between peek and
ack leaves the rows for the new holder. An event written in any process is
drained within the holder's 1 second poll. `audit.flush()` waits for its own
process's drain only, so in a process that does not hold the lease it does
not wait for a peer's delivery.

**Every SQLite extension detects another host.** The network filesystem check
and the lease are one implementation in core
(`@jimhoyd/urlcode/extensions`: `refuseNetworkFilesystem`, `joinHostLease`),
and each extension keeps its lease in its own database: the store in
`store_servers`, auth in `auth_servers` in `auth.sqlite` (one row per
activation), and audit in `audit_servers` in `audit.sqlite` (from its first
activation until the audit host closes). The rules above apply to each: a live
peer on another host refuses activation, processes on one host never refuse
each other, a row of another host is judged by whether its heartbeat advances,
and a process that loses the lease stops writing until it holds it again. So a
site that runs auth or audit without the store is refused on a second host too
([#941](https://github.com/jimhoyd-com/urlcode/issues/941)). A process that
lost the lease answers `503 auth_unavailable` on every auth request, and
stores no audit event, so audit's producers keep their events and deliver them
once it rejoins. Auth checks the lease once per request, before Better Auth
runs, because Better Auth's own statements cannot be wrapped. Store and audit
check it inside each write transaction. Each extension releases its lease
when an activation fails after joining
([#979](https://github.com/jimhoyd-com/urlcode/issues/979)).

What the lease does not do:

- Each lease guards only its own file. It cannot see a second host that
  shares none of them. On macOS and Windows a network filesystem is noticed
  only through the lease, once both hosts serve at once.
- It detects a second host within one heartbeat or one write, but it does not
  prevent the two from opening the file together. Over a network filesystem
  SQLite's locks and write-ahead log are unreliable, so the lease's own
  statements can fail there too. It is a check for a misconfiguration, not a
  way to run on two hosts.
- A process judges peers by its own monotonic clock. A clock that runs slow
  by a large factor (not an offset), or a stall inside a single write
  transaction, is not covered.
- A process that lost its lease keeps its connection and keeps reading. It
  also keeps watching the lease table, which takes the write lock once per
  heartbeat.
- A row that stays after a crash is watched for 20 seconds by the next
  process to start, then deleted. An operator never needs to clear it by
  hand. To clear it anyway, stop every server first, then run
  `DELETE FROM store_servers` (`auth_servers`, `audit_servers`) on the stopped
  database.

**Per process, not per host.** Throttle counters, origin caches and metrics
stay per process: a `throttle` quota across N processes allows up to N times
the declared budget, each process fills its own cache, and each serves its
own `/_urlcode/metrics`
([capacity](CAPACITY.md#several-serving-processes-on-one-host)). Better
Auth's sign-in limit is the exception: it counts in `auth.sqlite`, so it is
one budget across the processes.

#### What the multi-process harness proves

`npm run test:multiprocess`
([`test/multiprocess.integration.ts`](../test/multiprocess.integration.ts)),
which CI runs on Linux in every code-lane run ([CI](CI.md#checking-this-repository)),
starts three `urlcode serve` processes from the built CLI on distinct
loopback ports. They serve one site whose `host.mjs` composes audit, auth and
store over one data directory, and every collection declares `audit: true`
behind `auth: true`. The harness asserts:

- **Across the processes, released at once:** 240 interleaved transfers keep
  the sum over the accounts at zero, with no account below its floor. Twelve
  requests with one `Idempotency-Key` run the create once, and every other
  answer replays that record. Of twelve claims of one ticket exactly one
  transition wins. Of 24 overlapping bookings the committed ones never overlap.
  An answer is either the documented refusal or a `503
  storage_unavailable` that wrote nothing.
- **One drainer, exactly once:** only one process holds the drain lease
  throughout. Once the outbox is empty, `audit.sqlite` holds one event per
  committed change and each event id once: one per created record, two per
  committed transfer (counted by the retained `Idempotency-Key` claims) and one
  per claimed ticket. They are stored in commit order: no event's `at` is
  earlier than the one stored before it.
- **No false 401:** 24 correct sign-ins spread over the processes run while
  60 signed-in reads hit all three. Every sign-in answers `200`, `429` or
  `503`, every read `200` or `503`, and at most the shared limit's remaining
  budget signs in.
- **`SIGKILL` mid-load:** the process holding the audit drain lease is killed
  while all three write. A survivor takes the lease over and empties the
  outbox, and a replacement process starts beside the dead one's lease row.
  After the rest stop, `PRAGMA integrity_check` is `ok` on `store.sqlite`,
  `auth.sqlite` and `audit.sqlite`, the sum and non-overlap invariants hold,
  and the exactly-once count above still matches.

It does not prove throughput, a power loss, long-running WAL growth, or
anything about several hosts; a full disk is covered by the tests
[below](#what-the-disk-full-tests-prove). Its load lasts
seconds, so it is not a soak test, and it runs on CI's disk rather than a
production one. The declaration fence and the host lease are proved
separately in
[`packages/store/test/multiprocess.test.ts`](../packages/store/test/multiprocess.test.ts).

#### What the disk-full tests prove

A full disk makes a SQLite write fail with `SQLITE_FULL`. Two tests check
what the store, auth and audit extensions then answer, what they leave behind
and how they recover ([#902](https://github.com/jimhoyd-com/urlcode/issues/902)).
Every write in them is a documented refusal or a whole commit:

| Database full | What a caller sees | Written |
|---|---|---|
| `store.sqlite` | an HTTP write, a transfer or a host transaction answers `503 storage_unavailable` (`The store could not save this change`); reads answer `200` | nothing of the refused write: no record, no `Idempotency-Key` claim, no audit event in the outbox, no host transaction result |
| `audit.sqlite` | `AuditExports.record()` rejects with `503 audit_unavailable`; store writes on an audited collection still commit | none of a refused batch; the store's events wait in its outbox while the drain retries with backoff; once 1,000 wait, the collection's writes answer `503 audit_backlog` (that cap is tested in `packages/store/test/audit.test.ts`, not on a full disk) |
| `auth.sqlite` | a sign-in answers `503 {"error":"auth_unavailable"}` with `Retry-After: 1` and no `Set-Cookie`; a signed-in route still answers `200`, because verifying a session only reads | no session |

Once space frees up, the service recovers without a restart: an
`Idempotency-Key` whose write was refused runs for the first time (not a
replay), the host transaction runs, sign-in works again, and the drain
delivers every waiting event. Afterwards `PRAGMA integrity_check` is `ok` on
all three files, and `audit.sqlite` holds exactly one event per committed
change, each id once.

- **Deterministic, on every OS:**
  [`test/disk-full.test.ts`](../test/disk-full.test.ts), part of `npm test`,
  serves one site composing audit, auth and store in one process. It fills
  each database in turn: it caps every connection to that file at the file's
  current size (`PRAGMA max_page_count`, a per-connection setting, so the test
  reaches each extension's own connection) and fills the remaining free pages
  with a filler table. Creates, transfers and sign-ins run until the first
  refusal of each. The rows, claims and balances are then checked against the
  answers.
- **A really full filesystem:**
  [`test/disk-full.integration.ts`](../test/disk-full.integration.ts)
  (`npm run test:disk-full`) starts `urlcode serve` from the built CLI, with
  the site and its data directory on a filesystem of at most 64 MiB. It fills
  that filesystem to `ENOSPC` with a filler file, then runs creates, transfers
  and sign-ins until each is refused. It checks that the server keeps running
  and reads still answer, then removes the filler, retries the refused keys,
  stops the server and checks the files. CI runs it on Linux in the
  `multiprocess` job, on a 16 MiB `tmpfs` ([CI](CI.md#checking-this-repository));
  it has also passed on macOS on a 16 MiB HFS+ disk image.

Before these tests, a sign-in whose session could not be stored answered
Better Auth's bare `500` (a full disk) or core's `500` (a lock held past the
busy timeout); the auth mount now answers `503 auth_unavailable`.

They do not prove behaviour with several processes on a full disk, a
**restart** while the disk is full (opening or migrating a database on a full
disk is untested), a filesystem with reserved blocks or quotas (ext4, XFS), a
power loss, or a disk that fills during a WAL checkpoint under sustained load.
`max_page_count` caps the database file, not its `-wal` or `-shm`; only the
filesystem test fills those. Neither test is a soak test. A heartbeat that
cannot write is logged and retried. A write then confirms the lease under its
own lock, so writes are not refused only because the heartbeat failed. After
20 seconds without a heartbeat, another process may treat the row as dead: a
peer on this host deletes it, and this process rejoins at its next heartbeat
once space frees.

### Durability

How long a commit waits for the disk is an operator choice per site, in
`host.mjs` (never project YAML): `store({durability: 'full'})`, the default,
or `store({durability: 'normal'})`. Without the option the store reads
`STORE_DURABILITY`, then uses `full`. Any other value, SQLite's `off` and
`extra` included, refuses to start.

| `durability` | SQLite | A committed write survives |
|---|---|---|
| `full` (default) | `synchronous=FULL`: the write-ahead log is fsynced on every commit | a process crash, an OS crash and a power loss |
| `normal` | `synchronous=NORMAL`: fsynced only at checkpoints | a process crash; the last commits before an OS crash or power loss can be lost |

With `normal` the database still never corrupts, and every guarantee in this
section about what one transaction checks and writes together still holds: a
lost commit is lost whole, record, key claim and audit event alike. What it
gives up is durability of the most recent writes, which may already have been
answered `2xx`. An activation with `normal` writes one `extension_warning` to
the operator log saying so. The `urlcode-store` operator commands (`members`,
`reassign`, `ownerless-*`) always commit with `full`, whatever the serving
process uses; `backup` reads the live database and writes a checked copy.

Choose `normal` only after measuring that the fsync bounds your writes. On the
machine [Capacity](CAPACITY.md#measured-the-sqlite-store) measured it did not
(macOS `fsync` does not flush the drive's cache); on Linux, where `fsync`
does flush, the difference depends on the disk.

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
  recomputes the stored key column in one transaction. The replacement's
  activation records its declarations, so the
  [declaration fence](#several-serving-processes-on-one-host) refuses the
  retiring runtime's writes to a changed collection with
  `503 storage_unavailable` while it finishes in-flight requests; its reads
  keep working. When the reload fails after the store activated, the
  replacement's close records the serving runtime's declarations again, so it
  keeps writing.
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
the whole create, read, update, delete lifecycle. `store-booking`
([intervals](#non-overlapping-intervals)), `store-credits`
([transfers](#declared-transfers)) and `store-approval`
([edit and delete states](#edit-and-delete-states)) are the specialised ones. It does not install anything:
`urlcode extensions add store` (or `init --with auth,store`) installs the
extension and wires `host.mjs`; add `--example` for the `todos` collection.
Without `auth` the example needs `--ack store:public-write`.

## A frontend for the collection

The store serves JSON only; it ships no screens and no component kit
([#883](https://github.com/jimhoyd-com/urlcode/issues/883)). The frontend is
the application's own: a page served by a `static` route (or any other host)
calls the collection's mount with `fetch` from the same origin, sending and
reading `application/json`. The
[private-requests client](../proofs/private-requests/client/main.js) is the
reference pattern: Better Auth's own browser client signs in, and every other
call is a same-origin `fetch` to a store mount.

What such a client reads from the HTTP contract:

- **`etags`** on a list, keyed by id, and the `ETag` header on one record: send
  it back as [`If-Match`](#conditional-writes) on an edit, delete or
  transition, so a page left open while someone else changed the record gets
  `412` and the store writes nothing.
- **`may`** on a list and **`Allow-Transitions`** on one record: the
  [transitions the caller may run now](#what-the-caller-may-run), so the page
  offers only those. They are a hint, not a grant; the transition still checks
  everything in its own transaction.
- **`readOnlyProperties`** never go in a create or update body (`422`); only
  a [declared transition](#declared-transitions) changes them. A client
  generated from [`urlcode openapi`](#openapi) leaves them out of its request
  types.
- **Owner and readers mounts.** An owner lists the collection mount; a member
  lists the [readers mount](#membership-gates-and-cross-owner-reads) and runs
  the `by: others` transitions on their own mounts.

With `auth` composed, `auth: true` on the mount gates who can reach it, not who
owns which record: only an [owned](#per-record-ownership) collection scopes
each caller to their own records. For shadcn/ui components, use the official
shadcn tooling and bring an item into the app's source with
[`urlcode artifacts stage`](EXTENSIONS.md#staging-source-assets).

## OpenAPI

With the operator's host file, `urlcode openapi --host-file host.mjs` (and
`buildOpenApi(project, {extensions})`) describes every store mount as real
paths instead of an opaque mount ([OpenAPI export](TOOLING.md#openapi-export)):
the store's registration implements the extension contract's
[`describe()`](EXTENSIONS.md#openapi-description), which builds the paths from
the project's declaration alone, without opening the database.

| Mount | Paths |
|---|---|
| Collection | `GET`/`HEAD <mount>` (the list: `limit`, `cursor`, `sort` as an enum of the sortable properties, each filter with its property's schema), `POST <mount>`; `GET`/`HEAD`/`PUT`/`PATCH`/`DELETE <mount>/{id}`; `POST <mount>/{id}/increment/{field}`; `POST <mount>/{id}/<transition>` per transition on the mount; `POST <mount>/transfers/<transfer>` per transfer, taking `Store<Collection>Transfer` and answering `Store<Collection>Transferred` |
| Readers | Per readers mount: `GET`/`HEAD <mount>` and `<mount>/{id}`. With `properties` or `showOwner`, the mount's own `Store<Collection><Name>ReaderRecord` and `...ReaderList` (for `readers.directory` of `wallets`, `StoreWalletsDirectoryReaderRecord`); with `properties` it holds `id` and the listed properties only, `sort` and the filters are the listed ones, and there is no `403` without `members`. A mount with neither answers `Store<Collection>Record` |
| `by: others` transition | `POST <mount>/{id}` |
| Short link | `GET`/`HEAD <mount>/{key}`, a `302` with `Location` |

The schemas come from the record schema: `Store<Collection>Record` is it with
`id`, `createdAt` and `updatedAt` added and the collection's `defaults` and
`readOnlyProperties` written as the standard `default` and `readOnly`
annotations, `Store<Collection>Create` (for `POST` and `PUT`) leaves out the
read-only properties and requires only what has no default,
`Store<Collection>Patch` lets an optional property be `null`, and the list,
per-mount reader (with `_owner` under `showOwner`, and only the listed
properties under `properties`) and `StoreError` shapes are named the same way.
A gated create lists its `401` and `403 membership_required`, `editable` and
`deletable` add `409 record_locked` (naming the states) and the `Allow`
header and list `allow`, `unique` adds `409 value_taken`, and a declared
`length`, `step` or `origin` is named in the `422`. Each operation lists the headers it takes (`If-Match`, and
`Idempotency-Key` where the collection enables it) and answers (`ETag`,
`Allow-Transitions`, `Location`, `Idempotency-Replayed`), its `requestBody`
bound (`x-urlcode.maxBytes`: `maxRecordBytes` plus 4 KiB), and its refusals,
the `422` naming core's `UrlcodeBodyValidationIssue`. Only the methods the
route declares are kept, and core adds the runtime's headers and a sign-in
gate's `401`/`403` and security requirement. `packages/store/test/openapi.test.ts`
validates the output against the official OpenAPI 3.1 schema and runs the
[contract run](TOOLING.md#openapi-export) against a served store. Without the
host file the mounts stay opaque: core never loads extension code to describe
a project.

A collection whose `schema` names a [project schema](#a-named-schema-as-the-record-schema)
references it instead of copying it: core writes the schema once as
`components.schemas.<name>`, as for a route body naming it, and each record,
create and patch property is `{$ref: '#/components/schemas/<name>/properties/<property>'}`
with the collection's `default` and `readOnly` beside the reference. When the
collection takes the schema exactly as a create body (no read-only property,
and no default on a required one), `Store<Collection>Create` is the component
itself, so a generated client has one type for the store's `POST`, a route
body and an MCP tool naming that schema.

## Using a collection from another extension

An extension that `requires: [store]` reaches declared collections through the
store's typed export, `ctx.get('store')` in its definition's `host()`
(`StoreExports`, contract version 1, #529), never by reading
`extensions.store.config`. Once the store is active (declare it first under
`extensions`), `records('<collection>')` returns the collection's `ownership`,
`readOnly`, record `schema` (a deep-frozen copy; a named one resolved), `defaults` and
`readOnlyProperties`, and four calls that take the request
principal (`request.principal`):

- `create(principal, values)` stamps the principal as owner on an owned
  collection;
- `get(principal, id)` returns a record in the principal's scope;
- `update(principal, id, patch, {ifMatch})` is a partial update (PATCH): a
  property set to `null` is [cleared](#clearing-a-property);
- `list(principal, {limit, cursor})` returns one page of the principal's scope
  in creation order, `{items, total, next?, previous?}`: `limit` is capped at
  the collection's `pageSize`, and `next` and `previous` are the cursors of
  the adjacent pages (a malformed cursor is `400 invalid_query`).

- `transition(principal, id, name, {ifMatch})` runs a
  [declared transition](#conditional-transitions-and-result-aware-retries)
  exactly as its HTTP endpoint does, without an `Idempotency-Key`, and
  through the same membership gate.
- `transfer(principal, name, {from, to, amount}, {ifMatch})` runs a
  [declared transfer](#declared-transfers) the same way and returns
  `{from, to?}`, `to` only when the principal may read it.

A [membership collection](#membership-gates-and-cross-owner-reads) has no
mount, so this export (and the operator's `addMember`) is how code maintains
it: `create(null, {userId})` adds a member.

`create`, `get`, `update` and `transition` return `{record, etag}` (a record
never includes its owner) and
applies exactly the JSON API's rules: another owner's record and a missing id
are the same `404`, no principal on an owned collection is `401`, a record
that breaks the schema is `422 invalid_record` with `issues`, `maxRecords` is `409 collection_full`, and
a stale `ifMatch` is `412`. Failures are `StoreError`s with the same status and
code as the HTTP answer. The export performs no request admission of its own:
the consumer handles CSRF and origins for the requests it serves.
`transaction(work)` runs several of these
operations as one database transaction: see
[host transactions](#host-transactions).

## Not built yet

Holds are not built (a [declared transfer](#declared-transfers) moves value
between two records; a hold still needs a host transaction; the
[transition design](#what-is-not-covered) lists what each needs), nor are roles
beyond a [membership collection](#membership-gates-and-cross-owner-reads). Recorded in
[open decisions](OPEN-DECISIONS.md): ranges and text search. Owned collections
([#331](https://github.com/jimhoyd-com/urlcode/issues/331)) are owner-only apart from
[readers mounts](#membership-gates-and-cross-owner-reads): sharing one record with chosen principals and write access for managers or support are not
built.
