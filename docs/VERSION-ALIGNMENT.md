# Package and channel alignment

The package manifests and root lockfile are the version authority. Read live
registry and Git tag state with `npm run release:status`; do not maintain a
second table of changing version numbers in documentation.

| Package | Manifest | Version owner | Release tag |
| --- | --- | --- | --- |
| `@jimhoyd/urlcode` | `package.json` | Explicit core release PR | `v<version>` |
| `@jimhoyd/urlcode-ui` | `packages/ui/package.json` | Changesets | `@jimhoyd/urlcode-ui@<version>` |
| `@jimhoyd/urlcode-auth` | `packages/auth/package.json` | Changesets | `@jimhoyd/urlcode-auth@<version>` |
| `@jimhoyd/urlcode-admin` | `packages/admin/package.json` | Changesets | `@jimhoyd/urlcode-admin@<version>` |

Development uses workspace source. Auth and admin's `file:../..` development
links resolve core to this checkout, enforced by `check-workspace-links.ts`.
Core never imports extension packages. Release verification instead installs the
published lower bound of each declared peer range and checks resolution. A peer
floor rises when code requires a newly introduced API, not just because a sibling
published another version. Preserve the declared upper bound during Changesets
versioning; `.changeset/config.json` limits unnecessary peer rewrites.

Publishable workspace changes carry Changesets; the release PR applies them and
updates versions, changelogs and the lockfile together. Core stays an explicit
entry in that PR until a separately reviewed workspace migration. Its CLI banner
must match its manifest. `npm run release:check` rejects stale lockfile versions.
Unreleased source changes do not require moving a published tag or pretending a
new package has already shipped.

Alpha releases publish under `alpha`; they never automatically move npm
`latest`. Core's historical `latest` remains the stable 0.3.0 baseline until an
explicit stable release decision. Extensions have historical alpha versions on
`latest`; subsequent alpha publication does not keep that channel in lockstep.
Different channel values alone are not drift. Test the install combination you
recommend against peer ranges; a bare install may select an older channel.
`release:status` reports each declared peer floor and whether its current
`latest` and `alpha` satisfy the range.

## Generated applications

A generated application records its own versions. `urlcode init --with` writes a
`package.json` pinning the running runtime, the named extensions and their
declared peers at the exact versions resolved at generation time, after checking
that set against every declared peer range; `urlcode init --manifest` does the
same for a route-only project with the runtime alone; `urlcode-auth init` pins
this package and its peers. Plain `urlcode init` stays route-only and writes no
manifest, for projects whose runtime is managed elsewhere. Generation never runs
a package manager: `package-lock.json` exists only after the operator runs
`npm install` in the generated directory, and a pin taken from a local path or
tarball reproduces only where that path exists.

No upgrade command exists. A generated project moves to new versions by an
operator editing its manifest and re-installing. The issue that asked for this
(#212) describes a future command that would choose a tested compatible set,
show the changes and require explicit alpha selection; nothing here implements
that, and the pins above are only the groundwork it would need.

The standalone `urlcode-template` is an external exact-version consumer: after a
runtime release, update its dependency and starter through its own reviewed PR.
It is not automatically released by the monorepo coordinator. The retired
`urlcode-docs`, `urlcode-middleware`, `urlcode-dynamic-link` and `urlcode-short`
repositories are not release targets.

See [the development pipeline](DEVELOPMENT-PIPELINE.md) for preparation,
publication order, immutable retries and credential scope, and
[release security](RELEASE-SECURITY.md) for provenance and limitations.
