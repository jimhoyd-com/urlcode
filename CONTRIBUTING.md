# Contributing

Read SECURITY.md, THREAT-MODEL.md and IMPLEMENTATION-STATUS.md before changes.
The source specification is the URLCode auth spike; this repository owns the
trusted auth implementation, while core owns the generic extension contract.

Use a feature branch and pull request. Preserve Apache-2.0 licensing, required
checks and independent review; do not publish packages or bypass protected main.
Never commit credentials, customer databases or generated dist files. Live-provider
checks require operator configuration and are separate from synthetic tests.

Run `npm run verify` for code changes. For packaging, public exports, CLI or
scaffolding, use scripts/pack-sources.mjs with reviewed commits and test the local
tarballs in a clean consumer. Do not resolve unpublished URLCode peers from a
registry. Report actual evidence and remaining limitations.
