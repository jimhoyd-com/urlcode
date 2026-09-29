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
      done: {type: boolean, default: false}
```

The store acts on two standard annotations: `default` is stored on create when
the body omits the property, and `readOnly: true` means only a declared
transition changes it. A record that breaks the schema answers
`422 invalid_record` with the `issues` list a body-schema route answers. The
store-owned facts (`key`, `increments`, `ownership`, `transitions`, `readers`,
`membership`, `sortable`, `filterable`) sit beside the schema and name its
properties. With the host file loaded, `urlcode openapi` describes every store
mount from this schema (see [OpenAPI](../../docs/STORE.md#openapi)).

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
[add-ons](../../docs/EXTENSIONS.md#add-ons-extensions-and-artifacts) for the
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
| `durability` | `STORE_DURABILITY`, else `'full'` | `'full'` (SQLite `synchronous=FULL`: a committed write survives power loss) or `'normal'` (`synchronous=NORMAL`: faster commits; the last ones before a power loss or OS crash can be lost, and the activation logs a warning). Anything else refuses to start. The `urlcode-store` operator commands always commit with `full`. See [durability](../../docs/STORE.md#durability). |

The example is API only: a frontend calls the JSON mount with `fetch`, as
[the reference proof's client](../../proofs/private-requests/client) does.

When `auth` is installed the example puts `auth: true` on the API mount (a
signed-in session, and same-origin provenance for writes) and declares the
`todos` collection `ownership: owner`, so each signed-in user sees and changes
only their own todos. When `audit` is installed the example collection also
declares `audit: true`. Without `auth` the example refuses; the refusal prints the exact command, ending in
`--ack store:public-write`, which acknowledges a public writable endpoint (not
rate limiting, abuse protection or multi-tenant isolation).

The full guide, HTTP contract, limits and the honest list of concurrency
guarantees is [docs/STORE.md](https://github.com/jimhoyd-com/urlcode/blob/main/docs/STORE.md).
Short version: one server process per database (supported and tested, not
enforced: SQLite's locks keep another process from corrupting it, and a write
blocked past the 2-second busy timeout answers `503`); every write is one SQLite
transaction that commits the record, its key, its `Idempotency-Key` claim and
its audit event together or not at all; a retried `Idempotency-Key` replays the
first status with the current record (a different request under it is `422`);
per-collection record and byte quotas; last write wins unless a caller sends
`If-Match`; each HTTP request changes one record. A `urlcode dev` hot reload shares the database connection with the
replacement runtime (see [reload](../../docs/STORE.md#reload)). A collection is shared by default; one that holds
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
[per-record ownership](../../docs/STORE.md#per-record-ownership)). A collection may declare
`sortable` and `filterable` property lists for `?sort=<property>` /
`?sort=-<property>` and `?<property>=<value>` list queries (one sort property,
equality filters, `id` tie-break, opaque cursor; undeclared names, unparseable
values and values the property's own schema refuses are `400`s); they apply to
the whole collection, or on an owned collection to the caller's own records. A
`PATCH` that sets a property to `null` removes it; the result must still satisfy
the schema, so a required property refuses that with a `422` issue, and `PUT`
still takes only values (see [clearing a property](../../docs/STORE.md#clearing-a-property)).

A collection that declares `audit: true` records every write in the audit
log (the store `uses` the `audit` extension; activation refuses such a
collection when audit is not installed, or when no principal-providing policy
guards its mount). Each create, replace, update, delete and increment (never a
short-link click) is an event (`store.record.created`, `.replaced`, `.updated`,
`.deleted`, `.incremented`) with subject `<collection>/<id>`, the principal id
or `anonymous` as actor, and the changed property names, never values. The event
is inserted into the store database's outbox table in the same transaction as
the record and drained by audit while the host runs; when 1000 events wait
undelivered the next write answers `503 audit_backlog` and changes nothing. See [audited writes](../../docs/STORE.md#audited-writes).

Back the database up while the server serves with
`urlcode-store backup --database <absolute store.sqlite> --destination <absolute new file>`:
an online copy through SQLite's backup API (Node 22.16 or newer) that refuses an
existing destination, is written `0600` and is checked as a store database of the
same schema version before it appears. To restore, stop the server and put the
copy in place. See [backups](../../docs/STORE.md#storage-and-concurrency-what-it-does-and-does-not-guarantee).

Another extension that requires the store reaches declared collections through
its typed export, `StoreExports` (`ctx.get('store')`): `create`, `get`, a
partial `update` (which clears a property given `null`, like `PATCH`) and a
paginated `list`, each scoped to the request principal exactly as the JSON API
is, a declared `transition`, and `transaction(work)`, which runs several of those
operations synchronously as one database transaction (trusted host code only,
never sandboxed). See [using a collection from another extension](../../docs/STORE.md#using-a-collection-from-another-extension).

## Transitions

A collection may declare named `transitions` (#835): `POST <mount>/<id>/<name>`
moves one record from the exact `from` values to the constant `set` values
(and the `stamp` values `actor` or `now`) in one transaction, honouring
`If-Match` and `Idempotency-Key`, or answers `409 transition_conflict` and
writes nothing. On an owned collection `by: others` lets any principal except
the owner run it, on a separate mount whose route policy decides who may; a
`readOnly` property can only change through a transition.
Transitions are not an expression language: interval constraints and
multi-record transfers use a host transaction. See
[conditional transitions and result-aware retries](../../docs/STORE.md#conditional-transitions-and-result-aware-retries).
A list carries each listed record's `ETag` in `etags` and the transitions the
caller may run on it now in `may`, both keyed by id (one record's answer has
them as the `ETag` and `Allow-Transitions` headers), so a client sends
`If-Match` for the version it listed and offers only what the store would
accept. `may` reads only the caller's own membership, once per gate; see
[what the caller may run](../../docs/STORE.md#what-the-caller-may-run).

## Membership gates

Permissions are application data keyed by the principal id, not roles in auth
(#863). A collection declared `membership: true` with a `key` holds one record
per member, keyed by principal id. It has no mount and no HTTP API: the
operator maintains it with `urlcode-store members add|remove|list --database
<absolute store.sqlite> --project <absolute app> --collection <name>
[--principal <id>]` (or `addMember`, `removeMember` and `listMembers` from this
package), and trusted extension code through `StoreExports`. With
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
[membership gates and cross-owner reads](../../docs/STORE.md#membership-gates-and-cross-owner-reads).

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
              clicks: {type: integer, default: 0, minimum: 0}
      shortLinks:
        public: {mount: /go, collection: links, destination: destination, clicks: clicks}
routes:
  /api/links/*: {extension: store, methods: [GET, HEAD, POST, PUT, PATCH, DELETE], auth: true}
  /go/*: {extension: store, methods: [GET, HEAD]}
```

