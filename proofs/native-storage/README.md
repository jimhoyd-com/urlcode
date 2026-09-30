# Native storage: the owner's database, URLCode's boundary

This is the owner-choice storage check for
[#1052](https://github.com/jimhoyd-com/urlcode/issues/1052): a small notes
application that keeps its data with a database library the owner chose,
called directly from trusted function routes. The library here is Node's
built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html), used through its
own API: `DatabaseSync`, prepared statements and an explicit transaction, in
[`app/functions/notes.mjs`](app/functions/notes.mjs). Nothing sits between
the route and the database: no URLCode store, adapter, descriptor or catalog
entry. The bundled store extension is not installed. It is a
proof, not a supported storage integration or a release claim.

## Who does what

| URLCode supplies | The owner chooses |
|---|---|
| Routing, methods (`405`), path parameters (`format: uuid`, `400`) and the declared request body schema (`422`), all before the function runs | The database library, its file, table and queries |
| `auth: true`: the route answers `401` without a verified session and the function receives `context.capabilities.authjs.identity.userId` | The sign-in provider: Auth.js through the independent [`../authjs-provider`](../authjs-provider/extension.js) package, as in the [Auth.js proof](../private-requests-authjs/README.md) |
| Cross-origin refusal on unsafe methods (`403`) and the throttle on the sign-in mount | Ownership rules: each query filters by the signed-in user id |
| The data directory grant: `URLCODE_DATA_DIR`, a revision-pinned operator grant for serving and a fresh temporary directory for every `urlcode test` and `urlcode audit` run | Where the operator points it, outside the project |
| Review: `urlcode explain` shows the `auth: true` gate and labels the function as trusted code whose execution is not evaluated; `urlcode review` lists `functions/notes.mjs` by hash among the trusted files and has nothing to suggest | Transactions, schema changes, backups and retries |
| Tests: `urlcode test` and `urlcode audit` replay [`app/tests/requests.json`](app/tests/requests.json), signed-in steps and a restart included | |

Replacing `node:sqlite` with another library (an ORM, a PostgreSQL client, a
hosted service) changes `notes.mjs`, its dependencies and the operator's
connection settings. `urlcode.yaml` stays as it is. The trade is honest in
both directions: none of the store's declared guarantees apply here
(ownership, transitions, membership gates, `Idempotency-Key` replay, the
single-process lock, backup commands). This application enforces what its own
code enforces, and review says so rather than inspecting it.

## Store vocabulary is not emulated

`extensions.store` and a route with `extension: store` belong to the store
extension. Without it installed and composed by `host.mjs`, `urlcode
validate`, `urlcode test` and `urlcode serve` refuse the project before any
request, naming both the declaration and the mount (`Not registered by the
host file: store`). Nothing falls back to the application's own database.
The integration test asserts this.

## The data stays outside the project

- **Serving.** The operator sets `URLCODE_DATA_DIR` to an absolute directory
  and grants it in the reviewed policy (`urlcode permissions` proposes the
  grant for both notes routes). `notes.sqlite` is created there. Without the
  variable, `validate` and `serve` refuse before serving (`Missing required
  environment binding`), and the function refuses a relative path.
- **Tests and audit.** Each run creates an empty temporary directory, offers it
  as `URLCODE_DATA_DIR` and removes it when the run ends. The first signed-in
  fixture step expects zero notes, so a second run passes only because it
  starts empty. A `restart` step shows the file surviving a runtime restart.
- **Operator files.** The Auth.js secret and the synthetic account list are in
  `data/`, or in `NATIVE_STORAGE_DATA` when that is set, which keeps fixture
  runs apart from the files the site serves with. The integration test checks
  that the hermetic runs wrote no database into the site or that directory.

## Run it

It needs a packed build of this checkout. From the repository root:

```sh
npm ci && npm run build
npm pack --pack-destination /tmp/urlcode-pack
(cd proofs/authjs-provider && npm pack --pack-destination /tmp/urlcode-pack)
cp -R proofs/native-storage /tmp/native-storage && cd /tmp/native-storage
npm install /tmp/urlcode-pack/jimhoyd-urlcode-0*.tgz /tmp/urlcode-pack/example-urlcode-authjs-*.tgz
npm run setup     # data/: authjs.secret and users.json (two synthetic accounts)
npm run -s proposal > operator/policy.json   # review, then approve the revision yourself
mkdir -p data/notes && export URLCODE_DATA_DIR="$PWD/data/notes"
npm run validate && npm test && npm test && npm run audit   # audit is ready with 3 routes
npm start         # http://localhost:4200
```

The accounts are `ann@example.test` and `bob@example.test`, with passwords
`<name>-local-demo-password`. The Auth.js gaps recorded in the
[Auth.js proof](../private-requests-authjs/README.md#gaps-what-authjs-does-not-do-here)
apply here unchanged: JWT sessions without server-side revocation, and
accounts that are the operator's own file.

The repository's end-to-end check does all of this in a temporary directory
and exercises the served application over HTTP, concurrent writes included:
`npm run build && npm run test:proof:native`. Installation needs the npm
registry for `@auth/core`; nothing after it does, and `node:sqlite` adds no
dependency.
