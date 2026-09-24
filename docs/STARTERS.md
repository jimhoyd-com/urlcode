# One bare, agent-ready starter

`urlcode init <directory>` writes one intentionally empty URLCode project. It
contains `urlcode.yaml` with no routes or request fixtures, a Makefile, project
CI, `AGENTS.md`, and a read-only local `.mcp.json` for Claude Code and Codex. It
does not include sample functions, middleware, redirects, pages, tests, or a
package manifest. Add the first request fixture only when you add the first
route.

With URLCode installed:

```sh
urlcode init ../my-app
urlcode context --project ../my-app
urlcode validate --local --project ../my-app
urlcode test --project ../my-app
```

The initial `audit --expect-routes 0` reports `no-active-routes`: that is the
expected state of an intentionally empty app, not deployment readiness. The
generated GitHub workflow permits only that result until its first route is
added; then remove `allow-empty-project: true` and require a passing audit.

Or use the public GitHub template, which additionally pins its runtime
dependency, lockfile, npm scripts, and CI:

```sh
git clone https://github.com/jimhoyd-com/urlcode-template.git my-app
cd my-app
npm ci
npm run dev
npm run audit   # exits 1 with no-active-routes until the first route exists
```

The CLI copies application files from `starters/default`; the template's
application files are synchronized from the exact published core package after
each core release. That sync owns an explicit list of paths: it copies what the
starter ships and deletes any listed path the starter no longer ships, so the
template's generated files match what `urlcode init` writes. The template's own
README, workflow and package metadata stay template-owned, and the release
refuses to update a template whose README still names a synchronized file the
template no longer contains. Neither path forks the runtime or needs a hosting
account or database.

`urlcode init` names the release it came from: the `$schema` comment in
`urlcode.yaml` and the project workflow's `jimhoyd-com/urlcode/action@v…` ref
both carry the running runtime's version tag. Move them together when you
upgrade.

## Start an application deliberately

First ask the local MCP `get_context` tool for a compact, project-specific
workflow (or run `urlcode context --project DIR`). Then use a task-scoped
capability, schema, recipe, or example query. Add only the routes, files, and
fixtures required by the application. The local server is the source for this
project; [URLCode AI](https://urlcode.ai/llms.txt) is optional shared hosted
guidance and never replaces it.

`urlcode init` writes no `package.json`: the runtime may be installed globally,
in a parent workspace, or in a container. Add `--manifest` to write one that
pins the exact runtime version that generated the project, with the npm scripts
the template also ships (`dev`, `start`, `validate`, `test`, `routes`, `audit`),
then run `npm install` yourself. The CLI never runs a package manager.

Initialization refuses an existing destination except for a directory containing
only `package.json`, `package-lock.json`, `node_modules`, or `.git`. Existing
package metadata is preserved: when that `package.json` already depends on
`@jimhoyd/urlcode`, init only adds whichever of those scripts are missing (and
replaces the placeholder `test` script `npm init` writes), because a bare
`urlcode` is not on PATH for a project-local install. Outside npm scripts, run
the local copy as `npx --no --package @jimhoyd/urlcode urlcode …`; `urlcode
context` and MCP `get_context` print commands in that form when the project, or
a directory above it, declares the dependency. Keep secrets out of Git and use external operator
policy for bindings. See [readiness](READINESS.md) and
[function security](FUNCTION-SECURITY.md).

## Extended sites

<!-- urlcode-current-version:start -->
To start an extended site instead, install core `0.5.9` from npm and choose the supported
immutable bundle release from [package and channel
alignment](VERSION-ALIGNMENT.md). Name the set in any order; a writable `store`
without `auth` refuses unless you pass `--ack store:public-write`, which the
refusal prints for you (see [store](STORE.md)). For example, `urlcode init
../my-site --with ui,auth,admin` (which resolves `extension-bundles@v<core>`
unless `--bundle-release` pins another) writes
the same starter under `my-site/app/`, merges each bundle's routes and
declarations into it, and generates one `host.mjs`, README, core-only
`package.json`, and extension bundle lockfile. Installing in that directory is
your explicit `npm install` for core only.
The contract each package fulfils is in [extensions](EXTENSIONS.md#scaffolding-with-init---with),
with `--no-manifest` and `--pin` in [recorded versions](EXTENSIONS.md#recorded-versions).
<!-- urlcode-current-version:end -->

Both paths carry an `AGENTS.md` for repository-aware assistants. `urlcode init`
generates it from the installed runtime's capability catalog (the same source as
`urlcode capabilities`), so it names only the handlers, policies and site keys
that version implements, plus the exact `validate`, `test` and `audit` commands
with the starter's route count. The committed copy in `starters/default` is
regenerated from the same function and a test keeps the two identical. The file
points at the agent skill the package ships at `skills/urlcode/SKILL.md`.
Both paths also write `.mcp.json`, which registers the read-only `urlcode mcp`
server for Claude Code and Codex (`--project app` for an extended site); it is
never overwritten and carries no `--allow-authoring` ([tooling](TOOLING.md#registering-the-server)).
[URLCode AI](https://urlcode.ai/) is an optional, separate hosted MCP for shared
skills and LLM tooling; it is never added to the generated file and does not
replace the local project server ([setup](TOOLING.md#optional-hosted-ai-mcp)).

`examples/assets` contains a larger runnable file/page/download demonstration:
`make dev PROJECT=examples/assets`. It is an example, not a separate init choice.

The old `starter-dynamic` and `starter-redirects` branches are historical snapshots;
use `urlcode-template` for new clones. They are no longer maintained or advertised
as onboarding paths. Existing projects remain ordinary valid URLCode apps.
The runtime is licensed under Apache-2.0. Provider adapters follow the
[roadmap](../ROADMAP.md).
