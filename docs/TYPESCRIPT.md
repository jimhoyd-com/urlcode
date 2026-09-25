# Using URLCode from TypeScript

The runtime is written in TypeScript and the published package ships
declarations for every export, so an operator application, a plugin, an
observer, a compliance rules module or a build script can be type-checked
against the same contract the runtime enforces at load time. Nothing in the
project format changes: YAML and project functions/middleware (trusted by
default, or `sandbox: true`) are unaffected, and a JavaScript application keeps
working exactly as before.

## What ships

The tarball contains `dist/`: one `.js` per runtime module, `dist/types/*.d.ts`
beside them, `dist/BUILD-MANIFEST.json` with a SHA-256 per emitted file, and
`dist/addons.json`, which pins every add-on released with this core (see
[add-ons](EXTENSIONS.md#add-ons-extensions-and-artifacts)).
`package.json` resolves every subpath through export conditions:

| Import | Runtime | Declarations |
|---|---|---|
| `@jimhoyd/urlcode` | `dist/index.js` | `dist/types/index.d.ts` |
| `@jimhoyd/urlcode/plugins`, `@jimhoyd/urlcode/policies`, `@jimhoyd/urlcode/observability`, `@jimhoyd/urlcode/compliance`, `@jimhoyd/urlcode/prerender`, `@jimhoyd/urlcode/extensions`, `@jimhoyd/urlcode/host`, `@jimhoyd/urlcode/sandbox`, `@jimhoyd/urlcode/agent-context`, `@jimhoyd/urlcode/skills` | `dist/<name>.js` | `dist/types/<name>.d.ts` |
| `@jimhoyd/urlcode/aws`, `@jimhoyd/urlcode/vercel`, `@jimhoyd/urlcode/cloudflare` | `dist/<name>.js` | `dist/types/<name>.d.ts` |
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
  `Server`, `ServerOptions`, `HostPlugin`, `Observer`, `TestPlan`.
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
- `@jimhoyd/urlcode/extensions`: `defineExtension`, `ExtensionDefinition`,
  `ScaffoldRequest`, `ScaffoldResult`, `HostContext`, `HostedExtension`,
  `RuntimeExtension`, `ExtensionActivation`, plus the hook helpers. See
  [extensions](EXTENSIONS.md#the-extension-definition).
- `@jimhoyd/urlcode/host`: `composeHost`, which builds a site's `host.mjs`
  export from its list of extensions.
- `@jimhoyd/urlcode/aws`, `@jimhoyd/urlcode/vercel`, `@jimhoyd/urlcode/cloudflare`: `LambdaEvent`,
  `LambdaHandler`, `LambdaHandlerOptions`; `VercelHandler`,
  `VercelHandlerOptions`; `Artifact`, `WorkerRoute`, `Validators`.
- `@jimhoyd/urlcode/sandbox`: `SandboxPool`, `SandboxEntry`, `SandboxTarget`,
  `SandboxInvocation`, `SandboxPoolOptions`, `functionFile`. The public
  sandboxed-execution primitive: the same QuickJS/worker-thread engine that
  already backs a `sandbox: true` `function`/`middleware` route
  (`FunctionPool`, internally), generalized to an explicit list of
  `{source, export}` entries instead of anything route/YAML-shaped, for an
  extension package that needs to run a project-supplied hook through real
  isolation when the project's own config declares `sandbox: true` on it
  (see [EXTENSIONS.md](EXTENSIONS.md#project-level-lifecycle-hooks) and
  [FUNCTION-SECURITY.md](FUNCTION-SECURITY.md)). There is no trusted-mode
  export here: a hook that does not declare `sandbox: true` is ordinary
  project code the extension `import()`s directly via
  `ExtensionActivation.root`, no primitive required.

  ```ts
  import { SandboxPool, functionFile } from '@jimhoyd/urlcode/sandbox';

  const source = await functionFile(root, hookConfig.source); // root: ExtensionActivation.root
  const entries = [{ source, export: hookConfig.export ?? 'default' }];
  const pool = await new SandboxPool(entries, { root, workers: 1 }).start();
  const result = await pool.execute({ entry: entries[0] }, request, context, undefined);
  await pool.close();
  ```
- `@jimhoyd/urlcode/agent-context`: `listSkills`, `getSkill`, `listAgentCatalog`, `readAddonCatalog`, `searchDocs`,
  `getExample`, `validateYaml`, `explainError`, `suggestFixtures`, `summarizeYamlChange`. Deterministic, package-owned
  agent tooling: bundled-skill metadata, bounded lexical documentation search
  ([coverage and sources](TOOLING.md#bounded-documentation-search)),
  supplied-YAML syntax/schema validation, short remediation
  guidance for validator output, request-fixture suggestions for supplied YAML
  and a names-only summary of what changed between two YAML documents (result
  types `FixtureSuggestions` and `YamlChangeSummary`; shapes in
  [tooling](TOOLING.md#fixture-suggestions)). Every function reads only fixed, package-owned
  files (never an arbitrary local path or a remote URL) and takes plain
  strings in, plain data out; the one exception is `searchDocs(text, {project})`,
  which with a project also reads the static guides and `urlcode.json`
  descriptors of add-ons installed and pin-verified in that project's site, as
  data only. This is the same module URLCode's own `serveMcp`
  (`mcp`/`search_docs`/`validate_yaml`/`explain_error`, see
  [tooling and MCP](TOOLING.md)) is built on, so a host building its own MCP
  server or agent-tooling surface can reuse it instead of re-implementing it
  or importing from `dist/` directly.

  ```ts
  import { searchDocs, validateYaml, explainError } from '@jimhoyd/urlcode/agent-context';

  const hits = await searchDocs('sandbox');
  const result = validateYaml(candidateYaml);
  if (!result.valid) console.log(explainError(result.error).guidance);
  ```
- `@jimhoyd/urlcode/skills`: `listShippedSkills`. Stable, public access to every
  skill this package ships (currently `urlcode`, `urlcode-authoring` and
  `urlcode-operations`) as `{name, version, text}[]`, where `version` is this
  package's own version and `text` is the skill's full `SKILL.md`, read fresh
  from the installed package. This is the supported way for a host -- for
  example a hosted service that serves URLCode's authoring skills to a model
  -- to read shipped skill content. Reaching into package-layout paths such as
  `node_modules/@jimhoyd/urlcode/.claude/skills/urlcode-authoring/SKILL.md` or
  `node_modules/@jimhoyd/urlcode/skills/urlcode/SKILL.md` directly stays
  explicitly unsupported: that layout can change without notice, while this
  export's shape is a stable contract.

  ```ts
  import { listShippedSkills } from '@jimhoyd/urlcode/skills';

  const skills = await listShippedSkills();
  const authoring = skills.find(skill => skill.name === 'urlcode-authoring');
  ```

```ts
import { startServer, type ServerOptions, type Observer } from '@jimhoyd/urlcode';
import type { Plugin } from '@jimhoyd/urlcode/plugins';

const audit: Plugin = { name: 'audit', version: '1.0.0', targets: ['node'], onError(request, error) { console.error(request.route, error); } };
const forwarder: Observer = { name: 'forwarder', version: '1.0.0', onEvent(event) { queue.push(event); } };
const options: ServerOptions = { project: './site', port: 3000, plugins: [audit], observers: [forwarder], metrics: true };
const server = await startServer(options);
await server.close();
```

`listAgentCatalog()` is the versioned discovery index for agent tooling. It
lists the core's shipped skills and reference entry points, plus the signed
add-on manifest. Behaviour itself remains owned by the schema and the
topic-specific documentation. An extension's detailed authoring contract is
available only through a local project MCP session with its operator host, and
an artifact's members only after local pin verification; a hosted catalog must
not imply that either component is installed or activated for a project.

`readAddonCatalog()` (also exported from `@jimhoyd/urlcode`, with the
`AddonCatalog` type) returns the release-wide add-on agent catalog that ships
beside `dist/addons.json`: every extension and artifact of this core's release
with its package, version, description, `requires` and descriptor agent
references. It reads that one JSON file and never imports, downloads, installs
or activates an add-on, so a hosted service can serve complete agent metadata
from its pinned core alone. Like `listAgentCatalog()`, it is release-wide
discovery, not evidence that a project installed anything; see
[extensions](EXTENSIONS.md#the-release-wide-agent-catalog).

## How `dist/` is built, and why it is the same JavaScript

`npm run build` (`scripts/build.ts`) runs Node's own type stripping over every
`packages/core/src/*.ts`, the same transform that runs the source in development, and
rewrites relative specifiers from `.ts` to `.js`. It does not bundle, minify,
down-level or transform syntax, and it refuses to emit a file whose line count
differs from its source, so every line and column of `dist/x.js` is the
corresponding line of `packages/core/src/x.ts` with types turned into whitespace. The
`.d.ts` files come from `tsc` and never touch runtime output; the build fails
on any type error. `dist` is never committed: the release workflow builds it
in the digest-pinned container, records the Node and TypeScript versions and
the per-file hashes in the signed manifest, and CI's `build-fidelity` job
builds twice and diffs the trees. See [release security](RELEASE-SECURITY.md).

## Runtime behavior

Because the shipped JavaScript is the stripped source, the installed package
runs `dist/`, not TypeScript source. Running `.ts` source directly through
`npm run dev` is only the developer loop and never ships. Historical comparison
code and results are kept privately by the maintainers and are not public
evidence.

## Contributing in TypeScript

The source, scripts and tests are checked by `npm run typecheck`
(strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`erasableSyntaxOnly`), which `npm run verify` runs. Only erasable syntax is
allowed, so no enums, namespaces or parameter properties: what Node can strip
is exactly what the build emits. Contributors need Node 22.18+ to run the
source; installed packages still run on 22.13+. See
[local development](LOCAL-DEVELOPMENT.md).

The root `tsconfig.json` and every package's `tsconfig.json` under
`packages/*` extend the shared `tsconfig.base.json`, so their compiler options
cannot drift independently; each still sets its own `include`. Plain
JavaScript build/release tooling (`action/comment.mjs`, `packages/*/scripts/*.mjs`) is additionally type-checked
with `npm run typecheck:tooling` (`allowJs`/`checkJs`, `tsconfig.checkjs.json`)
using JSDoc annotations; recipe and example `.mjs` files remain lint-only.
