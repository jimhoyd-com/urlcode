# Operator extension fixture

This project declares a logical extension and a protected route. It contains no host modules or credentials. `test/extensions.test.ts` loads this exact YAML with an explicitly supplied demo registry and exercises both endpoints.

Runtime activation requires an external operator registry with a reviewed, static `projectSha256` matching `inspectExtensionRevision(project)`, plus an explicit canonical origin. Inspecting a revision does not grant it. The registry supplies versioned configuration and policy schemas and trusted host callbacks. Missing providers or mismatched revisions fail before activation. Cloudflare refuses this feature until an explicit Worker implementation exists.

The demo provider in the test is a protocol fixture, not authentication suitable for deployment. Real auth and admin services live in separate packages and supply their own registries.
