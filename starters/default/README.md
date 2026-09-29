# Your URLCode site

This is a bare, agent-ready URLCode site. It starts with no routes so your
application's YAML and tests describe only the behavior you intend to ship.

- `app/` is the route project: `urlcode.yaml`, functions, `tests/requests.json`.
- `host.mjs` is the trusted operator host. It lists the installed extensions
  and stays outside `app/`.
- `package.json` pins the URLCode runtime, and every add-on, exactly;
  `package-lock.json` records their integrity, and `addon-files.lock.json`
  (written by `urlcode extensions add` / `artifacts add`; commit it) the sha256
  of every installed add-on file, which `urlcode extensions verify` checks.

```sh
npm install
npm run dev
# In another terminal:
npm test
```

`npm test` has no cases until you add `app/tests/requests.json`. `npm run
audit` intentionally reports `no-active-routes` until you add the first route.
The included GitHub workflow permits only that initial audit result; remove
`allow-empty-project: true` after adding a route.

Add, remove and upgrade extensions and artifacts released with this runtime
from the site directory:

```sh
npx urlcode extensions available
npx urlcode extensions add auth store --example   # --example adds working demos, such as a per-user /api/todos collection
npx urlcode extensions remove store
npx urlcode upgrade --check
```

`extensions add` installs only the capability (for example auth's Better Auth
mount at `/api/auth/*`, with no route of yours protected yet), plus every
extension it requires; auth requires no other extension. `--example` also writes each added
extension's demo, such as store's `/api/todos` JSON collection (per-user when auth
is installed).

Once a site has an extension, the host is pinned to a reviewed project
revision, and every edit changes the revision. `npm run validate`, `npm test`,
`npm run routes` and `npm run audit` pass `--local-review`. With no reviewed
pin, each run is pinned to the current revision for that run only, on
`http://localhost`, and reads no policy, so it grants no binding. Edit and
rerun them without re-pinning.

Serving needs your approval. `npm run dev` and `npm start` need the public
origin and the operator's reviewed policy: the output of
`npx urlcode permissions --project app`, reviewed and saved outside `app/`,
for example as `operator/policy.json`. The CLI reads both from the
environment:

```sh
URLCODE_ORIGIN=https://your.site URLCODE_POLICY=operator/policy.json npm start
```

Without them the command refuses and prints the complete command to run.
With them, the check scripts use that policy and pin as given. Nothing writes
or updates the policy for you; re-review it after a project change.

The frontend is your own code calling those JSON routes with `fetch`; URLCode
ships no component kit. The
[private-requests client][proofs/private-requests/client/main.js]
is the reference pattern.

Start with the local MCP `get_context` tool (or `npx urlcode context --project
app`), then add the smallest declarative route or custom code the task requires.
`AGENTS.md` explains the workflow and points to the optional hosted shared
tooling at https://urlcode.ai/llms.txt.

Keep this site in your own Git repository. Secrets stay in ignored `.env.local`,
`data/` or provider environment values, with external operator policy for
function grants. See
[security][docs/FUNCTION-SECURITY.md]
and [readiness][docs/READINESS.md].
URLCode is licensed under the Apache License 2.0.

<!-- urlcode-current-version:start -->
[proofs/private-requests/client/main.js]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/proofs/private-requests/client/main.js
[docs/FUNCTION-SECURITY.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/FUNCTION-SECURITY.md
[docs/READINESS.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/READINESS.md
<!-- urlcode-current-version:end -->
