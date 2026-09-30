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
A `sandbox: true` function imports only relative project modules. A trusted
function resolves packages from the application's `node_modules` like any Node
module, so install the application's dependencies from its lockfile. Do not
install or execute an untrusted application’s package scripts as part of
serving it (`npm ci --ignore-scripts`). Validate using
the same injected environment as the serving process:

```sh
node /opt/urlcode/dist/cli.js validate --project /srv/my-links
node /opt/urlcode/dist/cli.js serve --project /srv/my-links \
  --host 127.0.0.1 --port 3000 --origin https://links.example.com
```

`--origin` defines the public URL seen by functions; proxy Host/X-Forwarded-*
headers are intentionally not trusted. On a loopback bind the `Host` header is
also checked against the loopback names, `--origin` and any `--alias-origin`
([host admission](#host-admission-on-a-loopback-bind)).

When the same deployment also answers on other origins (an apex and `www`, or a
second domain), list each with a repeatable `--alias-origin`:

```sh
node /opt/urlcode/dist/cli.js serve --project /srv/my-links --origin https://links.example.com \
  --alias-origin https://www.links.example.com --alias-origin https://go.example.net
```

It is one operator-set, site-wide list, never project YAML. Every extension's
same-origin check (`mcp`, `store`, `auth`) admits an alias
origin exactly as it admits `--origin`; everything that builds an absolute URL
(redirects, sitemaps, emails, links, HSTS) keeps using `--origin`. Startup
refuses an entry that is not an `https:` origin (loopback `http:` is allowed),
that carries a path, query, fragment, credentials or `*`, more than 16 entries,
or aliases without `--origin`. The same list goes to `validate`, `test`,
`routes` and `audit`; the AWS and Vercel handlers take an
`aliasOrigins` option or `URLCODE_ALIAS_ORIGINS` (comma-separated). See
[site origins](EXTENSIONS.md#site-origins-and-same-origin-checks).

Use a process supervisor that restarts on
failure and sends SIGTERM for shutdown. On SIGTERM, `/_urlcode/ready` starts
reporting unhealthy for `--drain-delay-ms` (default `0`, disabled) before the
listener stops accepting new connections — set this to give a load balancer
time to notice and stop routing here; `/_urlcode/health` (liveness) stays
healthy throughout so a supervisor does not restart a process that is
deliberately draining. Once the listener stops accepting connections, HTTP
connections get up to `--close-timeout-ms` (default `10000`) to finish before
being forced closed, and bounded in-flight functions drain. Open
[streamed responses](#streamed-responses) get the same grace to finish and
are then ended (end reason `shutdown`) just before the remaining connections
are closed. A `sandbox: true`
worker still starting at shutdown (for example a replacement after a guest
deadline) is allowed to finish starting, for at most its 5-second
initialization timeout, before it is stopped. Set
`--close-timeout-ms` (plus `--drain-delay-ms`) below your process
supervisor's stop grace period — Docker's `--stop-timeout`/`stop_grace_period`,
Kubernetes' `terminationGracePeriodSeconds` — or the process can be SIGKILLed
mid-drain, before observers and stores flush. `--headers-timeout-ms` (default
`10000`), `--request-timeout-ms` (default `15000`) and
`--keep-alive-timeout-ms` (default `5000`) bound how long a connection may sit
idle at each stage; keep them ahead of any reverse proxy's own timeouts.

A site with extensions also passes its operator host, and the host must be
pinned to the reviewed project revision. Give the command the reviewed
operator policy as well and the pin comes from it:

```sh
node /opt/urlcode/dist/cli.js serve --project /srv/site/app --origin https://links.example.com \
  --host-file /srv/site/host.mjs --policy /etc/urlcode/policy.json
```

When a command (`serve`, `dev`, `validate`, `test`, `routes`,
`audit`) receives both `--policy` and `--host-file`, core validates the
policy and hands its `projectSha256` to `composeHost()` as the host revision
pin; no `PROJECT_SHA256` export and no script that parses the policy is
needed. Only that revision reaches the host (as each `host()` hook's
`context.projectSha256`); the grants stay with core, and project YAML can
never supply the pin. `PROJECT_SHA256` still works on its own; if it is set
alongside `--policy` it must equal the policy's revision or the command
refuses with `code` `revision-pin-mismatch`. A policy for a different project
revision refuses once the host registers an extension, and without either
source `composeHost()` refuses as before. A policy holding no grants yet is
`{"version": 1, "projectSha256": "<revision>", "routes": {}}`. The AWS and
Vercel handlers do not load a host file; operator code that builds their
`extensions` with `composeHost()` still sets `PROJECT_SHA256`, and their
`URLCODE_POLICY` pin is checked against the project as before.

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
  -v "$PWD/starters/default/app:/project:ro" \
  urlcode:local
```

Replace the example mount with your route project (a site's `app/` directory). The image uses the unprivileged `node`
user; ensure mounted config/functions are readable by it. Core has no writable
mount of its own; operator-owned writable state of an extension (auth's
`data/auth.sqlite`, the store's `data/store.sqlite`, see
[extensions](EXTENSIONS.md)) lives beside `host.mjs`, outside the read-only
route project.
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

## Hosting URLCode inside another framework

A Node application built on another framework (Hono, a plain `node:http`
server, anything that speaks fetch `Request`/`Response`) can host a URLCode
project in-process. `createEmbeddedHandler` from `@jimhoyd/urlcode` turns a
runtime into a fetch handler that answers exactly as `urlcode serve` does for
the same project: the same request reading, client resolution, body limits,
error format and response rules, from the same code.
[proofs/ecosystem](../proofs/ecosystem/README.md) does this with Hono and is
the executable check.

```js
import { createRuntime, createEmbeddedHandler } from '@jimhoyd/urlcode';

// Activates the whole project, or refuses it, before the host listens.
const runtime = await createRuntime(project, { origin, extensions, plugins, permissions });
const urlcode = createEmbeddedHandler(runtime, {
  origin,                          // the public origin; see below
  trustedProxies: ['10.0.0.0/8'],  // as --trusted-proxies
  basePath: '/app',                // only behind a prefix-stripping mount
});
// Per request, with what the host knows about the connection:
const response = await urlcode(request, { peer: socket.remoteAddress, rawHeaders: incoming.rawHeaders });
// On shutdown, after the host's own server has closed:
await runtime.close();
```

With Hono on `@hono/node-server`, `peer` and `rawHeaders` are
`c.env.incoming.socket.remoteAddress` and `c.env.incoming.rawHeaders`.

Options:

- `origin`: what a request sees as its own origin (a function's
  `request.url`, conditions, policies). Omitted, it is the incoming Request
  URL's origin, which a Node host builds from the client's `Host` header. Set
  it for a public site, as `--origin` is set for `urlcode serve`.
- `maxBodyBytes` (default 1048576): the request body limit before a route's
  own `request.body.<METHOD>.maxBytes`, as `--max-body-bytes`.
- `trustedProxies`: the peers allowed to speak for a client, as
  `--trusted-proxies`. A request from one of them that carries exactly one
  `X-Forwarded-For` header is attributed to the first untrusted address from
  the right; from any other peer, or with the header repeated, the `peer` is
  the client. Without `peer` the client is unknown.
- `headerLines` (default `provided`): each call passes the original header
  lines as `rawHeaders` (Node's `name, value, …` shape), so a header sent twice
  is counted twice. A host that only has a fetch `Request` has lost that: its
  `Headers` joins repeats with `, `. Such a host sets
  `headerLines: 'unavailable'` and the handler then counts a joined value that
  contains a comma as two lines. Every refusal of a repeated header (a declared
  header parameter, a condition header, `Content-Type` on a checked body,
  `Cookie`, `Origin`, `Sec-Fetch-Site` and `Referer` for same-origin checks,
  the store's `Idempotency-Key` and `If-Match`) therefore still fires, and a
  single line whose value contains a comma is refused by those checks too. A
  handler created with the default and called without `rawHeaders` throws
  rather than guess. `runtime.handle()` called without `headerCounts` applies
  the same comma rule.
- `basePath`: the prefix a host mounts the site under and strips before
  calling the handler (Hono's `app.mount('/app', …)`). A function's
  `request.url` keeps the prefix, and every path-absolute `Location` in an
  answer (a `redirect` route to `/new`, a function or extension returning
  `/after`) gets it; an absolute or `//host` location is unchanged. Routes are
  still declared from the site root. Links inside HTML bodies and absolute
  URLs generated from `origin` (sitemaps, canonical links) are not rewritten.
  A host that keeps full paths (`app.all('/app/*', …)` with routes declared
  under `/app`) needs no `basePath`.
- `loopbackHost: { address, port, aliasOrigins? }`: the host listens on this
  loopback address and port, so apply the
  [loopback `Host` check](#host-admission-on-a-loopback-bind): a request
  whose single `Host` is not a loopback name on that port, `origin` or an alias
  origin is refused with 421. A non-loopback address is not checked, as on the
  Node server. Without `rawHeaders` the check reads the joined `Host`, so a
  repeated one is refused too.

A streamed route answers with a streamed body: status and headers follow the
producer's first chunk, so a producer that fails before it gets the ordinary
502, and one that fails later ends the body with an error.

These belong to `urlcode serve` and are not provided by the embedded handler.
The host supplies its own or goes without:

- the `/_urlcode/health`, `/_urlcode/ready` and `/_urlcode/metrics` probes and
  the readiness drain before close;
- the request event log and `--debug-errors` diagnostics (the runtime's own
  events still reach the `log` and `observers` given to `createRuntime`);
- in-flight admission (`--max-in-flight`), header, request and keep-alive
  timeouts, and the connection limits;
- [stream limits](#streamed-responses): concurrent streams, idle and total
  duration, and bytes per stream;
- trusting an upstream `X-Request-Id`: each answer gets a fresh id;
- hot reload and project watching.

The reverse direction also works. A framework application can answer from
a trusted function route (`return app.fetch(request)`, one declared route per
path, because function routes have no wildcard), or from an operator
extension mount when its own router should own a prefix. The fixture's
README lists each remaining gap with its source location.

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

### Host admission on a loopback bind

A server bound to a loopback address (the default `127.0.0.1`, any
127.0.0.0/8 address, `::1`, or `localhost`) is reachable from any web page the
machine's browser opens once that page's own domain is re-pointed at 127.0.0.1
(DNS rebinding). The browser then treats the server as same-origin, so no CORS
preflight stops it. To close that, such a server refuses every request, probes
and `/_urlcode/metrics` included, with `421 Misdirected request` before routing
unless it carries exactly one `Host` header naming:

- `localhost`, `127.0.0.1`, `[::1]` or the bound address itself, with the bound
  port (`localhost:3000`; the port may be omitted only when it is 80); or
- the authority of `--origin`, when set: `--origin https://links.example.com`
  admits `links.example.com` and `links.example.com:443`, and
  `--origin http://links.example.com:8080` admits only `links.example.com:8080`;
  or
- the authority of each `--alias-origin`, by the same rule.

Matching is case-insensitive and otherwise exact (no trailing dot, no other
port). A missing or repeated `Host` is refused, and an absolute-form request
target must name an admitted authority too. The body is a fixed text and never
repeats the header; the refusal is logged as an ordinary `request` record with
status 421. Only `--origin` and `--alias-origin` widen the list; no YAML does.

A reverse proxy on the same machine therefore either forwards the public Host
(Caddy's default) with `--origin` set to that public origin, or rewrites Host to
the upstream address it connects to (nginx's default `proxy_set_header Host
$proxy_host` sends `127.0.0.1:3000`). A server bound to a non-loopback address
(`--host 0.0.0.0`, `::` or a LAN address) is not checked, and neither are the
AWS, Vercel and Cloudflare targets, whose platform owns the Host. That includes
the container image, which binds `0.0.0.0` inside the container even when
`docker run -p 127.0.0.1:3000:3000` publishes it only on the host's loopback.
The check is a DNS-rebinding defence, not authentication.

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

`dev`, `test`, `routes`, `audit` and `validate --local` read
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

## Email delivery

No first-party extension sends email. A site that sends one (a contact form, a
notification) does it from a trusted function route that calls the mail
provider's own SDK, HTTP API or nodemailer directly. The route receives the
provider's endpoint, key or SMTP URL through an operator-granted `secrets`
binding, so project YAML never holds a credential. Its provider setup,
retries, sender and recipients are the application's code
([sending mail from your own code](../recipes/contact-form/README.md#sending-mail-from-your-own-code-instead)).

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
deadlines, byte limits and admission; [capacity](CAPACITY.md#enforced-limits-and-defaults)
lists the flags, their ranges and defaults. Set them on the container command
line; these are deployment controls, not portable route behavior. Horizontal replicas
must use identical application/config versions and secret bindings. In-memory
function state is not durable or shared application state: a trusted route's
module state persists for the life of its process (a `sandbox: true` route's
lasts one invocation), and neither is shared across replicas or kept across a
restart ([what persists](FUNCTION-SECURITY.md#what-the-trusted-default-can-and-cant-do)).
General application storage needs a future explicit capability broker; no
storage/network access is exposed to the guest. Core no longer has a native
link store, and the `urlcode-dynamic-link` extension package that replaced it
has been retired and unpublished. Stored short links are served by the
operator-installed `store` extension's `extensions.store.config.shortLinks`
([data store](STORE.md)), whose records live in the store's SQLite database:
back it up with the rest of the store (`urlcode-store backup`, safe while the
server runs; see [backups](STORE.md#storage-and-concurrency-what-it-does-and-does-not-guarantee)).

### Streamed responses

A route that [streams](SPECIFICATION.md#streamed-responses) (a trusted
`stream: true` function or a streaming extension) holds its connection while it
produces. Streams have their own limits, separate from the short-request ones:

| Flag (`startServer` option) | Default | Range | Ends a stream with reason |
|---|---|---|---|
| `--max-streams` (`maxStreams`) | 32 | 1–1024 | none: one more is answered 503 before any byte (`stream_refused`, reason `capacity`) and counted as shed |
| `--stream-idle-timeout-ms` (`streamIdleTimeoutMs`) | 30000 | 1000–3600000 | `idle-timeout`: no chunk produced, or the client not reading what was written, for this long |
| `--stream-max-duration-ms` (`streamMaxDurationMs`) | 300000 | 1000–86400000 | `max-duration`, however active the stream is |
| `--stream-max-bytes` (`streamMaxBytes`) | 16777216 | 1–268435456 | `max-bytes`; the chunk that would pass the limit is not sent |

- A streamed response counts against `--max-in-flight` only until its handler
  returns its status and headers; from then until it ends it counts against
  `--max-streams`. An open stream therefore never holds an application
  admission slot, and the in-flight gauge does not include it.
- `--request-timeout-ms` and the socket inactivity timeout do not end a
  healthy stream: the stream's idle timeout replaces the socket timeout for
  that response, and the socket timeout is restored when the stream completes
  and the connection is reused.
- A stream ended by a limit, a disconnect, an error or shutdown closes the
  connection without the chunked terminator; the producer is cancelled and its
  `AbortSignal` aborted with the reason. Every stream writes one `stream` log
  record when it ends (`requestId`, `status`, `bytes`, `durationMs`, `reason`;
  `method` and `route` with `--request-log detailed`), after the ordinary
  `request` record written when its head was sent ([monitoring](MONITORING.md)).
- Shutdown: streams share `--close-timeout-ms` with other connections and are
  ended with reason `shutdown` at its deadline. A dev hot reload lets streams
  on the retired snapshot run to their end (bounded by these limits); the
  retired snapshot and its extensions close after the last one.
- Put a reverse proxy's response buffering off for these routes (for example
  nginx `proxy_buffering off`, or the route sending `X-Accel-Buffering: no`),
  and keep its read timeout above `--stream-idle-timeout-ms`, or it will hold
  or cut the stream itself.
- A streamed MCP reply
  ([mcp streaming progress](../packages/mcp/README.md#streaming-progress-operator-opt-in))
  lasts as long as its tool call: it holds a `--max-streams` slot until the
  result is sent, and a tool that reports no progress for longer than
  `--stream-idle-timeout-ms` is cut. Size `--max-streams` for the concurrent
  tool calls you expect.
- On Vercel, `createVercelHandler({ streams: { maxStreams, idleTimeoutMs,
  maxDurationMs, maxBytes } })` sets the same limits per function instance; the
  platform's own function duration limit still applies. AWS, Cloudflare and
  static refuse streaming before serving.

The health version combines route-definition and asset-representation digests;
it does not identify the complete function/runtime release. Record runtime commit,
application commit, dependency locks and image digest in your deployment system.

## Deployment and rollback procedure

1. Build a candidate from pinned runtime/application revisions and lockfiles.
2. Validate its config/bindings and run local HTTP tests without external redirects.
3. Start it on an alternate private port/container. Check readiness and representative
   redirect/function behavior through the intended proxy configuration:
   `urlcode verify-deployment --project app --target https://candidate.host` compares
   version, fixtures, policy headers and site files with the project
   ([deployment checks](DEPLOYMENT-CHECKS.md)).
4. Switch proxy traffic after checks pass. Drain the previous instance before stopping.
5. If checks or observed behavior fail, route traffic back to the retained previous
   instance/image and its compatible secret bindings.

**With the bundled store, or bundled auth on its own SQLite file, one process
serves the site's data.** Each SQLite database is served by one process: a candidate started on
the same `data/` directory while the previous instance serves it is refused
at startup ("Another process is already serving this store database"), before
it writes anything ([store](STORE.md#one-serving-process-per-database)). For
such a site, steps 3 and 4 become: check the candidate on a copy of the data
(`urlcode-store backup` into a scratch directory, or `urlcode validate
--local-review`, which uses a fresh one), then stop the previous instance and
start the candidate on the real `data/`. Requests fail for that restart;
the lock is released the moment the previous process exits, however it
exits, so there is nothing to wait for. Rolling back is the same swap in
reverse. A candidate whose release migrated the store schema can only be
rolled back by restoring a backup taken before it started. Several servers on
one database need a database server, which the bundled SQLite store does not
use ([owner choice](EXTENSIONS.md#native-independent-integration-or-bundled-default)). The
SQLite file must be on local disk: a network filesystem is refused on Linux.

This is an operator procedure, not an implemented deployment control plane.
Rollback cannot undo a function's external side effects or migrate an app's
state automatically. Plan those independently. Keep Git definitions backed up;
back up any app-owned persistent state separately. YAML routes require no database.

## Capacity and incident planning

**A full disk.** The store and auth extensions keep their SQLite files in
the site's `data/` directory; the store's audit log is part of
`store.sqlite`. When that filesystem fills, a write that needs space is
refused and writes nothing: a store write answers `503 storage_unavailable`
with no record and no audit event, and a sign-in `503 auth_unavailable` with
no session. Reads, and routes behind an existing session, keep answering. The
process keeps running and needs no restart: free space (or grow the volume),
and writes and sign-ins resume; a client's retry with the same
`Idempotency-Key` then runs for the first time. Check both files afterwards with
`PRAGMA integrity_check` (`urlcode-store backup` also refuses a copy of
`store.sqlite` that does not pass it). Watch free space on the data volume and alert well before it
runs out, because the tests do not cover restarting on a full disk. What is
proved, and what is not, is in
[the disk-full tests](STORE.md#what-the-disk-full-tests-prove).

See [capacity and concurrency](CAPACITY.md) for hard limits, worker occupancy,
no-queue rejection, memory/reload budgets and theoretical sizing. See
[DDoS and recovery](RESILIENCE.md) for ingress responsibilities, incident response,
rollback/restore procedures, recovery objectives and drills.

See the [production-readiness gates](RELEASE-OPERATIONS.md#production-readiness) for evidence and open gates.

## Remaining production validation

See [production readiness](RELEASE-OPERATIONS.md#production-readiness) for the gates a deployment owner
must close before production approval. The Vercel, AWS, Cloudflare and static
adapters ship with local conformance tests only; none has been exercised on
its provider yet (see [capabilities](CAPABILITIES.md)). See
[roadmap](../ROADMAP.md). No claim of high availability, zero downtime or
provider portability beyond the Node process adapter is made by the current
release.

## Security review

The detailed 2026-09-16 internal audit is private maintainer material; it was
not an independent assessment. The public security and assessment boundaries
remain in [SECURITY.md](../SECURITY.md) and [the sandbox review](SANDBOX-REVIEW.md).
