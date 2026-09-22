# Security boundary

Forms is trusted operator code that runs in the host process. It is not a
sandbox or a multi-tenant boundary. Project form configuration cannot select a
module, secret, storage directory, or provider. The host supplies a 32-byte-or-
longer CSRF secret and a reviewed project revision pin; never put either in
project YAML or an application repository.

The extension issues a short-lived (10-minute) HMAC-protected CSRF token on
each form page, checks the canonical `Origin` header when present — falling
back to `Sec-Fetch-Site`, then `Referer`, and refusing the request when
neither gives same-origin evidence, rather than admitting an absent `Origin`
by default — accepts only bounded `application/x-www-form-urlencoded` bodies,
rejects duplicate declared fields, and returns fixed field messages. A 422
response deliberately re-renders only that request's submitted values so the
caller can correct the form; those values are HTML-escaped and never appear in
generic error messages, logs, or a later caller's page. The form response and
confirmation are `no-store` by the core extension privacy floor.

**CSRF token binding and reuse.** The token is bound to the caller: it embeds
a purpose tag (`urlcode-forms-csrf`, domain-separated from any other
`createSignedToken` user sharing the host's CSRF secret) and a random value
from an HttpOnly, `Secure`, `SameSite=Strict`, `__Host-`-prefixed
double-submit cookie the extension sets on first render and reuses across
subsequent renders. A token minted for one browser is refused for another
(missing cookie, or a different browser's cookie), and for a different flow.
It is **not single-use**: a valid token may be resubmitted more than once
within its 10-minute TTL. The extension holds no per-token state to enforce
single use (it is otherwise stateless — no store, no database); a flow whose
submission must not be replayable needs an idempotency mechanism of its own
(for example, a nonce or dedupe key checked by the flow's own storage,
typically inside `onSubmit` or the target it calls) rather than relying on
CSRF admission for that guarantee.

An optional `onSubmit` lifecycle hook is trusted project code, exactly like a
normal unsandboxed project function; `sandbox: true` is refused by the generic
extension-hook contract. It should not expose submitted values, and any durable
or remote side effect must be idempotent because a client can retry a valid
POST. Put a mount behind `auth: true` where its submissions require an account;
the form extension does not create identities, ownership rules, rate limits or
storage.

Passing tests does not establish independent security assessment, hostile
multi-tenant readiness, production abuse resistance, or delivery guarantees.
Report suspected vulnerabilities through the repository's private reporting
channel described in the root SECURITY.md.
