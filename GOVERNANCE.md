# Project governance

URLCode is a maintainer-led Apache-2.0 project. @jimhoyd maintains the public
runtime. The public schema/specification describe implemented behavior; the
roadmap describes future work. There is no feature restriction intended to
limit self-hosters.

## Changes and responsibility

Use pull requests with a clear problem, behavior and verification record. The
maintainer decides scope and merges after required checks pass and conversations
are resolved. `main` disallows force pushes/deletion and requires an up-to-date
branch, CI and PRs. Squash merges preserve linear history. No ruleset bypass is
configured for administrators or automation.

The public issue tracker accepts reports and proposals from anyone. Pull request
creation is limited to collaborators: external users should file an issue, and
the maintainer or a local agent acting through the maintainer's authenticated
identity turns accepted work into a branch and PR. Those agents may prepare,
review and merge PRs under the same checks and no-bypass rules as the maintainer;
their use does not grant another GitHub account repository access.

There is currently one maintainer, so review approval count is zero: PRs and CI
are mandatory, but an independent human review is not yet guaranteed. CODEOWNERS
records ownership. Add a required independent approval when the trusted maintainer
team grows. Revisit controls as the maintainer team and deployment scope grow.

## Release and security controls

CI actions and the Docker base image are pinned to immutable revisions. Dependabot
proposes npm, action and container updates; updates are reviewed and tested, not
auto-merged. Workflow tokens default to read-only and cannot approve PRs. Secret
scanning/push protection, dependency security alerts and private vulnerability
reporting are enabled. CodeQL scans the JavaScript code; its results are required
on main, with high/critical security findings and error-level alerts blocking merges. External contributors
require maintainer approval before their workflows run, and only GitHub-owned
actions are allowed by repository policy. Keep sensitive reports in the private
security channel.

Manual Actions releases enter the protected `release` environment before the
coordinator receives its automation token or performs a release mutation. The
maintainer is the required reviewer, self-review is allowed for the sole
maintainer, and administrators cannot bypass the gate. Release tag creation is
restricted to the maintainer identity used by trusted local agents and release
automation. A separate no-bypass ruleset prevents every actor from updating or
deleting an existing release tag.

Only current reviewed main receives fixes; there is no LTS/backport guarantee or
release SLA. Version 0.3.0 is the current self-hosted baseline. The manual candidate
pipeline signs build provenance; a tagged release publishes the signed
tarball to npm as @jimhoyd/urlcode with provenance, authenticating through a
registered trusted publisher rather than a stored token, so no long-lived npm
credential exists to leak or rotate. Pin exact
commits to identify patches. Which core version each downstream package
supports, how it declares that (peer range, exact pin or reviewed SHA), and the
order in which a core change reaches those repositories are recorded in
[docs/VERSION-ALIGNMENT.md](docs/VERSION-ALIGNMENT.md); it also records that a
published package must never declare a peer range no published core satisfies. Independent assessment and deployment exercises remain
required before claiming hostile multi-tenant or deployment-specific readiness.

## Licensing and participation

URLCode is licensed under [Apache-2.0](LICENSE). Contributions follow the terms
in [CONTRIBUTING.md](CONTRIBUTING.md); there is no separate CLA or DCO. Preserve
license notices and review third-party licensing when accepting dependencies or code.
Feedback, bug reports and documentation requests are welcome. Follow the
[contribution guide](CONTRIBUTING.md), [code of conduct](CODE_OF_CONDUCT.md) and
[security policy](SECURITY.md).
