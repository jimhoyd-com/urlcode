# Build-time TypeScript guests

The runtime does not need the TypeScript compiler. Install the optional compiler
only where you use `build-typescript`, in the site whose `@jimhoyd/urlcode`
install runs it (the directory holding its `package.json`), so the runtime
resolves it from the same `node_modules`. The runtime prints this command when
the compiler is missing:

```sh
npm install --save-dev --save-exact typescript@6.0.3
```

TypeScript guest authoring is a separate build step. Serving still accepts only
JavaScript ES modules. The build never imports application modules into Node
or runs application code, and it is `sandbox`-aware per route
(docs/SPIKE-DEFAULT-TRUST-MODEL.md): a route that declares `sandbox: true` is
transpiled under the sandbox's own module rules (relative imports only, no
dynamic import/bare specifiers, the module/size limits below), exactly as
before; a trusted (non-`sandbox: true`) route is transpiled without those
import/size restrictions, since it will run with full Node access — bare/npm
imports, dynamic `import()`, `import.meta` — once served. Both modes still
diagnose only syntax, not semantics, and neither imports application code into
the build process in a way that executes it.

```sh
urlcode recipes add typescript --out ./hello-source
urlcode build-typescript --project ./hello-source --out ./hello-built --dry-run
urlcode build-typescript --project ./hello-source --out ./hello-built
urlcode validate --local --project ./hello-built
urlcode serve --project ./hello-built
```

The SDK equivalent is
`await buildTypeScriptProject(source, output, {dryRun: false})`. The report lists
emitted modules and files and explicitly returns `typeChecked: false`.

Point `function.source` or `middleware[].source` at a `.ts`, `.js` or `.mjs`
module. Use explicit relative extensions in imports, such as
`import {message} from './message.ts'`. The build emits `.ts` as `.js` and
rewrites the runtime imports and YAML source references. Existing JavaScript
modules are preserved. Output name collisions, including case-only collisions,
are refused for portability. Source `.d.ts` entries are not executable modules.
The runtime's existing handling of relative imports/re-exports applies to the
emitted graph; unsupported re-export forms remain refused.

The trusted pinned TypeScript compiler transpiles ES2022/ES modules with fixed
settings. It does not read `tsconfig.json`, package scripts, plugins, compiler
transformers, dependency packages, Node declarations or ambient environment
files. It diagnoses syntax errors, but does **not** perform semantic type
checking, in either mode. CommonJS import/export syntax and imports outside
the project are always refused. Type-only relative imports are erased without
reading their targets.

For a `sandbox: true` route, bare/npm imports (including static type-only
imports), dynamic runtime imports, `import.meta` and import attributes are
refused, and the source graph is limited to 128 modules, 1 MiB per source and
4 MiB aggregate; the emitted graph must also pass the runtime's own sandboxed
source parser and byte limits before publication. For a trusted route, none of
that applies: bare/npm specifiers, dynamic `import()`, `import.meta` and
import attributes pass through unchanged (resolved by Node at serve time, not
by this build), and there is no module-count or aggregate-size ceiling — only
a generous 16 MiB per-source read cap that bounds authoring-time memory. A
module may be shared by trusted and sandboxed routes: it is emitted once, and
every module reachable from a `sandbox: true` route is still validated under
the sandbox rules and budgets above, which does not disqualify the trusted
route that also imports it. In both modes,
no import extension inference occurs — relative imports of project modules
still need an explicit `.ts`/`.js`/`.mjs` extension to be rewritten and
followed. This does not execute the modules or replace normal route, policy,
binding or sandbox validation at activation. Unsupported host/browser APIs
remain unavailable in QuickJS, even if TypeScript accepts their names. Run
`urlcode validate --local` and project tests on the output.

Includes are flattened into a duplicate-checked entry document. Only referenced
modules, page/download assets, static trees, site favicon/llms files and the
`tests/requests.json` fixtures (when present) are snapshotted. Unreferenced files, dotenv, hidden files, package manifests and
credential extensions are not copied. An explicit reference to a forbidden file
fails rather than silently excluding it. Asset limits are 16 MiB per file,
64 MiB aggregate and 10,000 output files. Empty static directories are refused;
add an asset before building. Paths have at most 32 segments and 1,024 characters;
symlinked source files/directories and multiply linked files are refused.
The input project and output parent must be stable and controlled by the caller
while building; this is not a hardened service for concurrent hostile writers.

Output must be a new directory whose parent already exists. Dependencies are
written before an atomic rename publishes the complete entry YAML; existing
outputs are never overwritten. Failed builds remove their newly created output.
Dry-run still transpiles and validates an isolated temporary snapshot, then
removes it; it never writes the requested output. Configuration parsing keeps
the loader's worker limits; transpilation runs in the authoring process and is
not a sandboxed multi-tenant compilation service.

Create operator grants against the **built** configuration/code revision.
Transpilation and flattened includes change the snapshot digest, so source
project grants must not be reused. External capabilities remain denied without
an exact revision-pinned operator policy. The build never resolves bindings or
copies credentials; it preserves logical binding declarations only.
