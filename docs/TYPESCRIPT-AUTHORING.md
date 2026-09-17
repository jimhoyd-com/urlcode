# Build-time TypeScript guests

TypeScript guest authoring is a separate build step. Serving still accepts only
JavaScript ES modules and executes them exclusively in QuickJS/WebAssembly.
The build never imports application modules into Node or runs application code.

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
checking. Type-only relative imports are erased without reading their targets.
Bare/npm imports (including static type-only imports), CommonJS import/export
syntax, dynamic runtime imports, `import.meta`, import attributes and imports
outside the project are refused. No import extension inference occurs.

The source graph is limited to 128 modules, 1 MiB per source and 4 MiB aggregate.
The emitted graph must pass the runtime's own source parser and byte limits
before publication. This does not execute the modules or replace normal route,
policy, binding or sandbox validation at activation. Unsupported host/browser
APIs remain unavailable in QuickJS, even if TypeScript accepts their names.
Run `urlcode validate --local` and project tests on the output.

Includes are flattened into a duplicate-checked entry document. Only referenced
modules, page/download assets, static trees and site favicon/llms files are
snapshotted. Unreferenced files, dotenv, hidden files, package manifests and
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
