# Untrusted function execution

Application code is untrusted even when it came from your own Git repository.
A compromised dependency, template or contribution must not inherit the URLCode
server's authority. Alpha.2 replaces alpha.1's Node execution entirely. There
is no `unsafe`, `trusted` or automatic host-execution fallback.

## Boundaries enforced now

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
[implemented contract](SPECIFICATION.md). Existing functions using Node/network
or binary/stream APIs must be rewritten for the supported profile or wait for a
reviewed capability implementation. Redirects need none of this machinery.

## Granting selected bindings

An application may request a named binding in YAML, but only an operator can
approve it. Inspect what the app requests without executing any module:

```sh
urlcode permissions --project /srv/gitroll-link
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
urlcode validate --project /srv/gitroll-link --policy /etc/urlcode/gitroll-link-policy.json
urlcode serve --project /srv/gitroll-link --policy /etc/urlcode/gitroll-link-policy.json
```

`dev`, `test` and `validate --local` use the same policy rules even for `.env.local`.
The JavaScript API accepts an equivalent operator-supplied `permissions` object.
Every config/module change invalidates the grant; inspect/review the new revision
before updating the operator file. Policies are read at startup, not hot-reloaded.
A failed development candidate leaves the previous approved snapshot running.

Granting a secret deliberately makes it available to every middleware and function
in that route. Middleware sources and their dependencies are included in the
approval digest; changes invalidate grants. The whole chain shares one fresh
guest heap and one execution deadline. Code can
include any granted data in its HTTP response. A sandbox cannot promise secrecy
from code authorized to read a value. Minimize grants, use scoped/short-lived
credentials and revoke/restart when needed. Other routes get none of that context.

## Native live-link storage

The optional `link` handler can read an explicitly operator-bound collection.
Its database is outside the project and public serving opens it read-only. This
is a native handler, not a guest capability: functions/middleware receive no SQL,
filesystem handle, database path or management token. Native link data changes do
not authorize new code or bindings. Management requires a separate operator CLI
or token-protected listener. See [dynamic links](DYNAMIC-LINKS.md).

## Next capability work

Outbound requests need a host-owned broker with explicit destination/method
allowlists, private/metadata/loopback-address restrictions, DNS/rebinding defenses,
redirect revalidation, deadlines and byte/concurrency limits. Application YAML
must not grant those permissions. Persistent state needs similarly scoped access.
Until such brokers are implemented and tested, these capabilities are unavailable.
Provider adapters must preserve this boundary or reject deployment; they cannot
silently replace sandbox execution with unrestricted Node functions.

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
