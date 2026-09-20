# Data store extension and CRUD recipe

`@jimhoyd/urlcode-store` is an operator-installed extension (see
[extensions](EXTENSIONS.md)) that serves declared collections as a bounded JSON
CRUD API. It is not core: the project declares collections and mounts, the
operator installs the package and chooses where the data lives, and application
data stays in the operator's systems. A Todo app needs no handler code.

Why it is an extension: core has no persistence handler, and the earlier stored
short-link extension was retired because that product did not belong, not
because operator-installed data extensions fail. The project first ran locked
down in a sandbox and later moved to trust by default
([direction](PROJECT-DIRECTION.md)); that change lets core stay small while
data-owning features ship as extensions the operator reviews and pins.

## Recipe: a Todo API in three steps

```sh
npm install @jimhoyd/urlcode @jimhoyd/urlcode-store   # in a scratch directory
npx urlcode init todo-site --with store
cd todo-site && npm install
```

`init --with store` writes the starter under `app/`, one `host.mjs`, a README
and a `package.json` pinning the versions it resolved. `app/urlcode.yaml`
declares the collection and its mount:

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
routes:
  /api/todos/*:
    extension: store
    methods: [GET, HEAD, POST, PUT, PATCH, DELETE]
```

Review the project, pin its revision, and serve:

```sh
npx urlcode extensions --project app --host-file "$PWD/host.mjs"    # inspect schemas
PROJECT_SHA256=$(node -e "import('@jimhoyd/urlcode/extensions').then(async m=>console.log(await m.inspectExtensionRevision('app')))") \
  npx urlcode serve --project app --host-file "$PWD/host.mjs" --origin https://todo.example.com
curl -X POST -H 'Content-Type: application/json' -d '{"title":"first"}' https://todo.example.com/api/todos
```

With `--with ui,auth,store` (auth before store) the scaffold adds `auth: true`
to the mount and reuses auth's pinned revision, so only signed-in callers reach
the API. Without auth the mount is public: never expose a writable collection
publicly unless that is the intent.

## HTTP contract

| Request | Answer |
|---|---|
| `GET /api/todos?limit=&cursor=` | `200 {items, total, next?}` in creation order; `limit` is capped at the collection `pageSize`, `cursor` is the offset from `next` |
| `POST /api/todos` | `201` and the record, `Location: /api/todos/<id>` |
| `GET /api/todos/<id>` | `200` record, or `404` |
| `PUT /api/todos/<id>` | replaces every declared field (omitted fields take their default), `200` |
| `PATCH /api/todos/<id>` | updates the supplied fields, `200` |
| `DELETE /api/todos/<id>` | `204` |

Every record carries a server-assigned UUID `id`, `createdAt` and `updatedAt`
(ISO 8601). Clients cannot set them. Writes need `Content-Type:
application/json` (`415` otherwise); a cross-origin `Origin` header on a write
is refused (`403`). Errors are `{error: {code, message, fields?}}` where
`fields` maps field names to fixed messages; submitted values are never echoed.
Status codes: `400` invalid record or JSON, `404`, `405` with `Allow`, `409`
`collection_full`, `413` body or record too large, `415`, `503` when the disk
write failed, `500` for anything unexpected (no cause in the body).

## Field schema

Fields are typed `string`, `integer`, `number` or `boolean`, each optionally
`required`, with a `default` (not both), and per type: `minLength`/`maxLength`
(strings, hard cap 65,536), `minimum`/`maximum` (numbers), `enum`. The store owns
this schema and does not depend on request-body validation in core ([#254]).
Unknown fields are rejected. `id`, `createdAt` and `updatedAt` are reserved.

Limits per collection: up to 64 fields, `maxRecords` up to 10,000 (default
1,000), `maxRecordBytes` up to 65,536 (default 4,096), `pageSize` up to 200
(default 50), at most 32 collections per project, `readOnly: true` to refuse
writes. The request body is refused above `maxRecordBytes` plus 4 KiB.

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
  process.
- The directory is single-writer. Activation takes an exclusive lock file
  (`.store.lock`, holding the pid) and refuses a second server over the same
  directory; a lock left by a dead process is reclaimed. This is a guard against
  mistakes, not a distributed lock: it does not work across machines or on
  network filesystems, and the same host needs one process (no `workers`
  multi-process clustering over the same directory).
- Every write rewrites the whole collection file, so cost grows with the
  collection size; the record and byte caps bound it. There is no transaction
  across records or collections, no index and no query language beyond
  paginated listing, no optimistic concurrency (`PUT`/`PATCH` are last write
  wins), and no history. Startup loads and revalidates every record; a file that
  no longer matches the declared fields refuses activation rather than serving
  bad data.
- Backups are the operator's: copy the directory while the server is stopped, or
  accept that a copy taken mid-write is the last complete file.

Errors never contain record values, file contents or filesystem paths.

## Trust and operation

The store is trusted operator code. It is not sandboxed and is not a
multi-tenant boundary: every caller who can reach a mount sees the whole
collection, so restrict the mount with `auth` (or another policy) and keep
per-user data out of a shared collection. There is no per-user ownership model
yet. Changing collections or mounts changes the project revision and needs a new
operator pin. The mount responses are `no-store`.

## Catalog recipe

`urlcode recipes search "crud store persist"` finds `store-crud`
([recipes](RECIPES.md)), the same collection as above with ordered fixtures for
the whole create, read, update, delete lifecycle. It does not install anything:
the operator must install `@jimhoyd/urlcode-store` and write a host file. Until
release wiring lands ([#323]), `init --with store` is not yet available from npm,
and the recipe README says so.

## Not built yet

Recorded in [open decisions](OPEN-DECISIONS.md): release-train wiring for the new
package ([#323]), filtering and sorting, per-record ownership, a SQLite backend,
and ui data-bound screens ([#262]).

[#254]: https://github.com/jimhoyd-com/urlcode/issues/254
[#323]: https://github.com/jimhoyd-com/urlcode/issues/323
[#262]: https://github.com/jimhoyd-com/urlcode/issues/262
