# Contributing

Read SECURITY.md, THREAT-MODEL.md and IMPLEMENTATION-STATUS.md before changes.
The source specification is the URLCode auth spike; this repository owns the
trusted auth implementation, while core owns the generic extension contract.

Use a feature branch and pull request. Preserve Apache-2.0 licensing, required
checks and independent review; do not publish packages by hand or bypass protected main.
Never commit credentials, customer databases or generated dist files. Live-provider
checks require operator configuration and are separate from synthetic tests.

Run `npm run verify` for code changes. Tests need a Node build whose bundled
SQLite is 3.51.3 or newer, or a patched 3.50.7+ / 3.44.6+ branch release;
`engines.node` alone does not guarantee this and the store refuses other builds.
For packaging, public exports, CLI or scaffolding, use scripts/pack-sources.mjs
at the repository root with a reviewed commit, and test the local tarballs in a
clean consumer. Peers resolve to siblings in this repository, never to a
registry; peers.json is gone, because a workspace cannot drift from itself.
Report actual evidence and remaining limitations.

## Releasing

Use the root [release coordinator](../../docs/DEVELOPMENT-PIPELINE.md) after
an explicit release decision. This package uses `@jimhoyd/urlcode-auth@<version>`
tags and `.github/workflows/release-auth.yml` in this monorepo; the npm trusted
publisher must name that workflow. Do not use the former standalone `v*` tags
or publish from a workstation. The coordinator waits for each package in
core, UI, auth, admin order and requires full verification of the exact commit.
Registry peer-floor checks run in an isolated copy; local development uses
workspace peers. Retries preserve the original artifacts and immutable tags.
