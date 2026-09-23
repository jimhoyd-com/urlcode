import { readFile, stat } from 'node:fs/promises';
import { relative, dirname, resolve, sep, posix } from 'node:path';
import { init, parse } from 'es-module-lexer';
import { functionFile } from './config.ts';
import { assert } from './errors.ts';

/** A function or middleware reference with its export named: what the sandbox loads. */
export interface FunctionDefinition { source: string; export: string }
/** Any route-like object carrying function definitions (a YAML route, whose `export` may be absent, or a compiled one). */
export interface FunctionRoute<D = FunctionDefinition> { middleware?: D[] | undefined; function?: D | undefined }
export interface FunctionSources {
  /** Module source text keyed by project-relative name (`/lib/a.mjs`). */
  sources: Record<string, string>; dependencies: Record<string, string[]>;
  /** Distinct [module, export] entry points. */
  entries: [string, string][];
  /** Absolute source path to module name. */
  names: Map<string, string>;
}

/** Snapshot budgets: what one set of guest modules may cost. Deliberate bounds
 * of the sandbox contract (docs/FUNCTION-SECURITY.md), not tuning knobs. */
export const MODULE_LIMIT = 128;
export const MODULE_BYTE_LIMIT = 1048576;
export const TOTAL_BYTE_LIMIT = 4194304;

export function routeFunctions<D>(route: FunctionRoute<D>): D[] { return [...(route.middleware || []), ...(route.function ? [route.function] : [])]; }

// Trusted (unsandboxed) routes are never bundled into a QuickJS module snapshot:
// they run through Node's own module resolution, with no restriction on bare
// specifiers, dynamic import or dependency count/size. For revision pinning
// (docs/SPIKE-DEFAULT-TRUST-MODEL.md, "trust-declaration integrity"), the
// project hash must still change when a trusted function/middleware's own
// source changes, so an operator's env/secret grant is invalidated the moment
// the code that could use it is edited. This only hashes each entry file's own
// bytes, not its transitive import graph the way the sandboxed collector does:
// a change to a helper module a trusted entry imports, without touching the
// entry file itself, does not by itself change the project hash. Documented as
// a known limitation in docs/FUNCTION-SECURITY.md.
export async function collectTrustedSources(routes: FunctionRoute[], root: string): Promise<Record<string, string>> {
  const sources: Record<string, string> = Object.create(null);
  for (const definition of routes.flatMap(routeFunctions)) {
    const name = '/' + relative(root, definition.source).split(sep).join('/');
    if (Object.hasOwn(sources, name)) continue;
    sources[name] = await readFile(definition.source, 'utf8');
  }
  return sources;
}

// Parse and snapshot source without ever importing project code into Node.
// Route-shaped callers go through `collectFunctionSources` below; a
// route-independent caller (the public sandbox primitive, src/sandbox.ts)
// calls this directly with its own explicit `{source, export}` list, so the
// module-allowlist walk and per-module/total byte budgets apply identically
// either way — there is exactly one collector, not a route-shaped one and a
// second generic one.
export async function collectSourcesFor(definitions: FunctionDefinition[], root: string): Promise<FunctionSources> {
  await init;
  const sources: Record<string, string> = Object.create(null), dependencies: Record<string, string[]> = Object.create(null);
  const entries: [string, string][] = [], names = new Map<string, string>(), seenEntries = new Set<string>();
  let bytes = 0;
  async function collect(file: string): Promise<string> {
    const name = '/' + relative(root,file).split(sep).join('/');
    if (Object.hasOwn(sources,name)) return name;
    // Name the module that crossed the budget and the counts against their
    // limits: the bare limit alone reads as a sandbox fault, when it usually
    // means the project has outgrown what one snapshot holds. Prerendering
    // splits a large site across snapshots rather than inheriting the bound as
    // a page ceiling. See docs/PRERENDER.md#function-budgets.
    assert(Object.keys(sources).length < MODULE_LIMIT, `Function module limit exceeded: ${name} is module ${Object.keys(sources).length + 1}, over the limit of ${MODULE_LIMIT} modules per snapshot`);
    const info = await stat(file);
    assert(info.size <= MODULE_BYTE_LIMIT, `Function source limit exceeded: ${name} is ${info.size} bytes, over the per-module limit of ${MODULE_BYTE_LIMIT} bytes`);
    assert(bytes + info.size <= TOTAL_BYTE_LIMIT, `Function source limit exceeded: ${name} (${info.size} bytes) brings the snapshot to ${bytes + info.size} bytes, over the total limit of ${TOTAL_BYTE_LIMIT} bytes`);
    const code = await readFile(file,'utf8'); bytes += Buffer.byteLength(code);
    assert(bytes <= TOTAL_BYTE_LIMIT, `Function source limit exceeded: ${name} brings the snapshot to ${bytes} bytes, over the total limit of ${TOTAL_BYTE_LIMIT} bytes`);
    sources[name] = code; const deps: string[] = dependencies[name] = [];
    const [imports] = parse(code);
    for (const item of imports) {
      assert(item.type === 'static' && typeof item.specifier === 'string' && !item.attributes && !item.phase, `Dynamic imports and import.meta are unsupported in sandbox functions (in ${name})`, { code: 'sandbox-import', file: name.slice(1) });
      const specifier = JSON.stringify(item.specifier.length > 100 ? `${item.specifier.slice(0, 100)}...` : item.specifier);
      assert(item.specifier.startsWith('./') || item.specifier.startsWith('../'), `Only relative project JavaScript imports are allowed: ${name} imports ${specifier}. A sandbox: true function has no Node built-ins or packages; import a ./ or ../ project module instead, or (after a deliberate trust review) drop sandbox: true so the route runs trusted`, { code: 'sandbox-import', file: name.slice(1) });
      const dependency = await functionFile(root,relative(root,resolve(dirname(file),item.specifier)));
      assert(posix.normalize(posix.join(posix.dirname(name),item.specifier)).startsWith('/'), 'Invalid module reference');
      deps.push(await collect(dependency));
    }
    return name;
  }
  for (const definition of definitions) {
    const name = await collect(definition.source);
    names.set(definition.source,name);
    const key = name + ":" + definition.export;
    if (!seenEntries.has(key)) { entries.push([name,definition.export]); seenEntries.add(key); }
  }
  return { sources,dependencies,entries,names };
}
/** Route-shaped convenience over `collectSourcesFor`: every existing caller (policy.ts,
 * prerender.ts, typescript-authoring.ts) keeps working unchanged from `FunctionRoute[]`. */
export async function collectFunctionSources(routes: FunctionRoute[], root: string): Promise<FunctionSources> {
  return collectSourcesFor(routes.flatMap(routeFunctions), root);
}
