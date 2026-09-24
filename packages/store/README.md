# @jimhoyd/urlcode-store

Operator-installed data store extension for URLCode. Declare typed collections in
`urlcode.yaml`, mount each with `extension: store`, and the extension serves a
bounded JSON CRUD API backed by atomically written files in an operator-owned
directory. No handler code.

## Install

```sh
npm install @jimhoyd/urlcode
npx urlcode init my-site --with ui,auth,store
# or, in an existing site:
npx urlcode extensions add store
```

`store` is released as a tarball on core's GitHub Release, at core's version,
and pinned by sha512 in core's `dist/addons.json`; `urlcode extensions add`
installs it into the site and checks that pin. See
[add-ons](../../docs/EXTENSIONS.md#add-ons-extensions-and-artifacts) for the
site layout and commands.

The scaffold declares a `todos` collection in `app/urlcode.yaml`, mounts it at
`/api/todos/*` in `app/routes/store.yaml`, and adds one line to `host.mjs`:

```js
// host.mjs (trusted operator code, outside app/)
import { composeHost } from '@jimhoyd/urlcode/host';
import store from '@jimhoyd/urlcode-store/extension';

export default await composeHost(import.meta.url, [
  store(),                    // or store({ directory: '/var/lib/site/store' })
]);
```

Collection files live in `store({ directory })`, else `STORE_DIRECTORY`, else
`data/store` beside `host.mjs`; the directory must be outside `app/`.

When `auth` is installed the scaffold puts `auth: true` on the mount. Without
`auth` the scaffold refuses; the refusal prints the exact command, ending in
`--ack store:public-write`, which acknowledges a public writable endpoint (not
rate limiting, abuse protection or multi-tenant isolation).

The full guide, HTTP contract, limits and the honest list of concurrency
guarantees is [docs/STORE.md](https://github.com/jimhoyd-com/urlcode/blob/main/docs/STORE.md).
Short version: one server process per directory (enforced by a lock file),
whole-file atomic writes, per-collection record and byte quotas, last write
wins, no transactions, no per-user ownership. A collection may declare
`sortable` and `filterable` field lists for `?sort=<field>` / `?sort=-<field>`
and `?<field>=<value>` list queries (one sort field, equality filters, `id`
tie-break, opaque cursor, undeclared names are `400`s); they apply to the whole
collection.

The `store-schema` artifact (`urlcode artifacts add store-schema`) carries this
extension's configuration schema and an example configuration as inert JSON
for authoring tools; it does not register `store` or grant access to a data
directory. See [artifacts](../../docs/EXTENSIONS.md#artifacts).

Requires the matching `@jimhoyd/urlcode` core as a peer. Apache-2.0.
