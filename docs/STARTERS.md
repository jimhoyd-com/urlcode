# One starter, two examples

There is one default starting project: a URL that runs a function and a regular redirect.
No `dynamic` versus `redirects` choice. For a page-only project use
`urlcode init <dir> --template page` ([below](#page-only-project)) or, for redirects only, `--template redirects` ([below](#redirect-only-project)).

With URLCode installed:

```sh
urlcode init ../my-links
urlcode dev --project ../my-links
urlcode audit --project ../my-links --expect-routes 2
```

Or use the public GitHub template, which includes a pinned runtime dependency:

```sh
git clone https://github.com/jimhoyd-com/urlcode-template.git my-links
cd my-links
npm ci
npm run dev
npm run audit
```

GitHub's **Use this template** button creates your own repository directly.
These are two ways to obtain the same route examples, not two project types.
The CLI copies app files from `starters/default` and uses the installed runtime;
the public repository adds npm dependency/lockfile/CI for independent installation.
Neither path forks the runtime or needs a hosting account or database.

## Files and growth

`urlcode.yaml` includes a function route file and a redirect file in a nested
folder. A JavaScript function, HTTP assertions and optional Makefile are included,
plus `.github/workflows/urlcode.yml`, which runs the [project checks action](CI.md)
on every push and pull request once the project is on GitHub.
See [organization](ORGANIZATION.md) for choosing your own layout. Defaults allow
GET/HEAD and use redirect 302; add configuration only when changing behavior.

`urlcode init` writes no `package.json`: the route project is route-only, and its
runtime may be installed globally, in a parent workspace or in a container. Add
`--manifest` to also write one pinning the runtime at exactly the version that
generated the project, then run `npm install` in it yourself to install that
version and produce a lockfile. The CLI never runs a package manager, and no
upgrade command exists — a pinned version changes when you edit the manifest.

Initialization refuses an existing destination. Own the app in your own repository,
keep secrets out of Git, and upgrade the runtime separately without regenerating
application files. Add pages, downloads, more functions and business-specific
features to this same project. Update tests and the expected route count as it grows.
See [readiness](READINESS.md) and [security](FUNCTION-SECURITY.md).

<!-- urlcode-current-version:start -->
To start an extended site instead, install core `0.5.0` from npm and choose the supported
immutable bundle release from [package and channel
alignment](VERSION-ALIGNMENT.md). Name the set in any order; a writable `store`
without `auth` refuses unless you pass `--ack store:public-write`, which the
refusal prints for you (see [store](STORE.md)). For example, `urlcode init
../my-site --with ui,auth,admin --bundle-release extension-bundles@v…` writes
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

`examples/assets` contains a larger runnable file/page/download demonstration:
`make dev PROJECT=examples/assets`. It is an example, not a separate init choice.

The old `starter-dynamic` and `starter-redirects` branches are historical snapshots;
use `urlcode-template` for new clones. They are no longer maintained or advertised
as onboarding paths. Existing projects remain ordinary valid URLCode apps.

## Redirect-only project

`urlcode init ../my-redirects --template redirects` writes the same tested starter that
`urlcode context --task redirects` returns: `urlcode.yaml` with each supported redirect shape,
`404.html`, a `package.json` pinning this runtime with a `start` script that honors `PORT`,
`tests/requests.json`, `AGENTS.md` and `.mcp.json`. `urlcode validate --local` and `urlcode test`
pass immediately; delete the routes you do not need. It cannot be combined with `--with`, and
`--manifest`/`--pin` are refused because its `package.json` already pins the runtime.

### Initializing in place

Agents and scripts install the runtime first (its docs ship in the package), so `urlcode init` also
accepts a directory that holds only `package.json`, `package-lock.json`, `node_modules` or `.git`:

```sh
npm init -y && npm install --save-exact @jimhoyd/urlcode
npx urlcode init . --template redirects
```

`package.json` is merged, not replaced: `scripts.start` is added, an installed `@jimhoyd/urlcode`
pin is kept, and everything else in it is left alone. A conflicting `scripts.start`, invalid JSON,
`--manifest` beside an existing `package.json`, or any other existing file is refused, and a failed run
removes only what it created and restores `package.json` byte for byte. `--with` still needs a new or empty directory.

## Page-only project

`urlcode init ../my-page --template page` writes the smallest valid project:
`urlcode.yaml` with one `/` page route, `public/index.html`, a `README.md`,
`tests/requests.json`, and the agent files `AGENTS.md` and `.mcp.json`. It has no functions,
middleware or Makefile, and
`urlcode validate --local` and `urlcode test` pass immediately. `--manifest` and
`--pin` work as for the default starter; `--template page` cannot be combined
with `--with`. Grow it with the routes in [pages and static files](ASSETS.md).

The runtime is licensed under Apache-2.0. Provider adapters follow the
[roadmap](../ROADMAP.md).
