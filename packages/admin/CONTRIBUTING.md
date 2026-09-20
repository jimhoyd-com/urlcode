# Contributing

Read SECURITY.md, THREAT-MODEL.md and IMPLEMENTATION-STATUS.md. The admin spike is
the source plan; privileged mutations belong to auth's transactional service, not
ad hoc database writes in the console. Never treat hidden controls as authorization.

Use a feature branch and pull request; preserve protected-main checks and review.
Keep Apache-2.0 licensing. Do not commit dist, real credentials, customer exports
or case evidence. Run `npm run verify` and use the reviewed cross-package tarball
workflow for exports, packaging and initializer changes. Report tested commits and
remaining deployment/security limitations.

## Releasing

Use the root [release coordinator](../../docs/DEVELOPMENT-PIPELINE.md) after
an explicit release decision. This package uses `@jimhoyd/urlcode-admin@<version>`
tags and `.github/workflows/release-admin.yml` in this monorepo; the npm trusted
publisher must name that workflow. Do not use the former standalone `v*` tags
or publish from a workstation. The coordinator waits for each package in
core, UI, auth, admin order and requires full verification of the exact commit.
Registry peer-floor checks run in an isolated copy; local development uses
workspace peers. Retries preserve the original artifacts and immutable tags.