Protect the CRUD mount according to who may create links (`auth: true` above
needs the auth extension). [Bounded keyed transitions](../../docs/STORE.md#bounded-keyed-transitions)
has the full rules for `key`, `increments` and `idempotency`; the
[field reference](#field-reference) below lists every `shortLinks` key.

## Store schema artifact

The `store-schema` artifact (`urlcode artifacts add store-schema`) carries this
extension's configuration schema and an example configuration as inert JSON
for authoring tools; it does not register `store` or grant access to a data
directory. See [artifacts](../../docs/EXTENSIONS.md#artifacts).

Requires the matching `@jimhoyd/urlcode` core as a peer. Apache-2.0.

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
| `extensions.store.config.collections.*.schema` | object | yes | unknown keys rejected | The record schema: a JSON Schema 2020-12 object schema in the same bounded profile as `request.body.<METHOD>.schema`, validated by the same validator, with a flat set of scalar properties. A body that breaks it answers 422 invalid_record with the same issue list a body-schema route answers. id, createdAt and updatedAt are reserved and store-owned. |
| `extensions.store.config.collections.*.schema.$schema` | constant | no | const: "https://json-schema.org/draft/2020-12/schema" | Optional; only the JSON Schema 2020-12 dialect. |
| `extensions.store.config.collections.*.schema.$comment` | string | no | maxLength: 4096 | A note for readers; not validated. |
| `extensions.store.config.collections.*.schema.title` | string | no | maxLength: 4096 | A short name for the record type. |
| `extensions.store.config.collections.*.schema.description` | string | no | maxLength: 4096 | What a record of this collection is. |
| `extensions.store.config.collections.*.schema.type` | constant | yes | const: "object" | Always object: a record is a JSON object. |
| `extensions.store.config.collections.*.schema.additionalProperties` | constant | yes | const: false | Always false, written out: a body naming a property the schema does not declare is refused. |
| `extensions.store.config.collections.*.schema.required` | array | no | maxItems: 64; uniqueItems: true; items: string (pattern: "^[a-z][A-Za-z0-9_]{0,63}$") | Properties every record must carry: a create or PUT without one (and without a default) answers 422, and PATCH cannot clear one. |
| `extensions.store.config.collections.*.schema.properties` | object | yes | minProperties: 1; maxProperties: 64; keys: "^[a-z][A-Za-z0-9_]{0,63}$" | The record properties by name, each a scalar schema. A string property needs maxLength (or an enum) to be sortable or filterable. |
| `extensions.store.config.collections.*.schema.properties.*.type` | string | yes | enum: ["string","integer","number","boolean"] | The one scalar type the property holds; records hold scalars only. |
| `extensions.store.config.collections.*.schema.properties.*.default` | string / number / boolean | no | one of: string (maxLength: 65536); number; boolean | Stored on create when the body omits the property; it must satisfy the property's own schema. |
| `extensions.store.config.collections.*.schema.properties.*.readOnly` | boolean | no | — | true: only a declared transition (its set or stamp) changes the property. A create stores its default (or leaves it unset), PUT keeps its value, and a POST, PUT or PATCH body naming it answers 422. A required readOnly property needs a default. Not the key or an increment. |
| `extensions.store.config.collections.*.maxRecords` | integer | no | minimum: 1; maximum: 10000 | Records the collection may hold (default 1000); a create beyond it answers 409 collection_full. |
| `extensions.store.config.collections.*.maxRecordBytes` | integer | no | minimum: 256; maximum: 65536 | Largest serialized record in bytes (default 4096); larger answers 413. |
| `extensions.store.config.collections.*.pageSize` | integer | no | minimum: 1; maximum: 200 | Records per list page, and the cap on a list request's limit (default 50). |
| `extensions.store.config.collections.*.readOnly` | boolean | no | — | true: the API serves only GET and HEAD (other methods answer 405); short-link click counting still works. |
| `extensions.store.config.collections.*.key` | string | no | pattern: "^[a-z][A-Za-z0-9_]{0,63}$" | A required string property (maxLength at most 128, no default) whose caller-chosen value the collection keeps unique; a duplicate create answers 409 key_exists. Not allowed with ownership: owner. |
| `extensions.store.config.collections.*.increments` | array | no | maxItems: 8; uniqueItems: true; items: string (pattern: "^[a-z][A-Za-z0-9_]{0,63}$") | Numeric properties with a numeric default that POST `<mount>/<id>/increment/<property>` raises by exactly one in one database transaction, within the property's schema (409 increment_limit otherwise). |
| `extensions.store.config.collections.*.idempotency` | object | no | unknown keys rejected | Enables the Idempotency-Key header on POST, PUT, PATCH, DELETE, increment and transitions. A retry with a retained key and the same request (method, path, body) replays the first answer's status with the record as it is now; the same key on a different request answers 422 idempotency_key_reused. Without it the header answers 400 idempotency_not_enabled. A key is scoped to the request principal, or to the network client when there is none. |
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
| `extensions.store.config.collections.*.membership` | boolean | no | — | true: a membership list. Its key property holds principal ids (one record per member); transitions and readers name it in members. It has no mount and no HTTP API: the operator maintains it with urlcode-store members or trusted extension code (StoreExports); a member's key cannot be changed, only removed and added. Needs key; takes no mount, ownership, transitions, readers, increments, idempotency, sortable, filterable or readOnly. With audit: true every added and removed member is recorded. |
| `extensions.store.config.collections.*.readers` | object | no | unknown keys rejected | With ownership: owner only: members of a membership collection list and read every owner's records, read-only, as GET `<mount>` (with the collection's limit, cursor, sort and filters) and GET `<mount>/<id>`. Owners keep their own view on the collection mount. The stored owner is shown only with showOwner. |
| `extensions.store.config.collections.*.readers.mount` | string | yes | maxLength: 256; pattern: "^/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$" | A separate mount: a route `<mount>/*` with extension: store (GET, HEAD) and a principal-providing policy. |
| `extensions.store.config.collections.*.readers.members` | string | yes | pattern: "^[a-z][a-z0-9_-]{0,63}$" | A membership collection: anyone it does not list gets 403 membership_required before any record is read. |
| `extensions.store.config.collections.*.readers.showOwner` | boolean | no | — | true: every record this mount answers carries _owner, the opaque principal id of the owner (for auth, the user id; never an email or name), so a member can tell requesters apart. Only this mount shows it: the owner's mount, transitions and StoreExports never do. |
| `extensions.store.config.shortLinks` | object | no | maxProperties: 32; keys: "^[a-z][a-z0-9_-]{0,63}$" | Public redirect mounts by name: GET `<mount>/<key>` atomically increments a counter and answers 302 to the record's stored destination; HEAD answers the same 302 without counting; an unknown key is 404. Each needs a route `<mount>/*` with extension: store (GET, HEAD). |
| `extensions.store.config.shortLinks.*.mount` | string | yes | maxLength: 256; pattern: "^/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$" | URL path of the redirect mount, separate from the collection's CRUD mount. |
| `extensions.store.config.shortLinks.*.collection` | string | yes | pattern: "^[a-z][a-z0-9_-]{0,63}$" | A declared shared collection with a key; the key value is the path segment after the mount. |
| `extensions.store.config.shortLinks.*.destination` | string | yes | pattern: "^[a-z][A-Za-z0-9_]{0,63}$" | A required string property with format: uri holding the redirect target; activation refuses it otherwise, and every write to it takes only an absolute HTTP(S) URL without credentials or whitespace (422 otherwise). |
| `extensions.store.config.shortLinks.*.clicks` | string | yes | pattern: "^[a-z][A-Za-z0-9_]{0,63}$" | A property listed in the collection's increments, raised by one on each GET (even when the collection is readOnly). |

### Authoring surfaces and limits

Declare collections under extensions.store.config.collections and mount each on a route with `extension: store`. Bounded unique keys, numeric increments, idempotency retention and short-link redirects remain store-owned; no handler code is needed.

- **collections** (configuration, `urlcode.yaml`): Per-collection mount, a record `schema` (a JSON Schema 2020-12 object schema in the request body profile: flat scalar properties, `additionalProperties: false`, the store acting on `default` and on `readOnly` as transition-only; a record that breaks it answers `422 invalid_record` with the body-schema issue list), bounded unique `key`, numeric `increments`, durable bounded `idempotency`, maxRecords, maxRecordBytes, pageSize, readOnly, `sortable` / `filterable` property lists, and `ownership: owner` (per-record ownership: each signed-in principal sees and changes only its own records; the mount must be guarded by a principal-providing policy such as `auth: true`) with an optional `maxRecordsPerOwner` (at most maxRecords; a principal at it gets `409 owner_quota_exceeded`), `audit: true` (every write recorded in the audit log with property names and the principal, never values; needs the audit extension, and writes answer `503 audit_backlog` while 1000 events wait to drain), and declared `transitions`.
- **membership** (configuration, `urlcode.yaml`): Permissions as data keyed by the principal id, never roles in auth: a `membership: true` collection with a `key` lists principal ids and has no mount (the operator maintains it with `addMember`/`removeMember`); a transition's `members: <collection>` admits only its members, and an owned collection's `readers: {mount, members}` lets members list and read every owner's records read-only on a separate mount.
- **shortLinks** (configuration, `urlcode.yaml`): Optional public GET redirect mounts that look up a collection key, use a declared `format: uri` destination property that takes only HTTP(S) URLs, and atomically increment a declared counter.
- **mount** (extension, `urlcode.yaml`): Collection routes `/api/<name>/*` use GET, HEAD, POST, PUT, PATCH, DELETE; short-link routes use GET, HEAD. Readers routes use GET, HEAD and a `by: others` transition route uses POST. Add `auth: true` to any private mount; an `ownership: owner` collection requires it (or another principal-providing policy).

Fast checks: `urlcode validate --project . --host-file <host.mjs> --origin <origin>`, `urlcode test --project . --host-file <host.mjs> --origin <origin>`.
<!-- extension-reference:end -->
