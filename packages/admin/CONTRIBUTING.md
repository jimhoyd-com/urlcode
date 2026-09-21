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
an explicit release decision. First-party executable extensions use an immutable
`extension-bundles@v…` tag and the root
[`extension-bundles.yml`](../../.github/workflows/extension-bundles.yml)
workflow; do not publish from a workstation. The bundle workflow requires full
verification of the exact commit and preserves immutable artifacts on retry.
