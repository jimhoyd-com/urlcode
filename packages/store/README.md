# @jimhoyd/urlcode-store

Operator-installed data store extension for URLCode. Declare collections in
`urlcode.yaml`, each with a JSON Schema 2020-12 record `schema`, mount each with
`extension: store`, and the extension serves a bounded JSON CRUD API backed by
one operator-owned SQLite database. No handler code.

## Record schema

A collection's `schema` is a JSON Schema 2020-12 object schema in the same
bounded profile as a route's `request.body.<METHOD>.schema`, compiled and run
by the same validator. It is a flat object of scalar properties, each with one
`type` (`string`, `integer`, `number` or `boolean`), and it writes out
`additionalProperties: false`:

```yaml
# snippet: partial -- one collection under extensions.store.config.collections
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
```

The schema carries value shape only, exactly as a request body schema does.
What the store does beyond it sits beside it on the collection and names its
properties: `defaults` (stored on create, and on `PUT`, when the body omits the
property) and `readOnlyProperties` (only a declared transition changes them),
with the other store-owned facts (`key`, `increments`, `ownership`,
`transitions`, `readers`, `membership`, `sortable`, `filterable`). A record
that breaks the schema answers `422 invalid_record` with the `issues` list a
body-schema route answers. With the host file loaded, `urlcode openapi`
describes every store mount from this schema (see [OpenAPI][store-openapi]).

### Named schemas

`schema` may instead name one of the project's
[named schemas][http-named-schemas] (the top-level `schemas:` map), so one
schema is a collection's record shape, a route's request body and an MCP
tool's arguments at once, and all three refuse the same invalid input at the
same pointer:

```yaml
version: "1"
schemas:
  Ticket:
    type: object
    additionalProperties: false
    required: [title]
    properties:
      title: {type: string, minLength: 1, maxLength: 80}
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

The named schema must satisfy the same restrictions as an inline one (a flat
object of scalar properties with `additionalProperties: false` and no
`$defs`), or activation refuses it naming the collection, the schema and the
pointer. The OpenAPI export references the named component from the store's
schemas instead of copying it.

## Responses

A record is its schema's properties plus the store-owned `id`, `createdAt` and
`updatedAt`. `GET <mount>` answers one page of records as `{items, total,
next?, may, etags}` (the list is `items`, not `records`):

```json
{
  "items": [
    {"id": "4b3f5c2e-8a51-4f0e-9d7a-2c6e1f0b9a13", "title": "Buy milk", "done": false,
     "createdAt": "2026-09-29T10:00:00.000Z", "updatedAt": "2026-09-29T10:00:00.000Z"}
  ],
  "total": 21,
  "next": 20,
  "may": {"4b3f5c2e-8a51-4f0e-9d7a-2c6e1f0b9a13": []},
  "etags": {"4b3f5c2e-8a51-4f0e-9d7a-2c6e1f0b9a13": "\"9f2c4e1a7b3d5f60a8c2e4b6d8f01a3c\""}
}
```

`total` counts every record the caller may see (or every match of the filters);
`next` is present only when there is another page: send it back as
`?cursor=` (a number for creation order, an opaque string for a sorted list).
`may` maps each listed id to the declared transitions the caller may run on it
now, and `etags` to the record's current `ETag` for `If-Match`. One record
(`GET`, `POST`, `PUT`, `PATCH`, a transition) answers the record itself.

Every refusal the store writes is one envelope, with `issues` on a `422
invalid_record` (the bounded issue list a body-schema route answers) and
`fields` on a `400 invalid_query`. Submitted values are never echoed:

```json
{"error": {"code": "invalid_record", "message": "Record does not match the collection schema",
  "issues": [{"pointer": "", "keyword": "required", "message": "is missing required property title", "property": "title"}]}}
{"error": {"code": "invalid_query", "message": "The query is not valid",
  "fields": {"limit": "must be a non-negative integer"}}}
