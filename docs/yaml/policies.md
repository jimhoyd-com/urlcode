# YAML guide: Policies and profiles

Snippets are entries under `routes:` unless stated otherwise; the [guide index](../YAML-GUIDE.md) lists every page.

## 15. Protect a route with an extension

```yaml
version: "1"
extensions:
  auth: { version: "1", config: {} }
routes:
  /api/auth/*: { extension: auth, methods: [GET, POST] }
  /private:
    respond: { text: Signed in }
    auth: true
```

`extensions` names a logical, operator-installed extension; it never names a
package, database or credential. `/api/auth/*` mounts the extension itself as
the handler (auth serves Better Auth's sign-in and session endpoints under
that prefix). `auth: true` on `/private` is the short form for requiring the
declared extension that provides the request principal (here `auth`) on a
route that has its own handler; it expands to `policies.extensions.auth: {}`,
which accepts no keys — write one form or the other, never both. Without a
signed-in session the route answers `401`. Declaring `auth` in a project with
no principal-providing extension, or more than one, refuses to load. See
[auth](../../packages/auth/README.md#protect-a-route) and
[extensions](../EXTENSIONS.md) for the full contract, including extension
middleware and lifecycle hooks.

## 16. Hardened profile and per-route overrides

```yaml
version: "1"
policies:
  profile: hardened               # security, agents, throttle, compression, cache
  throttle: { quota: 60, window: 60 }   # tighten one number; the rest stays
profiles:
  public-api:
    security: { headers: oshp-no-csp, set: { x-robots-tag: noindex } }
    cache: { strategy: swr, maxAge: 30, staleWhileRevalidate: 300 }
routes:
  /:
    page: {file: pages/index.html}
  /api/lookup/{id}:
    parameters:
      - {name: id, in: path, required: true, schema: {type: string, maxLength: 64}}
    function: {source: functions/lookup.mjs}
    policies:
      profile: public-api          # merges over the project layer
      throttle: {quota: 10, window: 60, partition: client-route}
  /healthz:
    respond: {text: ok}
    policies: {throttle: false, agents: false}
```

Everything under `policies` is optional and off unless declared. The project
block sets defaults, a route block adjusts them, `false` removes one policy for
that route and an object merges shallowly over what is below it. `hardened`
is the only built-in profile; `profiles` defines your own. Serve with
`--trusted-proxies` when a proxy sits in front so `client` partitioning sees
the real peer. Not every target accepts every policy: see the per-target
table in [policies](../POLICIES.md) before deploying the same YAML to an adapter.
