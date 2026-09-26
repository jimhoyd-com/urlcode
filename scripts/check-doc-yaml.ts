// Enforcing guard that the YAML examples in authored Markdown are real
// URLCode YAML (#780).
//
// Three guide examples shipped invalid: a flow-map redirect whose unquoted
// `{id}` is not YAML at all, a `page: {source: ...}` the schema refuses, and a
// `secrets` name outside the identifier pattern. Each read as plausible, and a
// reader (or an agent) copying it got an error the page never mentioned.
//
// For every fenced ```yaml / ```yml block in authored Markdown -- the guides
// under docs/ (docs/yaml/ and docs/policies/ first among them), recipe,
// example and package READMEs and the root pages -- this check:
//
//   1. parses it with the runtime's own strict YAML profile (`parseYaml`), and
//   2. validates it with the runtime's schema and route-shape rules
//      (`validateDocument`) when it is URLCode project YAML:
//        - a complete project (`version:` and `routes:`) is validated as is;
//        - a block whose top-level keys are all project keys (`routes`,
//          `policies`, `profiles`, `site`, `shared`, ...) is completed with
//          `version: "1"` (and an empty `routes:` when it has none);
//        - a route map (every top-level key starts with `/`) is wrapped as
//          `version: "1"` / `routes: <block>`.
//      Anything else (a GitHub workflow, an extension's own configuration
//      file, a single route body shown out of context) is only parsed.
//
// Build output, dependencies and dotted directories are skipped (the same
// walk check-local-links.ts makes), as are the generated schema reference and
// changelogs, which describe past releases.
//
// Opting out
// ----------
// An intentionally partial snippet -- one that elides with `...`, shows a
// refused form on purpose, or is not meant to be complete YAML -- carries a
// comment line in the block itself:
//
//   # snippet: partial
//
// The block is then skipped entirely. Say in the surrounding prose why it is
// partial. It FAILS (exit 1) on any other parse or validation error, naming
// the file, the block's first line and the runtime's message.
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml, validateDocument } from '../packages/core/src/config.ts';

const root = new URL('../', import.meta.url);

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage']);
const SKIP_FILES = new Set(['docs/YAML-REFERENCE.md']);
export const PARTIAL_MARKER = /^\s*#\s*snippet:\s*partial\b/m;
const PROJECT_KEYS = new Set(['version', 'routes', 'includes', 'policies', 'profiles', 'site', 'extensions', 'shared']);

export interface YamlBlock { line: number; text: string }

/** Fenced ```yaml / ```yml blocks of a Markdown source, with the 1-based line of their first content line. */
export function yamlBlocks(markdown: string): YamlBlock[] {
  const blocks: YamlBlock[] = [];
  let open: { fence: string; yaml: boolean; line: number; body: string[] } | undefined;
  for (const [index, line] of markdown.split('\n').entries()) {
    if (open) {
      const trimmed = line.trim();
      if (trimmed.startsWith(open.fence) && /^(`+|~+)$/.test(trimmed)) {
        if (open.yaml) blocks.push({ line: open.line, text: open.body.join('\n') });
        open = undefined;
      } else open.body.push(line);
      continue;
    }
    const start = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_-]*)/.exec(line);
    if (start) open = { fence: start[1]!, yaml: /^ya?ml$/i.test(start[2] ?? ''), line: index + 2, body: [] };
  }
  return blocks;
}

export type Outcome = { kind: 'skipped' | 'parsed' | 'validated' } | { kind: 'failed'; message: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The project document a block stands for, or undefined when it is not URLCode project YAML. */
export function asProject(data: unknown): Record<string, unknown> | undefined {
  if (!isObject(data)) return undefined;
  const keys = Object.keys(data);
  if (keys.length === 0) return undefined;
  if (keys.every(key => key.startsWith('/'))) return { version: '1', routes: data };
  if (keys.every(key => PROJECT_KEYS.has(key))) return { version: '1', routes: {}, ...data };
  return undefined;
}

/** Parses one block with the runtime's YAML profile and, when it is project YAML, validates it. */
export function checkBlock(text: string): Outcome {
  if (PARTIAL_MARKER.test(text)) return { kind: 'skipped' };
  let data: unknown;
  try { data = parseYaml(text); } catch (error) { return { kind: 'failed', message: (error as Error).message }; }
  const project = asProject(data);
  if (!project) return { kind: 'parsed' };
  try { validateDocument(structuredClone(project)); } catch (error) { return { kind: 'failed', message: (error as Error).message }; }
  return { kind: 'validated' };
}

async function markdownFiles(prefix = ''): Promise<string[]> {
  const entries = await readdir(new URL(prefix, root), { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
      found.push(...(await markdownFiles(`${path}/`)));
    } else if (entry.name.endsWith('.md') && entry.name !== 'CHANGELOG.md' && !SKIP_FILES.has(path)) {
      found.push(path);
    }
  }
  return found;
}

async function main(): Promise<void> {
  const failures: string[] = [];
  const counts = { validated: 0, parsed: 0, skipped: 0 };
  for (const file of await markdownFiles()) {
    const source = await readFile(new URL(file, root), 'utf8');
    for (const block of yamlBlocks(source)) {
      const outcome = checkBlock(block.text);
      if (outcome.kind === 'failed') failures.push(`  ${file}:${block.line}  ${outcome.message}`);
      else counts[outcome.kind] += 1;
    }
  }
  if (failures.length > 0) {
    console.error(`Guide YAML check: ${failures.length} block(s) are not valid URLCode YAML\n`);
    for (const failure of failures) console.error(failure);
    console.error('\nFix the example, or mark an intentionally partial snippet with a `# snippet: partial` comment line and say why in the prose.');
    process.exit(1);
  }
  console.log(`Guide YAML check: ${counts.validated} block(s) validated against the schema, ${counts.parsed} parsed only, ${counts.skipped} marked partial.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
