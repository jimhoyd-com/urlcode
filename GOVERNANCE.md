# Project governance

URLCode is a maintainer-led executable alpha. @jimhoyd maintains the public
runtime. The public schema/specification describe implemented behavior; the
roadmap describes future work. The free runtime comes first; managed Cloud
follows only after launch, stability and feedback. There is no feature restriction
intended to force self-hosters onto Cloud.

## Changes and responsibility

Use pull requests with a clear problem, behavior and verification record. The
maintainer decides scope and merges after required checks pass and conversations
are resolved. `main` disallows force pushes/deletion and requires an up-to-date
branch, CI and PRs. Squash merges preserve linear history. No ruleset bypass is
configured for administrators or automation.

There is currently one maintainer, so review approval count is zero: PRs and CI
are mandatory, but an independent human review is not yet guaranteed. CODEOWNERS
records ownership. Add a required independent approval when the trusted maintainer
team grows. Revisit controls as the project approaches a stable release.

## Release and security controls

CI actions and the Docker base image are pinned to immutable revisions. Dependabot
proposes npm, action and container updates; updates are reviewed and tested, not
auto-merged. Workflow tokens default to read-only and cannot approve PRs. Secret
scanning/push protection, dependency security alerts and private vulnerability
reporting are enabled. CodeQL scans the JavaScript code. External contributors
require maintainer approval before their workflows run, and only GitHub-owned
actions are allowed by repository policy. Keep sensitive reports in the private
security channel.

Only current reviewed main receives alpha fixes. There is no supported-version
LTS/backport guarantee, stable release SLA, package publication or signed release
pipeline yet. Commit identity matters more than the shared alpha version string.
Independent assessment and operational exercises remain release gates.

## Licensing and participation

The license is undecided. Public visibility and this governance document do not
supply a software license, CLA or DCO. Do not publish packages with invented license
metadata. Discuss third-party code contribution expectations before accepting them.
Feedback, bug reports and documentation requests are welcome. Follow the
[contribution guide](CONTRIBUTING.md), [code of conduct](CODE_OF_CONDUCT.md) and
[security policy](SECURITY.md).
