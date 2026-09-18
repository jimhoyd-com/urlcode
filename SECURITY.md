# Security boundary

This repository is an actively reviewed implementation, not an independent security assessment or a hostile multi-tenant authentication platform. Report a suspected vulnerability privately using the security reporting channel on the repository hosting this reviewed source; do not include passwords, session cookies, live recovery tokens or customer databases in public issues. If no private reporting channel is configured, ask the maintainer for one before sending sensitive details.

## Trusted and untrusted components

Operator modules, their dependencies, configuration, database directory, encryption/CSRF keys, identity providers and mail transport are trusted. Project routes and sandboxed guest code do not gain authority to load host modules. Core extension activation requires an explicitly supplied registry and a reviewed exact project revision pin. Never turn revision inspection into automatic approval.

Auth is Node/SQLite only. It refuses unpatched SQLite versions and requires private database files. Keep the database, WAL/SHM, backups, operator modules and key files outside the application project and inaccessible to guest filesystem access. Do not run the host as a shared hostile operating-system user. Filesystem permission and symlink checks do not defend against an attacker who already controls the operator account or its parent directories.

**Same-origin browser JavaScript is trusted.** HttpOnly cookies and stripped guest server headers do not isolate frontend JavaScript served on the account origin. Such JavaScript can fetch a CSRF value and send requests with ambient cookies. Serve only reviewed frontend content on that origin, or isolate the authentication surface on a different origin with explicit narrowly scoped integration. A WASM sandbox for server code is not a browser-content sandbox.

## Authentication and authorization

Use HTTPS with a canonical operator-specified origin, never an untrusted Host header. Cookies are Secure, HttpOnly and host-scoped. Unsafe HTTP operations require unambiguous same-origin and browser/session-bound CSRF proof. An XSS or compromised trusted dependency can cross this boundary; CSRF tokens do not prevent same-origin XSS.

Session tokens are opaque and stored as hashes. TOTP/recovery/code consumption and administrative invariants use transactions. Role changes and account state changes invalidate relevant sessions. Fresh authentication, ceilings and last-administrator checks are service responsibilities, not UI-only safeguards. Use actor-token administrative methods for delegated users; unrestricted operator methods are not HTTP authorization APIs.

Impersonation is opt-in, excludes privileged targets, expires, and denies account security/administrative mutations. The built-in account page shows a warning. Arbitrary guest pages do not automatically receive a universal impersonation banner; do not assume otherwise. Never expose an unrestricted issueSession or operator service method to a client.

Metadata is never a permission source. Private fields must stay out of public projections; public/unsafe fields are untrusted. Render translated/user text as text, not markup. Operator theme inputs are constrained; arbitrary project templates are deliberately excluded.

## Operational limitations

Rate limits, worker bounds and request limits reduce specific abuse paths; they do not replace perimeter admission controls or deployment capacity testing. Review proxy/client identity configuration. Do not weaken MFA because an email/reset flow is inconvenient. Provider account linking must remain explicit and issuer/subject-scoped rather than inferred from matching email.

Emails can fail or be delayed. Preserve an operator recovery procedure for deletion cancellations, email changes and provider outages. Do not log token-bearing callback URLs, passwords, codes, session headers or mail bodies. Development console/file senders intentionally expose development credentials and require explicit opt-in.

Backups contain sensitive account records and password hashes. Preserve keys separately, retain the exact reviewed configuration, test isolated restores, and plan session/token revocation when restoring old data. An integrity check proves database consistency, not freshness, provenance or absence of malicious operator modifications. Key rotation is not a substitute for revoking compromised sessions or rotating other credentials.

Synthetic tests do not prove real provider delivery, browser/device compatibility, accessibility conformance, production resilience, recovery time or independent security review. Keep those claims separate from local verification results.

This repository follows the [core URLCode security policy](https://github.com/jimhoyd-com/urlcode/blob/main/SECURITY.md) for reporting and support baseline.
