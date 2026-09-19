# Function execution: trusted by default, sandboxed opt-in

`function` and `middleware` routes run **trusted and unsandboxed by default**:
in the host process, with full Node, filesystem and network access, exactly
like any other project code (docs/SPIKE-DEFAULT-TRUST-MODEL.md). This is a
deliberate, maintainer-decided reversal of alpha.2's blanket sandbox — see
that spike document for the full rationale. It is a call the project makes,
not a property the runtime can verify: URLCode cannot know whether your code
is safe to trust, only whether you asked for isolation.

Declare `sandbox: true` on a route when its code specifically warrants
isolation: it processes input from a source the project doesn't fully trust
(a third-party webhook payload, for example), it is a contribution nobody on
the team has reviewed, or it handles a secret sensitive enough that a bug in
that one route should not be able to reach the rest of the process or the
filesystem. A sandboxed route runs in QuickJS inside WebAssembly, in a
separate worker thread, with none of the host access described below — its
guarantees are unchanged from every earlier release and are described in
full in the rest of this document. Absence of `sandbox` (or `sandbox: false`)
means trusted; there is no separate `unsafe`/`trusted` field to opt back into
the old sandboxed-by-default behavior — set `sandbox: true` per route instead.

**Either way, binding grants are unaffected.** Trusting a route's code by
default does not grant it any `env`/`secrets` it was not explicitly declared
in YAML and approved by an operator policy pinned to the project revision
(see "Granting selected bindings" below). A trusted function only *can* do
more with Node once it runs — it does not receive anything more than a
sandboxed one would.

This is a claim about `context`/`context.secrets` injection, not an
access-control guarantee on trusted code. The binding grant governs only what
URLCode hands a route through `context`; it does not restrict what trusted
(non-`sandbox`) code can independently do, because that code has full Node
access by design. A trusted function can read `process.env`, open files or
make network calls on its own regardless of what its route was or was not
granted — withholding a binding grant limits what URLCode gives the code
through `context`, not what the code itself, running with full Node access,
can go and get. A sandboxed route has no such independent access: the guest
API is all it has, so its binding grant *is* effectively its whole reach into
the environment. Trusted code's reach is not bounded that way; treat the
grant as scoping `context`, not as scoping the process.

## What "sandboxed" (`sandbox: true`) still guarantees

- Function sources are parsed/snapshotted without importing them into Node.
- Code runs in QuickJS inside WebAssembly, with no host JS functions/objects
  exposed to the guest. Request/response/context use a JSON/string boundary.
- No `process`, `require`, Node built-ins, filesystem, shell, sockets, fetch,
  WebSocket, workers, native extensions or ambient environment is available.
- Module resolution is restricted to the route's declared middleware and function relative JavaScript
  dependency graphs inside the project. Symlink escapes, remote/bare imports and
  dynamic imports in source fail. Runtime-created imports cannot broaden access.
- A fresh guest heap/module state per invocation prevents state crossing requests.
- 32 MiB guest heap, 512 KiB stack, source/input/output/header limits, bounded
  concurrency, guest interruption and an independent worker termination deadline.
- External bindings are denied by default. Project YAML cannot self-authorize.
  Operator grants are exact-name, route-scoped and pinned to configuration/source.

The guest API is intentionally narrower than Node or full Fetch; see the
[implemented contract](SPECIFICATION.md). A function moving from trusted to
`sandbox: true` that uses Node/network or binary/stream APIs must be rewritten
for the supported guest profile, or stay trusted. Redirects need none of this
machinery either way.

## What the trusted default can and can't do

A trusted route (no `sandbox`, or `sandbox: false`) has none of the guest
restrictions above:

- Full Node built-ins, `process`, the filesystem, `fetch`, sockets, workers
  and npm packages are available, exactly as in any other Node module.
- Module resolution is ordinary Node ESM resolution: bare specifiers, dynamic
  `import()` and node_modules all work. There is no dependency-graph allowlist
  and no per-module/total source-size budget (function-sources.ts's
  `MODULE_LIMIT`/`MODULE_BYTE_LIMIT`/`TOTAL_BYTE_LIMIT` apply only to what a
  sandboxed snapshot bundles).
- Node's own module cache is shared across invocations and across the whole
  process; there is no fresh heap per call. Module-level state persists
  between requests exactly like an ordinary long-running Node server, so a
  trusted function that mutates shared/global state affects later requests
  the way hand-written server code would.
- There is no worker-thread deadline that force-terminates a stuck call. A
  trusted invocation races a configurable timeout, but that race can only
  reject the *call*; it cannot preempt code that blocks the event loop
  synchronously. See [capacity](CAPACITY.md) for what this means for one slow
  or hung trusted route's effect on the rest of the process.
