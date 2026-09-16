# URLCode

A planned open-source URL shortener and programmable URL runtime. Describe
URL behavior with portable YAML, add code when needed, test locally and
deploy on infrastructure you choose. Your URLs, your source, your data.

## Status

Pre-implementation. This repository is the public project foundation, not a
working release. No CLI, runtime, schema, packages, Homebrew formula or provider
adapters are available yet. The open-source license will be selected before
runtime code is accepted or released. Do not treat proposed commands/features
as supported today.

## What we are building

- Short aliases and bulk redirects, parameterized routes, reusable templates,
  asynchronous signals and optional functions that execute on requests.
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

URLCode Cloud is the future optional managed service. OSS will remain useful
and production-capable for people who operate it themselves.

## Follow and contribute

See the [roadmap](ROADMAP.md), [contribution guide](CONTRIBUTING.md) and
[security guidance](SECURITY.md). Design discussion is welcome through issues.
Runtime implementation will follow a published schema and conformance tests.
