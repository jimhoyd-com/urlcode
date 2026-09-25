# Store CRUD

`/api/todos/*` is a persistent JSON CRUD API. The project declares one
collection and its mount; the operator-installed `store` extension serves it
and keeps the data in the operator's directory. There is no handler code. Full
contract, limits and guarantees: [docs/STORE.md](../../docs/STORE.md).

## Operator prerequisites

The store is not core and does not activate on its own.

- In a site, `urlcode extensions add store` installs the extension core pins
  and registers it in `host.mjs`, kept outside the project.
  `urlcode init DIR --with ui,auth,store --example` scaffolds a protected site
  with this collection in one step, declared `ownership: owner` so each
  signed-in user has their own todos; without `auth`, the store example needs
  `--ack store:public-write`. Without `--example` the store installs with no
  collection.
- The data directory must be outside the project. It is single-writer: one
  server process per directory.

A host for this recipe, in a site where `@jimhoyd/urlcode-store` is installed:

```js
// /operator/host.mjs -- trusted operator code, never part of the project
import { composeHost } from '@jimhoyd/urlcode/host';
import store from '@jimhoyd/urlcode-store/extension';

export default await composeHost(import.meta.url, [
  store({ directory: '/operator/data/store' }),
]);
```

`composeHost` pins the host to the reviewed revision: the `projectSha256` of
the operator policy you pass with `--policy`, or `PROJECT_SHA256`. Set it to
the `revision` that `urlcode manifest --project .` prints for this project.

```sh
urlcode validate --local --project . --host-file /operator/host.mjs --origin https://api.example.com
urlcode test --project . --host-file /operator/host.mjs --origin https://api.example.com
urlcode audit --project . --expect-routes 1 --host-file /operator/host.mjs --origin https://api.example.com
```

The bundled fixtures run one ordered create, read, update, delete lifecycle
that captures the new record's id and deletes it again, so they need an empty
collection and leave it empty. Point them at a scratch data directory, not one
holding real records. Try the write path by hand after serving:

```sh
curl -X POST -H 'Content-Type: application/json' -d '{"title":"first"}' https://api.example.com/api/todos
```

## Before exposing it

The mount is public unless you protect it: add `auth: true` (with the auth
extension) or another policy before any writable collection is reachable. Every
caller sees the whole collection, which is shared by default; for per-user data
declare `ownership: owner` on the collection and keep `auth: true` on its mount
([per-record ownership](../../docs/STORE.md#per-record-ownership)). Changing
`urlcode.yaml` changes the revision and needs a new pin. Cloudflare and static
targets refuse extensions, and the store writes local files, so run it on the
self-hosted runtime with a persistent disk.
