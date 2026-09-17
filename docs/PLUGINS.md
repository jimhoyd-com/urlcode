# Host plugins

A plugin is host code an operator passes to the runtime in JavaScript. It sees
every request after the route is matched and before the handler runs, may
answer it outright, and sees every response before it is written. The
declarative [policies](POLICIES.md) are implemented on the same hook names,
so first-party and operator behavior share one code path and one test seam.

Plugins are not part of the project format. Nothing in YAML names a plugin or
an npm package; the operator application passes them to `startServer`,
`createRuntime`, `createVercelHandler` or `createLambdaHandler`. A project stays
portable while an operator can still add a shared-store limiter, a verified-bot
check or a purge endpoint. Plugins run in the host process with the host's
privileges: they are the operator's trust boundary, not the project's, and the
runtime does not sandbox, review or limit what a plugin does with a request.
Treat a plugin like any other dependency of the operator application.

## Passing plugins

```js
import { startServer } from 'urlcode';

await startServer({
  project: './site',
  trustedProxies: ['10.0.0.0/8'],
  plugins: [auditPlugin],
});
```

`createRuntime(project, { plugins })` takes the same array for embedding
without the HTTP server. `createVercelHandler({ plugins })` and
`createLambdaHandler({ plugins })` pass it through to the adapter's runtime
with the target set to `vercel` or `aws`. The Cloudflare build takes no
plugins: the Worker carries only compiled policies. `runtime.plugins` lists
the activated `{ name, version }` pairs.

## Plugin shape

```js
const auditPlugin = {
  name: 'audit',                 // ^[a-z][a-z0-9-]{0,63}$, unique per runtime
  version: '1.0.0',              // any string up to 64 characters
  targets: ['node', 'vercel'],   // subset of node, vercel, aws, cloudflare
  async onActivate(runtime) {},                    // may throw to refuse activation
  async onRequest(request) {},                     // return a result to short-circuit
  async onResponse(request, result) { return result; }, // return the result to send
  onError(request, error) {},                      // observe a thrown error
  async onClose() {},                              // release resources
};
```

Validation happens at activation, before any request: at most 32 plugins,
each an object with a kebab-case `name` no other plugin uses, a `version`
string and a `targets` array of known target names; every declared hook must
be a function and at least one must be present. A plugin whose `targets` does
not include the runtime's target is refused with
`Plugin "name" does not support the vercel target`, mirroring how adapters
refuse routes, so the same operator application fails fast where a plugin's
assumptions do not hold.

`onActivate(runtime)` receives `{ testPlan(), version, root, target }`.
`testPlan()` returns the route inventory (`inventory[].policies` names the
effective policies per route) and `policies`, the per-route policy summaries
with their `target` value, so a plugin can inspect what it is joining and
throw to refuse. Hooks may be async; the runtime awaits them.

## The request object

Every request hook receives the same object the policies see, built once per
request by `policyRequest` in `src/policies.js`:

