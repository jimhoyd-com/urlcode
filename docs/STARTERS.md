# One bare, agent-ready starter

`urlcode init <directory>` writes one intentionally empty URLCode site: the
route project in `app/` (`urlcode.yaml` with no routes or request fixtures),
`host.mjs` (the operator host, with no extensions yet), a `package.json` that
pins the exact runtime version with npm scripts, a Makefile, project CI,
`AGENTS.md`, and a read-only local `.mcp.json` for Claude Code and Codex. It
does not include sample functions, middleware, redirects, pages or tests. Add
the first request fixture only when you add the first route.

```sh
npx @jimhoyd/urlcode init my-app
cd my-app
npm install
npm run dev        # urlcode dev --project app --host-file host.mjs
npm test
```

Run from the site directory, CLI commands default `--project` to `app`.

The initial `audit --expect-routes 0` reports `no-active-routes`: that is the
expected state of an intentionally empty app, not deployment readiness. The
generated GitHub workflow permits only that result until its first route is
added; then remove `allow-empty-project: true` and require a passing audit.

Without a global install, `npx` runs the published runtime once to create the
site, which then pins it:

```sh
npx @jimhoyd/urlcode init my-app
cd my-app
npm install
npm run dev
npm run audit   # exits 1 with no-active-routes until the first route exists
```

Commit `package-lock.json` with the site.

The CLI copies application files from `starters/default`; the template's
application files are synchronized from the exact published core package after
each core release. That sync owns an explicit list of paths: it copies what the
starter ships and deletes any listed path the starter no longer ships, so the
template's generated files match what `urlcode init` writes. The template's own
README, workflow and package metadata stay template-owned, and the release
refuses to update a template whose README still names a synchronized file the
template no longer contains. Neither path forks the runtime or needs a hosting
account or database.

`urlcode init` names the release it came from: the `package.json` pin, the
`$schema` comment in `app/urlcode.yaml` and the project workflow's
`jimhoyd-com/urlcode/action@v…` ref all carry the running runtime's version.
Move them together when you upgrade; the add-on pins come with the core
version.

## Start an application deliberately

First ask the local MCP `get_context` tool for a compact, project-specific
workflow (or run `urlcode context --project DIR`). Then use a task-scoped
capability, schema, recipe, or example query. Add only the routes, files, and
fixtures required by the application. The local server is the source for this
project; [URLCode AI](https://urlcode.ai/llms.txt) is optional shared hosted
guidance and never replaces it.

The generated `package.json` pins the exact runtime version that created the
site, with the npm scripts `dev`, `start`, `validate`, `test`, `routes` and
`audit`. The CLI runs a package manager only when you add an add-on; run `npm
install` yourself after `init`.

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
Add-ons are released with core `0.5.9` and pinned by it (see [package and
channel alignment](VERSION-ALIGNMENT.md)). Add extensions to a site with
`urlcode extensions add <name>`, or name them at creation: `urlcode init
../my-site --with ui,auth,admin` writes the same site and then adds those
extensions, installing each once with npm, writing its configuration into
`app/urlcode.yaml`, its routes into `app/routes/<name>.yaml`, its operator files
beside `host.mjs`, and one line each in `host.mjs`. Name the set in any order;
each extension brings what it requires. A writable `store` without `auth`
refuses unless you pass `--ack store:public-write`, which the refusal prints for
you (see [store](STORE.md)). The contract each extension fulfils is in
[add-ons](EXTENSIONS.md#add-ons-extensions-and-artifacts).
<!-- urlcode-current-version:end -->

Both paths carry an `AGENTS.md` for repository-aware assistants. `urlcode init`
generates it from the installed runtime's capability catalog (the same source as
`urlcode capabilities`), so it names only the handlers, policies and site keys
that version implements, plus the exact `validate`, `test` and `audit` commands
with the starter's route count. The committed copy in `starters/default` is
regenerated with `npm run docs:agents` from the same function and a test keeps
the two identical. The file
points at the agent skill the package ships at `skills/urlcode/SKILL.md`.
Both paths also write `.mcp.json`, which registers the read-only `urlcode mcp`
server for Claude Code and Codex with `--project app`; it is
never overwritten and carries no `--allow-authoring` ([tooling](TOOLING.md#registering-the-server)).
[URLCode AI](https://urlcode.ai/) is an optional, separate hosted MCP for shared
skills and LLM tooling; it is never added to the generated file and does not
replace the local project server ([setup](TOOLING.md#optional-hosted-ai-mcp)).

`examples/assets` contains a larger runnable file/page/download demonstration:
`make dev PROJECT=examples/assets`. It is an example, not a separate init choice.

Start new sites with `urlcode init`.
The runtime is licensed under Apache-2.0. Provider adapters follow the
[roadmap](../ROADMAP.md).
