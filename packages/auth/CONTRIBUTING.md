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

Releases are tags on commits that are already on main. Bump `version` in
package.json (and package-lock.json) in a reviewed pull request, then tag the
merged commit `v<version>` and push the tag: `.github/workflows/release.yml`
refuses a tag whose version differs from package.json or whose commit is not on
main. The workflow installs the peers from npm at the lower bound of each
`peerDependencies` range, so publish core and UI first, then auth, then admin.
It runs `npm run verify`, audits runtime dependencies, packs and attests the
tarball and creates the GitHub release. It publishes to npm only when the
repository variable `PUBLISH_NPM` is `true`, via npm trusted publishing (the
publisher registered on npmjs.org must name this repository and `release.yml`);
there is no npm token.
