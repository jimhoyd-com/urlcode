# Package and channel alignment

The package manifests and root lockfile are the version authority. Read live
registry and Git tag state with `npm run release:status`; do not maintain a
second table of changing version numbers in documentation.

Core's npm package, GitHub Release and Homebrew formula share the core release
version. The extension workspace manifests remain the source-version authority
for bundle production, but new consumers use signed executable bundles rather
than extension npm channels. A bundle catalog records the exact core version it
accepts and the source commit that built it; its lockfile records the catalog
tag and archive digests. `train.json` remains the machine-readable historical
receipt for the earlier npm package train.

| Package | Manifest | Version owner | Release tag |
| --- | --- | --- | --- |
| `@jimhoyd/urlcode` | `package.json` | Explicit core release PR | `v<version>` |
| UI bundle source | `packages/ui/package.json` | Changesets | `extension-bundles@v<version>` catalog member |
| Auth bundle source | `packages/auth/package.json` | Changesets | `extension-bundles@v<version>` catalog member |
| Admin bundle source | `packages/admin/package.json` | Changesets | `extension-bundles@v<version>` catalog member |
| Store bundle source | `packages/store/package.json` | Changesets | `extension-bundles@v<version>` catalog member |
| Forms bundle source | `packages/forms/package.json` | Changesets | `extension-bundles@v<version>` catalog member |

Data-only extension artifacts have an independent catalog and release process
outside the executable npm package train. Their catalog versions live in `extension-artifacts/source.json`, releases use
the disjoint `extensions@v*` tag namespace, and a project records the selected
artifact version, catalog tag, commit and digest in
`urlcode.extensions.lock.json`. An artifact version does not imply or require a
matching executable package version; see [the artifact contract](EXTENSIONS.md#signed-declarative-artifacts).

The legacy extension npm packages are deprecated migration artifacts. Do not
recommend them for new installations or infer their availability from an old
release receipt. They remain source workspaces so bundle generation can build
the exact reviewed inputs.

Development uses workspace source. Auth and admin's `file:../..` development
links resolve core to this checkout, enforced by `check-workspace-links.ts`.
Core never imports extension packages. Bundle preflight checks the catalog's core
compatibility before loading an archive. A source peer floor rises when code
requires a newly introduced API, not just because a sibling changed version.
Preserve the declared upper bound during Changesets versioning;
`.changeset/config.json` limits unnecessary peer rewrites.

A peer floor must include every core API its package uses, or the range allows a
core the package cannot work with (the store's first publication paired
`--ack store:public-write` in its scaffold with a core that rejects that flag).
`scripts/peer-api.ts` records the first core release that has each scaffold
contract member and each other newer core API a package imports; the table is
completed by a test that fails when `ScaffoldRequest` or `ScaffoldResult` gains a
member with no entry. Bundle preparation refuses to create a catalog when the
source packages require a core the selected release does not provide.

Publishable workspace changes carry Changesets; the release PR applies them and
updates versions, changelogs and the lockfile together. Core stays an explicit
entry in that PR until a separately reviewed workspace migration. Its CLI banner
must match its manifest. `npm run release:check` rejects stale lockfile versions.
Unreleased source changes do not require moving a published tag or pretending a
new package has already shipped.

GitHub Actions releases core through its protected workflow. A separate immutable
`extension-bundles@v…` tag releases the first-party executable bundles named
in its catalog from their reviewed workspace sources. Changesets still record
source release intent, but they do not authorize extension npm publication.

<!-- urlcode-current-version:start -->
Core `0.5.9` is published to npm, GitHub Releases and Homebrew. The supported
first-party executable extension release is
`extension-bundles@v0.5.9`; it was clean-consumer tested with core `0.5.9`.
For a new composed site, install core and select that immutable bundle release:

```sh
npm install --save-exact @jimhoyd/urlcode@0.5.9
npx urlcode init site --with ui,auth,admin,store --bundle-release extension-bundles@v0.5.9
```
<!-- urlcode-current-version:end -->

Bare package names resolve npm's current `latest`; exact application pins and a
committed lockfile keep an existing application from changing on a new release.

## Generated applications

A generated application records its own pins. `urlcode init --with
--bundle-release` writes a `package.json` pinning the running runtime and a
bundle lockfile recording each selected extension archive; it does not add
extension npm dependencies. `urlcode init --manifest` does the same for a
route-only project with the runtime alone. Plain `urlcode init` stays
route-only and writes no manifest, for projects whose runtime is managed
elsewhere. Generation never runs a package manager: `package-lock.json` exists
only after the operator runs `npm install` in the generated directory.

No upgrade command exists. A generated project moves to new versions by an
operator editing its manifest and re-installing. The issue that asked for this
(#212) describes a future command that would choose a tested compatible set,
show the changes and require explicit alpha selection; nothing here implements
that, and the pins above are only the groundwork it would need.

The standalone `urlcode-template` is an external exact-version consumer: after a
runtime release, update its dependency and starter through its own reviewed PR.
The coordinator prepares and checks that PR after registry installation succeeds;
the template is a consumer update, not a fifth npm package. The retired
`urlcode-docs`, `urlcode-middleware`, `urlcode-dynamic-link` and `urlcode-short`
repositories are not release targets.

See [the development pipeline](DEVELOPMENT-PIPELINE.md) for preparation,
publication order, immutable retries and credential scope, and
[release security](RELEASE-SECURITY.md) for provenance and limitations.
