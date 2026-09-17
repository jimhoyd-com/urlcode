# Project direction

This page states the product boundary: what URLCode is, what it is not, how
application projects relate to the runtime, where a future managed Cloud fits,
and why the runtime is licensed under Apache-2.0. It describes intent and
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

## Application projects

Applications such as Gitroll, and the planned Placecode and Peercode showcases,
are ordinary consumers of the public runtime. They exist to prove the contract is
sufficient in practice, and they get no private fork, privileged capability or
Cloud dependency. If an application needs something the runtime cannot express,
that is a gap in the public contract to close in the open, not a reason for a
special path. See the [roadmap](../ROADMAP.md).

## URLCode Cloud

A managed operator of the same free runtime remains future work, after the free
self-hosted product launches and stabilizes. It is an additional way to run
projects, not a replacement for self-hosting and not a condition of using them.
Provider infrastructure settings do not belong in route behavior YAML: a project
that runs on Cloud must remain runnable on a laptop or a single container.

## Why Apache-2.0

The runtime is free and open-source software under the
[Apache License 2.0](../LICENSE). It permits commercial use, modification,
redistribution and private use, adds an explicit patent grant, and requires
attribution and a statement of changes. The patent grant and the trademark
limitation are the reasons it is preferred here over a shorter permissive
license: contributors and operators both get predictable terms as the project
gains a managed operator. Contribution terms follow from the same license; see
[contributing](../CONTRIBUTING.md).

The license covers the runtime source in this repository. It grants no rights in
any application's own routes, content or data, and it is not a warranty or a
production-readiness claim — those are set by the
[readiness register](RELEASE-READINESS.md) and [security policy](../SECURITY.md).
