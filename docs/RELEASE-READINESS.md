# Release readiness

A stable release means the package was published. It does **not** establish
production readiness, independent security assessment, hostile multi-tenant
isolation or support commitments. Use the runtime, schema and documentation from
the same pinned commit. Manifests and `npm run release:status` are the source of
current version and channel state.

## Evidence in the repository

- `npm run verify` checks lint, types, generated references and unit/real-HTTP
  behavior. `npm run test:package` exercises the packed artifact and starter.
- CI covers supported Node and operating-system combinations, package fidelity,
  the constrained container and workspace compatibility. A passing check covers
  only its tested behavior.
- Native routes do not execute project code unless middleware is attached.
  Functions and middleware are trusted Node code by default; `sandbox: true`
  opts into the bounded QuickJS/WASM path. Binding injection is externally
  granted and revision-pinned in either mode.
- URLCode is Apache-2.0. The portable YAML contract, supported handlers and
  target limits are defined by the [specification](SPECIFICATION.md) and
  [capabilities](CAPABILITIES.md), not this page.

## Gates before production approval

The deployment owner must record the workload, exact revisions, environment,
commands, results and an accountable owner for each open gate:

1. Independent review of the host and `sandbox: true` boundaries.
2. Sustained load and soak through the real TLS/ingress path, with workload SLOs,
   tail latency, rejection/error rate, RSS and recovery evidence.
3. Kill/restart, resource-exhaustion and deployment/rollback exercises using the
   chosen supervisor and ingress. Durable-state extensions own their own
   backup/restore proof.
4. Tested alerting and ownership for errors, latency, readiness, logs, disk and
   restart failures.
5. Any support, publication or provider commitments needed for the deployment.

[Operational proof](OPERATIONAL-PROOF.md) gives the deployment acceptance
record. [Sandbox review](SANDBOX-REVIEW.md) defines the independent-review gate.
[Development pipeline](DEVELOPMENT-PIPELINE.md) and
[release security](RELEASE-SECURITY.md) describe how candidates are built and
published. Dated registry checks, detailed source-review notes and superseded
release observations are private maintainer records, not current status.
