# DDoS, overload and recovery playbook

This is an operator plan for the current self-hosted release, not a claim of built-in DDoS
protection, managed failover or tested high availability. URLCode's sandbox and
resource limits reduce some failure modes; they cannot protect a saturated
network link. Keep the public origin behind your existing protected ingress.

## Defense responsibilities

| Layer | Operator action | What URLCode provides today |
|---|---|---|
| Upstream network | Hosting/CDN DDoS mitigation and an escalation contact; protect bandwidth before it reaches the origin | No network-level mitigation service |
| Edge/proxy | TLS, per-client and aggregate request/connection budgets, header/body/time limits; restrict direct origin access | Private bind default; no automatic TLS/WAF. Optional per-instance [`throttle` and `agents` policies](POLICIES.md) as a second layer behind the edge, with `--trusted-proxies` naming the hops allowed to set `X-Forwarded-For` |
| Application | Validate inputs, bound expensive work, authenticate sensitive operations | Strict route/body validation; sandbox deadlines and no execution queue |
| Process/container | CPU/RAM/PID limits, restart backoff, least privilege, read-only reviewed app | Worker isolation, bounded worker replacement, health and request logs |
| Release/recovery | Known-good artifacts, candidate verification, traffic switching, rollback drills | Local validation/tests/audit; explicit snapshot reload; no orchestration |

