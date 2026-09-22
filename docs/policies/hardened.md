# Policies: The built-in `hardened` profile and hardening guidance

Part of [policies](../POLICIES.md), which holds the shared rules and the per-target table.

## The built-in `hardened` profile

`policies.profile: hardened` expands to the following and nothing else, so it
can be read in one place and overridden key by key. This is
`builtinProfiles.hardened` in `packages/core/src/policies.ts`:

```yaml
policies:
  security: { headers: oshp }
  agents: { deny: [ai-crawlers], status: 403 }
  throttle: { quota: 120, window: 60, partition: client, status: 429 }
  compression: { encodings: [br, gzip], minBytes: 1024 }
  cache: { strategy: revalidate }
```

The numbers are starting points chosen to be safe for a single small instance;
they are not tuned for any workload and not a security assessment of your
deployment. Note what the profile implies per target: on Vercel and AWS it
refuses activation as written, because `throttle.partition: client` is
refused there; set `throttle: false` (or `partition: route`) at the project
or route level. `compression` is delegated to the platform. On Cloudflare
only `agents` and `security` survive and `compression` is delegated, so the
profile must also drop `throttle` and `cache` there.
There is no `strict` profile: anything stricter is a per-project decision.

## Hardened configuration guidance

Advice, not defaults, condensed from the spike's section 6.

1. **Network and edge first.** Volumetric protection, TLS termination and
   per-client connection budgets stay with the provider or the reverse proxy.
   Runtime policies are a second layer, never the first.
2. **Ingress to origin.** Bind privately; allow only the proxy's addresses;
   pass `--trusted-proxies` so `client` partitioning sees the real peer.
3. **Request policies.** Agents before throttle: denials are cheaper than
   counting. Start throttle in `mode: report` for a release to see real
   quotas in the headers and logs, then switch to `enforce`.
4. **Allow before deny.** Keep an explicit allow for the crawlers you need
   indexed; a broad deny without one is the common self-inflicted outage.
5. **Route contract.** Exact methods, `request.body` limits and `expires` on
   campaign routes still do most of the work.
6. **Response policies.** Security headers on every route; compression only
   on listed types and never on secret-bearing responses (the BREACH class of
   attack, which is why compression is skipped where a route declares secrets
   unless `allowWithSecrets` says otherwise); caching only with a strategy
   whose semantics you can state, `immutable` only on content-hashed paths,
   `no-store` everywhere else.
7. **Lists as pinned data.** Bundled agent lists ship with the release, so a
   rollback rolls the list back too.
8. **Read the table.** Check `urlcode routes` on each target you deploy to;
   the same YAML is refused where it cannot be enforced, and that is the
   point.
