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
double-submit cookie the extension mints on first render and reuses across
subsequent renders. Every render (including a 422 re-render) re-issues that
cookie with the same value and a fresh 10-minute `Max-Age`, so the cookie
always lives at least as long as the token on the page just served. A token minted for one browser is refused for another
(missing cookie, or a different browser's cookie), and for a different flow.
It is **not single-use**: a valid token may be resubmitted more than once
within its 10-minute TTL. The extension holds no per-token state to enforce
single use (it is otherwise stateless — no store, no database); a flow whose
submission must not be replayable needs an idempotency mechanism of its own
(for example, a nonce or dedupe key checked by the flow's own storage,
typically inside `onSubmit` or the target it calls) rather than relying on
CSRF admission for that guarantee.

<a id="confirmation-values"></a>
**Confirmation values.** A flow shows submitted values on its confirmation
only for the fields it lists in `confirmation.show`; no other value leaves the
POST. After a successful submission (and `onSubmit`), the extension seals
those values into an `HttpOnly`, `Secure`, `SameSite=Strict`, `__Host-`
prefixed cookie, `__Host-urlcode-forms-confirmation`, with a 5-minute
`Max-Age`. The seal is AES-256-GCM under a key derived from the host's CSRF
secret with HKDF-SHA256 (info `urlcode-forms-confirmation-v1`, separate from
the CSRF token's HMAC use of the secret), with a random 96-bit nonce per
submission. The flow name and the caller's CSRF binding cookie are
authenticated as associated data and the plaintext carries an expiry, so the
cookie does not open for another flow, another browser (a different or absent
binding cookie), after 5 minutes, or after any modification; each of those
renders the fixed confirmation with no field values and no error. Values never
appear in a URL, and the cookie is ciphertext, not readable plaintext. It is
stateless on purpose, because forms serves node, AWS and Vercel targets where
the confirmation request can reach a different instance than the POST.

The confirmation `GET` clears the cookie whatever its state, so a refresh shows
the fixed page, but this is **not server-enforced single use**: the extension
keeps no record of opened handoffs, and a browser that retained the cookie
could present it again within its 5 minutes. Only that same browser can open
it. Values larger than 2 KiB of JSON are not handed off. The confirmation is
sent with `Cache-Control: no-store` and every value is HTML-escaped before
placeholders are substituted. Changing the CSRF secret invalidates in-flight
handoffs along with CSRF tokens.

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
