# Release security

[Release operations](RELEASE-OPERATIONS.md) is the runbook. This page states
what the release pipeline guarantees and what it does not. A release uses a
reviewed commit on `main` that passed the complete verification of that exact
commit; the project does not bypass protected-branch checks or self-approve
pull requests.

## What the pipeline guarantees

- **Built once, from the released commit.** The `build` job of
  `.github/workflows/publish.yml` builds core and every add-on from the merge
  commit (`npm ci --ignore-scripts`, then the builds), packs them with `scripts/release-pack.ts`, and
  uploads the result as the run's artifact. The `publish` job publishes those
  files and never rebuilds; a re-run reuses them. `dist/` is never committed.
- **Attested.** Every file in `release/` (each tarball, `SHA256SUMS`, the SBOM,
  the triage report and the Homebrew formula) gets a GitHub build-provenance
  attestation. Check one with
  `gh attestation verify <file> --repo jimhoyd-com/urlcode`.
- **Trusted publishing with provenance.** Core reaches npm through npm trusted
  publishing: the registry trusts `publish.yml` running in the `release`
  environment, no long-lived npm token exists, and the published version
  carries npm provenance naming the workflow run and commit. Changing the
  workflow file name, repository or environment needs a registry trust update.
- **Core pins the add-ons.** Only core is published to npm. Each add-on is a
  tarball on the `v<version>` GitHub Release, and core's `dist/addons.json`
  pins every one by download URL and sha512 integrity. That file is written
  before core is packed, so it is inside core's attested, provenance-carrying
  tarball; `release-pack.ts` refuses a core tarball whose pins differ from the
  packed add-ons. `urlcode extensions add`, `artifacts add` and `list --strict`
  refuse a lockfile entry that does not match the pin.
- **Order.** The GitHub Release (every tarball) is created first, then every
  pinned add-on is downloaded from its public URL and compared with its pin,
  and only then is core published to npm. A published core therefore never
  points at an add-on that cannot be downloaded with exactly the pinned bytes.
- **Immutable once published.** Tag rulesets let only the maintainer and GitHub
  Actions create a `v*` tag and nobody move or delete one; immutable releases
  keep published assets fixed. A retry refuses an existing asset or npm version
  with different bytes, and a stable release never moves GitHub's latest
  release backwards. A bad release is fixed forward with a new version and
  `npm deprecate`.
- **Least privilege.** The workflow defaults to read-only contents. Only
  `build` can mint attestations; only `publish`, in the `release` environment
  limited to `main`, can write contents and packages or request an npm OIDC
  token; `verify` can only open an issue. Every third-party action is pinned
  by commit SHA, and the publishing job uses no npm cache.

## The trade-off: reproducibility is proven, not containerised

The build runs on a GitHub-hosted runner at the Node version pinned in
`.node-version`, not inside a digest-pinned container that produces a
byte-reproducible candidate. Instead, CI's `build-fidelity` job
(`npm run ci:build-fidelity`) builds everything twice from clean builds and
packs both with the real release packer, on the same `.node-version`; the
tarballs and pins must be byte-identical. That proves the build and packer are
deterministic for a given commit and toolchain. It does not prove that a different runner image or Node patch would
produce the same bytes, so the attested files, not a rebuild, are the
reference for what was published.

## Dependency-alert triage

Each release carries an attested CycloneDX SBOM and `supply-chain-triage.json`
beside the exact core tarball. The triage report hashes both files, maps every
non-development lockfile component to its resolved `node_modules` path(s), and
resolves the reviewed exceptions in
[`security/supply-chain-exceptions.json`](../security/supply-chain-exceptions.json).
It is generated after `npm pack`, so it identifies the archive that is
published, not a reconstructed registry download.

Compare any third-party scanner category with this attested component and path
inventory. Record an exception only when it names the exact package and
version, the category, a bounded rationale and a re-review trigger. An alert
without a component or path is an attribution task, not evidence of a
vulnerability; do not guess an exception. A concrete vulnerability, malicious
behavior or changed dependency goes through the normal
[security reporting](../SECURITY.md) process. This review complements the
production `npm audit` gate, provenance, CodeQL and the independent
sandbox/host security review; it replaces none of them.

## Limits

An attestation establishes provenance, not safety. Publication does not prove
registry identity beyond what trusted publishing asserts, container behavior
beyond the smoke tests, production security or operational fitness; those
need the deployment evidence in
[production readiness](RELEASE-OPERATIONS.md#production-readiness). Workflow
artifacts expire after 90 days; the GitHub Release is the durable copy, and a
deployment should keep its own last-good copies for rollback.
