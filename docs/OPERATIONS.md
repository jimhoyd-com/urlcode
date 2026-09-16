# Running the alpha yourself

This is an early self-hosted runtime, not yet the complete stable release.
Deploy only workloads whose requirements fit the [implemented contract](SPECIFICATION.md).
Provider adapters, automatic TLS/DNS management, distributed rate limits,
metrics exporters and durable event delivery are not included.

## Process deployment

Install a reviewed URLCode commit with Node 22.13+ and `npm ci --omit=dev`.
Keep the runtime separate from an application checkout pinned to its own commit.
Functions support only relative project JavaScript modules; do not install or
execute an untrusted application’s package scripts as part of serving it. Validate using
the same injected environment as the serving process:

```sh
node /opt/urlcode/src/cli.js validate --project /srv/gitroll-link
node /opt/urlcode/src/cli.js serve --project /srv/gitroll-link \
  --host 127.0.0.1 --port 3000 --origin https://links.example.com
```

`--origin` defines the public URL seen by functions; proxy Host/X-Forwarded-*
headers are intentionally not trusted. Use a process supervisor that restarts on
failure and sends SIGTERM for shutdown. Shutdown stops accepting requests, gives
HTTP connections up to 10 seconds, and drains bounded in-flight functions.

Serve a read-only application tree where practical. The operator-owned runtime
account must be able to read application files/dependencies. Authoring happens
in development/CI, not by modifying a running replica's filesystem.

## Container deployment

The supplied image packages the runtime; it does not copy your application or
local secret files. Build from the reviewed runtime checkout:

```sh
docker build -t urlcode:local-alpha .
docker run --rm --name gitroll-link \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 512m --cpus 1 --pids-limit 128 \
  -p 127.0.0.1:3000:3000 \
  -v "$PWD/starters/default:/project:ro" \
  urlcode:local-alpha
```

Replace the example mount with your app. The image uses the unprivileged `node`
user; ensure mounted config/functions are readable by it. Apps needing writable
temporary files or additional dependencies must explicitly provide those mounts
or build them into their own app image. The resource values above illustrate
container limits, not a sizing recommendation; large configuration compilation
can need more memory. Measure your workload. Tag/redeploy immutable image digests
in real operation rather than treating a mutable tag as a rollback identity.

## Domains, HTTPS and exposure

Point your domain's DNS at the reverse proxy/load balancer you operate, terminate
HTTPS there, and forward to the loopback/private URLCode port. Use a tested proxy
such as your existing Caddy/nginx/load-balancer setup for certificates, connection
limits and rate limiting. No certificate automation is supplied by URLCode yet.
Keep direct backend access private. Restrict `/_urlcode/*` endpoints to operators
at the proxy; they are unauthenticated and reveal route count/config digest.

If functions perform sensitive actions, implement authentication and authorization
in the application. A short URL is not automatically an access-control mechanism.
Functions are untrusted and isolated in WASM by default. Keep separate deployment
processes/containers and narrowly scoped credentials as additional boundaries.
Do not expose a public code-upload/multi-tenant service on the basis of this alpha
without separate security review and stronger service-level containment.

## Secrets and rotation

Only `dev`, `test` and `validate --local` read `.env.local`. Authoring and
permissions inspection do not read credentials or execute functions. `serve` and
ordinary `validate` use process environment only. Resolve logical names from
your own secret store/supervisor and inject them at startup; direct provider
secret-store integrations remain future work. Bindings also require an external,
revision-pinned operator policy; see [setup](FUNCTION-SECURITY.md). Do not place secret values in
command-line arguments, route YAML, image layers or Git.

Check tracked files as well as ignore rules. Docker builds use an explicit
allowlist; npm artifacts include runtime/schema/starter/docs files only. Do not
build an application image by blindly copying its entire development directory.
Rotate a credential by replacing its injected value and restarting/redeploying;
production does not watch or refresh secret values automatically.

## Health, logs and limits

- `GET /_urlcode/health`: process liveness.
- `GET /_urlcode/ready`: 200 when the active snapshot and all function workers
  are available; 503 while a worker is unavailable. Busy workers alone do not
  mark readiness down. Replacement is bounded; recurring crashes need restart.
- Request logs: JSON request ID, status and duration. No URLs, query strings,
  headers, bodies, bindings or user exception text. Forward stdout to your log
  system and alert on sustained 5xx and latency. The default logger drops records
  when stdout buffering reaches 1 MiB and reports the dropped count when output
  recovers; alert on `logs_dropped`. Function console output is
  suppressed; app-specific diagnostics are not yet a first-class feature.
- HTTP: 8 KiB target, 16 KiB headers, 1 MiB buffered body, 15-second request
  receipt timeout, 10-second header timeout, 5-second keep-alive, 1,000 requests
  per socket and 1,024 active connections. Proxy timeouts/rate limits still matter.
- Functions: 2 concurrent workers, no queue, 5-second deadline, 1 MiB buffered
  response and 16 KiB response headers. Saturation 503; timeout 504; error 502.
  QuickJS guests have a 32 MiB heap and 512 KiB stack budget and no network or
  host capabilities. Outer workers have additional V8 limits. Total process/WASM
  memory still needs deployment-level limits; do not equate guest budget with RSS.

The JavaScript server API can configure workers, deadlines and byte limits;
these are deployment controls, not portable route behavior. Horizontal replicas
must use identical application/config versions and secret bindings. In-memory
function state is reset after every invocation, not durable/shared application state.
Use explicit application storage when a business needs that guarantee.

The health version hashes route definitions only. Record runtime commit,
application commit, dependency locks and image digest in your deployment system.

## Deployment and rollback procedure

1. Build a candidate from pinned runtime/application revisions and lockfiles.
2. Validate its config/bindings and run local HTTP tests without external redirects.
3. Start it on an alternate private port/container. Check readiness and representative
   redirect/function behavior through the intended proxy configuration.
4. Switch proxy traffic after checks pass. Drain the previous instance before stopping.
5. If checks or observed behavior fail, route traffic back to the retained previous
   instance/image and its compatible secret bindings.

This is an operator procedure, not an implemented deployment control plane.
Rollback cannot undo a function's external side effects or migrate an app's
state automatically. Plan those independently. Keep Git definitions backed up;
back up any app-owned persistent state separately. No routing database is required.

## Remaining production validation

Before a stable release: sustained soak/load tests on deployment hardware,
independent security review, failure/restart drills, upgrade/rollback exercises,
clear support/reporting policy, broader operational metrics, business starter,
and tested provider adapters. See [roadmap](../ROADMAP.md). No claim of high
availability, zero downtime or provider portability beyond the Node process
adapter is made by this alpha.