```

The codes and statuses are in the [HTTP contract][store-http-contract]. The
runtime's own refusals on other routes (a body-schema `422`, an unmatched `404`)
are a different body unless the site sets `errors: {format: json}`; see
[error format][http-error-format]. For the exact schema of every mount, run
`npx urlcode openapi --project app --host-file host.mjs` in the site: with the
host file loaded, the export describes each collection's paths, record, create,
patch, list and `StoreError` shapes ([OpenAPI export][tooling-openapi-export]).

## Install

```sh
npm install @jimhoyd/urlcode
npx urlcode init my-site --with auth,store --example
# or, in an existing site:
npx urlcode extensions add store --example
```

Without `--example` the store installs as a capability only: an empty
`collections` block in `app/urlcode.yaml`, no mount and no acknowledgement.
Declare your own collection and its `extension: store` route there.

`store` is released as a tarball on core's GitHub Release, at core's version,
and pinned by sha512 in core's `dist/addons.json`; `urlcode extensions add`
installs it into the site and checks that pin. See
[add-ons][add-ons] for the
site layout and commands.

`--example` declares a `todos` collection in `app/urlcode.yaml` and mounts it at
`/api/todos/*` in `app/routes/store.yaml`. Either way `add` adds one line to `host.mjs`:

```js
// host.mjs (trusted operator code, outside app/)
import { composeHost } from '@jimhoyd/urlcode/host';
import store from '@jimhoyd/urlcode-store/extension';

export default await composeHost(import.meta.url, [
  store(),                    // or store({ database: '/var/lib/site/store.sqlite' })
]);
```

Every collection lives in one SQLite database (`node:sqlite`, so Node only):
`store({ database })`, else `STORE_DATABASE`, else `data/store.sqlite` beside
`host.mjs`; it must be outside `app/`.

Host options, all optional:

| Option | Default | Meaning |
|---|---|---|
| `database` | `STORE_DATABASE`, else `data/store.sqlite` beside `host.mjs` | Absolute path of the SQLite database, outside `app/`. |
| `durability` | `STORE_DURABILITY`, else `'full'` | `'full'` (SQLite `synchronous=FULL`: a committed write survives power loss) or `'normal'` (`synchronous=NORMAL`: faster commits; the last ones before a power loss or OS crash can be lost, and the activation logs a warning). Anything else refuses to start. The `urlcode-store` operator commands always commit with `full`. See [durability][store-durability]. |

The example is API only: a frontend calls the JSON mount with `fetch`, as
[the reference proof's client][reference-client] does.

When `auth` is installed the example puts `auth: true` on the API mount (a
signed-in session, and same-origin provenance for writes) and declares the
`todos` collection `ownership: owner`, so each signed-in user sees and changes
only their own todos. When `audit` is installed the example collection also
declares `audit: true`. Without `auth` the example refuses; the refusal prints the exact command, ending in
`--ack store:public-write`, which acknowledges a public writable endpoint (not
rate limiting, abuse protection or multi-tenant isolation).

The full guide, HTTP contract, limits and the honest list of concurrency
guarantees is [docs/STORE.md][store-guide].
Short version: one server process per database (supported and tested, not
enforced: SQLite's locks keep another process from corrupting it, and a write
blocked past the 2-second busy timeout answers `503`); every write is one SQLite
transaction that commits the record, its key, its `Idempotency-Key` claim and
its audit event together or not at all; a retried `Idempotency-Key` replays the
first status with the current record (a different request under it is `422`);
per-collection record and byte quotas; last write wins unless a caller sends
`If-Match`; each HTTP request changes one record. A `urlcode dev` hot reload shares the database connection with the
replacement runtime (see [reload][store-reload]). A collection is shared by default; one that holds
per-user data declares `ownership: owner`, and every request is then scoped to
the principal a policy such as `auth: true` on its mount sets (another user's
record is a `404`, records written before it became owned are served to nobody
until `urlcode-store ownerless-assign` or `ownerless-delete` handles them,
`urlcode-store reassign --from <principal> --to <principal>` moves one
principal's records to another in one transaction (on an `audit: true`
collection every moved or deleted record is recorded, with the operator's
optional `--actor`, and the report shows the undelivered events and warns when
no server's audit drain has kept up in the last 60 seconds), and
`maxRecordsPerOwner` caps each user's records with `409 owner_quota_exceeded`; see
[per-record ownership][store-per-record-ownership]). A collection may declare
`sortable` and `filterable` property lists for `?sort=<property>` /
`?sort=-<property>` and `?<property>=<value>` list queries (one sort property,
equality filters, `id` tie-break, opaque cursor; undeclared names, unparseable
values and values the property's own schema refuses are `400`s); they apply to
the whole collection, or on an owned collection to the caller's own records. A
`PATCH` that sets a property to `null` removes it; the result must still satisfy
the schema, so a required property refuses that with a `422` issue, and `PUT`
still takes only values (see [clearing a property][store-clearing-a-property]).

A collection that declares `audit: true` records every write in the audit
log (the store `uses` the `audit` extension; activation refuses such a
collection when audit is not installed, or when no principal-providing policy
guards its mount). Each create, replace, update, delete and increment (never a
short-link click) is an event (`store.record.created`, `.replaced`, `.updated`,
`.deleted`, `.incremented`) with subject `<collection>/<id>`, the principal id
or `anonymous` as actor, and the changed property names, never values. The event
is inserted into the store database's outbox table in the same transaction as
the record and drained by audit while the host runs; when 1000 events wait
undelivered the next write answers `503 audit_backlog` and changes nothing. See [audited writes][store-audited-writes].

Back the database up while the server serves with
`urlcode-store backup --database <absolute store.sqlite> --destination <absolute new file>`:
an online copy through SQLite's backup API (Node 22.16 or newer) that refuses an
existing destination, is written `0600` and is checked as a store database of the
same schema version before it appears. To restore, stop the server and put the
copy in place. See [backups][store-backups].

Another extension that requires the store reaches declared collections through
its typed export, `StoreExports` (`ctx.get('store')`): `create`, `get`, a
partial `update` (which clears a property given `null`, like `PATCH`) and a
paginated `list`, each scoped to the request principal exactly as the JSON API
is, a declared `transition` or `transfer`, and `transaction(work)`, which runs several of those
operations synchronously as one database transaction (trusted host code only,
never sandboxed). `transaction(work, {idempotencyKey, fingerprint})` is
retry-safe: the key, the fingerprint and `work`'s JSON result (at most 16 KiB)
are kept in the same transaction, a retry with the same fingerprint returns
that result without running `work`, and a different one is
`422 idempotency_key_reused`. See [using a collection from another extension][store-using-a-collection-from-another-extension].

## Transitions

A collection may declare named `transitions` (#835): `POST <mount>/<id>/<name>`
moves one record from the exact `from` values to the constant `set` values
(and the `stamp` values `actor` or `now`) in one transaction, honouring
`If-Match` and `Idempotency-Key`, or answers `409 transition_conflict` and
writes nothing. On an owned collection `by: others` lets any principal except
the owner run it, on a separate mount whose route policy decides who may; a
property in `readOnlyProperties` can only change through a transition (or a
transfer). Transitions are not an expression language. See
[conditional transitions and result-aware retries][store-conditional-transitions-and-result-aware-retries].

A collection may declare `transfers: {<name>: {amount, min?, members?}}`
(#902): `POST <mount>/transfers/<name>` with `{from, to, amount}` subtracts a
positive whole `amount` from one record's integer property and adds it to
another's in one transaction, so the sum never changes; a debit below `min`
(default 0) answers `409 insufficient_balance` and writes nothing. On an owned
collection the caller debits only its own record and may credit any owned
record, and the answer shows the credited record only when the caller owns it.
Amounts are integers (minor units for a currency): a fraction is
`422 invalid_transfer`, never rounded. `If-Match` (on `from`),
`Idempotency-Key` and audit apply. See [declared transfers][store-declared-transfers].

A scheduling collection declares `intervals: {start, end, within?, scope?,
when?}` (#902): among the records holding the `when` values, no two in one
scope with equal `within` values (a room) may hold overlapping half-open
`[start, end)` intervals. Every create, `PUT`, `PATCH` and transition is
checked in its own transaction through a partial index (one index step, not a
scan) and an overlap answers `409 interval_conflict`, writing nothing, so a
refused move keeps its slot. On an owned collection the default
`scope: collection` lets another owner's booking block a slot without naming
it: `error.conflict.id` appears only for a record the caller may read. Bounds
are both numbers or both UTC date-times (`Z`, at most millisecond precision).
See [non-overlapping intervals][store-non-overlapping-intervals].
A list carries each listed record's `ETag` in `etags` and the transitions the
caller may run on it now in `may`, both keyed by id (one record's answer has
them as the `ETag` and `Allow-Transitions` headers), so a client sends
`If-Match` for the version it listed and offers only what the store would
accept. `may` reads only the caller's own membership, once per gate; see
[what the caller may run][store-what-the-caller-may-run].

## Membership gates

Permissions are application data keyed by the principal id, not roles in auth
(#863). A collection declared `membership: true` with a `key` holds one record
per member, keyed by principal id. It has no mount and no HTTP API: the
operator maintains it with `urlcode-store members add|remove|list --database
<absolute store.sqlite> --project <absolute app> --collection <name>
[--principal <id>]` (or `addMember`, `removeMember` and `listMembers` from this
package), and trusted extension code through `StoreExports`. With auth, the
principal id is the Better Auth user id: `npx urlcode-auth find-user --email
<email>` prints it. With
`audit: true` every added and removed member is recorded
(`store.membership.added`/`.removed`, subject `<collection>/<principal id>`)
in the same transaction as the change, and `urlcode-store reassign` moves a
principal's membership with its records. A transition
that names `members: <collection>` admits only members (`403
membership_required` before any record is read, the same for an existing and a
missing id). An owned collection's `readers: {mount, members}` lets members
list (with the declared filters and sort) and read every owner's records,
read-only, on a separate mount; `showOwner: true` adds each record's owner id
(`_owner`) to that mount's answers only. Membership is read inside each request's
transaction, so a change applies to the next request. See
[membership gates and cross-owner reads][store-membership-gates-and-cross-owner-reads].

## Short links

A collection with a unique `key`, a required `format: uri` destination
property and one `increments` counter can back public short links with no
function: `shortLinks.<name>` names that collection, its destination and click
properties, and a redirect mount separate from the CRUD mount. Every write to
the destination also takes only an absolute HTTP(S) URL without credentials
(`422` otherwise). `GET /go/<code>`
counts the click and answers `302` to the stored destination; `HEAD` answers the
same without counting; an unknown code is `404`.

```yaml
version: "1"
extensions:
  store:
    version: "1"
    config:
      collections:
        links:
          mount: /api/links
          key: code
          increments: [clicks]
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
        public: {mount: /go, collection: links, destination: destination, clicks: clicks}
routes:
  /api/links/*: {extension: store, methods: [GET, HEAD, POST, PUT, PATCH, DELETE], auth: true}
  /go/*: {extension: store, methods: [GET, HEAD]}
```

Protect the CRUD mount according to who may create links (`auth: true` above
needs the auth extension). [Bounded keyed transitions][store-bounded-keyed-transitions]
has the full rules for `key`, `increments` and `idempotency`; the
[field reference](#field-reference) below lists every `shortLinks` key.

## Store schema artifact

The `store-schema` artifact (`urlcode artifacts add store-schema`) carries this
extension's configuration schema and an example configuration as inert JSON
for authoring tools; it does not register `store` or grant access to a data
directory. See [artifacts][extensions-artifacts].

Requires the matching `@jimhoyd/urlcode` core as a peer. Apache-2.0.

<!-- The links below are pinned to this release, so an installed copy of this README reads the docs of the
version it describes; `npm run release:bump` moves them and scripts/check-local-links.ts checks their targets. -->
<!-- urlcode-current-version:start -->
[store-guide]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md
[store-http-contract]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md#http-contract
[store-openapi]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md#openapi
[http-error-format]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/HTTP.md#error-format
[http-named-schemas]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/HTTP.md#named-schemas
[tooling-openapi-export]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/TOOLING.md#openapi-export
[add-ons]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/EXTENSIONS.md#add-ons-extensions-and-artifacts
[store-durability]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md#durability
[reference-client]: https://github.com/jimhoyd-com/urlcode/tree/v0.6.5/proofs/private-requests/client
[store-reload]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md#reload
[store-per-record-ownership]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md#per-record-ownership
[store-clearing-a-property]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md#clearing-a-property
[store-audited-writes]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md#audited-writes
[store-backups]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md#storage-and-concurrency-what-it-does-and-does-not-guarantee
[store-using-a-collection-from-another-extension]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md#using-a-collection-from-another-extension
[store-conditional-transitions-and-result-aware-retries]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md#conditional-transitions-and-result-aware-retries
[store-what-the-caller-may-run]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md#what-the-caller-may-run
[store-membership-gates-and-cross-owner-reads]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md#membership-gates-and-cross-owner-reads
[store-bounded-keyed-transitions]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md#bounded-keyed-transitions
[store-non-overlapping-intervals]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md#non-overlapping-intervals
[store-declared-transfers]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md#declared-transfers
[extensions-artifacts]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/EXTENSIONS.md#artifacts
<!-- urlcode-current-version:end -->

<!-- extension-reference:start -->
<!-- Generated from urlcode.json by scripts/generate-extension-reference.ts (npm run docs:extensions). Do not edit between these markers; change the extension's schema descriptions instead. -->

## Field reference

Every key `store` accepts, rendered from this package's `urlcode.json` (the schema the runtime validates against). Required means required within its containing object; `*` is a key you choose and `[]` an array item.

**Schema-valid is not activatable.** JSON Schema checks shape only. Activation also checks what a schema cannot express: the route for each declared mount exists, referenced fields and collections are declared, peers are installed and active, and the cross-field rules the descriptions state. A project that validates can still refuse to start; run `urlcode validate --project . --host-file <host.mjs> --origin <origin>`, which activates it.

**Peers.** uses `audit` when installed (optional: the features that need one refuse to activate without it).

### Configuration: `extensions.store.config`

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `extensions.store.config.collections` | object | yes | maxProperties: 32; keys: "^[a-z][a-z0-9_-]{0,63}$" | Collections by name, each stored as rows of the site's store database (data/store.sqlite outside app/, chosen by the operator) and served as a bounded CRUD API at its mount. |
| `extensions.store.config.collections.*.mount` | string | no | maxLength: 256; pattern: "^/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$" | URL path of the collection's JSON API; it needs a route `<mount>/*` with extension: store (GET, HEAD, POST, PUT, PATCH, DELETE). Required, except on a membership collection, which has none. |
| `extensions.store.config.collections.*.schema` | string / object | yes | one of: string (pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$"); object (fields below) | The record schema, inline or by the name of a project named schema (top-level schemas:). Either way it is a request body schema restricted to a flat record: the collection's defaults and readOnlyProperties carry what the store does beyond value shape. |
| `extensions.store.config.collections.*.schema.$schema` | constant | no | const: "https://json-schema.org/draft/2020-12/schema" | Optional; only the JSON Schema 2020-12 dialect. |
| `extensions.store.config.collections.*.schema.$comment` | string | no | maxLength: 4096 | A note for readers; not validated. |
| `extensions.store.config.collections.*.schema.title` | string | no | maxLength: 4096 | A short name for the record type. |
| `extensions.store.config.collections.*.schema.description` | string | no | maxLength: 4096 | What a record of this collection is. |
| `extensions.store.config.collections.*.schema.type` | constant | yes | const: "object" | Always object: a record is a JSON object. |
| `extensions.store.config.collections.*.schema.additionalProperties` | constant | yes | const: false | Always false, written out: a body naming a property the schema does not declare is refused. |
| `extensions.store.config.collections.*.schema.required` | array | no | maxItems: 64; uniqueItems: true; items: string (pattern: "^[a-z][A-Za-z0-9_]{0,63}$") | Properties every record must carry: a create or PUT without one (and without a default) answers 422, and PATCH cannot clear one. |
| `extensions.store.config.collections.*.schema.properties` | object | yes | minProperties: 1; maxProperties: 64; keys: "^[a-z][A-Za-z0-9_]{0,63}$" | The record properties by name, each a scalar schema. A string property needs maxLength (or an enum) to be sortable or filterable. |
| `extensions.store.config.collections.*.schema.properties.*.type` | string | yes | enum: ["string","integer","number","boolean"] | The one scalar type the property holds; records hold scalars only. |
| `extensions.store.config.collections.*.defaults` | object | no | maxProperties: 64; keys: "^[a-z][A-Za-z0-9_]{0,63}$"; values: string / number / boolean (one of: string (maxLength: 65536); number; boolean) | Declared properties and the value stored on create (and on PUT) when the body omits them; each value must satisfy its property's schema. A required property with a default may be omitted from a create. |
| `extensions.store.config.collections.*.readOnlyProperties` | array | no | maxItems: 64; uniqueItems: true; items: string (pattern: "^[a-z][A-Za-z0-9_]{0,63}$") | Declared properties only a declared transition (its set or stamp) or transfer (its amount) changes. A create stores the default (or leaves them unset), PUT keeps the stored value, and a POST, PUT or PATCH body naming one answers 422. A required one needs a default, and some transition must set or stamp it or some transfer move it. Not the key or an increment. The OpenAPI record marks them readOnly. |
| `extensions.store.config.collections.*.maxRecords` | integer | no | minimum: 1; maximum: 10000 | Records the collection may hold (default 1000); a create beyond it answers 409 collection_full. |
| `extensions.store.config.collections.*.maxRecordBytes` | integer | no | minimum: 256; maximum: 65536 | Largest serialized record in bytes (default 4096); larger answers 413. |
| `extensions.store.config.collections.*.pageSize` | integer | no | minimum: 1; maximum: 200 | Records per list page, and the cap on a list request's limit (default 50). |
| `extensions.store.config.collections.*.readOnly` | boolean | no | — | true: the API serves only GET and HEAD (other methods answer 405); short-link click counting still works. |
| `extensions.store.config.collections.*.key` | string | no | pattern: "^[a-z][A-Za-z0-9_]{0,63}$" | A required string property (maxLength at most 128, no default) whose caller-chosen value the collection keeps unique; a duplicate create answers 409 key_exists. Not allowed with ownership: owner. |
| `extensions.store.config.collections.*.increments` | array | no | maxItems: 8; uniqueItems: true; items: string (pattern: "^[a-z][A-Za-z0-9_]{0,63}$") | Numeric properties with a numeric default that POST `<mount>/<id>/increment/<property>` raises by exactly one in one database transaction, within the property's schema (409 increment_limit otherwise). |
| `extensions.store.config.collections.*.idempotency` | object | no | unknown keys rejected | Enables the Idempotency-Key header on POST, PUT, PATCH, DELETE, increment, transitions and transfers. A retry with a retained key and the same request (method, path, body) replays the first answer's status with the record as it is now; the same key on a different request answers 422 idempotency_key_reused. Without it the header answers 400 idempotency_not_enabled. A key is scoped to the request principal, or to the network client when there is none. |
| `extensions.store.config.collections.*.idempotency.maxKeys` | integer | yes | minimum: 1; maximum: 1000 | Newest distinct keys the collection retains, across all callers; an evicted key is no longer protected and a retry with it runs again. |
| `extensions.store.config.collections.*.sortable` | array | no | maxItems: 8; uniqueItems: true; items: string (pattern: "^[a-z][A-Za-z0-9_]{0,63}$") | Declared properties a list request may sort by (sort=`<property>` or sort=`-<property>`). |
| `extensions.store.config.collections.*.filterable` | array | no | maxItems: 8; uniqueItems: true; items: string (pattern: "^[a-z][A-Za-z0-9_]{0,63}$") | Declared properties a list request may filter by equality (`<property>`=`<value>`); a value the property's schema refuses answers 400 invalid_query. limit, cursor and sort cannot be filterable. |
| `extensions.store.config.collections.*.ownership` | string | no | enum: ["shared","owner"] | shared (default): every caller who reaches the mount sees every record. owner: each record belongs to the principal that created it, and every read and write is scoped to it; the mount must carry a principal-providing policy such as auth: true. |
| `extensions.store.config.collections.*.maxRecordsPerOwner` | integer | no | minimum: 1; maximum: 10000 | With ownership: owner only: records one principal may hold, at most maxRecords; beyond it a create answers 409 owner_quota_exceeded. |
| `extensions.store.config.collections.*.audit` | boolean | no | — | true: every write is recorded in the audit log (property names and the principal, never values), in the same transaction as the write. On a membership collection, adding or removing a member (from any path, the operator CLI included) records store.membership.added or store.membership.removed with the member's principal id in the subject. Needs the audit extension; writes answer 503 audit_backlog while 1000 events wait to drain. |
| `extensions.store.config.collections.*.transitions` | object | no | maxProperties: 16; keys: "^[a-z][a-z0-9_-]{0,63}$" | Declared conditional state changes by name: POST `<mount>/<id>/<name>` moves one record from the from values to the set (and stamp) values in one transaction, honouring If-Match and Idempotency-Key; a record not in the from state answers 409 transition_conflict and nothing is written. Not an expression language. |
| `extensions.store.config.collections.*.transitions.*.from` | object | yes | minProperties: 1; maxProperties: 8; keys: "^[a-z][A-Za-z0-9_]{0,63}$"; values: string / number / boolean (one of: string (maxLength: 256); number; boolean) | Declared properties and the exact value each must currently hold; each value must satisfy its property's schema. |
| `extensions.store.config.collections.*.transitions.*.set` | object | yes | minProperties: 1; maxProperties: 8; keys: "^[a-z][A-Za-z0-9_]{0,63}$"; values: string / number / boolean (one of: string (maxLength: 256); number; boolean) | Declared properties and the constant value the transition writes; each must satisfy its property's schema. Not the collection key. |
| `extensions.store.config.collections.*.transitions.*.stamp` | object | no | maxProperties: 4; keys: "^[a-z][A-Za-z0-9_]{0,63}$"; values: string (enum: ["actor","now"]) | String properties the store fills: actor (the principal id, needs maxLength of at least 128) or now (the commit time in ISO 8601, needs maxLength of at least 24). No enum, const, pattern, format or composition keyword on them. |
| `extensions.store.config.collections.*.transitions.*.by` | string | no | enum: ["owner","others"] | With ownership: owner only. owner (default): only the record's owner, on the collection mount. others: any principal except the record's owner (the owner gets 403 own_record_refused), served on its own mount. |
| `extensions.store.config.collections.*.transitions.*.mount` | string | no | maxLength: 256; pattern: "^/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$" | Required with by: others, refused otherwise: the transition is served as POST `<mount>/<id>` on a route `<mount>/*` with extension: store (POST) and a principal-providing policy. |
| `extensions.store.config.collections.*.transitions.*.members` | string | no | pattern: "^[a-z][a-z0-9_-]{0,63}$" | A membership collection (membership: true): only principals it lists may run the transition; anyone else gets 403 membership_required before any record is read. Checked inside the write transaction, so a membership change applies to the next request. |
| `extensions.store.config.collections.*.membership` | boolean | no | — | true: a membership list. Its key property holds principal ids (one record per member); transitions and readers name it in members. It has no mount and no HTTP API: the operator maintains it with urlcode-store members or trusted extension code (StoreExports); a member's key cannot be changed, only removed and added. Needs key; takes no mount, ownership, transitions, transfers, readers, increments, idempotency, sortable, filterable or readOnly. With audit: true every added and removed member is recorded. |
| `extensions.store.config.collections.*.readers` | object | no | unknown keys rejected | With ownership: owner only: members of a membership collection list and read every owner's records, read-only, as GET `<mount>` (with the collection's limit, cursor, sort and filters) and GET `<mount>/<id>`. Owners keep their own view on the collection mount. The stored owner is shown only with showOwner. |
| `extensions.store.config.collections.*.readers.mount` | string | yes | maxLength: 256; pattern: "^/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$" | A separate mount: a route `<mount>/*` with extension: store (GET, HEAD) and a principal-providing policy. |
| `extensions.store.config.collections.*.readers.members` | string | yes | pattern: "^[a-z][a-z0-9_-]{0,63}$" | A membership collection: anyone it does not list gets 403 membership_required before any record is read. |
| `extensions.store.config.collections.*.readers.showOwner` | boolean | no | — | true: every record this mount answers carries _owner, the opaque principal id of the owner (for auth, the user id; never an email or name), so a member can tell requesters apart. Only this mount shows it: the owner's mount, transitions and StoreExports never do. |
| `extensions.store.config.collections.*.intervals` | object | no | unknown keys rejected | A non-overlap constraint for scheduling: among the records it applies to, no two in the same scope (and with equal within values) may hold overlapping half-open [start, end) intervals, so an interval ending where another starts is allowed. Checked inside the write transaction of every create, PUT, PATCH and transition against an index, never a scan of the collection; an overlap answers 409 interval_conflict and nothing is written, so a move that would overlap keeps the record where it was. Activation refuses stored records that already overlap. Not on a membership collection. |
| `extensions.store.config.collections.*.intervals.start` | string | yes | pattern: "^[a-z][A-Za-z0-9_]{0,63}$" | A required property holding the start: a string with format: date-time, whose values must be UTC (ending in Z) with at most millisecond precision and compare as instants, or an integer or number. |
| `extensions.store.config.collections.*.intervals.end` | string | yes | pattern: "^[a-z][A-Za-z0-9_]{0,63}$" | A required property of the same kind as start holding the end; a record whose end is not after its start answers 422 invalid_record. |
| `extensions.store.config.collections.*.intervals.within` | array | no | maxItems: 4; uniqueItems: true; items: string (pattern: "^[a-z][A-Za-z0-9_]{0,63}$") | Required properties that partition the constraint (a room, a resource): two intervals conflict only when every one of these is equal. |
| `extensions.store.config.collections.*.intervals.scope` | string | no | enum: ["collection","owner"] | collection (default): every record blocks every other, across owners on an owned collection (another owner's conflicting record is never named). owner: with ownership: owner only, each owner's records are constrained among themselves. |
| `extensions.store.config.collections.*.intervals.when` | object | no | minProperties: 1; maxProperties: 8; keys: "^[a-z][A-Za-z0-9_]{0,63}$"; values: string / number / boolean (one of: string (maxLength: 256); number; boolean) | Only records holding exactly these values take part, for example {status: booked} so a cancelled booking frees its slot; each value must satisfy its property's schema. Without it every record takes part. |
| `extensions.store.config.collections.*.transfers` | object | no | maxProperties: 8; keys: "^[a-z][a-z0-9_-]{0,63}$" | Declared transfers by name: POST `<mount>/transfers/<name>` with the JSON body {from, to, amount} (two distinct record ids and a positive whole number) subtracts amount from the from record's amount property and adds it to the to record's in one transaction, so the sum over the collection never changes; a debit that would leave from below min answers 409 insufficient_balance and nothing is written. On an owned collection the caller may debit only its own record and may credit any owned record (a transfer between owners); on a shared collection anyone who reaches the mount may move between any two records, so gate it with members or the route. Honours If-Match (on from) and Idempotency-Key; audited as store.record.transferred on both records. Not on a membership collection. |
| `extensions.store.config.collections.*.transfers.*.amount` | string | yes | pattern: "^[a-z][A-Za-z0-9_]{0,63}$" | A required integer property with an integer default (a currency in minor units): the balance moved. Not an increment and not named by intervals. List it under readOnlyProperties so only transfers change it. |
| `extensions.store.config.collections.*.transfers.*.min` | integer | no | minimum: -9007199254740991; maximum: 9007199254740991 | The lowest value the debited record may be left holding (default 0: no overdraft). A negative min on a members-gated transfer is an issuer: its records may go below zero, which is the supply outstanding, and the sum still never changes. |
| `extensions.store.config.collections.*.transfers.*.members` | string | no | pattern: "^[a-z][a-z0-9_-]{0,63}$" | A membership collection (membership: true): only principals it lists may run the transfer; anyone else gets 403 membership_required before any record is read. |
| `extensions.store.config.shortLinks` | object | no | maxProperties: 32; keys: "^[a-z][a-z0-9_-]{0,63}$" | Public redirect mounts by name: GET `<mount>/<key>` atomically increments a counter and answers 302 to the record's stored destination; HEAD answers the same 302 without counting; an unknown key is 404. Each needs a route `<mount>/*` with extension: store (GET, HEAD). |
| `extensions.store.config.shortLinks.*.mount` | string | yes | maxLength: 256; pattern: "^/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$" | URL path of the redirect mount, separate from the collection's CRUD mount. |
| `extensions.store.config.shortLinks.*.collection` | string | yes | pattern: "^[a-z][a-z0-9_-]{0,63}$" | A declared shared collection with a key; the key value is the path segment after the mount. |
| `extensions.store.config.shortLinks.*.destination` | string | yes | pattern: "^[a-z][A-Za-z0-9_]{0,63}$" | A required string property with format: uri holding the redirect target; activation refuses it otherwise, and every write to it takes only an absolute HTTP(S) URL without credentials or whitespace (422 otherwise). |
| `extensions.store.config.shortLinks.*.clicks` | string | yes | pattern: "^[a-z][A-Za-z0-9_]{0,63}$" | A property listed in the collection's increments, raised by one on each GET (even when the collection is readOnly). |

### Authoring surfaces and limits

Declare collections under extensions.store.config.collections and mount each on a route with `extension: store`. Bounded unique keys, numeric increments, idempotency retention, per-owner records, declared transitions, transfers between balances, membership lists, readers and short-link redirects remain store-owned; no handler code is needed.

- **collections** (configuration, `urlcode.yaml`): Per-collection mount, a record `schema` (a JSON Schema 2020-12 object schema in the request body profile: flat scalar properties, `additionalProperties: false`; inline, or the name of a project schema under top-level `schemas:` shared with route bodies and MCP tools; a record that breaks it answers `422 invalid_record` with the body-schema issue list), `defaults` (values a create stores for omitted properties) and `readOnlyProperties` (changed only by a transition), bounded unique `key`, numeric `increments`, durable bounded `idempotency`, maxRecords, maxRecordBytes, pageSize, readOnly, `sortable` / `filterable` property lists, and `audit: true` (every write recorded in the audit log with property names and the principal, never values; needs the audit extension, and writes answer `503 audit_backlog` while 1000 events wait to drain). Create, list, read, replace, update and delete need no handler.
- **ownership** (configuration, `urlcode.yaml`): `ownership: owner` on a collection: each signed-in principal creates, lists, reads, changes and deletes only its own records: every read and write is scoped to the principal that created the record. Not combined with a unique `key`. The mount must be guarded by a principal-providing policy such as `auth: true`. An optional `maxRecordsPerOwner` (at most maxRecords) answers `409 owner_quota_exceeded` at the limit.
- **transitions** (configuration, `urlcode.yaml`): Declared `transitions` move one record from exact `from` values to constant `set` values (with `stamp: {property: actor\|now}`) in one transaction as `POST <mount>/<id>/<name>`; a record not in the `from` state answers `409 transition_conflict`. On an owned collection `by: others` serves the transition on its own `mount` to any principal except the owner (an approval or review step), and `members: <membership collection>` admits only that list's members. Not an expression language.
- **intervals** (configuration, `urlcode.yaml`): `intervals: {start, end, within?, scope?, when?}` on a collection: no two records it applies to (those holding the `when` values, such as `{status: booked}`) in one scope with equal `within` values (a room) may hold overlapping half-open `[start, end)` intervals; any create, PUT, PATCH or transition that would answers `409 interval_conflict` and writes nothing. Checked through an index in the write transaction, across owners on an owned collection without naming another owner's record. Bounds are both numbers or both `format: date-time` strings in UTC (`Z`).
- **transfers** (configuration, `urlcode.yaml`): `transfers.<name>: {amount, min?, members?}` on a collection: `POST <mount>/transfers/<name>` with `{from, to, amount}` moves a positive whole amount from one record's integer `amount` property to another's in one transaction, so the sum never changes; a debit below `min` (default 0) answers `409 insufficient_balance` and writes nothing. On an owned collection the caller debits only its own record and may credit anyone's. Integers only (a currency in minor units); `If-Match` on `from`, `Idempotency-Key` and audit apply.
- **membership** (configuration, `urlcode.yaml`): Permissions as data keyed by the principal id, never roles in auth: a `membership: true` collection with a `key` lists principal ids and has no mount (the operator maintains it with `urlcode-store members` or `addMember`/`removeMember`). A transition's `members` and a collection's `readers.members` name it.
- **readers** (configuration, `urlcode.yaml`): An owned collection's `readers: {mount, members, showOwner?}` lets the members of a membership collection list (with the collection's limit, cursor, sort and filters) and read every owner's records read-only on a separate mount; owners keep their own view on the collection mount.
- **shortLinks** (configuration, `urlcode.yaml`): Optional public GET redirect mounts that look up a collection key, use a declared `format: uri` destination property that takes only HTTP(S) URLs, and atomically increment a declared counter.
- **mount** (extension, `urlcode.yaml`): Collection routes `/api/<name>/*` use GET, HEAD, POST, PUT, PATCH, DELETE; short-link routes use GET, HEAD. Readers routes use GET, HEAD and a `by: others` transition route uses POST. Add `auth: true` to any private mount; an `ownership: owner` collection requires it (or another principal-providing policy).

Fast checks: `urlcode validate --project . --host-file <host.mjs> --origin <origin>`, `urlcode test --project . --host-file <host.mjs> --origin <origin>`.
<!-- extension-reference:end -->
