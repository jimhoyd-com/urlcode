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

Records live in `data/store/` beside `host.mjs` (or `STORE_DIRECTORY`), outside
`app/`. Review the project, put the revision the command printed in the
operator policy as its `projectSha256` (or set `PROJECT_SHA256` to it), and
serve; `--policy` with `--host-file` pins the host automatically
([the revision pin](EXTENSIONS.md#the-revision-pin)):

```sh
npx urlcode extensions --host-file host.mjs    # inspect schemas
npx urlcode serve --host-file host.mjs --policy /etc/urlcode/policy.json --origin https://todo.example.com
curl -X POST -H 'Content-Type: application/json' -d '{"title":"first"}' https://todo.example.com/api/todos
```

With `auth` installed (`--with ui,auth,store --example` in any order, or `urlcode
extensions add auth` before `store --example`) the example adds `auth: true` to the
mount, so only signed-in callers reach the API and the screen, and declares the
`todos` collection `ownership: owner`, so each signed-in user sees and changes
only their own todos ([per-record ownership](#per-record-ownership)); no
acknowledgement is needed. Without `auth` the example collection stays shared,
because there is no principal to own a record.

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
| `PATCH /api/todos/<id>` | updates the supplied fields, `200` |
| `DELETE /api/todos/<id>` | `204` |

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
Status codes: `400` invalid record or JSON, `404`, `405` with `Allow`, `409`
`collection_full` (or `owner_quota_exceeded` on an
[owned collection with a per-owner limit](#per-owner-record-limit)), `413` body or record too large, `415`, `503` when the disk
write failed, `500` for anything unexpected (no cause in the body).

## Bounded keyed transitions

Collections can opt into three deliberately small state primitives. They are
not a general transaction language, do not run project code, and do not select a
database or provider. The operator still supplies the directory in the host
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
  one under the collection write lock. It refuses undeclared counters and an
  increment that would violate the field's declared finite/integer/minimum or
  maximum limits. There is no caller-provided delta, conditional expression or
  multi-record operation.
- `idempotency: {maxKeys: N}` enables an optional `Idempotency-Key` header on
  a collection's `POST`, `PUT`, `PATCH`, `DELETE`, and increment endpoints.
  A key is 1–128 characters with no control character. The store claims it in
  the same atomic file replacement as the accepted mutation. A retained repeat
  is always `409 idempotency_duplicate`; invalid/failed mutations do not claim
  the key. The newest `N` distinct keys are retained in order, so an evicted
  key is intentionally no longer protected. Supplying the header to a
  collection that did not enable idempotency is `400 idempotency_not_enabled`,
  rather than silently offering a false guarantee. Retention is scoped per
  network client (the runtime's caller identity), so two different callers
  choosing the same key value do not collide; an unauthenticated mount has no
  stronger caller identity than that to scope by.

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

## Conditional writes

A single-record `GET`/`HEAD` on a collection's own CRUD mount returns a
strong `ETag`, as does the response to a `POST`, `PUT` or `PATCH`. Send that
value back as `If-Match` on a later `PUT`, `PATCH` or `DELETE` to make the
write conditional: it applies only if the record has not changed since, and
otherwise answers `412` without writing anything — useful when two callers
might update the same record concurrently and the loser should not silently
overwrite the winner's change. `If-Match` is optional; omitting it keeps the
default last-write-wins behavior unchanged. A malformed `If-Match` (not this
store's own quoted hex format) is `400`, not a silent bypass.

An idempotency claim is a durable *state/delivery decision*, not delivery
itself: the store does not send webhooks, provide an outbox, retry a remote
request or prove that another system received anything. It is suitable for a
webhook handler to record exactly one accepted transition before its own
operator-owned delivery mechanism; external side effects still need their own
idempotency protocol.

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
- The whole collection is sorted and filtered in memory per request, bounded by
  `maxRecords` (at most 10,000). On a shared collection sorting and filtering
  apply to every record; on an [owned](#per-record-ownership) one they apply to
  the caller's own records only, and `total` and cursors count only those.

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
signed-in user's id, or for a
[bearer key](EXTENSIONS.md#bearerapi-key-routes) either the id of the user the
operator issued it for (`userId`, so its records belong to that user and survive
rotating the key) or, for a service key with no user, `apikey:<key id>` (records
it creates belong to that key; [move them](#moving-records-to-another-principal)
when the key is replaced). The store never reads a
cookie, header or auth table itself, and it compares the id for equality only.

On an owned collection:

- `POST` stamps the caller's principal on the new record. The owner is stored in
  the data file as `_owner` and never appears in a response; a body naming
  `_owner` is `400` like any undeclared field, and `PUT`/`PATCH` keep the stored
  owner. There is no transfer through the API; the operator can
  [move records](#moving-records-to-another-principal) with the server stopped.
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
- `Idempotency-Key` retention is scoped by principal as well as by network
  client.
- Activation refuses the collection when its mount's route carries no
  principal-providing policy (for example no `auth: true`), and refuses `key`
  (and so short links) on it: a collection-wide unique key would tell one
  owner that another already used a value, and a public short link cannot serve
  an owned record.

Limits that stay true on an owned collection: `maxRecords` still caps the whole
collection, and `409 collection_full` still tells any caller that it is full
(with or without `maxRecordsPerOwner`, enough principals together can fill it,
so size `maxRecords` for them); all owners' records share
one file, one lock and one write sequence; the store is still trusted operator
code on one host, not a hostile multi-tenant boundary; and backups copy every
owner's records together. Access by an operator or support role to another
user's records is not modelled: auth's impersonation gives the impersonated
user's principal, so an impersonating operator acts on that user's records.

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
- Only a create adds a record, and the limit is checked in the same write
  sequence as the create, so concurrent creates cannot overshoot it. A replayed
  `Idempotency-Key` is refused as a duplicate before anything is counted.
- The counts are derived from the records in memory, rebuilt when the store
  activates and after every write; nothing extra is stored. Records with no
  owner (see below) count toward the collection but toward no principal.
  `ownerless-assign` can leave a principal above its limit, and lowering the
  limit can too: the store still activates, the principal's existing records
  stay readable and changeable, and it cannot create more until it is back
  under the limit.

### Making an existing collection owned

Records written while a collection was shared carry no owner. After the
collection is declared `ownership: owner` they are served to **nobody**: they
are not listed, read, changed or deleted through the API, but they still count
toward `maxRecords`. The store never guesses an owner. With the server
stopped (the commands take the directory lock and refuse while it runs), the
operator reports them and then assigns them to one principal or deletes them:

```sh
npx urlcode-store ownerless --directory /srv/site/data/store --collection notes
npx urlcode-store ownerless-assign --directory /srv/site/data/store --collection notes --owner <principal id>
npx urlcode-store ownerless-delete --directory /srv/site/data/store --collection notes
```

Each prints `{collection, records, ownerless, ids}` as JSON. `--owner` takes a
principal id exactly as the provider sets it (for auth, the user's id from
`urlcode-auth users`, or `apikey:<key id>`). The same operations are exported
from the package as `reportOwnerless`, `assignOwnerless` and `deleteOwnerless`.

Going back is refused: a collection declared shared whose file holds records
with an owner fails activation, because serving them shared would hand every
user's records to every caller. Remove the owners from a stopped copy of the
file deliberately if that is really intended. A store older than this feature
refuses such a file too (`_owner` is not a declared field), so ownership is a
one-way change for older releases.

### Moving records to another principal

Records belong to the principal that created them. When that principal is
replaced, for example a service API key (`apikey:<key id>`) that is rotated or
revoked, its records stay in the file but nobody can reach them. With the server
stopped, the operator moves them
([#732](https://github.com/jimhoyd-com/urlcode/issues/732)); run `--dry-run`
first to see the counts:

```sh
npx urlcode-store reassign --directory /srv/site/data/store --project /srv/site/app \
  --from apikey:<old key id> --to apikey:<new key id> --dry-run
npx urlcode-store reassign --directory /srv/site/data/store --project /srv/site/app \
  --from apikey:<old key id> --to apikey:<new key id>
```

- `--from` and `--to` are principal ids exactly as the provider sets them (for
  auth, a user's id from `urlcode-auth users`, or `apikey:<key id>`), validated
  with the same pattern core applies to a principal. The two must differ.
- `--project` is the site's route project (the `app/` directory). The command
  reads it through core's project loader to learn which collections are
  declared `ownership: owner` and each one's `maxRecordsPerOwner`; only those
  collections are touched. `--collection <name>` limits the move to one of them
  (a shared or undeclared name is refused). A declared collection with no data
  file yet has nothing to move.
- Only each record's owner changes. Records owned by anyone else, and records
  with no owner (see below), are left alone.
- It prints `{from, to, dryRun, moved, collections: [{collection, moved,
  toBefore, toAfter, maxRecordsPerOwner}]}` as JSON. `--dry-run` takes the lock,
  counts and writes nothing.
- **The per-owner limit is respected.** When moving would leave `--to` holding
  more than a collection's `maxRecordsPerOwner`, the whole command is refused,
  naming the collection and the counts, and no collection is changed (a dry run
  is refused the same way). Delete or move some of `--to`'s records first, or
  raise the limit. `maxRecords` is unaffected, since no record is added.
- Like the `ownerless` commands it takes the directory lock and refuses while a
  store process holds it. All counts are checked before anything is written;
  each changed collection file is then replaced atomically, one after another. A
  disk failure between two files can leave the earlier collections moved, and
  running the same command again moves the rest.
- It does not touch `Idempotency-Key` retention, which is scoped by principal: a
  retry by `--to` with a key `--from` used is not recognised as a duplicate.

The same operation is exported as `reassignOwner(directory, {from, to,
collections, collection?, dryRun?})`, where `collections` is the declared
`extensions.store.config.collections`. A key that should keep a user's records
across rotation can be issued for that user in the first place
([keys that act for a user](../packages/auth/README.md#keys-that-act-for-a-user));
then no move is needed.

## Storage and concurrency: what it does and does not guarantee

- One JSON file per collection in the operator directory (default `data/store`
  beside `host.mjs`, or `STORE_DIRECTORY`). The directory must be outside the
  project (checked after symlink resolution) and is created `0700`, files `0600`.
- Each write goes to a temporary file, is fsynced, then renamed over the
  collection file, and the directory is fsynced (best effort). A crash leaves
  either the old or the new file, never a torn one; a failed write changes
  nothing in memory or on disk.
- Writes within one process are applied strictly one at a time per collection,
  so concurrent requests cannot interleave or lose each other's updates in that
  process. Unique-key claims, increments, and retained idempotency claims use
  that same sequence and the same replacement file as the changed record.
- The directory is single-writer. Activation takes an exclusive lock file
  (`.store.lock`, holding the pid) and refuses a second server over the same
  directory; a lock left by a dead process is reclaimed. This is a guard against
  mistakes, not a distributed lock: it does not work across machines or on
  network filesystems, and the same host needs one process (no `workers`
  multi-process clustering over the same directory).
- Every write rewrites the whole collection file, so cost grows with the
  collection size; the record and byte caps bound it. There is no transaction
  across records or collections, no index and no query language beyond
  paginated listing with declared sorting and equality filtering, no optimistic concurrency (`PUT`/`PATCH` are last write
  wins), and no history. Startup loads and revalidates every record; a file that
  no longer matches the declared fields refuses activation rather than serving
  bad data.
- The keyed-transition guarantee is therefore one Node server process per
  operator directory. A second local process refuses the lock; multiple hosts,
  network filesystems and clustered workers are unsupported. An atomic crash
  leaves either the old transition and idempotency set or the new pair. This is
  durable local state, not a distributed exactly-once or external-delivery
  guarantee.
- Backups are the operator's: copy the directory while the server is stopped, or
  accept that a copy taken mid-write is the last complete file.

Errors never contain record values, file contents or filesystem paths.

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
`readOnly` and declared `fields`, and three calls that take the request
principal (`request.principal`):

- `create(principal, values)` stamps the principal as owner on an owned
  collection;
- `get(principal, id)` returns a record in the principal's scope;
- `update(principal, id, patch, {ifMatch})` is a partial update (PATCH).

Each returns `{record, etag}` (the record never includes its owner) and
applies exactly the JSON API's rules: another owner's record and a missing id
are the same `404`, no principal on an owned collection is `401`, field
errors are `400` with field names, `maxRecords` is `409 collection_full`, and
a stale `ifMatch` is `412`. Failures are `StoreError`s with the same status and
code as the HTTP answer. The export performs no request admission of its own:
the consumer handles CSRF and origins for the requests it serves.
[form-records](../packages/form-records/README.md) uses it to save a declared
form into an owned collection, with a confirmation and a constrained edit page.

## Not built yet

Recorded in [open decisions](OPEN-DECISIONS.md): a SQLite backend, ranges and
text search, and richer screens beyond the first slice ([#262]): labels,
columns, sort and filter controls have all shipped
([#330](https://github.com/jimhoyd-com/urlcode/issues/330)). Owned collections
([#331](https://github.com/jimhoyd-com/urlcode/issues/331)) are owner-only: sharing a record with other principals and manager or support access are not
built.
