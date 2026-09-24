# Running URLCode yourself

This is the self-hosted runtime. Its deliberately bounded feature set
is not a claim of suitability for every production workload. Deploy only workloads
whose requirements fit the [implemented contract](SPECIFICATION.md).
`--metrics` serves Prometheus text at `/_urlcode/metrics` ([monitoring](MONITORING.md));
automatic TLS/DNS management, distributed rate limits, push-based metrics
exporters and durable event delivery are not included. For provider adapters see
[remaining production validation](#remaining-production-validation).

## Process deployment

Install a reviewed URLCode commit with Node 22.13+ and `npm ci --omit=dev`.
Keep the runtime separate from an application checkout pinned to its own commit.
Functions support only relative project JavaScript modules; do not install or
execute an untrusted application’s package scripts as part of serving it. Validate using
the same injected environment as the serving process:

```sh
node /opt/urlcode/dist/cli.js validate --project /srv/my-links
node /opt/urlcode/dist/cli.js serve --project /srv/my-links \
  --host 127.0.0.1 --port 3000 --origin https://links.example.com
```

`--origin` defines the public URL seen by functions; proxy Host/X-Forwarded-*
headers are intentionally not trusted. Use a process supervisor that restarts on
failure and sends SIGTERM for shutdown. On SIGTERM, `/_urlcode/ready` starts
reporting unhealthy for `--drain-delay-ms` (default `0`, disabled) before the
listener stops accepting new connections — set this to give a load balancer
time to notice and stop routing here; `/_urlcode/health` (liveness) stays
healthy throughout so a supervisor does not restart a process that is
deliberately draining. Once the listener stops accepting connections, HTTP
connections get up to `--close-timeout-ms` (default `10000`) to finish before
being forced closed, and bounded in-flight functions drain. Set
`--close-timeout-ms` (plus `--drain-delay-ms`) below your process
supervisor's stop grace period — Docker's `--stop-timeout`/`stop_grace_period`,
Kubernetes' `terminationGracePeriodSeconds` — or the process can be SIGKILLed
mid-drain, before observers and stores flush. `--headers-timeout-ms` (default
`10000`), `--request-timeout-ms` (default `15000`) and
`--keep-alive-timeout-ms` (default `5000`) bound how long a connection may sit
idle at each stage; keep them ahead of any reverse proxy's own timeouts.

Serve a read-only application tree where practical. The operator-owned runtime
account must be able to read application files/dependencies. Authoring happens
in development/CI, not by modifying a running replica's filesystem.

## Container deployment

The supplied image packages the runtime; it does not copy your application or
local secret files. Build from the reviewed runtime checkout:

```sh
docker build -f packaging/container/Dockerfile -t urlcode:local .
docker run --rm --name my-links \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 512m --cpus 1 --pids-limit 128 \
  --stop-timeout 10 \
  -p 127.0.0.1:3000:3000 \
  -v "$PWD/starters/default:/project:ro" \
  urlcode:local
```

Replace the example mount with your app. The image uses the unprivileged `node`
user; ensure mounted config/functions are readable by it. Core has no writable
mount of its own; a future mount-based extension (like `auth`/`admin`, see
[extensions](EXTENSIONS.md)) is the place for operator-owned writable state.
The image listens on `$PORT` (default `3000`, read by both the CLI's default
and its `HEALTHCHECK`); set `-e PORT=8080` and publish that port instead of
editing the image's `CMD`. `--stop-timeout` is Docker's own grace period
before SIGKILL (`docker stop` also accepts `-t`); keep it at or above
`--close-timeout-ms`/`--drain-delay-ms` (see [process deployment](#process-deployment)),
which the image's `CMD` does not currently set explicitly and so uses their
defaults.
Sandboxed application functions cannot access mounted files or installed
Node packages. The resource values above illustrate
container limits, not a sizing recommendation; large configuration compilation
can need more memory. Measure your workload. Tag/redeploy immutable image digests
in real operation rather than treating a mutable tag as a rollback identity.

## Domains, HTTPS and exposure

Point your domain's DNS at the reverse proxy/load balancer you operate, terminate
HTTPS there, and forward to the loopback/private URLCode port. Use a tested proxy
such as your existing Caddy/nginx/load-balancer setup for certificates, connection
limits and rate limiting. No certificate automation is supplied by URLCode yet.
Keep direct backend access private. Restrict `/_urlcode/*` endpoints to operators
at the proxy; they are unauthenticated. `/_urlcode/health` and `/_urlcode/ready`
return only `{"status":...}` by default; pass `--health-details` (or `--metrics`,
which implies it) to also include the build version and route count, and keep
that behind the proxy restriction above if you do. `/_urlcode/metrics`, when
enabled with `--metrics`, is Prometheus text and is unauthenticated by the same
rule.

If functions perform sensitive actions, implement authentication and authorization
in the application. A short URL is not automatically an access-control mechanism.
Functions and middleware run trusted and unsandboxed by default, in the host
process with full Node, filesystem and network access; a route that declares
`sandbox: true` runs isolated in QuickJS/WebAssembly instead (see
[function security](FUNCTION-SECURITY.md)). Keep separate deployment
processes/containers and narrowly scoped credentials as additional boundaries.
Do not expose a public code-upload/multi-tenant service on the basis of the self-hosted release alone
without separate security review and stronger service-level containment.

## Secrets and rotation

`dev`, `test`, `routes`, `audit`, `benchmark` and `validate --local` read
`.env.local`. Authoring and
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
  are available; 503 while a worker
  is unavailable. Busy workers alone do not
  mark readiness down. A failed worker is replaced with
  exponential backoff (250 ms doubling to a 30-second ceiling) and readiness
  reports 503 until every slot is serving again. Replacement does not stop, so a
  request-triggered deadline cannot disable functions until an operator restarts;
  a cause that keeps recurring keeps the instance shedding load and needs an
  operator. Alert on sustained `function_worker` restart events.
- Probes are answered from their own admission budget (16 by default,
  `--max-in-flight-health`), so they stay available while the application is
  saturated without being an unmetered endpoint. They are unauthenticated and
  report the configuration digest and route count: keep them on an internal
  interface or restrict them at the ingress.
- Request logs: JSON request ID, status and duration. No URLs, query strings,
  headers, bodies, bindings or user exception text. `--request-log detailed` adds
  the request method and the matched route pattern (`/u/{id}`, or `null` when
  nothing matched). Both come from the reviewed configuration, never from
  request-supplied path, parameter or query text, which is what makes per-route
  error rates and latency available without logging user data.
- `--debug-errors` (off by default) writes the route, source file, thrown
  message and stack behind a trusted function's generic 502/504, and the
  message of a rejected reload, to stderr. Thrown text can contain whatever the
  function put in it, including request data, so enable it to diagnose, not as
  a standing setting, and keep stderr as private as the host.
- Request IDs are generated per request and returned in `x-request-id`. An
  inbound `x-request-id` is ignored unless `--trust-request-id` is set, which is
  only correct when a trusted proxy sets the header and strips client-supplied
  copies; untrusted values are still rejected unless they are a single header of
  at most 128 characters from `[A-Za-z0-9_.:-]`. Forward stdout to your log
  system and alert on sustained 5xx and latency. The default logger drops records
  when stdout buffering reaches 1 MiB and reports the dropped count when output
  recovers; alert on `logs_dropped`. Function console output is
  suppressed; app-specific diagnostics are not yet a first-class feature.
  Synchronous and asynchronous sink failures are contained; a failed sink drops
  subsequent output and needs operator recovery. Collectors own rotation/retention.
- HTTP: 8,192-character target, 16 KiB headers, 1 MiB buffered body, 15-second request
  receipt timeout, 10-second header timeout, 5-second keep-alive, 1,000 requests
  per socket and 1,024 active connections. At most 64 application requests are
  admitted through response completion; excess requests receive 503. Health probes
  remain available under admission saturation. A 15-second socket inactivity
  timeout closes stalled readers/writers. Proxy timeouts/rate limits still matter.
- Functions: a `sandbox: true` route gets 2 concurrent workers (`--workers`),
  no queue and a 5-second deadline (`--function-timeout-ms`); a trusted route
  (`sandbox` false or absent, the default) shares the in-flight admission cap
  instead of a worker pool and races the same deadline. Either mode buffers
  1 MiB of response (`--max-response-bytes`) and 16 KiB response headers.
  Saturation 503; timeout 504; error 502.
  QuickJS guests have a 32 MiB heap and 512 KiB stack budget and no network or
  host capabilities; a trusted route has neither budget and full Node access.
  Outer workers have additional V8 limits. Total process/WASM
  memory still needs deployment-level limits; do not equate guest budget with RSS.

`urlcode serve`/`dev` and the JavaScript server API both configure workers,
deadlines and byte limits: `--workers`, `--function-timeout-ms`,
`--max-response-bytes`, `--max-body-bytes`, `--max-in-flight` and
`--max-in-flight-health`. Set them on the container command line; these are
deployment controls, not portable route behavior. Horizontal replicas
must use identical application/config versions and secret bindings. In-memory
function state is reset after every invocation, not durable/shared application state.
General application storage needs a future explicit capability broker; no
storage/network access is exposed to the guest. Core no longer has a native
link store, and the `urlcode-dynamic-link` extension package that replaced it
has been retired and unpublished.

The health version combines route-definition and asset-representation digests;
it does not identify the complete function/runtime release. Record runtime commit,
application commit, dependency locks and image digest in your deployment system.

## Deployment and rollback procedure

1. Build a candidate from pinned runtime/application revisions and lockfiles.
2. Validate its config/bindings and run local HTTP tests without external redirects.
3. Start it on an alternate private port/container. Check readiness and representative
   redirect/function behavior through the intended proxy configuration:
   `urlcode verify-deployment --project . --target https://candidate.host` compares
   version, fixtures, policy headers and site files with the project
   ([deployment checks](DEPLOYMENT-CHECKS.md)).
4. Switch proxy traffic after checks pass. Drain the previous instance before stopping.
5. If checks or observed behavior fail, route traffic back to the retained previous
   instance/image and its compatible secret bindings.

This is an operator procedure, not an implemented deployment control plane.
Rollback cannot undo a function's external side effects or migrate an app's
state automatically. Plan those independently. Keep Git definitions backed up;
back up any app-owned persistent state separately. YAML routes require no database.

## Capacity and incident planning

See [capacity and concurrency](CAPACITY.md) for hard limits, worker occupancy,
no-queue rejection, memory/reload budgets and theoretical sizing. See
[DDoS and recovery](RESILIENCE.md) for ingress responsibilities, incident response,
rollback/restore procedures, recovery objectives and drills.

See the [release-readiness register](RELEASE-READINESS.md) for evidence and open gates.

## Remaining production validation

Before approving a production deployment: run sustained soak/load tests on its
hardware, obtain independent security review, exercise failure/restart and
upgrade/rollback, establish a clear support/reporting policy, and add the needed
operational metrics. The Vercel, AWS, Cloudflare and static adapters ship with
local conformance tests only; none has been exercised on its provider yet (see
[capabilities](CAPABILITIES.md)). See [roadmap](../ROADMAP.md). No claim of high
availability, zero downtime or provider portability beyond the Node process
adapter is made by the current release.

## Security review

The detailed 2026-09-16 internal audit is private maintainer material; it was
not an independent assessment. The public security and assessment boundaries
remain in [SECURITY.md](../SECURITY.md) and [the sandbox review](SANDBOX-REVIEW.md).
