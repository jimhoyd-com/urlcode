# @jimhoyd/urlcode-abuse

## Unreleased

The definition declares its deployment targets (node), which `npm run build:addons` writes into `urlcode.json` as `targets` (#859); core refuses a registration whose targets differ, and the capability preflight refuses a recipe or plan that uses this extension on any other target.

- New add-on: the persistent, pseudonymous abuse counters that used to live inside auth, now available to any
  extension through `AbuseExports` v1.
  - **Namespaces, budgets and backoffs:** namespaced fixed-window budgets with atomic `admit`, a Retry-After, and
    challenge escalation; exponential failure backoff.
  - **Pseudonymous keys:** HMAC-SHA256 counter keys under the scaffolded `data/abuse.key`.
  - **A bounded table:** `maxKeys` answers 503 when full, each claimed scope holds at most an equal share of it,
    and each add sweeps expired rows first.
  - **A challenge wrapper:** a deadline, a concurrency bound and widget validation around any provider.
  - **Turnstile and honeypot:** the Turnstile provider moved from auth, with the action generalised to the
    caller's namespace, and a honeypot helper.
  - Node only, with no routes.
