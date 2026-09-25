# Deploying to Vercel

The Vercel adapter runs a URLCode project as a Node function. The same
`urlcode.yaml` that runs locally or in a container serves the deployment —
that is the point of the project format.

**This adapter serves native handlers only:** redirects, validated responses,
pages, static assets and downloads. `function` and `middleware` routes are
refused at activation, trusted or sandboxed alike, not per request, so a deployment cannot
half-work, and that is a settled position rather than a pending limitation. See
[what is not supported](#what-this-adapter-does-not-do).

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

If the deployment also answers on other origins, list them in the
`aliasOrigins` option or `URLCODE_ALIAS_ORIGINS` (comma-separated `https:`
origins, at most 16). Extensions' same-origin checks admit them beside the
canonical origin; generated URLs keep the canonical one. An invalid entry fails
activation. See [site origins](EXTENSIONS.md#site-origins-and-same-origin-checks).

## What this adapter does not do

| Not supported | Why |
|---|---|
| `function` routes | They need the self-hosted Node lifecycle; a `sandbox: true` route would additionally spawn worker threads and load the WASM engine on every cold start. Correctness is not the issue; the execution model is — per-route compilation was considered and declined. |
| Middleware | Runs in the same execution mode as the route's function, and is refused with it. |
| `urlcode serve` operational endpoints | `/_urlcode/health` and `/_urlcode/ready` describe a long-lived process. Use Vercel's own observability. |

Each refusal happens at activation with a message naming the route, so you find
out on deploy rather than on a request.

`function` and `middleware` are not coming to this adapter. The supported answer
is to deploy the project as one trusted Node process — a container or a VM
running the project as it runs locally — which supports every route type today,
on any host you like including AWS (ECS, EC2, App Runner). See
[the decision](OPEN-DECISIONS.md#accepted-one-node-deployment-per-project).

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
