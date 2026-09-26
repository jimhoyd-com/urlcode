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
see [repository CI](CI.md#checking-this-repository).

## Try the runtime

From the runtime checkout, `make dev` installs locked dependencies if needed and
starts the starter at http://127.0.0.1:3000. Without Make, run `npm ci`
once, then `npm run dev`. Dependency installation requires npm registry access;
the examples themselves work locally.

The starter declares no routes, so there is nothing to request until you add one.
For a running sample, use `make dev PROJECT=examples/assets`: try `/hello/Ada`
(a function, trusted and in-process like every route without `sandbox: true`),
`/go` (redirect), `/about`, `/assets/…` and `/download`. Edit the files in
`starters/default/` to experiment. `dev` watches configuration, source and assets;
invalid edits leave the last valid snapshot running. Ctrl+C drains and stops it.
Runtime source changes under `packages/core/src/` require restarting the dev command; project
reload is not a runtime-code watcher.

Run at a terminal (stdout is a TTY, no `--json`), `dev` and `serve` print short
readable lines instead of the JSON event stream: a startup line naming the
listening URL and route count, then one line per request (`GET /go 302 0.9ms`),
a reload summary, and a one-line hint on an unmatched request when the project
declares no routes yet. Piping stdout, or passing `--json`, always gets the raw
JSON event stream documented in [observability](OBSERVABILITY.md); scripts and
agents should use one of those, not the TTY text. `urlcode init` similarly
prints the created path and any manifest next steps as text on a TTY, and the
same fields as a `created` JSON event otherwise.

## Own an application

Run `make init DEST=../my-links`. It writes a site, not a bare project: the
route project is `../my-links/app/` (its `urlcode.yaml`), and the trusted
operator host `../my-links/host.mjs` sits beside it, outside the project.
`PROJECT` and `--project` name the route project, so from the runtime checkout
run `make dev PROJECT=../my-links/app`. The CLI equivalents:

```sh
npm run init -- ../my-links
npm run dev -- --project ../my-links/app
npm run validate -- --project ../my-links/app
npm run test:project -- --project ../my-links/app
```

These run the route project without the operator host, which is all a site
without extensions needs. Once `urlcode extensions add` wires an extension into
`host.mjs`, also pass `--host-file ../my-links/host.mjs`; `host.mjs` imports
`@jimhoyd/urlcode/host`, so run `npm install` in the site first.

There is one starter, and it starts with no routes. Initialization never overwrites
an existing directory. Once created, edits belong to your app repository; upgrading
the runtime does not regenerate them. Each site has a Makefile and npm scripts
for its own `dev`, `serve`, `validate`, `test` and `doctor` commands; both pass
`--project app --host-file host.mjs`, so install the site before using them:

```sh
cd ../my-links
npm install
npm run dev
# The site's Makefile, run against this runtime checkout instead of the pinned install
# (host.mjs still resolves @jimhoyd/urlcode from the site's node_modules):
make dev URLCODE='node /path/to/urlcode/packages/core/src/cli.ts'
# Without an install, a site with no extensions: no --project selects app/, no host file
node /path/to/urlcode/packages/core/src/cli.ts dev
```

## Command reference (runtime checkout)

| Make | npm | Purpose |
|---|---|---|
| `make setup` | `npm ci` | Install exact dependencies; replaces node_modules |
| `make dev` | `npm run dev` | Watched starter project, local dotenv |
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

Run `make help` for shortcuts. `PROJECT` defaults to `starters/default/app`; `HOST`
to `127.0.0.1`; `PORT` to `3000`. Quote paths containing spaces:

```sh
make dev PROJECT="../my-links demo/app" PORT=3001
npm run dev -- --project "../my-links demo/app" --port 3001
```

Make automatically runs `npm ci` when its dependency marker is missing or older
than package metadata. Use `make setup` after manually changing node_modules.
Do not run setup concurrently with a running dev server or tests.

## Environment and troubleshooting

`.env.local` belongs in the selected route project directory (`app/` in a site) and is ignored by Git; process
environment values take precedence. No starter requires secret values. Do not
copy placeholder credentials into a working secret store. External env/secret
bindings still need an operator policy outside the app, pinned to its config/code.
Inspect and set it up using the [security guide](FUNCTION-SECURITY.md); pass it
through the CLI, for example `npm run dev -- --project ../my-links/app --policy /path/to/policy.json`.
Local convenience never grants permissions or changes a route's execution mode:
a trusted route stays trusted, and a `sandbox: true` route stays sandboxed.

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
- Extensions and edits: with `--host-file`, `dev` checks the extension
  revision pin strictly at startup, then lets each hot reload carry that pin
  forward to the edited project and logs one `extension_pin_followed` record
  (`extensions`, `from`, `to`; on a terminal, `Extension pin followed the edit
  for "<name>" (dev only; re-review and re-pin before serve)`). Every other
  extension check still runs on the reload. This is development only: `serve`
  and every other command refuse a stale pin, so review the edited project and
  pin its revision before serving it ([the revision pin](EXTENSIONS.md#the-revision-pin)).
  `--policy` grants are not carried forward: when the host is pinned by
  `--policy` and the project requests an env, secret or egress grant, a reload
  is still rejected as described above.
- A function answers `502 Function execution failed`: the response stays
  generic on purpose, and dev writes a `function_error` line to stderr with the
  matched `route`, the `source` file and `export`, the thrown `message` and its
  `stack` (a `504` deadline gets one too). A module that fails to load names its
  file, line (when Node or `node --check` can place it), export and the loader's
  message, in both `validate` and `dev`. `urlcode serve --debug-errors` turns the
  same stderr diagnostics on for a server; they never reach responses, the JSON
  event log or observers. Sandboxed (`sandbox: true`) routes are unchanged and
  still report only the generic answer.
- An extension fails to activate: `validate`, `test` and `dev` with
  `--host-file` print `Extension "<name>" failed to activate: <message>` (or
  `registration could not be prepared` when core rejects the registration's
  schemas or credential headers), with `code` `extension-activation` or
  `extension-registration` and an `extension` field. The message is what the
  extension threw, on one line, bounded to 500 characters and without a stack.
  `serve` prints the same line when it refuses to start, because startup output
  belongs to the operator; a request never sees it. The hosted AWS and Vercel
  adapters activate on the first request and answer it with a plain `500
  Internal server error`, logging the reason to the function log.
- An extension warns while it activates: the site still starts, and `validate`,
  `test` and `dev`/`serve` print one
  `{"event":"extension_warning","extension":"<name>","message":"..."}` line on
  stdout per warning (`dev` and `serve` on a terminal render it as
  `Extension "<name>" warning: <message>`); `test` prints it even without
  `--verbose`. The message uses the same one-line, 500-character, stackless
  form as an activation error; at most 20 are printed per extension per
  activation, then one `further warnings suppressed` line. A warning is the
  extension telling the operator to act (for example auth's passkey
  relying-party ID check); requests never see it. See
  [activation warnings](EXTENSIONS.md#activation-warnings).
- The host file fails before any extension activates: when `host.mjs` itself
  throws while it is imported (a top-level error or an import that cannot be
  resolved), the same commands print `Host file failed to load: <message>`
  with `code` `host-load`; when an extension's `host()` hook throws inside
  `composeHost`, they print `Extension "<name>" host() failed: <message>` with
  `code` `extension-host` and an `extension` field. Both use the same one-line,
  500-character, stackless form, and core's own refusals inside `composeHost`
  (for example a missing revision pin) keep their own message. A
  module-resolution message is shown as Node reports it, including the
  missing specifier and the absolute path of the file that imported it: the
  line is the operator's own diagnostic about the operator's own checkout,
  printed only to that console or CI log and never in an HTTP response. Treat
  a shared CI log accordingly; the text never includes environment values or
  secrets unless the host file's own error message does.
- Changed runtime source: stop and restart dev, then `npm run typecheck`. Changed app source: reload is automatic.
- Missing dependency or wrong Node: check `node --version`, then `npm ci`.
- Need access from another device: explicitly use `HOST=0.0.0.0` or `--host 0.0.0.0`;
  this exposes the development listener to your network. Loopback remains the default.
  A non-loopback bind also drops the loopback `Host` check described next.
- A request answers `421 Misdirected request`: `dev` and `serve` on a loopback
  bind only accept a `Host` of `localhost`, `127.0.0.1` or `[::1]` with the
  bound port, or the `--origin` authority. Browse to `http://localhost:3000`
  rather than a custom hostname mapped to 127.0.0.1, or pass that name as
  `--origin`. `urlcode test` and `audit` request `127.0.0.1:<port>`, so a
  fixture that sets its own `host` header is refused too. See
  [host admission](OPERATIONS.md#host-admission-on-a-loopback-bind).

Production deployment uses `serve` behind the HTTPS setup described in
[operations](OPERATIONS.md). These shortcuts do not provision providers or select a license.
