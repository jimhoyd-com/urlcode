# Security boundary

The admin console is a privileged client of URLCode auth's service API. Its operator modules and dependencies are trusted. It holds no auth secret: it reads auth's `AuthExports` v1 (the signed-in account, a CSRF token, auth's URLs and the actor-bound administration API) and audit's `AuditExports`, and imports only types from auth. It manages auth accounts, not infrastructure, and it does not make a hostile multi-tenant deployment safe. Core no longer provides its former link-management API.

Use the reviewed core extension contract and an explicit static project revision pin. Host modules and database/key files belong outside the application project. Use Node with patched SQLite, HTTPS and a canonical operator-provided origin. The `/admin/*` mount must carry auth's policy (`auth: {onDeny: 404}`), which resolves the session and verifies CSRF before admin runs; do not discover plugins or database credentials from project YAML.

Same-origin frontend scripts share browser authority. HttpOnly cookies and server guest-header filtering do not prevent such scripts from obtaining CSRF proof and issuing authenticated requests. Auth/admin must run beside trusted frontend content or on a separately isolated origin. Restrictive response CSP does not repair other compromised pages on the same origin.

Every delegated mutation goes through auth's administration API with the opaque actor auth minted for the request's session; auth rechecks the session, permission and freshness on every call, and sends every credential-bearing email itself, so no raw token reaches admin. UI hiding is not authorization. The service rechecks current privileges, freshness, delegation ceilings, target version/state and last-administrator constraints inside transactions. Do not expose unrestricted operator APIs through generic HTTP dispatch. Account metadata and role names supplied by users never grant permissions.

Case approval requires distinct authorized actors and a current target. A two-person approval transaction is not identity proof: establish a documented human evidence procedure for account recovery. Keep meaningful reasons and protect the audit trail. Review permissions before assigning support roles.

Impersonation is explicit and bounded, excludes privileged targets, and cannot perform security/admin step-up actions. Auth notifies the account through mail before returning a usable impersonation session, and refuses the impersonation when it cannot. Auth's middleware shows a support banner on every route an auth policy guards; public pages without one show nothing. Do not claim universal banners or use impersonation as a substitute for least-privilege diagnostic tooling.

Protect database backups, audit exports, operator stdin and notification records as sensitive data. Never post passwords, tokens, keys or live customer database files in public issues. Report vulnerabilities using the repository's private security reporting channel; if none is configured, request a private contact before sharing sensitive evidence.

Passing tests do not establish independent assessment, real-provider compatibility, production recovery/soak behavior or WCAG conformance. Track those checks separately. The console's partial reporting and case workflows should not be described as completion of every item in the design proposal.

This package follows the [core URLCode security policy](../../SECURITY.md) for reporting and support baseline.
