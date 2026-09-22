# Policies: The policy contract and your own patterns

Part of [policies](../POLICIES.md), which holds the shared rules and the per-target table.

## The policy contract in TypeScript

The policies are modules of one shape, `PolicyModule<Config, State>` in
`packages/core/src/types.ts`: `targets`, `compile`, `onRequest`, `onResponse`, optional
`onError`, `describe` and `close`. `@jimhoyd/urlcode/policies` exports that type with
`PolicyRequest`, `PolicyContext`, `PolicyChain`, `PolicyShared` and
`PolicyRegistry` (the five built-ins keyed by name), and the declarations ship
with the package. A per-policy configuration is typed as the YAML it accepts,
and a `profiles` layer may hold a partial one:

```ts
import { registry, targets, type PolicyRegistry, type PolicyRequest } from '@jimhoyd/urlcode/policies';

const throttle: PolicyRegistry['throttle'] = registry.throttle;   // PolicyModule<ThrottleConfig, ThrottleState>
const support = throttle.targets({ quota: 120, window: 60, partition: 'client', status: 429 });  // per-target support for this config
console.log(support.vercel, support.cloudflare);
function inspect(request: PolicyRequest): void { console.log(request.route, request.client, targets); }
```

The registry is read-only: a project cannot add a policy from YAML, and an
operator adds behavior through [plugins](../PLUGINS.md), not by editing it.

## Supplying your own patterns

The runtime ships mechanisms and one named profile, not an opinion about who
should be blocked. Ways to express your own:

- **Custom profiles.** Define any number under `profiles` and select one per
  project or per route. Profiles are plain data and travel with the YAML.
- **Per-route overrides.** Any key can be tightened, replaced or set to
  `false` on a route.
- **Own agent lists.** `agents.deny` and `agents.allow` accept bundled list
  names and project-relative `.json` files in the same schema, so a list you
  do not want to redistribute stays yours. `denyPatterns`/`allowPatterns`
  take a bounded, linear-time pattern subset. See [agents](agents.md).
- **Header by header.** `security.set` adds or overrides a header and wins over
  the profile, YAML `response.headers` and handler output; `security.unset`
  drops one the profile would emit. Headers the runtime or a handler owns
  (`content-type`, `cache-control`, `set-cookie`, `etag`, `location`, and the
  rest listed in `packages/core/src/policies/security.ts`) cannot be `set`.
  See [security](security.md).
- **Explicit cache fields.** A strategy sets defaults; `maxAge`,
  `staleWhileRevalidate`, `staleIfError`, `cdnMaxAge`, `originTtl`, `vary`,
  `statuses`, `maxBytes` and `maxEntries` override what it implies.
  See [cache](cache.md).
- **Plugins.** Verified-bot checks, shared-store throttling, purge endpoints
  and anything vendor-specific are host code an operator passes in;
  see [plugins](../PLUGINS.md).
