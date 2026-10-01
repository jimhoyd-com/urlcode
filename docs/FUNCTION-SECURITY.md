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

## Migrating to the trusted default

If you are upgrading a project from a release before this change shipped:
**every existing `function` and `middleware` route silently changes execution
mode**, from sandboxed to trusted, unless it already has (or you add)
`sandbox: true`. This is a real behavior change on upgrade, not a
documentation update — a route that used to run with no filesystem or network
access will, after the upgrade, run with full Node access unless you opt it
back into the sandbox.

Before upgrading:

- List every `function` and `middleware` route in the project.
- For each one, decide whether you fully trust that code to run in-process
  with full Node/filesystem/network access — the same trust you would extend
  to any other code you deploy to that server.
- Add `sandbox: true` explicitly to any route whose code you do not fully
  trust, that processes input from a source you don't control, or that handles
  a secret binding you want isolated — before you upgrade, not after.
- Routes you do want running trusted need no change; that is now the default.

The change moves the sandbox from an unconditional guarantee to an explicit,
per-route choice, mainly for performance: the previous blanket sandbox capped
concurrency at two workers with no queue shared across every function route on
the server, which does not scale to real concurrent traffic. It also brings
first-party code in line with how the rest of the Node ecosystem treats
deployed application code. The sandbox itself is unchanged for routes that opt
into it; only the default for routes that declare neither option has changed.

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
  The heap is enforced by giving each sandbox worker a fixed 44 MiB
  WebAssembly memory (the 32 MiB guest heap plus the engine's own baseline),
  not by QuickJS's allocation counter, which this build undercounts. The memory
  is allocated at that size and never grows: a grow detaches the host's views
  of it, which made the engine leak a context and abort at runtime disposal
  for some response sizes (#1096). Untouched pages are not resident, so this
  costs address space, not RSS. A guest whose allocations reach the cap fails
  with the generic 502 even if it catches the error, and its worker is retired
  and replaced (logged as a `function_worker` restart). An engine that aborts
  while freeing an invocation's runtime is retired the same way. The
  in-guest interrupt is polled between bytecode batches, so a loop of few, very
  expensive operations can overrun it; the worker termination deadline is the
  enforced bound for those.
- The response body lives in the guest heap as the engine's string, at most
  one byte of heap per UTF-8 byte of the body, and the host reads it in slices
  of 2^20 UTF-16 units outside the JSON metadata, so handing it over costs one
  slice's copy rather than an escaped copy of the whole body. A body within the
  16 MiB `--max-response-bytes` ceiling therefore fits whatever its characters,
  leaving about half the heap for the guest's own work, and the ceiling is the
  same for trusted and sandboxed routes. Measured with a guest that builds
  nothing else, the heap holds a body string of up to 32 MiB (32 MiB of ASCII
  or of 4-byte characters, 64 MiB of Latin-1 text), twice the ceiling. A body
  the heap cannot hand over answers 502; it never arrives short.
- The guest's result is recorded where guest code cannot rewrite it, and the
  host checks its shape before trusting it. A result that states a body length
  for any method other than HEAD is invalid and answers 502; the runtime frames
  the response by the bytes it sends ([responses][docs/HTTP.md#responses]).
- A sandboxed route always answers with one whole buffered response:
  `stream: true` is refused beside `sandbox: true`, and no `AbortSignal` or
  other host object crosses into the guest's context.
- External bindings are denied by default. Project YAML cannot self-authorize.
  Operator grants are exact-name, route-scoped and pinned to configuration/source.

The guest API is intentionally narrower than Node or full Fetch; see the
[implemented contract][docs/SPECIFICATION.md]. A function moving from trusted to
`sandbox: true` that uses Node/network or binary/stream APIs must be rewritten
for the supported guest profile, or stay trusted. Redirects need none of this
machinery either way.

This engine — worker spawning, the module-allowlist walk, the two-layer
deadline, `maxBytes` and response-shape validation — is one implementation
shared by route dispatch and by `@jimhoyd/urlcode/sandbox`'s `SandboxPool`.
That public HTTP-shaped primitive remains available to extension authors, but
project extension hooks use arbitrary typed values and contract v1 runs them
trusted in-process; it rejects `sandbox: true` rather than claiming HTTP sandbox
semantics apply to them. See [extensions][docs/EXTENSIONS.md#project-level-lifecycle-hooks].

## What the trusted default can and can't do

A trusted route (no `sandbox`, or `sandbox: false`) has none of the guest
restrictions above:

- Full Node built-ins, `process`, the filesystem, `fetch`, sockets, workers
  and npm packages are available, exactly as in any other Node module.
- Module resolution is ordinary Node ESM resolution: bare specifiers, dynamic
  `import()` and node_modules all work. There is no dependency-graph allowlist
  and no per-module/total source-size budget (the module-count and byte
  budgets apply only to the source a sandboxed route's snapshot bundles).
- Node's own module cache is shared across invocations and across the whole
  process; there is no fresh heap per call. Module-level state persists
  between requests exactly like an ordinary long-running Node server, so a
  trusted function that mutates shared/global state affects later requests
  the way hand-written server code would.
- There is no worker-thread deadline that force-terminates a stuck call. A
  trusted invocation races a configurable timeout, but that race can only
  reject the *call*; it cannot preempt code that blocks the event loop
  synchronously. See [capacity][docs/CAPACITY.md] for what this means for one slow
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
- A trusted route may declare `stream: true` to send its Response body as it
  is produced ([streamed responses][docs/SPECIFICATION.md#streamed-responses]).
  The operator's stream limits bound delivery (bytes, duration, idle time,
  concurrency) and cancel the producer, but like the call deadline they
  cannot preempt code that blocks the event loop.

What does **not** change with trust: `args` are still exactly the validated
values the route declares (never raw request input), and `env`/`secrets` are
still exactly what the route's YAML requests and an operator policy grants,
pinned to the project revision — trust changes where code runs, not what
it is handed *through `context`*. It does not change what the code can go get
on its own once it is running; see "binding grants are unaffected" above for
that distinction.

## Trusted code, not trusted requests

"Trusted" describes the code's authorship — first-party project code you
reviewed and deployed — not the requests it handles. Every request, in either
mode, still carries client-controlled path, query, header and body data that is
exactly as adversarial as it always was. Running trusted means that code
executes with full Node access if it mishandles that input; it does not mean
the input itself became safe to trust. Declare `parameters` and `request.body`
validation in YAML, check `args` and any other request data again inside
function/middleware code, and implement your own authentication and
authorization — no route, sandboxed or trusted, adds automatic auth.
`sandbox: true` narrows what a bug or an unreviewed dependency in the *code*
can do with that same request data; it is not a substitute for validating or
authenticating the request itself.

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
what the approval digest hashes. Sandboxed routes retain their complete bounded
module snapshot. Trusted functions, middleware and extension hooks pin their
entry bytes plus the non-executing inventory described below.
Inspect/review the new revision before updating the operator file. Policies
are read at startup, not hot-reloaded. A failed development candidate leaves
the previous approved snapshot running. A denial caused by a stale pin says
so: the binding or egress error names the pinned and current revisions and
points at `urlcode permissions`.

### Trusted dependency review

`inspect` and `review` include `trustedDependencies`: project-relative file
hashes, bare package names, sanitized lockfile version/integrity records, and
explicit opaque reasons. `complete` means complete only within this static-import
inspection profile, never a complete execution graph. This inventory enters
`projectSha256`, so changing a recorded helper, package manifest or npm lockfile invalidates the operator pin.
Inspection never imports application modules, installs packages or performs
network resolution. It follows relative static imports, re-exports and literal
dynamic imports inside the project, including JSON and Node-strippable TypeScript
helpers. Cycles are visited once. Local package scopes' `package.json` files and
root/parent-site `package.json`, `package-lock.json` and `npm-shrinkwrap.json`
bytes are hashed; raw metadata and registry URLs are not printed.

The inventory is bounded to 256 files, 2 MiB per file and 8 MiB total, with at
most 256 opaque reasons and 256 package names. An outside-project import,
symlink, missing file,
computed import, CommonJS/created loader, unparsed source or exceeded budget
is reported as opaque (`complete: false`), not forbidden in trusted code.
Package implementation files are not traversed: npm lock bytes identify the
reviewed dependency selection, not the bytes actually installed in
`node_modules`. An installed-package edit without a lock change is not detected.
Lock metadata is a root-lock identity hint, not Node's resolved export/condition
or nested package identity. This is explicitly incomplete dependency review,
not an execution allowlist or a complete supply-chain attestation. Opaque
code and ambient filesystem/network reads require separate human review.
Operator host files and registrations remain separately trusted operator code;
this application-entry inventory does not include them. Supplying `--host-file`
to a command can execute that host module, independently of passive inventory.

The existing entry-file pin remains even if inventory limits prevent recording
an entry in the inventory. A helper change beyond those limits is not detected.
Changing the digest does not clear Node's transitive module cache: restart to
load changed helpers as described under the trusted execution limitations above.
Granting a secret makes it available to every middleware/function in its route;
trusted code retains full Node access. Authorized code can return granted data
in its response. Minimize grants, use scoped credentials and revoke/restart when
needed. Other routes get none of that injected context.

The same `routes[pattern].env` grant covers an `extension:` mount's `env`
block: the compiled values reach the extension as `ExtensionRequest.env` and
its project hooks as `context.env`, and an ungranted reference fails
activation exactly as it does on a function route. `secrets` are refused on an
extension route. Extension code and hooks are trusted in-process code, so this
grant is an injection convenience, not a restriction: it governs what URLCode
hands them, not what they can read from `process.env` themselves. See
[extensions][docs/EXTENSIONS.md#request-context-route-env-and-request-id].

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
remain trusted computing components that need patching and review. The per-worker
WebAssembly memory cap bounds each guest, but not the host worker's own V8 and
native memory or the rest of the process; use OS/container memory/CPU/PID limits
as an additional layer. Native engine bugs or resource exhaustion remain residual risks.
For a public arbitrary-code/multi-tenant service, require independent security
review plus process/VM-level isolation and operational controls before launch.
Do not advertise this release as an audited hostile multi-tenant hosting platform.

**Node 24 and `sandbox: true`.** Node 24.x up to at least v24.21.0 carries a V8 bug
([nodejs/node#66366](https://github.com/nodejs/node/issues/66366)): when worker
threads running WebAssembly are terminated, as the sandbox pool does on a guest
deadline or failure, V8 can double-free a wasm-to-JS import wrapper and abort
the **whole process** with `Check failed: jit_page_->allocations_.erase(addr) == 1`.
Guest deadlines are reachable from request input. Until a Node 24 release
includes the backport ([nodejs/node#66376](https://github.com/nodejs/node/pull/66376)),
start a Node 24 server that serves `sandbox: true` routes with
`node --no-wasm-code-gc`. The flag only delays reclaiming unused wasm machine
code, and sandbox limits are unchanged. It must be on the command line, because
`NODE_OPTIONS` does not accept it. Alternatively, run Node 22 or 26, where the
bug was not reproduced upstream. The repository's test runner passes the flag
(`npm run test:shard`); see #708.

Implementation references: [QuickJS/WASM project](https://github.com/justjake/quickjs-emscripten)
and its [runtime isolation/limits API](https://github.com/justjake/quickjs-emscripten/blob/main/doc/quickjs-emscripten/classes/QuickJSRuntime.md).

<!-- urlcode-current-version:start -->
[docs/HTTP.md#responses]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.6/docs/HTTP.md#responses
[docs/SPECIFICATION.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.6/docs/SPECIFICATION.md
[docs/EXTENSIONS.md#project-level-lifecycle-hooks]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.6/docs/EXTENSIONS.md#project-level-lifecycle-hooks
[docs/CAPACITY.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.6/docs/CAPACITY.md
[docs/SPECIFICATION.md#streamed-responses]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.6/docs/SPECIFICATION.md#streamed-responses
[docs/EXTENSIONS.md#request-context-route-env-and-request-id]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.6/docs/EXTENSIONS.md#request-context-route-env-and-request-id
<!-- urlcode-current-version:end -->
