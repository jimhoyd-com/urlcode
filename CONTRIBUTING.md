# Contributing

Read SECURITY.md, THREAT-MODEL.md and IMPLEMENTATION-STATUS.md. The admin spike is
the source plan; privileged mutations belong to auth's transactional service, not
ad hoc database writes in the console. Never treat hidden controls as authorization.

Use a feature branch and pull request; preserve protected-main checks and review.
Keep Apache-2.0 licensing. Do not commit dist, real credentials, customer exports
or case evidence. Run `npm run verify` and use the reviewed cross-package tarball
workflow for exports, packaging and initializer changes. Report tested commits and
remaining deployment/security limitations.

Never publish from a workstation. A release is a `v<version>` tag on a commit that
is already on `main`, with `<version>` equal to `package.json`'s `version`; pushing
the tag runs `.github/workflows/release.yml`, which verifies against the published
peers at the lower bound of each range, attests the tarball and creates the GitHub
release. The npm publish step runs only when the repository variable `PUBLISH_NPM`
is `true` and the npm trusted publisher for `@jimhoyd/urlcode-admin` names this
repository and `release.yml`; there is no npm token. Publish order for the alphas
is core, then ui, then auth, then admin, so that each release resolves its peers
from the registry.
