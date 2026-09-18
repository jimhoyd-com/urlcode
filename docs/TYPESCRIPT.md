# Using URLCode from TypeScript

The runtime is written in TypeScript and the published package ships
declarations for every export, so an operator application, a plugin, an
observer, a compliance rules module or a build script can be type-checked
against the same contract the runtime enforces at load time. Nothing in the
project format changes: YAML and sandboxed functions are unaffected, and a
JavaScript application keeps working exactly as before.

## What ships

The tarball contains `dist/`: one `.js` per runtime module, `dist/types/*.d.ts`
beside them, and `dist/BUILD-MANIFEST.json` with a SHA-256 per emitted file.
`package.json` resolves every subpath through export conditions:

| Import | Runtime | Declarations |
|---|---|---|
| `urlcode` | `dist/index.js` | `dist/types/src/index.d.ts` |
| `@jimhoyd/urlcode/plugins`, `@jimhoyd/urlcode/policies`, `@jimhoyd/urlcode/observability`, `@jimhoyd/urlcode/compliance`, `@jimhoyd/urlcode/prerender`, `@jimhoyd/urlcode/extensions` | `dist/<name>.js` | `dist/types/src/<name>.d.ts` |
| `@jimhoyd/urlcode/aws`, `@jimhoyd/urlcode/vercel`, `@jimhoyd/urlcode/cloudflare` | `dist/<name>.js` | `dist/types/src/<name>.d.ts` |
| `@jimhoyd/urlcode/schema` | `schemas/urlcode.schema.json` | — |

Each entry has three conditions: `types` (the declarations), `default` (the
built JavaScript) and `development`, which points at the `.ts` source and
exists only so the repository's own tests and examples can import the package
by name without a build (`node --conditions=development`). An installed
package never uses it; Node refuses to strip types under `node_modules`.

Use `"module": "NodeNext"` (or `"bundler"`) resolution so the `exports` map
and its `types` condition apply. The declarations reference Node's types
(`Buffer`, `node:http`, `NodeJS.Timeout`), so a consumer needs `@types/node`,
as any Node application already has. The package smoke test installs the
packed tarball and type-checks a consumer that imports every subpath, so a
release cannot ship a declaration that does not resolve.

## The main exported types

- `urlcode`: `Runtime`, `RuntimeOptions`, `RuntimeRequest`, `RequestTrace`,
  `Server`, `ServerOptions`, `HostPlugin`, `Observer`, `TestPlan`, `LinkStore`,
  `LinkRow`, `LinkStoreOptions`, `LinkReader`, `LinkStoreBinding`, `LinkApi`,
  `LinkApiOptions`, `LinkEvent`, `LinkObserverOptions`.
- `@jimhoyd/urlcode/plugins`: `Plugin`, `PluginRuntime`, `PolicyRequest`,
  `HandlerResult`, `HeaderPair`, `TargetName`. See [plugins](PLUGINS.md).
- `@jimhoyd/urlcode/policies`: `PolicyModule`, `PolicyRegistry`, `PolicyRequest`,
  `PolicyContext`, `PolicyChain`, `PolicyShared`. See [policies](POLICIES.md).
- `@jimhoyd/urlcode/observability`: `Observer`, `ObserverEvent`, `MetricsSnapshot`,
  `Metrics`, `RecordContext`. See [observability](OBSERVABILITY.md).
- `@jimhoyd/urlcode/compliance`: `ComplianceRule`, `ProjectRule`, `RouteRule`,
  `ProjectContext`, `RouteContext`, `RawFinding`, `Finding`,
  `ComplianceOptions`, `ComplianceReport`, `ComplianceProfileName`. See
  [compliance](COMPLIANCE.md).
- `@jimhoyd/urlcode/prerender`: `PrerenderOptions`, `PrerenderedPage`,
  `NativeProjectOptions`. See [prerendering](PRERENDER.md).
- `@jimhoyd/urlcode/aws`, `@jimhoyd/urlcode/vercel`, `@jimhoyd/urlcode/cloudflare`: `LambdaEvent`,
  `LambdaHandler`, `LambdaHandlerOptions`; `VercelHandler`,
  `VercelHandlerOptions`; `Artifact`, `WorkerRoute`, `Validators`.

```ts
import { startServer, type ServerOptions, type Observer } from '@jimhoyd/urlcode';
import type { Plugin } from '@jimhoyd/urlcode/plugins';

const audit: Plugin = { name: 'audit', version: '1.0.0', targets: ['node'], onError(request, error) { console.error(request.route, error); } };
const forwarder: Observer = { name: 'forwarder', version: '1.0.0', onEvent(event) { queue.push(event); } };
const options: ServerOptions = { project: './site', port: 3000, plugins: [audit], observers: [forwarder], metrics: true };
const server = await startServer(options);
await server.close();
```

## How `dist/` is built, and why it is the same JavaScript

`npm run build` (`scripts/build.ts`) runs Node's own type stripping over every
`src/*.ts`, the same transform that runs the source in development, and
rewrites relative specifiers from `.ts` to `.js`. It does not bundle, minify,
down-level or transform syntax, and it refuses to emit a file whose line count
differs from its source, so every line and column of `dist/x.js` is the
corresponding line of `src/x.ts` with types turned into whitespace. The
`.d.ts` files come from `tsc` and never touch runtime output; the build fails
on any type error. `dist` is never committed: the release workflow builds it
in the digest-pinned container, records the Node and TypeScript versions and
the per-file hashes in the signed manifest, and CI's `build-fidelity` job
builds twice and diffs the trees. See [release security](RELEASE-SECURITY.md).

## No runtime cost

Because the shipped JavaScript is the stripped source, the package runs what
it ran before the conversion. The measurement in
[performance](PERFORMANCE.md#typescript-conversion-2026-09-17) compared the
last plain-JavaScript commit with `dist/` on the same machine: CLI cold start,
routing throughput, p95 latency and RSS are within run-to-run spread. Running
the `.ts` source directly, as `npm run dev` does in a clone, costs about
190 ms of cold start and 35 MiB for the stripping itself; that mode is the
developer loop and never ships.

## Contributing in TypeScript

The source, scripts, tests and benchmarks are checked by `npm run typecheck`
(strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`erasableSyntaxOnly`), which `npm run verify` runs. Only erasable syntax is
allowed, so no enums, namespaces or parameter properties: what Node can strip
is exactly what the build emits. Contributors need Node 22.18+ to run the
source; installed packages still run on 22.13+. See
[local development](LOCAL-DEVELOPMENT.md).
