# Installing URLCode

URLCode is a Node CLI. Every channel below installs the same published tarball;
pick whichever fits how you already manage tools. All of them require
**Node.js 22.13 or newer**. The tarball ships plain JavaScript built from the
TypeScript source (`dist/`, with declarations; see [TypeScript](TYPESCRIPT.md)),
so the installed `urlcode` command runs `dist/cli.js` and needs no build tool.

Live short-link storage additionally needs a Node build carrying the patched
SQLite WAL fix. Run `urlcode doctor` after installing and check `liveLinks`;
everything except live links works on any supported build. See
[dynamic links](DYNAMIC-LINKS.md#node-build-requirement).

## npm

```sh
npm install --global urlcode
urlcode --help
```

Project-local, which is what an application repository should normally pin:

```sh
npm install --save-dev urlcode
npx urlcode validate
```

## Homebrew

```sh
brew tap jimhoyd-com/urlcode
brew install urlcode
```

The tap's formula is generated from the published tarball for each release and
attached to the GitHub release as `urlcode.rb`.

## Install script

```sh
curl -fsSL https://raw.githubusercontent.com/jimhoyd-com/urlcode/main/install.sh | sh
```

It downloads the release tarball, verifies its SHA-256 against the release's
`SHA256SUMS`, and installs with npm. Options:

```sh
curl -fsSL .../install.sh | sh -s -- --version 0.1.0 --prefix "$HOME/.local"
```

`--prefix` avoids needing privileges for a global npm directory; add
`$PREFIX/bin` to `PATH`. Piping a script into a shell means trusting the source
for that moment: to inspect first, download it, read it, then run it.

## Container

```sh
docker run --rm -p 127.0.0.1:3000:3000 -v "$PWD:/project:ro" ghcr.io/jimhoyd-com/urlcode:0.1.0 \
  serve --project /project --host 0.0.0.0
```

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

## Verify what you installed

Releases carry Sigstore provenance signed by the release workflow. Before
trusting a downloaded artifact:

```sh
gh attestation verify urlcode-0.1.0.tgz --repo jimhoyd-com/urlcode \
  --signer-workflow jimhoyd-com/urlcode/.github/workflows/release.yml
```

A signature establishes where an artifact came from. It is not a statement that
the release is safe for your workload, and it is not a production-readiness
claim; see [release readiness](RELEASE-READINESS.md) and
[release security](RELEASE-SECURITY.md).
