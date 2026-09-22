# Store CRUD

`/api/todos/*` is a persistent JSON CRUD API. The project declares one
collection and its mount; the operator-installed `store` extension serves it
from a verified bundle and keeps the data in the operator's
directory. There is no handler code. Full contract, limits and guarantees:
[docs/STORE.md](../../docs/STORE.md).

## Operator prerequisites

The store is not core and does not activate on its own.

- The operator selects the signed `store` bundle release and registers it in a
  host file kept outside the project.
- `urlcode init --with ui,auth,store --bundle-release extension-bundles@v…`
  scaffolds a protected site from verified bundles. A no-auth `init --with
  store` needs `--ack store:public-write`.
- The data directory must be outside the project. It is single-writer: one
  server process per directory.

```js
// /operator/host.mjs -- trusted operator code, never part of the project
import {inspectExtensionRevision} from '@jimhoyd/urlcode/extensions';
import {loadExtensionBundle} from '@jimhoyd/urlcode/extension-bundles';
const {storeExtension} = await loadExtensionBundle(process.env.URLCODE_PROJECT, 'store');
const projectSha256 = await inspectExtensionRevision(process.env.URLCODE_PROJECT);
export default {extensions: [storeExtension({directory: '/operator/data/store', projectSha256})]};
```

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
caller sees the whole collection; there is no per-user ownership. Changing
`urlcode.yaml` changes the revision and needs a new pin. Cloudflare and static
targets refuse extensions, and the store writes local files, so run it on the
self-hosted runtime with a persistent disk.