NGINX provides request-rate controls and connection controls keyed by values such
as client IP. Their counters do not cover every stage of connection handling;
connection limiting starts after request headers are read. Treat them as layers,
not a complete volumetric defense. Use aggregate budgets too, and test legitimate
users behind shared NATs. Sources: [request limits](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html),
[connection limits](https://nginx.org/en/docs/http/ngx_http_limit_conn_module.html).

If a CDN/proxy sits ahead of your ingress, configure trusted client-IP restoration
for only that provider's verified proxy addresses. Never use arbitrary incoming
X-Forwarded-For as the rate-limit identity. Keep the origin firewall/private
network restricted to the intended ingress. URLCode deliberately does not trust
forwarded headers to construct its public URL; set `--origin` explicitly.

The optional [`throttle` policy](policies/throttle.md) adds a per-client budget
inside the runtime, and the [`agents` policy](policies/agents.md) refuses listed
User-Agents before a body is read or the sandbox starts. Both are a second
layer behind the edge, not a replacement for it: counters are per instance,
the socket and admission limits still apply first, and a flood still costs
connections. The client identity is the socket peer unless
`urlcode serve --trusted-proxies <cidr,...>` names the proxies allowed to set
`X-Forwarded-For`; a forwarded header from any other peer is ignored, and an
unresolved client shares one bucket rather than being exempt. See
[policies](POLICIES.md).

Cache only responses whose semantics permit public caching. Never cache private,
credential-bearing or personalized responses as a blanket mitigation. Default
function/redirect responses are no-store; assets default to revalidation. Use
versioned immutable asset URLs when appropriate. An NGINX/native-route exporter
is not implemented; adding a reverse proxy does not bypass runtime execution.

## Threats and behavior to expect

| Failure or traffic pattern | Current consequence | Mitigation / recovery |
|---|---|---|
| High-rate ordinary requests | Event-loop, logging, bandwidth or socket exhaustion | Filter/rate-limit upstream; scale only within measured resource/cost budgets |
| Flood of functions or middleware | Two default worker slots fill; further calls receive 503 | Bound programmable traffic before the origin; isolate heavy workloads |
| Infinite/slow application code | Shared invocation deadline returns 504; worker terminated/replaced | Identify bad release/route with protected diagnostics; roll back or block route at ingress |
| Guest invalid response or failure | Generic 502 | Compare with last deployment; run fixture on a private candidate |
| Repeated worker exits | Replacement backs off (250 ms doubling to 30 s) and keeps retrying; readiness stays 503 until every slot serves | Contain the cause; load is shed meanwhile. Replacement never stops, because a guest deadline is reachable from ordinary request input and must not disable functions until an operator restarts |
| Large/slow requests | 64 admitted application requests, body/header limits and receipt timeouts; copies still consume memory | Smaller proxy/body budgets and connection admission limits |
| Slow response readers | Retain admission/output buffers until finish/disconnect; 15-second socket inactivity timeout | Proxy downstream timeouts and connection controls |
| Corrupt YAML/code/asset update | Dev/explicit reload rejects candidate and retains old snapshot | Restore reviewed files; verify actual active version; do not assume edit activated |
| Host OOM or process crash | In-process recovery cannot preserve service | Supervisor with backoff; route traffic to healthy replica; restore tested image |
| Disk/log sink trouble | Logs may drop; startup/config reads can fail | Disk/RSS alerts, bounded retention and log-drop monitoring |
| Bandwidth flood at origin link | App may be unreachable regardless of worker limits | Hosting/network mitigation provider escalation |

A 503/504 can also be an intentional application response. Runtime logs do not
include a per-route reason code, so status alone cannot prove an attack or a
capacity failure. Correlate ingress metrics, release changes and controlled
probes. Do not add secrets, full query strings or request bodies to diagnostics.

## Prepare before exposure

- Name an incident owner, backup and hosting/ingress escalation contacts. Decide
  who can change filters, switch traffic, approve rollback and rotate credentials.
- Retain known-good runtime/app commits, locks, images and compatible policy files.
  Keep protected backups outside the host. Secret values belong in your secret
  system, never the artifact archive or Git.
- Keep at least one verified rollback path; use redundant replicas if your
  availability objective needs them. A single instance cannot promise continuity
  through a host failure or full restart.
- Define acceptable successful RPS, p95/p99, error rates and resource utilization
  using [capacity tests](CAPACITY.md). Set alerts for deviations, readiness failures,
  restarts/OOM, memory pressure, bandwidth, log drops and infrastructure spend.
- Restrict `/_urlcode/*` to operator access at ingress. Keep liveness and readiness
  separate: busy workers do not make readiness fail; missing workers do.
- Use bounded retries with backoff/jitter where retries are safe. Do not retry
  non-idempotent requests blindly or create a synchronized retry storm.

## Incident procedure

1. **Confirm and record.** Note start time, affected service, runtime/app/image
   versions, error/latency trends and recent changes. Check upstream reachability,
   process health and readiness through an operator-only path. Distinguish an
   ingress incident from a bad deployment or legitimate traffic increase.
2. **Protect capacity.** Apply reviewed ingress filters/admission limits and
   contact the mitigation provider for network saturation. Restrict an abusive
   route at ingress if needed. Preserve working simple routes where possible.
   Do not raise worker counts/timeouts blindly or scale without a spend ceiling.
3. **Stabilize.** Remove failed replicas from traffic. If a release is implicated,
   switch to the retained verified revision; avoid repeatedly rebuilding snapshots
   under attack. For a bad function, an ingress block is faster than a YAML edit
   that still needs deployment and may invalidate binding policy.
4. **Restore deliberately.** Start a candidate with the intended runtime/app,
   assets, bindings and matching external policy. Check private readiness and
   representative response assertions. Switch a small traffic share first when
   supported, observe, then increase. Drain the old instance before stopping it.
5. **Verify recovery.** Confirm successful traffic, latency, RSS and error rates
   return to the agreed envelope. Check native and programmable routes, HEAD,
   redirect destinations and critical asset behavior. Readiness alone is not enough.
6. **Close and improve.** Record cause, actions, outage duration, lost telemetry,
   customer impact and costs. Keep useful mitigations; remove temporary broad
   restrictions carefully. Add a regression fixture or drill for the failure.

Restarting can replace failed workers, but it does not fix a malicious request
pattern, broken release or saturated link. Rotate credentials if exposure is
suspected, not automatically for every traffic spike. Redeploy to load new values;
serve does not refresh them. No credential values should enter incident notes.

## Recovery objectives and data

Choose RTO (acceptable recovery time) and RPO (acceptable data loss) per deployment;
URLCode does not promise values. A stateless YAML deployment can be recreated
from retained immutable artifacts, subject to recovery of DNS/ingress and secret
access. Log loss is possible under pressure and has a separate retention target.
Stored live-link records and future app-owned state need their own backups and restore
verification; Git route configuration does not back up runtime data.

A rollback needs the previous app/runtime and its matching policy and compatible
secret bindings. The health version combines configuration and asset digests;
it is not a complete code/release identity. Track Git/image identities externally.
Browser/CDN-cached permanent redirects may continue after rollback; choose cache
lifetimes accordingly and plan edge purges. Rollback cannot undo external side
effects, and current URLCode has no state migration/restore control plane.

## Safe recovery drills and pass criteria

Run only against owned, isolated test deployments with fixed request/time budgets
and stop conditions. Coordinate with the hosting provider for any network stress
exercise; do not generate uncontrolled floods or target third-party destinations.

| Drill | Evidence to retain |
|---|---|
| Saturate the function pool with bounded test handlers | Excess work receives bounded failures; native probe remains observable; normal traffic recovers afterward |
| Handler timeout/worker replacement | 504 observed, replacement or bounded unavailable state understood, no leaked request data |
| Invalid dev reload | Old response stays active; rejection logged; corrected candidate activates |
| Kill a disposable replica | Supervisor backoff and health-based routing work; successful capacity of survivors measured |
| Roll back a bad release | Prior exact response restored with matching policy; actual recovery time recorded |
| Restore on a clean host | Artifacts, policy and secure bindings suffice; assets and all critical fixtures pass |
| Simulate a slow/full log sink | Dropped-log reporting is observed; service and disk usage remain bounded |
| Remove mitigation after a bounded overload | Latency/errors/resources return to baseline without a restart loop |

Existing unit/HTTP tests cover several component failures; these deployment drills
are a plan, not evidence they have all been run. Remaining gaps include distributed
admission/fairness, production metrics/exporters, dedicated slow-reader protection,
provider-level mitigation validation and sustained failure/soak testing. These are
free-runtime/operator requirements; they do not require waiting for Cloud.

For optional live links, protect the separate management listener and token, bound
its traffic, and back up the SQLite store with the documented closed-store or
SQLite-aware procedure. Store worker failure returns 503; stop the cause before
reloading/restarting. An uncertain mutation may have committed. See
[dynamic-link recovery](DYNAMIC-LINKS.md).
