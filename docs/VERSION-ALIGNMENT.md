# Package and channel alignment

The package manifests and root lockfile are the version authority. Read live
registry and Git tag state with `npm run release:status`; do not maintain a
second table of changing version numbers in documentation.

For readers, the README's npm badges show each package's live `latest` version.
That is package stability, not a claim that all five version numbers match.
The current publisher renders each new GitHub release's signed `train.json` as
a **Recommended tested stack** table containing the exact five versions
exercised together, each npm channel and every declared peer requirement, plus
an exact-version install command. `train.json` is the machine-readable receipt;
`peerDependencies` remain the compatibility contract.

| Package | Manifest | Version owner | Release tag |
| --- | --- | --- | --- |
| `@jimhoyd/urlcode` | `package.json` | Explicit core release PR | `v<version>` |
| `@jimhoyd/urlcode-ui` | `packages/ui/package.json` | Changesets | `@jimhoyd/urlcode-ui@<version>` |
| `@jimhoyd/urlcode-auth` | `packages/auth/package.json` | Changesets | `@jimhoyd/urlcode-auth@<version>` |
| `@jimhoyd/urlcode-admin` | `packages/admin/package.json` | Changesets | `@jimhoyd/urlcode-admin@<version>` |
| `@jimhoyd/urlcode-store` | `packages/store/package.json` | Changesets | `@jimhoyd/urlcode-store@<version>` |

`@jimhoyd/urlcode-store` joined the release train after the last
published set, so that set does not include it. Its first publication was
manual, from `main` at `7972185`, because the release scripts cannot look up a
package that has never been on npm; see
[the first-publish runbook](FIRST-NPM-PUBLISH.md). The published store scaffold
needs a core release newer than the one published beside it for the no-auth
`--ack store:public-write` path. Store peers only on core, so it can release
alone or with the set; the candidate train, consumer install smoke and signed
`train.json` cover all five packages together.

Development uses workspace source. Auth and admin's `file:../..` development
links resolve core to this checkout, enforced by `check-workspace-links.ts`.
Core never imports extension packages. Release verification instead installs the
published lower bound of each declared peer range and checks resolution. A peer
floor rises when code requires a newly introduced API, not just because a sibling
published another version. Preserve the declared upper bound during Changesets
versioning; `.changeset/config.json` limits unnecessary peer rewrites.

A peer floor must include every core API its package uses, or the range allows a
core the package cannot work with (the store's first publication paired
`--ack store:public-write` in its scaffold with a core that rejects that flag).
`scripts/peer-api.ts` records the first core release that has each scaffold
contract member and each other newer core API a package imports; the table is
completed by a test that fails when `ScaffoldRequest` or `ScaffoldResult` gains a
member with no entry. `release:prepare` raises a selected package's core floor to
what it needs when the core in the checkout already has it, refuses when it does
not, and the tag workflow's preflight refuses to publish a package whose floor
falls short. A package that needs an API core has not yet released therefore
cannot be released alone: release core first, or select all packages.
`release:peers` also builds the package and runs its tests, including one that
drives the installed core's own `init --with store`, against the published core at
the floor.

Publishable workspace changes carry Changesets; the release PR applies them and
updates versions, changelogs and the lockfile together. Core stays an explicit
entry in that PR until a separately reviewed workspace migration. Its CLI banner
must match its manifest. `npm run release:check` rejects stale lockfile versions.
Unreleased source changes do not require moving a published tag or pretending a
new package has already shipped.

Manual GitHub Actions releases can select `core`, `ui`, `auth`, `admin`, `store`, or
`all`. A single-package release updates only that package's manifest, lock entry,
changelog and relevant Changesets; core also owns its duplicated CLI/MCP/plugin
version metadata and downstream starter update. The all-packages action aligns
every manifest and advances internal peer floors together. Changesets that name
packages across the selected boundary must be released together rather than
partially consumed.

<!-- urlcode-current-version:start -->
The `0.4.7` release is an explicit stable release decision for core, UI, auth
and admin. Publication moves each package's npm `latest` channel to `0.4.7`, in
core → UI → auth → admin order, after its release checks pass. A prepared
manifest or merged release PR does not prove registry publication: use
`npm run release:status` to inspect the live result before installing the set.
This alignment does not permanently couple package versions; subsequent
releases can still select only the packages that changed.

Alpha releases publish under `alpha`; they never automatically move npm
`latest`. Stable publication does not move `alpha`, so the two channels can
legitimately show different versions. Test the install combination you recommend
against peer ranges. `release:status` reports each declared peer floor and
whether its current `latest` and `alpha` satisfy the range.

After all four `0.4.7` versions are published, install the aligned set with:

```sh
npm install --save-exact @jimhoyd/urlcode@0.4.7 @jimhoyd/urlcode-ui@0.4.7 @jimhoyd/urlcode-auth@0.4.7 @jimhoyd/urlcode-admin@0.4.7
```
<!-- urlcode-current-version:end -->

Bare package names resolve npm's current `latest`; exact application pins and a
committed lockfile keep an existing application from changing on a new release.

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
The coordinator prepares and checks that PR after registry installation succeeds;
the template is a consumer update, not a fifth npm package. The retired
`urlcode-docs`, `urlcode-middleware`, `urlcode-dynamic-link` and `urlcode-short`
repositories are not release targets.

See [the development pipeline](DEVELOPMENT-PIPELINE.md) for preparation,
publication order, immutable retries and credential scope, and
[release security](RELEASE-SECURITY.md) for provenance and limitations.