- A snapshot reload re-imports a trusted route's own entry file fresh (each
  reload gets its own cache-busted module registration), so editing the
  `source` file a route declares and reloading picks up the change, the same
  as the sandboxed pool rebuilding from scratch. A file that entry file
  merely *imports* is not similarly busted: Node's own module cache is
  keyed by the resolved URL of that import statement, which this runtime
  does not rewrite, so an edited dependency two files deep from the route
  keeps serving its old content until the process restarts. Restructure a
  route so the code you expect to hot-reload is the declared entry file
  itself, or restart rather than reload after editing a trusted route's
  dependencies. A `sandbox: true` route has no such gap: reload always
  rebuilds its whole snapshot, dependencies included.

What does **not** change with trust: `args` are still exactly the validated
values the route declares (never raw request input), and `env`/`secrets` are
still exactly what the route's YAML requests and an operator policy grants,
pinned to the project revision — trust changes where code runs, not what
it is handed *through `context`*. It does not change what the code can go get
on its own once it is running; see "binding grants are unaffected" above for
that distinction.

## Granting selected bindings

An application may request a named binding in YAML, but only an operator can
approve it. Inspect what the app requests without executing any module:

```sh
urlcode permissions --project /srv/my-links
```

This prints a proposed JSON shape with `version: 1`, `projectSha256` and `routes`.
It grants nothing. Review the code/configuration and keep only necessary bindings.
Save the policy **outside the application checkout**, in an operator-controlled
file; never let application authors or deployment artifacts overwrite it.

```json
{
  "version": 1,
  "projectSha256": "REPLACE_WITH_THE_REVIEWED_PROJECT_DIGEST",
  "routes": {
    "/customer/{id}": {
      "env": ["API_MODE"],
      "secrets": ["customer_api_key"]
    }
  }
}
```

The placeholder deliberately does not validate. Use the actual digest produced
by inspection. Then, with values securely injected into the process:

```sh
urlcode validate --project /srv/my-links --policy /etc/urlcode/my-links-policy.json
urlcode serve --project /srv/my-links --policy /etc/urlcode/my-links-policy.json
```

`dev`, `test` and `validate --local` use the same policy rules even for `.env.local`.
The JavaScript API accepts an equivalent operator-supplied `permissions` object.
Every config change invalidates the grant, and so does a module change within
what the approval digest actually hashes: for a sandboxed route, its
middleware/function sources and their full dependency graph; for a trusted
route, only its own entry-file source (see the next paragraph — a trusted
route's transitive dependencies are explicitly **not** part of that digest).
Inspect/review the new revision before updating the operator file. Policies
are read at startup, not hot-reloaded. A failed development candidate leaves
the previous approved snapshot running.

Granting a secret deliberately makes it available to every middleware and function
in that route, trusted or sandboxed alike. A sandboxed route's middleware
sources and their full dependency graph are included in the approval digest,
as before; a trusted route's own entry-file source is included too, so
changing that file's content invalidates the grant, but a change to a helper
module it merely imports does not by itself (see function-sources.ts's
`collectTrustedSources`) — a known, documented gap versus the sandboxed path's
full dependency-graph hashing: a trusted route's grant scope is entry-file-only,
not transitive. Either way, code can include any granted data
in its HTTP response: neither the sandbox nor the trusted default promises
secrecy from code that was explicitly authorized to read a value. Minimize
grants, use scoped/short-lived credentials and revoke/restart when needed.
Other routes get none of that context.

## Next capability work

Outbound requests need a host-owned broker with explicit destination/method
allowlists, private/metadata/loopback-address restrictions, DNS/rebinding defenses,
redirect revalidation, deadlines and byte/concurrency limits. Application YAML
must not grant those permissions. Persistent state needs similarly scoped access.
Until such brokers are implemented and tested, these capabilities are unavailable
to a *sandboxed* route. Provider adapters must preserve a `sandbox: true`
route's isolation or reject deployment; they cannot silently downgrade a
route that explicitly asked for the sandbox into unrestricted Node execution.
(A trusted route, by contrast, already has unrestricted Node execution by
design on the self-hosted target — see "What the trusted default can and
can't do" above; non-Node targets refuse `function`/`middleware` entirely,
trusted or sandboxed, since neither execution mode exists there.)

## Verification and remaining risk

Tests attempt constructor/eval escapes, Node/filesystem/shell/network imports,
runtime-created imports, cross-request prototype/state pollution, oversized
allocations, loops, unauthorized secret requests and stale/repo-local policies.
These are regression tests, not a proof of complete security.

The URLCode host, parser, QuickJS/WASM engine, native runtime and dependencies
remain trusted computing components that need patching and review. Guest heap
limits do not cap all host/WASM RSS; use OS/container memory/CPU/PID limits as an
additional layer. Native engine bugs or resource exhaustion remain residual risks.
For a public arbitrary-code/multi-tenant service, require independent security
review plus process/VM-level isolation and operational controls before launch.
Do not advertise this release as an audited hostile multi-tenant hosting platform.

Implementation references: [QuickJS/WASM project](https://github.com/justjake/quickjs-emscripten)
and its [runtime isolation/limits API](https://github.com/justjake/quickjs-emscripten/blob/main/doc/quickjs-emscripten/classes/QuickJSRuntime.md).
