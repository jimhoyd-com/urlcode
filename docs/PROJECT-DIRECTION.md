# Project direction

This page states the product boundary: what URLCode is, what it is not, how
application projects relate to the runtime, and the license it is released
under. It describes intent and
boundaries, not a delivery schedule; the [roadmap](../ROADMAP.md) owns sequence
and the [readiness register](RELEASE-READINESS.md) owns what is proven.

## What URLCode is

A portable runtime for programmable URL behavior. A project declares its public
URL surface in YAML, adds isolated JavaScript only where declarative handlers are
not enough, and runs the same definition locally, in a container, or on operator
infrastructure. The project format is deliberately bounded so a runtime can
validate it, inspect it, test it and eventually carry it across hosting providers.

Git owns route definitions and code. Operators own credentials, storage and
capability grants. Application data stays in the operator's systems.

## What URLCode is not

- **Not a URL shortener.** Short links are one handler beside redirects,
  validated responses, request functions, middleware, pages, static assets and
  downloads. The [live-link store](DYNAMIC-LINKS.md) is optional and single-host.
- **Not a general Node web framework.** Guest code runs inside WASM isolation
  with no ambient filesystem, network or Node APIs. Behavior that cannot be
  expressed in the bounded contract is rejected rather than emulated.
- **Not a hosting account system.** There is no end-user identity, billing or
  public account surface. Management is a private operator API.
- **Not a provider configuration format.** Provider infrastructure settings do
  not belong in route behavior YAML. A project must remain runnable on a laptop
  or in a single container wherever else it is deployed.

## Application projects

Applications built on URLCode are ordinary consumers of the public runtime.
They exist to prove the contract is sufficient in practice, and they get no
private fork or privileged capability. If an application needs something the
runtime cannot express, that is a gap in the public contract to close in the
open, not a reason for a special path. See the [roadmap](../ROADMAP.md).

## License

The runtime is free and open-source software under the
[Apache License 2.0](../LICENSE). Contribution terms follow from the same
license; see [contributing](../CONTRIBUTING.md).

The license covers the runtime source in this repository. It grants no rights in
any application's own routes, content or data, and it is not a warranty or a
production-readiness claim — those are set by the
[readiness register](RELEASE-READINESS.md) and [security policy](../SECURITY.md).
