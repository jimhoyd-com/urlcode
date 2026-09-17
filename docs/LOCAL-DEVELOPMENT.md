# Local development

Use Node.js 22.13+ and npm (CI targets Node 22, 24 and 26). Make is an optional
shortcut layer; npm and the CLI work on Windows, macOS and Linux. No global
package install, Cloud account, database or Docker is needed for the local loop.

## Try the runtime

From the runtime checkout, `make dev` installs locked dependencies if needed and
starts the function/redirect starter at http://127.0.0.1:3000. Without Make, run `npm ci`
once, then `npm run dev`. Dependency installation requires npm registry access;
the examples themselves work locally.

Try `/hello/Ada` (sandboxed function) and `/go` (redirect).
For pages/files/downloads, run `make dev PROJECT=examples/assets` instead. Edit the files in
`starters/default/` to experiment. `dev` watches configuration, source and assets;
invalid edits leave the last valid snapshot running. Ctrl+C drains and stops it.
Runtime source changes under `src/` require restarting the dev command; project
reload is not a runtime-code watcher.

## Own an application

Run `make init DEST=../gitroll-link`, then
`make dev PROJECT=../gitroll-link`. The CLI equivalents from the runtime checkout:

```sh
npm run init -- ../gitroll-link
npm run dev -- --project ../gitroll-link
npm run validate -- --project ../gitroll-link
npm run test:project -- --project ../gitroll-link
```

There is one starter, containing both examples. Initialization never overwrites
an existing directory. Once created, edits belong to your app repository; upgrading
the runtime does not regenerate them. Each starter has a Makefile for its own
`dev`, `serve`, `validate`, `test` and `doctor` commands. It uses an installed
`urlcode`, or an explicit runtime command:

```sh
cd ../gitroll-link
make dev URLCODE='node /path/to/urlcode/src/cli.js'
# Without Make or a global install:
node /path/to/urlcode/src/cli.js dev
```

## Command reference (runtime checkout)

| Make | npm | Purpose |
|---|---|---|
| `make setup` | `npm ci` | Install exact dependencies; replaces node_modules |
| `make dev` | `npm run dev` | Watched function/redirect starter, local dotenv |
| `make validate` | `npm run validate` | Validate the app and local bindings |
| `make test-project` | `npm run test:project` | App HTTP assertions, redirects not followed |
| `make test` | `npm test` | Runtime unit, HTTP and sandbox tests |
| `make verify` | `npm run verify` | Lint, syntax/JSON checks and runtime tests |
| `make test-package` | `npm run test:package` | Actual archive install and starter tests; registry access |
| `make serve` | `npm run serve` | Fixed snapshot, no watcher or dotenv |
| `make doctor` | `npm run doctor` | Runtime/platform details |

Run `make help` for shortcuts. `PROJECT` defaults to `starters/default`; `HOST`
to `127.0.0.1`; `PORT` to `3000`. Quote paths containing spaces:

```sh
make dev PROJECT="../gitroll-link demo" PORT=3001
npm run dev -- --project "../gitroll-link demo" --port 3001
```

Make automatically runs `npm ci` when its dependency marker is missing or older
than package metadata. Use `make setup` after manually changing node_modules.
Do not run setup concurrently with a running dev server or tests.

## Environment and troubleshooting

`.env.local` belongs in the selected app directory and is ignored by Git; process
environment values take precedence. No starter requires secret values. Do not
copy placeholder credentials into a working secret store. External env/secret
bindings still need an operator policy outside the app, pinned to its config/code.
Inspect and set it up using the [security guide](FUNCTION-SECURITY.md); pass it
through the CLI, for example `npm run dev -- --project ../gitroll-link --policy /path/to/policy.json`.
Local convenience never bypasses the function sandbox or grants permissions.

- Port busy: change `PORT=3001` or pass `--port 3001` through npm.
- Missing Make: use the npm commands; Make is not a runtime dependency.
- Invalid edits: run validation for diagnostics; fix the project and the watcher retries.
- Changed runtime source: stop and restart dev. Changed app source: reload is automatic.
- Missing dependency or wrong Node: check `node --version`, then `npm ci`.
- Need access from another device: explicitly use `HOST=0.0.0.0` or `--host 0.0.0.0`;
  this exposes the development listener to your network. Loopback remains the default.

Production deployment uses `serve` behind the HTTPS setup described in
[operations](OPERATIONS.md). These shortcuts do not provision providers or select a license.
