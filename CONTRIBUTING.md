# Contributing

URLCode is an executable alpha. The license remains undecided; no contribution
license terms are established here. Development and Git pushes may proceed.

Use Node.js 22.13+ (CI targets 22 and 24):

```sh
make dev         # installs dependencies and starts the watched function/redirect demo
# In another terminal:
make verify
make test-package
```

Without Make, use `npm ci`, `npm run dev`, `npm run verify` and
`npm run test:package`. See [local development](docs/LOCAL-DEVELOPMENT.md) for
project/port overrides and the independent app workflow.

Verification runs ESLint, syntax/JSON checks and unit/real HTTP tests. Package
verification installs an actual archive in a temporary directory and checks the
starter. It needs npm registry access. Default runtime tests use only local
HTTP/fake services; no cloud account, DB or ngrok. Benchmarks are separate:
`npm run benchmark -- 10000`.

Keep changes consistent with the [implemented contract](docs/SPECIFICATION.md)
and [roadmap](ROADMAP.md). Add behavior/conformance tests for routing changes and
update docs when support changes. Do not claim a provider or OS is supported
without a passing test run. Preserve portable behavior and useful self-hosting.

Use synthetic data. Never commit secrets, customer URL collections or local
environment files. Treat all application function code as untrusted. Never import it into Node or
add an unsafe fallback. Capability grants must come from operator policy outside
the project. Extend adversarial tests with every new guest/host bridge. See the
[security model](docs/FUNCTION-SECURITY.md).

## Maintaining the starter

`starters/default` is the only initializer source. Keep its route YAML, functions
and request fixtures aligned with the public `urlcode-template` repository.
The public template adds its pinned runtime dependency, npm commands and CI;
CLI initialization uses the user's already installed runtime. Test both paths.
The richer asset demo lives in `examples/assets`, not a selectable starter.
Old starter-dynamic/starter-redirects branches are historical and no longer
maintained; do not use them in onboarding or publish further subtree updates.
