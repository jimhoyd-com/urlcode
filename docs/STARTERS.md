# One bare, agent-ready starter

`urlcode init <directory>` writes one intentionally empty URLCode project. It
contains `urlcode.yaml` with no routes, a minimal 404 `tests/requests.json`, a
Makefile, project CI, `AGENTS.md`, and a read-only local `.mcp.json` for Claude
Code and Codex. It does not include sample functions, redirects, pages, or a
package manifest.

With URLCode installed:

```sh
urlcode init ../my-app
urlcode context --project ../my-app
urlcode validate --local --project ../my-app
urlcode test --project ../my-app
urlcode audit --project ../my-app --expect-routes 0
```

Or use the public GitHub template, which contains the same generated app files
and additionally pins its runtime dependency, lockfile, npm workflow, and CI:

```sh
git clone https://github.com/jimhoyd-com/urlcode-template.git my-app
cd my-app
npm ci
npm run dev
npm run audit
```

The CLI copies application files from `starters/default`; the public template
is synchronized from the exact published core package after each core release.
Neither path forks the runtime or needs a hosting account or database.

## Start an application deliberately

First ask the local MCP `get_context` tool for a compact, project-specific
workflow (or run `urlcode context --project DIR`). Then use a task-scoped
capability, schema, recipe, or example query. Add only the routes, files, and
fixtures required by the application. The local server is the source for this
project; [URLCode AI](https://urlcode.ai/llms.txt) is optional shared hosted
guidance and never replaces it.

`urlcode init` writes no `package.json`: the runtime may be installed globally,
in a parent workspace, or in a container. Add `--manifest` to write one that
pins the exact runtime version that generated the project, then run `npm install`
yourself. The CLI never runs a package manager.

Initialization refuses an existing destination except for a directory containing
only `package.json`, `package-lock.json`, `node_modules`, or `.git`. Existing
package metadata is preserved. Keep secrets out of Git and use external operator
policy for bindings. See [readiness](READINESS.md) and
[function security](FUNCTION-SECURITY.md).

## Extended sites

<!-- urlcode-current-version:start -->
To start an extended site instead, install core `0.5.6` from npm and choose the
supported immutable bundle release from [package and channel
alignment](VERSION-ALIGNMENT.md). For example, `urlcode init ../my-site --with
ui,auth,admin --bundle-release extension-bundles@v…` writes an extension site
under `my-site/app/`, its host file, README, core-only `package.json`, and
extension bundle lockfile. See [extensions](EXTENSIONS.md#scaffolding-with-init---with)
for `--no-manifest` and `--pin`.
<!-- urlcode-current-version:end -->

The runtime is licensed under Apache-2.0. Provider adapters follow the
[roadmap](../ROADMAP.md).
