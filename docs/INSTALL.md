# Installing URLCode

URLCode is a Node CLI. Every channel below installs the same published tarball;
pick whichever fits how you already manage tools. All of them require
**Node.js 22.13 or newer**. The tarball ships plain JavaScript built from the
TypeScript source (`dist/`, with declarations; see [TypeScript](TYPESCRIPT.md)),
so the installed `urlcode` command runs `dist/cli.js` and needs no build tool.
The archive contains only runtime and authoring resources; `llms-full.txt` is
its offline documentation bundle, while the browsable `docs/` tree stays in the
source repository.

## npm

The npm `latest` tag identifies core's current stable release. Each GitHub
release records the exact core, UI, auth and admin combination tested together;
`npm run release:status` in a checkout reports live registry availability. Use
`@alpha` only to select the separate prerelease channel explicitly.

```sh
npm install --global @jimhoyd/urlcode@latest
urlcode --help
```

Project-local, which is what an application repository should normally pin.
Which dependency list it belongs in depends on how the project uses URLCode:

```sh
# Using URLCode as a tool: validate, test and build in CI, never imported by
# the code that serves requests.
npm install --save-dev --save-exact @jimhoyd/urlcode@latest
npx urlcode validate

# Embedding the runtime (see TYPESCRIPT.md): the application imports
# @jimhoyd/urlcode at startup, so it must survive `npm ci --omit=dev`.
npm install --save --save-exact @jimhoyd/urlcode@latest
```

A devDependency is absent from a production install, so an application that
imports `createRuntime`, `startServer`, `prerenderPages` or any other
[embedding entry point](TYPESCRIPT.md) fails at startup on a missing module if it
is installed with `--save-dev`. An application should also pin an **exact**
version rather than a range: the compiled Cloudflare artifact format is tied to
the runtime version that reads it.

The optional signed declarative extension artifacts are installed by this
pinned CLI into a project cache, not by npm. They contain only bounded
JSON/Markdown authoring data and cannot install or activate an executable
extension. Use an immutable release tag and commit the resulting lockfile as
described in [extensions](EXTENSIONS.md#signed-declarative-artifacts).

## Homebrew

```sh
brew tap jimhoyd-com/urlcode
brew trust jimhoyd-com/urlcode
brew install urlcode
```

Homebrew refuses to load a formula from a third-party tap until you trust it,
so without the middle line the install stops with `Refusing to load formula …
from untrusted tap`. Trusting a tap means agreeing to run code from this
repository, the same as with the install script; `brew trust --formula
jimhoyd-com/urlcode/urlcode` limits it to this one formula.

The release workflow renders `urlcode.rb` from the measured npm tarball,
publishes npm, then synchronizes that formula to the tap before creating the
GitHub release. A missing tap credential or rejected tap update fails the
release instead of silently leaving Homebrew behind. Homebrew verifies the
tarball's SHA-256 against the formula before installing. Check `brew info
urlcode` if the reported version does not match the intended release, and use
npm or the install script while reporting the mismatch.

## Install script

```sh
curl -fsSL https://raw.githubusercontent.com/jimhoyd-com/urlcode/main/install.sh | sh
```

It downloads the release tarball, verifies its SHA-256 against the release's
`SHA256SUMS`, and installs with npm. Options:

```sh
curl -fsSL .../install.sh | sh -s -- --version X.Y.Z --prefix "$HOME/.local"
```

`--prefix` avoids needing privileges for a global npm directory; add
`$PREFIX/bin` to `PATH`. Piping a script into a shell means trusting the source
for that moment: to inspect first, download it, read it, then run it.

## Container

No image is published yet: the release job's GHCR step is gated behind the
`PUBLISH_CONTAINER` repository variable and has not run, so there is nothing at
`ghcr.io/jimhoyd-com/urlcode` to pull. After the release tag exists, build it from that checkout:

<!-- urlcode-current-version:start -->
```sh
git clone --branch v0.4.8 https://github.com/jimhoyd-com/urlcode.git
docker build -t urlcode:0.4.8 urlcode
docker run --rm -p 127.0.0.1:3000:3000 -v "$PWD:/project:ro" urlcode:0.4.8 \
  serve --project /project --host 0.0.0.0
```
<!-- urlcode-current-version:end -->

The image runs the same built runtime, `node /opt/urlcode/dist/cli.js`, as its
entry point. Pin the digest rather than a tag for a deployment, and give the
container its own resource limits. See [operations](OPERATIONS.md).

## From source

```sh
git clone https://github.com/jimhoyd-com/urlcode.git
cd urlcode
make dev
```

A clone runs the TypeScript source directly (`node src/cli.ts`, Node 22.18+),
with no build step; see [local development](LOCAL-DEVELOPMENT.md).

Three Node versions appear around the project, and they are not a contradiction:
the installed package runs on Node 22.13 or newer (`engines`), running the
TypeScript source from a clone needs 22.18 or newer because it relies on Node's
built-in type stripping, the release workflow's npm trusted publishing needs
22.14 or newer, and the container image pins Node 26. Only the first number
constrains a deployment of the published tarball.

## Verify what you installed

Releases carry Sigstore provenance signed by the release workflow. Before
trusting a downloaded artifact:

```sh
gh attestation verify jimhoyd-urlcode-0.3.0.tgz --repo jimhoyd-com/urlcode \
  --signer-workflow jimhoyd-com/urlcode/.github/workflows/release.yml
```

A signature establishes where an artifact came from. It is not a statement that
the release is safe for your workload, and it is not a production-readiness
claim; see [release readiness](RELEASE-READINESS.md) and
[release security](RELEASE-SECURITY.md).
