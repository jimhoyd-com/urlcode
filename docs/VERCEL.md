# Deploying to Vercel

The Vercel adapter runs a URLCode project as a Node function. The same
`urlcode.yaml` that runs locally or in a container serves the deployment —
that is the point of the project format.

**This adapter serves native handlers only:** redirects, validated responses,
pages, static assets and downloads. Isolated functions, middleware and stored
live links are refused at activation, not per request, so a deployment cannot
half-work. See [what is not supported](#what-this-adapter-does-not-do).

A working project is in [`examples/vercel/`](../examples/vercel/).

## Set it up

```js
// api/index.js
import { createVercelHandler } from '@jimhoyd/urlcode/vercel';

export default createVercelHandler({ project: process.cwd() });
```

```json
{
  "functions": {
    "api/index.js": {
      "runtime": "nodejs22.x",
      "includeFiles": "{urlcode.yaml,routes/**,public/**}"
    }
  },
  "rewrites": [{ "source": "/(.*)", "destination": "/api" }]
}
```

Two details decide whether this works:

- **`includeFiles`** must cover every file the project reads: the entry YAML,
  any `includes`, and every page, download and static directory. They are read
  at activation, so a missing one fails the whole deployment rather than one
  route. Node 22.13 or newer is required.
- **The rewrite** sends every path to the handler, because URLCode owns routing.
  Anything you leave outside it is served by Vercel, not by your project.

## Bindings

A self-hosted deployment grants `env` and `secrets` through an operator policy
file outside the project. Vercel has no such place, so the adapter reads the
same document from the **`URLCODE_POLICY`** environment variable:

```sh
urlcode permissions --project .        # prints the grant document
vercel env add URLCODE_POLICY          # paste it
```

It is validated exactly as the file is, including the `projectSha256` pin — so a
policy issued for one revision does not activate another. Change a route or a
binding and the grant must be reissued, which is the intended friction. The
values themselves are ordinary Vercel environment variables; the policy decides
which routes may read them.

## Origin

Functions and absolute URLs see the origin the adapter resolves, in order:
the `origin` option, `URLCODE_ORIGIN`, then Vercel's own
`VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_URL` or `VERCEL_BRANCH_URL`. Those are
platform-set, not client-supplied — forwarded headers stay untrusted here as
everywhere else. Set `URLCODE_ORIGIN` explicitly when you serve a custom domain
and want it in generated URLs.

## What this adapter does not do

| Not supported | Why |
|---|---|
| Isolated functions | Every cold start would spawn worker threads and load the WASM engine. Correctness is not the issue; predictable latency is, and it is unmeasured. |
| Middleware | Runs in the same sandbox as functions. |
| Stored live links | SQLite needs a durable writable file. A serverless filesystem is ephemeral and per-instance, so records would silently diverge between instances. |
| `urlcode serve` operational endpoints | `/_urlcode/health` and `/_urlcode/ready` describe a long-lived process. Use Vercel's own observability. |

Each refusal happens at activation with a message naming the route, so you find
out on deploy rather than on a request.

## Operating it

Every instance activates the project independently: parsing YAML, snapshotting
assets and compiling routes on each cold start. Keep asset snapshots small — the
[capacity limits](CAPACITY.md) apply per instance, and a 64 MiB snapshot is 64
MiB in every concurrent instance.

There is no reload: a deployment serves the revision it was built from, which is
what you want from immutable deployments. Ship a change by deploying.

Logs go to Vercel's collector rather than to a stdout stream you control, so the
[monitoring recipes](MONITORING.md) that parse JSON records need adapting;
the record fields are the same.

## Verification status

The adapter is tested against the self-hosted runtime for byte-identical status,
body and headers across redirects, parameters, responses, pages, static files
and misses, and for refusing unsupported handlers, enforcing the policy pin and
bounding request bodies.

**It has not been deployed to Vercel.** Those tests drive the real handler over
a real Node request, which is the shape Vercel invokes, but no run on the
platform has happened. Treat `includeFiles` coverage, cold-start latency and
custom-domain behaviour as unverified until you deploy the example and see it
work.
