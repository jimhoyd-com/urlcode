# @jimhoyd/urlcode-store

Operator-installed data store extension for URLCode. Declare typed collections in
`urlcode.yaml`, mount each with `extension: store`, and the extension serves a
bounded JSON CRUD API backed by atomically written files in an operator-owned
directory. No handler code.

## Install the signed bundle

```sh
npm install @jimhoyd/urlcode
npx urlcode init my-site --with ui,auth,store \
  --bundle-release extension-bundles@vRELEASE
```

Replace `RELEASE` with a supported immutable tag from the [signed bundle
releases](https://github.com/jimhoyd-com/urlcode/releases?q=extension-bundles&expanded=true).
This verifies and locks the selected bundles before writing the host; the
generated project's npm dependencies contain core only. Do not install this
extension from npm for a new site. See [signed executable extension bundles](../../docs/EXTENSIONS.md#signed-executable-extension-bundles)
for the trust boundary, lockfile and update procedure.

The former store npm package is deprecated migration history, not an
installation or release channel.

```js
// host.mjs (trusted operator code, outside the project)
import {loadExtensionBundle} from '@jimhoyd/urlcode/extension-bundles';
const {storeExtension} = await loadExtensionBundle('/absolute/site/app', 'store');
export default {extensions: [storeExtension({directory: '/var/lib/site/store', projectSha256})]};
```

`npx urlcode init my-site --with ui,auth,store` generates the project, host and README with the mount protected by `auth`. Without `auth` the scaffold refuses; the refusal prints the exact command, ending in `--ack store:public-write`, which acknowledges a public writable endpoint (not rate limiting, abuse protection or multi-tenant isolation). The `--ack` flag belongs to the core CLI, and this package's peer range requires a core release that has it. A core older than that (installed past the peer warning, or the store release that predates the fix) rejects `--ack` as an unknown option, and the scaffold cannot tell that apart from the flag being absent, so its refusal cannot name the cause: upgrade `@jimhoyd/urlcode` rather than working around it, or add `auth` to `--with`.

The full guide, HTTP contract, limits and the honest list of concurrency
guarantees is [docs/STORE.md](https://github.com/jimhoyd-com/urlcode/blob/main/docs/STORE.md).
For offline authoring tools, core also publishes a separately versioned, signed
`store-schema` declarative artifact. It is only a configuration-schema snapshot
and example: installing it does not install this package, register `store`, or
grant access to an operator data directory. See the
[signed artifact contract](https://github.com/jimhoyd-com/urlcode/blob/main/docs/EXTENSIONS.md#signed-declarative-artifacts).
Short version: one server process per directory (enforced by a lock file),
whole-file atomic writes, per-collection record and byte quotas, last write
wins, no transactions, no per-user ownership. A collection may declare
`sortable` and `filterable` field lists for `?sort=<field>` / `?sort=-<field>`
and `?<field>=<value>` list queries (one sort field, equality filters, `id`
tie-break, opaque cursor, undeclared names are `400`s); they apply to the whole
collection.

Requires the matching `@jimhoyd/urlcode` core as a peer. Apache-2.0.
