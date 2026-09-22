# Security boundary

Forms is trusted operator code that runs in the host process. It is not a
sandbox or a multi-tenant boundary. Project form configuration cannot select a
module, secret, storage directory, or provider. The host supplies a 32-byte-or-
longer CSRF secret and a reviewed project revision pin; never put either in
project YAML or an application repository.

The extension issues a short-lived HMAC-protected CSRF token on each form page,
checks the canonical `Origin` header when present, accepts only bounded
`application/x-www-form-urlencoded` bodies, rejects duplicate declared fields,
and returns fixed field messages. A 422 response deliberately re-renders only
that request's submitted values so the caller can correct the form; those
values are HTML-escaped and never appear in generic error messages, logs, or a
later caller's page. The form response and confirmation are `no-store` by the
core extension privacy floor.

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
