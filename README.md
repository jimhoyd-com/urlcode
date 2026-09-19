# URLCode

**A portable runtime for programmable URL behavior, and the framework that grows
from it.** Declare an application's public URL surface in YAML, add isolated
JavaScript only where declarative handlers are not enough, and run the same
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
[next steps](docs/NEXT-STEPS.md).

## What it is

A project is a `urlcode.yaml` with `version: "1"`. Each route has exactly one
handler: `redirect`, `respond`, `page`, `static`, `download`, `function`,
`link`, `proxy`, `conditional` or an `extension` mount, with optional ordered
`middleware`. The runtime validates the whole project before serving it,
compiles it once, and refuses anything a target cannot enforce with the route
named. Functions and middleware run trusted, in-process, with full Node
access by default; a route opts into an isolated QuickJS/WebAssembly sandbox
with a fresh heap per call and no Node, filesystem or network by declaring
`sandbox: true`. Either way, secrets reach them only through operator grants
pinned to the project revision.

URLCode is not a URL shortener: short links are one handler. It is not a
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

| Package | Adds | Status |
|---|---|---|
| [urlcode](https://github.com/jimhoyd-com/urlcode) (this repository) | Runtime, CLI, policies, live links, provider adapters, extension contract | `0.4.0-alpha.1` (alpha) on top of the `0.3.0` release, Apache-2.0 |
| [urlcode-ui](https://github.com/jimhoyd-com/urlcode-ui) | Shared presentation: escaped templates, shadcn/ui partials, themes, translations | `0.1.0-alpha.1` on npm, alpha: review pending |
| [urlcode-auth](https://github.com/jimhoyd-com/urlcode-auth) | Accounts: password, passkeys, OIDC, email codes, TOTP, sessions, roles, account page | `0.1.0-alpha.1` on npm, alpha: review pending |
| [urlcode-admin](https://github.com/jimhoyd-com/urlcode-admin) | Administration: users, sessions, roles, audit, approvals, cases, impersonation | `0.1.0-alpha.1` on npm, alpha: review pending |

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

`0.4.0-alpha.1` is the current release of the extension contract and the
agent tooling, on top of the `0.3.0` self-hosted release. It adds the
extension contract, capabilities and provider conformance, strict redirect
interchange, bulk import, recipes and search, TypeScript guest authoring,
conditions, bounded proxy and signals, and the MCP read and authoring modes;
use the schema and docs from the runtime revision you run.
The [roadmap](ROADMAP.md) separates implemented from planned, and
[release readiness](docs/RELEASE-READINESS.md) records what is proven and
what is not: provider deployments, soak and independent security review
remain open.

Live-link storage uses separate bounded reader/writer pools. It requires a Node
build containing a patched SQLite version — 3.51.3 or newer, 3.50.7, or 3.44.6 —
which some current releases on a supported Node line do not carry. Run
`urlcode doctor` and check `liveLinks` before relying on it; everything else
runs on any supported Node.
See [pool controls and scaling limits](docs/DYNAMIC-LINKS.md#separate-reader-and-writer-pools).

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
Follow [organization and readability practices](docs/BEST-PRACTICES.md) as your
project grows. Operators should read [capacity/concurrency](docs/CAPACITY.md) and the
[DDoS and recovery playbook](docs/RESILIENCE.md). Embedding the runtime from
TypeScript is covered in [TypeScript](docs/TYPESCRIPT.md). [All documentation](docs/README.md).

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

Live stored-link routes require **`dynamicLinks: true`** in the entry `urlcode.yaml`;
the starter explicitly sets false. Ordinary functions and parameterized redirects
do not need it. [Live-link setup](docs/DYNAMIC-LINKS.md).

## Built with URLCode

[urlcode-shortener](https://github.com/jimhoyd-com/urlcode-shortener) is a
standalone, account-free demo built on URLCode's public runtime and storage APIs.
It combines short links that expire after one hour or less, QR downloads, and a
shadcn/ui + Tailwind frontend. URLCode handles the page/assets and stored-link
redirects; the application adds anonymous creation and its own limits.

Read its [build retrospective](https://github.com/jimhoyd-com/urlcode-shortener/blob/main/docs/BUILD-RETROSPECTIVE.md)
for what the runtime supplied, what the application still needed, and proposed
improvements. The demo's license, hosting and production validation remain open;
it does not change URLCode's Apache-2.0 license or guest isolation model.

[urlcode-docs](https://github.com/jimhoyd-com/urlcode-docs) demonstrates URLCode
hosting a static documentation site with shadcn/ui and Tailwind. It syncs this
repository’s Markdown and examples at a pinned revision, applies templates through
sandboxed middleware during the build, and serves the output through native
page/static/download routes. This repository remains the documentation source of
truth. See the [docs-site retrospective](https://github.com/jimhoyd-com/urlcode-docs/blob/main/docs/BUILD-RETROSPECTIVE.md)
for reuse, integration work and upstream improvements. Hosting and a public domain
are not yet selected; the original site-code license is pending.

## Start from YAML

Already wrote `urlcode.yaml`? Run `urlcode scaffold --project ./my-links --dry-run`,
then remove `--dry-run` to create missing modules, pages and directories. Existing
files are preserved; code placeholders return 501 until implemented.
[Scaffolding guide](docs/SCAFFOLDING.md).
Live-link storage and the auth extension need a Node build whose SQLite is
3.51.3 or newer, 3.50.7 or 3.44.6. `urlcode doctor` reports `liveLinks`;
everything else runs on any supported Node (22.13+ installed, 22.18+ to run
the TypeScript source).

## Try it

```sh
npm install --global @jimhoyd/urlcode     # or: brew tap jimhoyd-com/urlcode && brew install urlcode
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
- **Live short links:** a `link` route on an optional SQLite store; create,
  update and delete without reloads through the CLI or the private management
  API. [Dynamic links](docs/DYNAMIC-LINKS.md).
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
into a Worker. Each target refuses at activation or build time what it cannot
run, with the route named. None has been exercised on its provider yet; the
adapters have local conformance tests only. [Operations](docs/OPERATIONS.md),
[capabilities](docs/CAPABILITIES.md), [Vercel](docs/VERCEL.md), [AWS](docs/AWS.md),
[Cloudflare](docs/CLOUDFLARE.md).

## For AI agents

[llms.txt](llms.txt) is the compact index; [the framework](docs/FRAMEWORK.md)
is the map; [AI authoring](docs/AI-AUTHORING.md) is the contract with the
capability matrix and a copyable task prompt. `urlcode mcp` exposes read-only
inspection, validation and conversion previews over stdio, and
`--allow-authoring` adds project-confined authoring tools
([tooling](docs/TOOLING.md)).

## Documentation

Full documentation lives in
[urlcode-docs](https://github.com/jimhoyd-com/urlcode-docs). It is authored
there directly, not generated from this repository, and it is where new guides,
references and recipes belong.

`docs/` in this repository is contributor and maintainer material — local
development, CI, the release process, reviews and the generated field
reference. Reader-facing pages still under `docs/` are being migrated.

## Built with URLCode

[urlcode-short](https://github.com/jimhoyd-com/urlcode-short), an
account-free short-link demo with a shadcn/ui front end, and
[urlcode-docs](https://github.com/jimhoyd-com/urlcode-docs), a static
documentation site rendered through sandboxed middleware at build time. Both are
ordinary consumers of the public runtime; their retrospectives list what the
runtime supplied and what they still had to build.

## License and contributing

Apache-2.0. Commercial use, modification, redistribution and self-hosting are
permitted. See [contributing](CONTRIBUTING.md), [security](SECURITY.md),
[governance](GOVERNANCE.md) and the [roadmap](ROADMAP.md).
