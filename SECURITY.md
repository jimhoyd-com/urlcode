# Security boundary

The admin console is a privileged client of URLCode auth's service API. Its operator modules, dependencies, service instance, keys and notification transport are trusted. It is not a replacement for the runtime's separately credentialed infrastructure management endpoints, and it does not make a hostile multi-tenant deployment safe.

Use the reviewed core extension contract and an explicit static project revision pin. Host modules and database/key files belong outside the application project. Use Node with patched SQLite, HTTPS and a canonical operator-provided origin. Share the auth service and CSRF key intentionally; do not discover plugins or database credentials from project YAML.

Same-origin frontend scripts share browser authority. HttpOnly cookies and server guest-header filtering do not prevent such scripts from obtaining CSRF proof and issuing authenticated requests. Auth/admin must run beside trusted frontend content or on a separately isolated origin. Restrictive response CSP does not repair other compromised pages on the same origin.

Every delegated mutation must use an actor-token auth service method. UI hiding is not authorization. The service rechecks current privileges, freshness, delegation ceilings, target version/state and last-administrator constraints inside transactions. Do not expose unrestricted operator APIs through generic HTTP dispatch. Account metadata and role names supplied by users never grant permissions.

Case approval requires distinct authorized actors and a current target. A two-person approval transaction is not identity proof: establish a documented human evidence procedure for account recovery. Keep meaningful reasons and protect the audit trail. Review permissions before assigning support roles.

Impersonation is explicit and bounded, excludes privileged targets, and cannot perform security/admin step-up actions. Notifications are required before returning a usable impersonation session. The built-in account page carries a warning; arbitrary guest pages do not automatically show one. Do not claim universal banners or use impersonation as a substitute for least-privilege diagnostic tooling.

Protect database backups, audit exports, operator stdin and notification records as sensitive data. Never post passwords, tokens, keys or live customer database files in public issues. Report vulnerabilities using the repository's private security reporting channel; if none is configured, request a private contact before sharing sensitive evidence.

Passing tests do not establish independent assessment, real-provider compatibility, production recovery/soak behavior or WCAG conformance. Track those checks separately. The console's partial reporting and case workflows should not be described as completion of every item in the design proposal.

This repository follows the [core URLCode security policy](https://github.com/jimhoyd-com/urlcode/blob/main/SECURITY.md) for reporting and support baseline.
