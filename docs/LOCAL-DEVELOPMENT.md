# Local development

Use Node.js 22.18+ and npm (CI targets Node 22, 24 and 26). The runtime is
written in TypeScript and runs from source with no build step: `npm run dev`
is `node packages/core/src/cli.ts`, which Node runs through its own type stripping (that is
why a contributor needs 22.18, while an installed package still runs on 22.13).
`npm run typecheck` is the type gate and part of `npm run verify`.
`npm run build` emits the JavaScript in `dist/` that the package and container
ship, together with the declarations; `dist` is never committed. Make is an optional
shortcut layer; npm and the CLI work on Windows, macOS and Linux. No global
package install, hosting account, database or Docker is needed for the local loop.

For the repository's prose-only checks, CI selection and release helper commands,
see [the development pipeline](DEVELOPMENT-PIPELINE.md).

## Try the runtime

From the runtime checkout, `make dev` installs locked dependencies if needed and
starts the function/redirect starter at http://127.0.0.1:3000. Without Make, run `npm ci`
once, then `npm run dev`. Dependency installation requires npm registry access;
the examples themselves work locally.

Try `/hello/Ada` (sandboxed function) and `/go` (redirect).
For pages/files/downloads, run `make dev PROJECT=examples/assets` instead. Edit the files in
`starters/default/` to experiment. `dev` watches configuration, source and assets;
invalid edits leave the last valid snapshot running. Ctrl+C drains and stops it.
Runtime source changes under `packages/core/src/` require restarting the dev command; project
reload is not a runtime-code watcher.

## Own an application

Run `make init DEST=../my-links`, then
`make dev PROJECT=../my-links`. The CLI equivalents from the runtime checkout:

```sh
npm run init -- ../my-links
npm run dev -- --project ../my-links
npm run validate -- --project ../my-links
npm run test:project -- --project ../my-links
```

There is one starter, containing both examples. Initialization never overwrites
an existing directory. Once created, edits belong to your app repository; upgrading
the runtime does not regenerate them. Each starter has a Makefile for its own
`dev`, `serve`, `validate`, `test` and `doctor` commands. It uses an installed
`urlcode`, or an explicit runtime command:

```sh
cd ../my-links
make dev URLCODE='node /path/to/urlcode/packages/core/src/cli.ts'
# Without Make or a global install:
node /path/to/urlcode/packages/core/src/cli.ts dev
```

## Command reference (runtime checkout)

| Make | npm | Purpose |
|---|---|---|
| `make setup` | `npm ci` | Install exact dependencies; replaces node_modules |
| `make dev` | `npm run dev` | Watched function/redirect starter, local dotenv |
| `make validate` | `npm run validate` | Validate the app and local bindings |
| `make test-project` | `npm run test:project` | App HTTP assertions, redirects not followed |
| `make test` | `npm test` | Runtime unit, HTTP and sandbox tests |
| — | `npm run typecheck` | Strict TypeScript check of runtime, scripts and tests |
| `make verify` | `npm run verify` | Lint, type check, syntax/JSON checks and runtime tests |
| — | `npm run build` | Emit `dist/` (stripped JavaScript and declarations); never committed |
| `make test-package` | `npm run test:package` | Actual archive install and starter tests; registry access |
| — | `npm run test:examples` | Build, then run the starter and example project tests, Cloudflare build and cookbook audit CI runs |
| `make serve` | `npm run serve` | Fixed snapshot, no watcher or dotenv |
| `make doctor` | `npm run doctor` | Runtime/platform details |

Run `make help` for shortcuts. `PROJECT` defaults to `starters/default`; `HOST`
to `127.0.0.1`; `PORT` to `3000`. Quote paths containing spaces:

```sh
make dev PROJECT="../my-links demo" PORT=3001
npm run dev -- --project "../my-links demo" --port 3001
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
through the CLI, for example `npm run dev -- --project ../my-links --policy /path/to/policy.json`.
Local convenience never bypasses the function sandbox or grants permissions.

- Port busy: change `PORT=3001` or pass `--port 3001` through npm.
- Missing Make: use the npm commands; Make is not a runtime dependency.
- Invalid edits: dev keeps serving the last valid snapshot and writes a
  `reload_rejected` line to stderr carrying the same message `urlcode validate`
  prints for that state; fix the project and the watcher retries. When the
  `--policy` file is pinned to an older `projectSha256`, the message says so,
  names both revisions and points at `urlcode permissions`: any edit to routes,
  policies or function sources changes the revision, so regenerate, review and
  re-pin the grants, then restart dev (policies are read at startup). There is
  no automatic re-pin.
- A function answers `502 Function execution failed`: the response stays
  generic on purpose, and dev writes a `function_error` line to stderr with the
  matched `route`, the `source` file and `export`, the thrown `message` and its
  `stack` (a `504` deadline gets one too). A module that fails to load names its
  file, line (when Node or `node --check` can place it), export and the loader's
  message, in both `validate` and `dev`. `urlcode serve --debug-errors` turns the
  same stderr diagnostics on for a server; they never reach responses, the JSON
  event log or observers. Sandboxed (`sandbox: true`) routes are unchanged and
  still report only the generic answer.
- Changed runtime source: stop and restart dev, then `npm run typecheck`. Changed app source: reload is automatic.
- Missing dependency or wrong Node: check `node --version`, then `npm ci`.
- Need access from another device: explicitly use `HOST=0.0.0.0` or `--host 0.0.0.0`;
  this exposes the development listener to your network. Loopback remains the default.

Production deployment uses `serve` behind the HTTPS setup described in
[operations](OPERATIONS.md). These shortcuts do not provision providers or select a license.
