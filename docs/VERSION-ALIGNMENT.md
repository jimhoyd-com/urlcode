# Package and channel alignment

The package manifests and root lockfile are the version authority. Read live
registry and Git tag state with `npm run release:status`; do not maintain a
second table of changing version numbers in documentation.

Core's npm package, GitHub Release and Homebrew formula share the core release
version. Every add-on shares it too: the extensions under `packages/` and the
artifacts under `artifacts/` are versioned in lockstep with core, released as
tarballs on core's GitHub Release, and pinned by core's own `dist/addons.json`
(download URL and sha512). Only core is published to npm. Upgrading a site
means changing its core version; that release's add-on pins come with it. A
dedicated `urlcode upgrade` command is planned.

| Package | Manifest | Version owner | Release |
| --- | --- | --- | --- |
| `@jimhoyd/urlcode` | `package.json` | Explicit core release PR | npm, `v<version>` GitHub Release, Homebrew |
| `@jimhoyd/urlcode-ui` | `packages/ui/package.json` | Core's version | tarball on the `v<version>` GitHub Release |
| `@jimhoyd/urlcode-auth` | `packages/auth/package.json` | Core's version | tarball on the `v<version>` GitHub Release |
| `@jimhoyd/urlcode-admin` | `packages/admin/package.json` | Core's version | tarball on the `v<version>` GitHub Release |
| `@jimhoyd/urlcode-store` | `packages/store/package.json` | Core's version | tarball on the `v<version>` GitHub Release |
| `@jimhoyd/urlcode-forms` | `packages/forms/package.json` | Core's version | tarball on the `v<version>` GitHub Release |
| `@jimhoyd/urlcode-mcp` | `packages/mcp/package.json` | Core's version | tarball on the `v<version>` GitHub Release |
| `@jimhoyd/urlcode-store-schema` (artifact) | `artifacts/store-schema/package.json` | Core's version | tarball on the `v<version>` GitHub Release |

Each extension declares core and its sibling add-ons as exact peer
dependencies at that same version, siblings optional, so a site installs each
package once at its top level. Packing refuses an add-on whose version differs
from core's. Development uses workspace source: the packages' `file:../..`
development links resolve core to this checkout, enforced by
`check-workspace-links.ts`, and `npm run build` writes a development
`addons.json` that points `urlcode extensions add` at the local workspaces. Core
never imports extension packages.

Publishable workspace changes carry Changesets; the release PR applies them and
updates versions, changelogs and the lockfile together. Core stays an explicit
entry in that PR until a separately reviewed workspace migration. Its CLI banner
must match its manifest. `npm run release:check` rejects stale lockfile versions.
Unreleased source changes do not require moving a published tag or pretending a
new package has already shipped.

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

A generated application records its own pins. `urlcode init` writes a
`package.json` pinning the running runtime exactly; `urlcode extensions add` and
`urlcode artifacts add` add each add-on's release tarball URL, and
`package-lock.json` records its integrity. `urlcode extensions list --strict`
and `urlcode artifacts list --strict` fail when the lockfile no longer matches
core's pins.

The standalone `urlcode-template` is an external exact-version consumer: after a
runtime release, update its dependency and starter through its own reviewed PR.
The coordinator prepares and checks that PR after registry installation succeeds;
the template is a consumer update, not another npm package.

See [release operations](RELEASE-OPERATIONS.md#prepare-a-version) for preparation,
publication order, immutable retries and credential scope, and
[release security](RELEASE-SECURITY.md) for provenance and limitations.
