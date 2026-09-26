# YAML guide: Policies and profiles

Snippets are entries under `routes:` unless stated otherwise; the [guide index](../YAML-GUIDE.md) lists every page.

## 15. Protect a route with an extension

```yaml
version: "1"
extensions:
  auth: { version: "1", config: { registration: "off" } }
routes:
  /account/*: { extension: auth, methods: [GET, HEAD, POST] }
  /private:
    respond: { text: Signed in }
    auth: { role: member }
```

`extensions` names a logical, operator-installed extension; it never names a
package, database or credential. `/account/*` mounts the extension itself as
the handler (auth owns everything under that prefix). `auth: {...}` on
`/private` is the short form for requiring the installed `auth` extension on a
route that has its own handler; it expands to `policies.extensions.auth` and
accepts only `required`, `role`, `permission`, `verified`, `freshWithinSeconds`
and `onDeny` — write one form or the other, never both. Declaring `auth` in a
project without `extensions.auth` refuses to load. See
[extensions](../EXTENSIONS.md#protecting-a-route-the-auth-short-form) for the
full contract, including extension middleware and lifecycle hooks.

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