| Field | Value |
|---|---|
| `method` | Request method, upper case |
| `target` | Raw request target (path plus query string) as received |
| `path` | Parsed path |
| `params` | Route parameter values by name |
| `query` | Parsed query as `URLSearchParams` |
| `headers` | Request `Headers` |
| `headerCounts` | Occurrences per header name, lower case, so a duplicated scalar header can be detected (empty on Cloudflare, where the platform joins repeats) |
| `client` | Client address as the host resolved it through `--trusted-proxies` or the platform's connection address, or `null` when none could be resolved. Never a raw forwarded header |
| `origin` | Public origin the runtime was told (`--origin`, `URLCODE_ORIGIN` or the platform's), used for HSTS and absolute URLs |
| `route` | The matched route's configured pattern, never request text |
| `secrets` | `true` when the route declares secret bindings |

The object identity is stable for the life of the request, so a plugin may key
a `WeakMap` on it to carry state from `onRequest` to `onResponse`. Nothing on
it reaches the guest: there is no sandbox handle, no deadline, no `env` or
`secrets` values and no binding. A plugin cannot extend or shorten a function's
deadline, read or write guest state, or obtain a binding the operator policy
did not grant to the route.

## Results

A result is what the runtime writes:

```js
{ status: 429, headers: [['content-type', 'text/plain; charset=utf-8'], ['retry-after', '30']], body: Buffer.from('Too many requests\n') }
```

`headers` is an array of `[name, value]` pairs; `body` is a `Buffer`
(a `Uint8Array` on Cloudflare). `onRequest` returns such a result to answer the
request without running the handler, or `undefined` to continue. `onResponse`
returns the result to send; returning `undefined` keeps the one it was given.
Replace rather than mutate. Every result still passes through the shared
response writer on the way out: the status must be an integer from 200 to 599,
header names and values are validated (an invalid one fails the request as a
function's would), hop-by-hop headers and `Content-Length` are dropped and
recomputed, `X-Request-Id` and `X-Content-Type-Options: nosniff` are added, and
`Cache-Control: no-store` is added when the result carries no `Cache-Control`.
HEAD and 204/205/304 results are sent without a body.

## Ordering

Plugins wrap everything else. On the request side the first plugin in the
array runs first, then the second, then the policies (`agents`, `throttle`,
`cache`), then the route contract and the handler. On the response side the
policies run, then plugins in reverse: the first plugin sees the request first
and the response last, the standard onion. A short-circuit from any
`onRequest` skips the remaining plugins, every policy request hook and the
handler, and goes straight to the response side; the response hooks of
policies with a request phase are skipped for it (nothing is cached, no
rate-limit headers), security headers and compression still apply, and every
plugin's `onResponse` still runs.

`onError` hooks run in reverse order for an error the runtime throws after
the request object exists (404 for a disabled route is thrown before it; a
405 is an ordinary result and reaches `onResponse`). They observe only: a
throw inside `onError` is swallowed and the outcome stands. A policy's error
hook may answer with a fallback instead; when one does, plugin `onError`
hooks do not run and plugin `onResponse` hooks see the fallback (no
first-party policy returns one today). `onClose` runs in reverse order when
the runtime closes, after the policies have released their state; a throw
there is ignored.

On a reload the same plugin objects are activated again: `onActivate` runs
for the new runtime before `onClose` runs for the retired one, so plugin
state persists unless `onClose` discards it. An `onActivate` that throws
rejects the reload and the old runtime keeps serving.

## What a plugin cannot do

- Reach inside the guest, extend a deadline or see bindings: the request
  object carries none of those, and there is no other handle.
- Change a project's routes or policies after activation; `onActivate` can
  refuse, not rewrite.
- Be selected from YAML. A project cannot require a plugin, and a plugin's
  presence does not change how the project validates.
- Change a thrown error's status or body from `onError`.
- Run on Cloudflare: the Worker carries compiled policies only.

## Sketches

Both examples are sketches, not shipped code: they omit error handling,
configuration and the store or verifier they depend on.

### Shared-store throttle

The built-in `throttle` keeps counters per instance. Across replicas an
operator needs a shared store; a plugin keys it on the resolved client and the
route pattern, both of which the request object already carries.

```js
// Sketch. `store.increment(key, windowSeconds)` is a fixed-window counter
// in a shared store and returns the count after increment.
export function sharedThrottle({ store, quota, window }) {
  return {
    name: 'shared-throttle', version: '0.1.0', targets: ['node', 'vercel', 'aws'],
    async onRequest(req) {
      const key = `${req.route}|${req.client ?? 'shared'}`;
      const used = await store.increment(key, window);
      if (used <= quota) return undefined;
      return {
        status: 429,
        headers: [['content-type', 'text/plain; charset=utf-8'], ['cache-control', 'no-store'], ['retry-after', String(window)]],
        body: Buffer.from('Too many requests\n'),
      };
    },
  };
}
```

Combine it with `policies.throttle: false` on the routes it covers, or keep
the built-in policy as a per-instance ceiling underneath it.

### Verified-bot allow

The `agents` policy matches strings only. Verifying that a request claiming to
be a search crawler really comes from one (reverse DNS as the major engines
document, or an HTTP Message Signature per the web-bot-auth drafts) needs a
network lookup and a cache, so it is a plugin. The sketch answers 403 to a
claimed crawler whose address does not verify and lets everything else
continue to the `agents` policy.

```js
// Sketch. `verify(address)` resolves the address back to the crawler's
// documented domains and caches the answer; it is not part of the runtime.
export function verifiedBots({ verify, claims = /Googlebot|bingbot/i }) {
  return {
    name: 'verified-bots', version: '0.1.0', targets: ['node'],
    async onRequest(req) {
      const agent = req.headers.get('user-agent') || '';
      if (!claims.test(agent) || !req.client) return undefined;
      if (await verify(req.client)) return undefined;
      return { status: 403, headers: [['content-type', 'text/plain; charset=utf-8'], ['cache-control', 'no-store']], body: Buffer.from('Forbidden\n') };
    },
  };
}
```

A plugin that logs should follow the policies' rule: record the route pattern
and the outcome, not the client address or the User-Agent string.
