# @jimhoyd/urlcode-abuse

## Unreleased

- New add-on: the persistent, pseudonymous abuse counters that used to live inside auth, now available to any
  extension through `AbuseExports` v1.
  - **Namespaces, budgets and backoffs:** namespaced fixed-window budgets with atomic `admit`, a Retry-After, and
    challenge escalation; exponential failure backoff.
  - **Pseudonymous keys:** HMAC-SHA256 counter keys under the scaffolded `data/abuse.key`.
  - **A bounded table:** `maxKeys` answers 503 when full, and each add sweeps expired rows first.
  - **A challenge wrapper:** a deadline, a concurrency bound and widget validation around any provider.
  - **Turnstile and honeypot:** the Turnstile provider moved from auth, with the action generalised to the
    caller's namespace, and a honeypot helper.
  - Node only, with no routes.
