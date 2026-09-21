# Publishing a new package to npm for the first time

This runbook covers the first publication of a package that has never been on
npm, such as `@jimhoyd/urlcode-store`. Every later release goes through the
[release pipeline](DEVELOPMENT-PIPELINE.md); only the first one is manual.

The maintainer runs it. Agents prepare and verify, and never hold npm
credentials, run `npm publish`, configure npm settings or approve the protected
`release` environment.

## Why the pipeline cannot do it

`scripts/release.ts` looks every package up on the registry and treats a 404 as
an error, on purpose: those lookups assume the package already exists, and a
missing package must never be read as "safe to publish". So `release:plan`,
`release:status` and `release:run` all fail with
`Registry lookup failed for <name>: 404` until the package exists. The release
workflow also publishes through npm trusted publishing, which is configured on
the package's npmjs.com settings. To my knowledge npm needs the package to exist
before that can be set up; confirm on screen.

The way out is one manual publish, then trusted publishing, then the pipeline.

## Before you publish

1. The package is wired into the release train: its `package.json` version
   matches the published set, `publishConfig.access` is `public`, and it is in
   the release scripts, the workflows, the package audit budget and the
   [version alignment](VERSION-ALIGNMENT.md) table. The store's wiring landed
   in [#326](https://github.com/jimhoyd-com/urlcode/pull/326).
2. Publish from a commit on `main` whose checks are green. Record its full SHA.
3. Its peer range is satisfied by the published packages. Check that the
   package works with the **published** versions of what it peers on, not only
   with the workspace source. See [Check the published set](#check-the-published-set).
4. Build and pack it, and note the integrity, before anything is published:

```bash
npm ci && npm run build && npm run build --workspace <package-name>
```

```bash
cd packages/<name> && npm pack
```

`npm pack --json` prints `size`, `shasum`, `integrity` and `entryCount`. `npm
publish --dry-run` shows the file list and publishes nothing. If the tarball
holds only a few files, the build is missing (`files` lists `dist`).

## Publish

Use a clean checkout of exactly the recorded commit, with no local changes:

```bash
git fetch origin && git switch --detach <full-sha>
```

Then, from `packages/<name>` after the build above, log in as an npm user who
owns the scope and publish. npm asks for the 2FA code. `publishConfig` already
sets public access. The first version has no provenance statement, because that
needs the CI identity.

```bash
npm publish
```

## Verify the registry has your bytes

```bash
npm view <package-name>@<version> dist.integrity dist.shasum dist-tags
```

The integrity and shasum must equal the values `npm pack` printed. Then run
`npm run release:status`: the new package should report `published: true` and
its channel, and the lookup should no longer fail. `tagSha` is `null` until a
tag exists and `releaseNeeded` is `false` for a version that is already on the
registry.

## Configure trusted publishing

On npmjs.com, open the package's settings and add a trusted publisher for GitHub
Actions: the repository owner and name (`jimhoyd-com/urlcode`) and the workflow
filename (`release-store.yml` for the store). The release workflow has no
`environment:` key of its own, because the protected `release` environment gates
the coordinator. Read the form's fields on screen; they are npm's and can change.

Until this is done, the pipeline's publish step cannot authenticate for that
package.

## Check the published set

Install the published packages together in an empty directory and run the
scaffold or the smallest real use:

```bash
npm init -y && npm i @jimhoyd/urlcode@<v> @jimhoyd/urlcode-store@<v>
```

```bash
npx urlcode init site --with ui,auth,store
```

Do this before announcing the package, and record what does not work. The store's
first publication found a real gap this way: the store's first version was built from
source that includes the `--allow-public-write` scaffold flag and the unordered
`--with` contract, which the core published at that time predates. With the published
pair, `init --with ui,auth,store` scaffolds, but `init --with store` refuses and
tells you to pass a flag the published core rejects as an unknown option. The fix
is a core release that includes those changes, and a store peer floor that
requires it.

## After the first publish

- **The next release is a new version.** The scripts refuse to publish different
  bytes under an existing version and never move a tag. Release the next patch
  version through the pipeline.
- **The manual version has no signed release.** It has no `train.json`, no
  attached GitHub release and no version tag. Creating the tag is optional and
  needs the maintainer identity (the tag rule allows only that bypass). Run
  `npm run release:run` without `--execute` and read what it says before the next
  release.
- **Fix the docs that said "not published".** Search for phrases such as "not yet
  available from npm" and "first publication", correct them to what you verified
  with the published set, and update the version alignment table.
- **Close the tracking issue** with the commit SHA and the registry integrity.

## What an agent may do

Read the registry, run `npm pack` and `npm publish --dry-run`, compare
checksums, test the published set in a scratch directory, and update these docs.
Publishing, npm account and package settings, tokens and approving the `release`
environment are the maintainer's.
