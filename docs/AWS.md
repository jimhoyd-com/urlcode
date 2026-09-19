# Deploying to AWS Lambda

The AWS adapter runs a URLCode project as a Lambda function behind a **Function
URL** or an **API Gateway HTTP API**. The same `urlcode.yaml` that runs locally
or in a container serves the deployment.

**This adapter serves native handlers only** — redirects, validated responses,
pages, static assets and downloads — for the same reasons as
[the Vercel adapter](VERCEL.md): functions and middleware would pay worker and
WASM startup on every cold start. Both are refused at activation with the route
named, never per request.

A working project is in [`examples/aws/`](../examples/aws/).

## Set it up

```js
// handler.mjs
import { createLambdaHandler } from '@jimhoyd/urlcode/aws';

export const handler = createLambdaHandler({ project: process.env.LAMBDA_TASK_ROOT });
```

The deployment package must contain every file the project reads: the entry
YAML, any `includes`, and every page, download and static directory. They are
read at activation, so a missing one fails the deployment rather than one route.
Node 22.13 or newer.

## Payload format 2.0 only

Function URLs and API Gateway **HTTP APIs** send payload format 2.0, which
carries `rawPath` and `rawQueryString` — the request as it arrived.

A **REST API** sends format 1.0, which supplies the path and query already
decoded. The original bytes cannot be recovered from them, and this runtime
rejects ambiguous encoding deliberately: rebuilding a target from decoded parts
would either re-encode differently than the client sent or quietly accept what
the runtime refuses. Rather than guess, the adapter refuses a 1.0 event and says
why. Front the function with an HTTP API, or run the container image with
`urlcode serve`.

## Bindings and origin

`URLCODE_POLICY` carries the same grant document the operator policy file holds,
validated identically including the `projectSha256` pin — see
[the Vercel guide](VERCEL.md#bindings), which describes the same mechanism.
Store it in the function's environment, or fetch it from Secrets Manager and set
it before the handler is created.

`URLCODE_PUBLIC_HOST` sets the public hostname for generated URLs. Lambda has no
platform variable naming your domain, so unlike Vercel there is nothing to infer
from: set it when a custom domain or an API Gateway stage prefix is in play.
Forwarded headers stay untrusted.

## Limits worth knowing before you deploy

| Limit | Consequence |
|---|---|
| Lambda response payload is 6 MB | A larger asset cannot be returned. The runtime allows 16 MB per asset, so a project valid self-hosted can exceed what Lambda can send. Keep large files in object storage and redirect to them. |
| Response bodies are base64-encoded | Guessing whether a body is text is how binary assets get corrupted, so every response is encoded. Base64 inflates by about a third, against that 6 MB ceiling. |
| Each execution environment activates independently | Parsing, asset snapshotting and route compilation happen per cold start, and the [capacity limits](CAPACITY.md) apply per instance: a 64 MiB snapshot is 64 MiB in every concurrent one. |
| No reload | A deployment serves the revision it was packaged from. Ship a change by deploying. |
| No `/_urlcode/health` or `/_urlcode/ready` | Those describe a long-lived process. Use Lambda's own metrics; the [monitoring recipes](MONITORING.md) that parse stdout records need adapting for CloudWatch, though the record fields are the same. |

## Verification status

The adapter is tested against the self-hosted runtime for identical status, body
and headers across redirects, parameters, responses, pages, static files and
misses; for format 1.0 and malformed events being refused; for base64 request
bodies and route body policy; for cookies arriving and leaving through the
format 2.0 array; and for the policy pin.

**It has not been deployed to AWS.** The tests drive the real handler with real
payload format 2.0 events, but no invocation on Lambda has happened. Treat
package contents, cold-start latency, API Gateway's own header handling and the
6 MB ceiling as unverified until you deploy the example and see it work.
