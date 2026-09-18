# Provider conformance and deployment evidence

The synthetic project in [`examples/provider-conformance`](../examples/provider-conformance)
exercises the common declarative runtime subset: redirect status/location, dropped
incoming queries, validated mapped queries, encoded path components, constant
responses, HEAD, method refusal, request-body limits and missing routes. It has
no bindings, function code, customer data or provider infrastructure configuration.

`test/provider-verification.test.ts` replays the same 12 versioned cases through
an actual local self-hosted HTTP server, a local Vercel Node handler, AWS payload
v2 and a freshly built Cloudflare artifact. This establishes local adapter
behavior only. It does not exercise provider ingress, deployment configuration,
TLS termination, production DNS, scaling or provider accounts.

## Record a deployment observation

First deploy the synthetic fixture into a disposable environment you own using
the [AWS](AWS.md), [Vercel](VERCEL.md) or [Cloudflare](CLOUDFLARE.md) adapter. Do not point this runner at a
third-party service or an unrelated production application: it sends three POST
requests to fixture paths, whose declared behavior has no side effects.

```js
import { verifyProviderDeployment } from '@jimhoyd/urlcode';
const evidence = await verifyProviderDeployment(
  'vercel',
  'https://your-owned-fixture.example',
  { timeoutMs: 3000, gitCommit: 'your-commit-id', release: 'your-release-id' }
);
console.log(JSON.stringify(evidence, null, 2));
if (!evidence.pass) process.exitCode = 1;
```

The CLI form is `urlcode verify-provider --target vercel --origin https://owned-fixture.example [--timeout-ms 3000] [--release label] [--git-commit sha]`, where `--release` and `--git-commit` are the caller-supplied labels recorded in the report and `--timeout-ms` is the per-request deadline.

Targets are `self-hosted`, `aws`, `vercel` and `cloudflare`. The caller must supply
an HTTPS origin without credentials, path, query or fragment. TLS verification
is mandatory. The runner does not provision resources, read credentials, follow
redirects or fetch redirect destinations. Every request has an absolute deadline
(default 3 seconds, configurable 50–10,000 ms); the suite has a 60-second deadline.
Responses stop at 64 KiB and headers at 16 KiB. It sends at most 12 requests,
sequentially, using identity encoding. Timeout, oversized body and TLS failures
produce failed findings. Reports include no arbitrary response body/header data.

`runProviderConformance(target, transport, options)` supports local adapter
replays through an explicit callback. The transport receives an AbortSignal;
callbacks must honor it to release their own resources. The runner can bound
waiting for a custom callback, but cannot terminate arbitrary caller code.
Its report always says `evidence: "local-adapter"` and
`providerVerification: "unverified"`.

## Evidence interpretation

Reports have `schemaVersion: 1`, `fixtureVersion: 1`, target, origin, timestamp,
a fixture-case SHA-256, caller-supplied release/Git labels, request count, overall
`pass` and a finding for every case. Findings report expected/observed status
and which assertion failed. The case digest identifies probe expectations;
it is not an artifact or deployed configuration digest.

Live HTTP reports say `evidence: "deployment-http"` and
`providerVerification: "observed"`, including failed attempts. **Observed does
not mean passing**: inspect `pass` and every finding. Target/provider identity,
ownership and release labels are caller assertions, not independent attestation.
Save reports alongside a Git revision and deployment identity in the operator's
release records; review origins and labels before publishing them.

No real AWS, Vercel or Cloudflare deployment evidence is checked in. Provider
provisioning and deployment verification remain pending operator-owned accounts
and explicit deployment URLs. CI passing must never be reported as an actual
provider deployment result, independent security review, or soak/recovery proof.

## Remaining transport differences

AWS payload v2 coalesces repeated header values; its adapter conservatively
interprets comma-separated non-cookie headers as repeats. Vercel's local Node
adapter can observe raw header counts; real ingress may normalize first.
Cloudflare's Fetch interface can expose already-coalesced values and normalized
URLs. Encoded slashes, malformed URL syntax, repeated scalar headers and multiple
Set-Cookie delivery require target-specific edge checks beyond this common suite.
The local adapter regression suites retain those implementation-level checks.

This fixture intentionally has no policy settings. A passing common-subset
report does not establish compression, distributed throttling, caching, agent
policy updates or project-specific guarantees. Use project-specific deployment
verification and production operational checks in addition to this small suite.
