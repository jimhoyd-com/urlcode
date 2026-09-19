# Project governance

URLCode UI (@jimhoyd/urlcode-ui) is the shared presentation package for URLCode extensions. It is a maintainer-led
Apache-2.0 project that follows the governance of the core URLCode repository
([jimhoyd-com/urlcode/GOVERNANCE.md](https://github.com/jimhoyd-com/urlcode/blob/main/GOVERNANCE.md));
this file records how that governance applies here. @jimhoyd maintains the
repository. The package is published to npm as alphas while integration with
core is reviewed; the documented contract describes implemented behavior, not
planned work.

## Changes and responsibility

Use pull requests with a clear problem, behavior and verification record. The
maintainer decides scope and merges after required checks pass and conversations
are resolved. `main` disallows force pushes/deletion and requires an up-to-date
branch, CI and PRs. Squash merges preserve linear history. No ruleset bypass is
configured for administrators or automation.

There is currently one maintainer, so review approval count is zero: PRs and CI
are mandatory, but an independent human review is not yet guaranteed. CODEOWNERS
records ownership. Add a required independent approval when the trusted maintainer
team grows. Revisit controls as the maintainer team and deployment scope grow.

## Release and security controls

CI actions are pinned to immutable revisions. Dependabot proposes npm (development dependencies only; the package has no runtime dependencies) and GitHub Actions updates; updates are reviewed and tested, not
auto-merged. Workflow tokens default to read-only and cannot approve PRs. Secret
scanning/push protection, dependency security alerts and private vulnerability
reporting are enabled. CodeQL scans the JavaScript/TypeScript code; its results
are required on main, with high/critical security findings and error-level alerts
blocking merges. External contributors require maintainer approval before their
workflows run, and only GitHub-owned actions are allowed by repository policy.
Keep sensitive reports in the private security channel.

Only current reviewed main receives fixes; there is no LTS/backport guarantee or
release SLA. The package is published to npm as alphas; reviewed-source builds
from an exact commit remain the alternative (see
[CONTRIBUTING.md](CONTRIBUTING.md)). Pin exact versions or commits to identify
patches. Independent assessment and deployment exercises
remain required before claiming hostile multi-tenant or deployment-specific
readiness.

## Licensing and participation

URLCode UI is licensed under [Apache-2.0](LICENSE). Contributions follow the terms
in [CONTRIBUTING.md](CONTRIBUTING.md); there is no separate CLA or DCO. Preserve
license notices and review third-party licensing when accepting dependencies or code.
Feedback, bug reports and documentation requests are welcome. Follow the
[contribution guide](CONTRIBUTING.md), [code of conduct](CODE_OF_CONDUCT.md) and
[security policy](SECURITY.md).
