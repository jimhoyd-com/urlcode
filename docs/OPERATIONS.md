# Running URLCode yourself

This is the stable 0.1 self-hosted runtime. Its deliberately bounded feature set
is not a claim of suitability for every production workload. Deploy only workloads
whose requirements fit the [implemented contract](SPECIFICATION.md).
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
docker build -t urlcode:0.1.0 .
docker run --rm --name gitroll-link \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 512m --cpus 1 --pids-limit 128 \
  -p 127.0.0.1:3000:3000 \
  -v "$PWD/starters/default:/project:ro" \
  urlcode:0.1.0
```

Replace the example mount with your app. The image uses the unprivileged `node`
user; ensure mounted config/functions are readable by it. Only operator-owned components such as the optional link store can use writable
mounts. Sandboxed application functions cannot access mounted files or installed
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
at the proxy; they are unauthenticated and reveal route count/config digest.

If functions perform sensitive actions, implement authentication and authorization
in the application. A short URL is not automatically an access-control mechanism.
Functions are untrusted and isolated in WASM by default. Keep separate deployment
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
  are available and configured link-store readers are healthy; 503 while a worker/store
  is unavailable. Busy workers alone do not
  mark readiness down. A failed worker or store connection is replaced with
  exponential backoff (250 ms doubling to a 30-second ceiling) and readiness
  reports 503 until every slot is serving again. Replacement does not stop, so a
  request-triggered deadline cannot disable functions until an operator restarts;
  a cause that keeps recurring keeps the instance shedding load and needs an
  operator. Alert on sustained `function_worker`/`link_store_worker` restart events.
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
- Functions: 2 concurrent workers (`--workers`), no queue, 5-second deadline
  (`--function-timeout-ms`), 1 MiB buffered response (`--max-response-bytes`) and
  16 KiB response headers. Saturation 503; timeout 504; error 502.
  QuickJS guests have a 32 MiB heap and 512 KiB stack budget and no network or
  host capabilities. Outer workers have additional V8 limits. Total process/WASM
  memory still needs deployment-level limits; do not equate guest budget with RSS.

`urlcode serve`/`dev` and the JavaScript server API both configure workers,
deadlines and byte limits: `--workers`, `--function-timeout-ms`,
`--max-response-bytes`, `--max-body-bytes`, `--max-in-flight` and
`--max-in-flight-health`. Set them on the container command line; these are
deployment controls, not portable route behavior. Horizontal replicas
must use identical application/config versions and secret bindings. In-memory
function state is reset after every invocation, not durable/shared application state.
General application storage needs a future explicit capability broker; no
storage/network access is exposed to the guest. The optional native
[link store](DYNAMIC-LINKS.md) supports live short-link records on one host.

The health version combines route-definition and asset-representation digests;
it does not identify the complete function/runtime release. Record runtime commit,
application commit, dependency locks and image digest in your deployment system.

## Optional dynamic-link deployment

Keep SQLite and management tokens outside the application, in a private durable
local directory. Initialize through `links init/create`, bind public serving with
`--link-store`, and expose management on a separate private listener. Restrict
its token to your trusted backend; apply ingress limits and backups. Public
serving opens read-only pools; management has a separate writer and read pool.
Budget connections across processes and monitor writer health separately. See
[dynamic-link operations](DYNAMIC-LINKS.md). Multiple host replicas must not share
this file over a network filesystem; no distributed adapter is included yet.

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
back up any app-owned persistent state separately. YAML routes require no database; dynamic link records require separate backups.

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
operational metrics. Provider adapters remain separate roadmap work. See
[roadmap](../ROADMAP.md). No claim of high
availability, zero downtime or provider portability beyond the Node process
adapter is made by the current release.

## Security review

The [2026-09-16 internal audit](SECURITY-AUDIT.md) records fixes, regression evidence
and remaining security/operational gates. This is not an independent assessment.

## Management hardening baseline

Management is now restricted to literal loopback addresses. Prefer `--auth-file`
for individual expiring, revocable credentials with collection/action scopes.
Every successful built-in store mutation has an atomic, durable SQLite audit row;
HTTP request logs remain best effort. See [management security](MANAGEMENT-SECURITY.md)
for policy examples, compatibility, archival and rollback requirements, and
[operational proof](OPERATIONAL-PROOF.md) for executable recovery drills.
