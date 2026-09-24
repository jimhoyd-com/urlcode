# Package and channel alignment

Core and every add-on share one version. The package manifests and the root
lockfile are the version authority; this page names no version outside the
marked block below. `npm run release:bump -- <version>` is the only way the
version changes, and `node scripts/release-bump.ts --check` (part of
`npm run check`) fails when any declaration disagrees. The procedure is in
[release operations](RELEASE-OPERATIONS.md#release-a-version).

| Package | Manifest | Where it is published |
| --- | --- | --- |
| `@jimhoyd/urlcode` (core) | `package.json` | npm, `v<version>` GitHub Release, Homebrew (stable), GHCR image |
| Every extension (`@jimhoyd/urlcode-<name>`) | `packages/<name>/package.json` | tarball on the `v<version>` GitHub Release, pinned by core |
| Every artifact (`@jimhoyd/urlcode-<name>`) | `artifacts/<name>/package.json` | tarball on the `v<version>` GitHub Release, pinned by core |

| Version | npm dist-tag | GitHub Release | Homebrew | GHCR tags | Template PR |
| --- | --- | --- | --- | --- | --- |
| `X.Y.Z` | `latest` | latest release | updated | `:X.Y.Z`, `:latest` | opened |
| `X.Y.Z-alpha.N` | `alpha` | prerelease | unchanged | `:X.Y.Z-alpha.N`, `:alpha` | none |

Core's `dist/addons.json` pins every add-on of its release by download URL and
sha512, so `urlcode upgrade` moves a site's core and every add-on together;
that release's add-on pins come with it. Each add-on declares core and the sibling add-ons it
uses as exact peers at the same version, siblings optional, so a site installs
each package once at its top level. Development resolves core to this checkout
through the packages' `file:../..` links (`check-workspace-links.ts`), and
`npm run build` writes a development `addons.json` that points
`urlcode extensions add` at the local workspaces. Core never imports an
extension package.

<!-- urlcode-current-version:start -->
Core `0.5.9` is published to npm, GitHub Releases and Homebrew. For a new
composed site:

```sh
npx @jimhoyd/urlcode@0.5.9 init site --with ui,auth,admin,store
```
<!-- urlcode-current-version:end -->

Bare package names resolve npm's current `latest`; exact application pins and a
committed lockfile keep an existing application from changing on a new release.

## Generated applications

`urlcode init` writes a `package.json` pinning the running runtime exactly;
`urlcode extensions add` and `urlcode artifacts add` add each add-on's release
tarball URL, and `package-lock.json` records its integrity.
`urlcode extensions list --strict` and `urlcode artifacts list --strict` fail
when the lockfile no longer matches core's pins.
