# Operator extension fixture

This project declares two logical extensions and two protected routes: `/private` spells out `policies.extensions.demo`, while `/account` uses the route-level `auth` short form, which expands to `policies.extensions.auth` because `auth` is the one declared extension that provides the request principal (the first-party catalog says so; the test's stand-in registration must then declare `providesPrincipal: true`). It contains no host modules or credentials. `test/extensions.test.ts` loads this exact YAML with an explicitly supplied demo registry and exercises both endpoints.

Runtime activation requires an external operator registry with a reviewed, static `projectSha256` matching `inspectExtensionRevision(project)`, plus an explicit canonical origin. Inspecting a revision does not grant it. The registry supplies versioned configuration and policy schemas and trusted host callbacks. Missing providers or mismatched revisions fail before activation. Cloudflare refuses this feature until an explicit Worker implementation exists.

The demo provider in the test is a protocol fixture, not authentication suitable for deployment. Its `role: member` requirement belongs to that synthetic registry: the first-party `auth` extension ([packages/auth](../../packages/auth/README.md), a Better Auth adapter) takes no policy keys, only `auth: true`.
