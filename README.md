# URLCode

**A portable runtime for programmable URL behavior, and the framework that grows
from it.** Declare an application's public URL surface in YAML, add JavaScript
only where declarative handlers are not enough, and run the same
project locally, in a container, on your own infrastructure or on a provider
adapter. When the project gets serious, add accounts and an administration
console as operator-installed extensions instead of building them again.
**URL behavior as code.**

[![Verify](https://github.com/jimhoyd-com/urlcode/actions/workflows/ci.yml/badge.svg)](https://github.com/jimhoyd-com/urlcode/actions/workflows/ci.yml)

[Documentation](docs/README.md) · [The framework](docs/FRAMEWORK.md) · [For AI agents](llms.txt) · [Starter](https://github.com/jimhoyd-com/urlcode-template) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

**Your AI should build your application, not your framework.** Coding agents
rebuild the same routing, validation, middleware, policies and authentication
plumbing on every project, and the person ends up owning the plumbing. URLCode
represents those behaviors as a strict, portable YAML contract that both people
and agents can read: the agent describes what, the runtime owns how, and
generated code goes to the part that is actually the application. It is
infrastructure for AI-built software, not a framework for building AI models.
[Why](docs/PROJECT-DIRECTION.md#why-your-ai-should-build-your-application-not-your-framework) ·
[roadmap](ROADMAP.md).

## What it is

A project is a `urlcode.yaml` with `version: "1"`. Each route has exactly one
handler: `redirect`, `respond`, `page`, `static`, `download`, `function`,
`proxy`, `conditional` or an `extension` mount, with optional ordered
`middleware`. The runtime validates the whole project before serving it,
compiles it once, and refuses anything a target cannot enforce with the route
named. Functions and middleware run trusted, in-process, with full Node
access by default; a route opts into an isolated QuickJS/WebAssembly sandbox
with a fresh heap per call and no Node, filesystem or network by declaring
`sandbox: true`. Either way, the `env`/`secrets` the runtime *hands* a route
come only from operator grants pinned to the project revision; grants govern
that injected context, not the ambient Node environment a trusted, in-process
module can reach on its own like any other code in the host.

URLCode is not a URL shortener: stored short links are an operator-installed
extension, not core's job. It is not a
general Node web framework: routing, validation, middleware wiring and
policies are declared in YAML, not hand-wired; isolating a specific route's
code from the host is an explicit `sandbox: true` opt-in, not something every
route gets by writing a handler. It is not a provider configuration format:
infrastructure settings stay out of route YAML.
See [project direction](docs/PROJECT-DIRECTION.md).

## The framework

Four packages, one project shape. A project climbs from redirects to a full
application by adding YAML; the operator wires trusted packages in one host
file outside the project. The full map, the composition contract and the rules
an AI agent must follow are in [the framework](docs/FRAMEWORK.md).

| Package | Adds | Stable npm channel |
|---|---|---|
| [urlcode](https://github.com/jimhoyd-com/urlcode) (this repository) | Runtime, CLI, policies, provider adapters, extension contract | [![npm stable version](https://img.shields.io/npm/v/%40jimhoyd%2Furlcode?label=stable)](https://www.npmjs.com/package/@jimhoyd/urlcode) |
| [urlcode-ui](packages/ui) (in this repository) | Shared presentation: escaped templates, shadcn/ui partials, themes, translations | [![npm stable version](https://img.shields.io/npm/v/%40jimhoyd%2Furlcode-ui?label=stable)](https://www.npmjs.com/package/@jimhoyd/urlcode-ui) |
| [urlcode-auth](packages/auth) (in this repository) | Accounts: password, passkeys, OIDC, email codes, TOTP, sessions, roles, account page | [![npm stable version](https://img.shields.io/npm/v/%40jimhoyd%2Furlcode-auth?label=stable)](https://www.npmjs.com/package/@jimhoyd/urlcode-auth) |
| [urlcode-admin](packages/admin) (in this repository) | Administration: users, sessions, roles, audit, approvals, cases, impersonation | [![npm stable version](https://img.shields.io/npm/v/%40jimhoyd%2Furlcode-admin?label=stable)](https://www.npmjs.com/package/@jimhoyd/urlcode-admin) |

The badges report each package's live npm `latest` channel, which is the stable
version of that package. Stability is independent: matching version numbers are
not required. Releases created by the current [GitHub release
publisher](https://github.com/jimhoyd-com/urlcode/releases) show the exact
four-package combination tested together, its declared peer
requirements and a copyable exact-version install command; the signed
`train.json` asset is the machine-readable receipt. Peer ranges, channel rules
and generated application pins are documented in [package and channel
alignment](docs/VERSION-ALIGNMENT.md).

`urlcode-dynamic-link` and `urlcode-short` were published once as
`0.1.0-alpha.1` and have since been retired: both were unpublished from npm and
their repositories deleted, and neither has a successor. Nothing supported
provides stored short links today — a project that needs them owns that storage
itself. Anything still pinned to `@jimhoyd/urlcode-dynamic-link@0.1.0-alpha.1`
also has to deal with its exact declared peer `@jimhoyd/urlcode: 0.4.0-alpha.1`,
which cannot be installed beside core `0.4.0-alpha.2` and never will be.

`urlcode-middleware` was retired the same way on 2026-09-19 —
`@jimhoyd/urlcode-middleware` was unpublished from npm at `0.1.0-alpha.2` and
its repository deleted. Unlike the two above, its capability did not go away
with it: **per-route middleware is native to core**, through the
`middleware:` array documented in [docs/MIDDLEWARE.md](docs/MIDDLEWARE.md).
The deleted package only ever offered the same behavior through the extension
seam. A project using it moves its entries to the native array; there is no
gap to report here.

```yaml
version: "1"
extensions:
  auth:  { version: "1", config: { registration: "off" } }
  admin: { version: "1", config: {} }
routes:
  /go:          { redirect: { url: https://example.com, status: 302 } }
  /account/*:   { extension: auth,  methods: [GET, HEAD, POST] }
  /admin/*:     { extension: admin, methods: [GET, HEAD, POST] }
  /private:
    respond: { text: Signed in }
    policies: { extensions: { auth: {} } }
```

The YAML names logical extensions; it never names packages, code, databases
or credentials. `urlcode-auth init` writes the operator host, keys and a
private data directory beside the project; `urlcode serve --host-file` loads
it. Cross-repository acceptance is tracked in
[issue 58](https://github.com/jimhoyd-com/urlcode/issues/58).

## Status

<!-- urlcode-current-version:start -->
The `0.4.9` release updates core. UI, auth, admin and store retain independent
release versions; use `npm run release:status` or the release's signed
`train.json` for the verified install combination. A stable core version selects
core's npm `latest` channel; it does not close the review and deployment
evidence gaps below. `0.4.0-alpha.1`
added the extension contract, capabilities and provider conformance, strict
redirect interchange, bulk import, recipes and search, TypeScript guest
authoring, conditions, bounded proxy and signals, and the MCP read and
authoring modes. `0.4.0-alpha.2` then made `function` and `middleware` routes
run trusted and unsandboxed by default, with `sandbox: true` as a per-route
opt-in, and removed the native `link:`/`dynamicLinks:` YAML shape. That is a
behaviour change for existing projects with no YAML edit; read
[the roadmap entry](ROADMAP.md) before upgrading. Use the schema and docs from
the runtime revision you run.
<!-- urlcode-current-version:end -->
The [roadmap](ROADMAP.md) separates implemented from planned, and
[release readiness](docs/RELEASE-READINESS.md) records what is proven and
what is not: provider deployments, soak and independent security review
remain open.

Core has no native `link` handler. Stored short links moved out to a
mount-based `urlcode-dynamic-link` extension, which has since been retired and
unpublished; no supported package provides them.

URLCode is free and open-source software licensed under the
[Apache License 2.0](LICENSE). Commercial use, modification, redistribution and
self-hosting are permitted under its terms.

## Documentation

Start with the [YAML guide and recipe book](docs/YAML-GUIDE.md),
[complete field reference](docs/YAML-REFERENCE.md), and
[runnable 25-route cookbook](examples/cookbook/README.md). For AI-assisted
authoring, use [the AI guide](docs/AI-AUTHORING.md), the bundled agent skills
([authoring](.claude/skills/urlcode-authoring/SKILL.md),
[operations](.claude/skills/urlcode-operations/SKILL.md)) and [llms.txt](llms.txt).
Agents can also read project-pinned, signed declarative extension schemas through
the read-only MCP tools described in [extensions](docs/EXTENSIONS.md#signed-declarative-artifacts);
those artifacts are inert data, not an alternate executable package channel.
Follow [organization and readability practices](docs/BEST-PRACTICES.md) as your
project grows. Operators should read [capacity/concurrency](docs/CAPACITY.md) and the
[DDoS and recovery playbook](docs/RESILIENCE.md). Embedding the runtime from
TypeScript is covered in [TypeScript](docs/TYPESCRIPT.md). [All documentation](docs/README.md).

All of it lives in [`docs/`](docs/README.md) in this repository — guides,
references and recipes alongside the contributor and maintainer material: local
development, CI, the release process, reviews and the generated field
reference. New pages belong here, in the same pull request as the change they
describe. `urlcode-docs`, the separate documentation site repository, was
deleted on 2026-09-19 after any content ahead of this repository was brought
across.

## Start your own project

Use [urlcode-template](https://github.com/jimhoyd-com/urlcode-template) for a small
app with just a function route and a regular redirect. Clone it or use GitHub’s
**Use this template** button, then run `npm ci` and `npm run dev`. The runtime is
a pinned dependency; no separate checkout or global installation is needed.

```sh
git clone https://github.com/jimhoyd-com/urlcode-template.git my-links
cd my-links
npm ci
npm run dev
```

## Start from YAML

Already wrote `urlcode.yaml`? Run `urlcode scaffold --project ./my-links --dry-run`,
then remove `--dry-run` to create missing modules, pages and directories. Existing
files are preserved; code placeholders return 501 until implemented.
[Scaffolding guide](docs/SCAFFOLDING.md). Node 22.13+ installed, 22.18+ to run
the TypeScript source; the separate `urlcode-auth` extension may have its own
SQLite build requirement, unverified from this repository.

## Install

URLCode needs Node.js 22.13 or later. Pick the installation channel that fits
your environment:

```sh
# npm
npm install --global @jimhoyd/urlcode@latest

# Homebrew
brew tap jimhoyd-com/urlcode
brew trust jimhoyd-com/urlcode
brew install urlcode

# Generic installer (downloads a release tarball and verifies its SHA-256)
curl -fsSL https://raw.githubusercontent.com/jimhoyd-com/urlcode/main/install.sh | sh
```

For project-local installs, exact version pins, and provenance details, see
[the installation guide](docs/INSTALL.md).

## Try it

```sh
urlcode init my-urls && cd my-urls
urlcode dev
```

Open `http://127.0.0.1:3000/hello/Ada` for the function route and `/go` for
the redirect. Edit the YAML; valid changes reload. `urlcode test` runs the
project's HTTP fixtures. The [install guide](docs/INSTALL.md) covers the
checksum-verified script, project-local installs, the container image and
signed provenance. To work from a clone: `git clone … && make dev`.

## A URL that runs your function

```yaml
version: "1"
routes:
  /hello/{name}:
    parameters:
      - { name: name, in: path, required: true, schema: { type: string, minLength: 1, maxLength: 80 } }
    function:
      source: functions/hello.mjs
      args: { name: { from: path, name: name } }
    env:
      GREETING: { value: Hello }
```

```js
export default function hello(request, { args, env }) {
  return Response.json({ message: `${env.GREETING}, ${args.name}!` });
}
```

Add `middleware: [{ source: middleware/headers.mjs }]` to wrap any handler with
`await next()`. Fourteen ready-made middleware patterns ship in the cookbook
and as `urlcode recipes add middleware`. See [functions and the sandbox](docs/FUNCTION-SECURITY.md)
and [middleware](docs/MIDDLEWARE.md).

## Everything else in YAML

- **Pages, files, downloads:** `page`, `static`, `download` with MIME detection,
  ETags, ranges and safety limits. [Assets](docs/ASSETS.md).
- **HTTP:** methods, validated path/query/header inputs, body limits, response
  headers and cookies. [HTTP](docs/HTTP.md).
- **Policies and site conventions:** throttle, agents, security headers,
  compression, cache; robots, sitemap, favicon, security.txt, llms.txt.
  [Policies](docs/POLICIES.md), [site](docs/SITE.md).
- **Conditions, proxy, signals:** exact predicates with disjoint cases; a bounded
  HTTPS proxy and best-effort webhooks behind operator grants.
  [Conditions](docs/CONDITIONS.md), [egress](docs/EGRESS.md).
- **Organization:** `includes` across folders; strict CSV/JSON/YAML and
  provider-file import; searchable recipes and examples. [Organization](docs/ORGANIZATION.md),
  [interchange](docs/INTERCHANGE.md), [bulk](docs/BULK.md), [recipes](docs/RECIPES.md).
- **Checks:** `validate`, `test`, `routes`, `audit --expect-routes`, `benchmark`,
  `capabilities`, deployment verification and a GitHub Action.
  [Readiness](docs/READINESS.md), [CI](docs/CI.md).

## Deploy

Self-hosted Node process or container first. `@jimhoyd/urlcode/vercel` and
`@jimhoyd/urlcode/aws` serve declarative projects as native handlers;
`urlcode build --target cloudflare` compiles redirects and declared responses
into a Worker; `urlcode build --target static` compiles redirects and static
files into plain objects and redirect metadata for S3 + CloudFront, with no
server at all. Each target refuses at activation or build time what it cannot
run, with the route named. None has been exercised on its provider yet; the
adapters have local conformance tests only. [Operations](docs/OPERATIONS.md),
[capabilities](docs/CAPABILITIES.md), [Vercel](docs/VERCEL.md), [AWS](docs/AWS.md),
[Cloudflare](docs/CLOUDFLARE.md), [static hosting](docs/STATIC.md).

## For AI agents

[llms.txt](llms.txt) is the compact index; [the framework](docs/FRAMEWORK.md)
is the map; [AI authoring](docs/AI-AUTHORING.md) is the contract with the
capability matrix and a copyable task prompt. `urlcode mcp` exposes read-only
inspection, validation and conversion previews over stdio, and
`--allow-authoring` adds project-confined authoring tools
([tooling](docs/TOOLING.md)).

## Built with URLCode

Two applications were built on the public runtime as ordinary consumers, and
both have since been retired: `urlcode-docs`, a static documentation site
rendered through its own middleware at build time and served through native
page/static/download routes, and `urlcode-short`, an account-free short-link
demo combining expiring links, QR downloads and a shadcn/ui frontend — URLCode
supplied the pages, assets and routing, the application supplied anonymous
creation, link storage and its own limits. `urlcode-short`'s repository is
deleted, so its build retrospective is no longer reachable; what it recorded
about the gap between the runtime and a real application is carried in
[principles and open decisions](docs/OPEN-DECISIONS.md) and [roadmap](ROADMAP.md).

## License and contributing

Apache-2.0. Commercial use, modification, redistribution and self-hosting are
permitted. See [contributing](CONTRIBUTING.md), [security](SECURITY.md),
[governance](GOVERNANCE.md) and the [roadmap](ROADMAP.md).
