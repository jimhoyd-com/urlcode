# Contributing

URLCode is an executable alpha. The license remains undecided; no contribution
license terms are established here. Development and Git pushes may proceed.

Use Node.js 22.13+ (CI targets 22 and 24):

```sh
npm ci
npm run verify
npm run test:package
```

Verification runs ESLint, syntax/JSON checks and unit/real HTTP tests. Package
verification installs an actual archive in a temporary directory and checks both
starters. It needs npm registry access. Default runtime tests use only local
HTTP/fake services; no cloud account, DB or ngrok. Benchmarks are separate:
`npm run benchmark -- 10000`.

Keep changes consistent with the [implemented contract](docs/SPECIFICATION.md)
and [roadmap](ROADMAP.md). Add behavior/conformance tests for routing changes and
update docs when support changes. Do not claim a provider or OS is supported
without a passing test run. Preserve portable behavior and useful self-hosting.

Use synthetic data. Never commit secrets, customer URL collections or local
environment files. Operator-authored functions are trusted code, not a sandbox.

## Maintaining cloneable starter branches

After main passes verification, generate each app-only branch from its source
subdirectory with `git subtree split --prefix=starters/redirects` (and `dynamic`).
Review the resulting tree and test a fresh clone using the installed runtime.
Push its commit to `starter-redirects` or `starter-dynamic` with a normal
fast-forward push. Do not force-push user changes or maintain divergent runtime
code in these branches. Update their compatible runtime metadata with releases.
