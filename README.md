# URLCode

**URLs that run code.** A planned, publicly developed toolkit for programmable
URLs with open-source intent; the license remains undecided.
The model is URL → behavior → response; a route is the fundamental object.
Shortening is the first use case, not the limit. Describe
URL behavior with portable YAML, add code when needed, test locally and
deploy on infrastructure you choose. Your URLs, your source, your data.

## Status

Pre-implementation. This repository is the public project foundation, not a
working release. No CLI, runtime, schema, packages, Homebrew formula or provider
adapters are available yet. The license is undecided and will be addressed
separately; development and code pushes can proceed. No license has been
applied. Do not treat proposed commands/features as supported today.
The [roadmap](ROADMAP.md) separates local alpha, self-hosted beta, provider release
and later advanced/Cloud work; Cloud is not required to ship the public runtime.

## What we are building

- Short aliases and bulk redirects, parameterized routes, reusable templates,
  asynchronous signals and optional functions that execute on requests.
- Simple page/static-directory/download handlers after the local core; bounded
  proxies and protected/stateful downloads are later extensions.
  Serve files without unnecessary functions; no SSR/ISR, CMS or generic hosting.
- A standard YAML/JSON Schema contract with familiar HTTP parameter conventions.
  Describe behavior once; keep provider infrastructure out of the project.
- A CLI and composable scripts for CSV↔YAML/JSON, imports/exports, validation,
  searching and safe bulk editing of thousands of links. No required web UI/TUI.
- Full local development, unit and real HTTP end-to-end tests, optional ngrok
  integration, reproducible performance tests and monitoring integrations.
- Cross-platform installation, including a Homebrew tap when packages exist.
- Cheap self-deployment: generic process/container first, with Cloudflare, AWS,
  Vercel and other adapters as their capabilities are implemented and tested.

Ordinary redirects will not require a database. Compile the configuration into
indexed routing snapshots; native provider redirects are preferred where they
preserve semantics. Simple redirects must not invoke Lambda. Durable signals
or one-time links may require optional storage with explicit guarantees.

Git is the source of truth. Commit secret references, never secret values;
use ignored `.env.local` locally and provider secret stores when deploying.
The same YAML, templates, functions and tests should work unchanged on every
supported target, with environment/provider bindings managed separately.
Unsupported provider features must be reported rather than silently discarded.

The product boundary is “I need a URL that…”, rather than a general application
hosting platform. Templates expand into inspectable portable routes; Git stores
source, not runtime logs, analytics, counters or secret values.

We will release the free version, gather feedback from real use, and improve it
until it is launched and stable. Only then will we flesh out Cloud and build it.
We preserve reusable runtime/provider boundaries now so that future direction
does not require rewriting user projects.

URLCode Cloud is the future optional managed service, with a proprietary
control plane. Brand rights are separate from the future software license.
The public runtime will remain useful and production-capable for people who operate it themselves.

## Follow and contribute

See the [roadmap](ROADMAP.md), [contribution guide](CONTRIBUTING.md) and
[security guidance](SECURITY.md). Design discussion is welcome through issues.
Runtime implementation will follow a published schema and conformance tests.
