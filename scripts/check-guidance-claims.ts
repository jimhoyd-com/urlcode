// Enforcing guard that agent-facing guidance agrees with the schema it teaches.
//
// URLCode's agent surfaces -- the generated project guide, the bundled starter,
// the three skill copies, the llms indexes and the AI authoring contract -- tell
// an agent which YAML it may write. When one of them contradicts
// schemas/urlcode.schema.json, every agent that reads it generates the wrong
// project, and nothing else in `npm run check` notices: lint, typecheck,
// generated-resource checks and the test suite all pass while the prose is
// wrong about the product.
//
// That happened. In #158 the guidance gained the sentence "never invent an
// `auth` field" while route-level `auth` was implemented, schema-defined and
// asserted in test/recipes.test.ts, steering agents away from a supported
// declarative short form and toward the long policy form it expands to -- the
// opposite of the declarative-first principle the same change introduced. It
// merged green.
//
// This check FAILS (exit 1). Three rules, each derived from the schema rather
// than from a hand-maintained list:
//
//   1. no-denied-field       A field the schema defines may not be described as
//                            invented, unsupported or nonexistent.
//   2. handler-inventory     A line enumerating route handlers may name only
//                            handlers the schema still defines, so a removed
//                            one (`link`, extracted to the since-retired
//                            urlcode-dynamic-link package in
//                            f7dbe54) cannot linger in generated guidance.
//   3. taught-field          A field the guidance instructs the reader to
//                            declare must resolve in the schema.
//
// Opting out
// ----------
//   <!-- guidance-claims: ignore -->       exempts the paragraph it appears in,
//       or the paragraph immediately after it when the marker sits on its own
//       line.
//   <!-- guidance-claims: ignore-file -->  exempts the whole file.
//
// Use it for text that is deliberately about another version or a superseded
// design, never to silence a live contradiction. Guidance that is wrong about
// this revision gets fixed.
import { readdir, readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

// The surfaces an agent actually reads before writing YAML.
const TARGETS = [
  'src/agents-guide.ts',
  'starters/default/AGENTS.md',
  'skills/urlcode/SKILL.md',
  '.claude/skills/urlcode-authoring/SKILL.md',
  '.claude/skills/urlcode-operations/SKILL.md',
  'packaging/claude-plugin/skills/urlcode-authoring/SKILL.md',
  'packaging/claude-plugin/skills/urlcode-operations/SKILL.md',
  'llms.txt',
  'llms-full.txt',
  'docs/AI-AUTHORING.md',
];

// The same surfaces inside each workspace package under `packages/`. Read from
// disk rather than listed, so folding a package in or retiring one does not
// leave this array quietly out of date -- the failure mode being that a package
// looks covered while nothing scans it. Missing entries are skipped by the read
// below, so naming a file a package does not ship costs nothing.
async function packageTargets(): Promise<string[]> {
  const entries = await readdir(new URL('packages/', root), { withFileTypes: true }).catch(() => []);
  const targets: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    for (const name of ['llms.txt', 'llms-full.txt', 'AGENTS.md', 'docs/AI-AUTHORING.md', 'skills/SKILL.md']) {
      targets.push(`packages/${entry.name}/${name}`);
    }
  }
  return targets;
}

// Words that appear in backticks in a field-shaped sentence but are not YAML
// fields: commands, flags, files and the runtime's own exported symbols.
const NOT_FIELDS = new Set([
  'urlcode.yaml', 'host.js', 'host.mjs', '.mcp.json', 'package.json', 'AGENTS.md',
  'urlcode', 'npm', 'node', 'make', 'validate', 'test', 'audit', 'serve', 'dev',
  'init', 'build', 'context', 'explain', 'manifest', 'capabilities', 'schema',
  'recipes', 'examples', 'permissions', 'benchmark', 'doctor', 'mcp',
  'true', 'false', 'null', 'Response', 'Request', 'args', 'context.state',
]);

const DENIAL = /\b(?:never invent|do not invent|don't invent|does not exist|do not exist|no such (?:field|key)|unsupported field|is not a (?:field|key)|invented (?:field|key))\b/i;
const TEACHES = /\b(?:declare|add|set|write)\s+(?:the\s+)?`([A-Za-z][\w.]*)`\s+(?:field|key|block)\b/gi;
// How close a field name must sit to a denial before the denial is read as
// being about that field.
const PROXIMITY = 60;
const HANDLER_LINE = /\bhandlers?\b[^.\n]{0,40}:(?:[^.\n]*`[a-z][\w-]*`){3,}/i;

function schemaNames(node: unknown, into: Set<string>): Set<string> {
  if (!node || typeof node !== 'object') return into;
  const record = node as Record<string, unknown>;
  if (record.properties && typeof record.properties === 'object') {
    for (const key of Object.keys(record.properties as object)) into.add(key);
  }
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) for (const item of value) schemaNames(item, into);
    else schemaNames(value, into);
  }
  return into;
}

function paragraphs(text: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let buffer: string[] = [];
  let start = 1;
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') {
      if (buffer.length) out.push({ text: buffer.join(' '), line: start });
      buffer = [];
      start = index + 2;
      continue;
    }
    if (!buffer.length) start = index + 1;
    buffer.push(line.trim());
  }
  if (buffer.length) out.push({ text: buffer.join(' '), line: start });
  return out;
}

const schema = JSON.parse(await readFile(new URL('schemas/urlcode.schema.json', root), 'utf8'));
const fields = schemaNames(schema, new Set<string>());
const handlers = Object.keys(schema.$defs?.route?.properties ?? {});

const failures: string[] = [];
let scanned = 0;

for (const target of [...TARGETS, ...(await packageTargets())]) {
  let source: string;
  try { source = await readFile(new URL(target, root), 'utf8'); } catch { continue; }
  scanned += 1;
  if (source.includes('<!-- guidance-claims: ignore-file -->')) continue;

  for (const { text, line } of paragraphs(source)) {
    if (text.includes('<!-- guidance-claims: ignore -->')) continue;
    const where = `${target}:${line}`;

    // 1. A schema-defined field described as invented or nonexistent. Scoped to
    //    the sentence, and to a field named within PROXIMITY characters of the
    //    denial, so a general rule ("report unsupported requirements instead of
    //    inventing fields") standing beside an unrelated field name is clean.
    for (const sentence of text.split(/(?<=[.;])\s+/)) {
      const denial = DENIAL.exec(sentence);
      if (!denial) continue;
      for (const match of sentence.matchAll(/`([A-Za-z][\w.]*)`/g)) {
        const name = match[1] ?? '';
        if (!fields.has(name) || NOT_FIELDS.has(name)) continue;
        const distance = Math.abs((match.index ?? 0) - denial.index);
        if (distance > PROXIMITY) continue;
        failures.push(`${where}  no-denied-field: \`${name}\` is defined in schemas/urlcode.schema.json, but this text calls it invented or unsupported.`);
      }
    }

    // 2. A handler enumeration naming a handler the schema no longer defines.
    if (HANDLER_LINE.test(text)) {
      for (const match of text.matchAll(/`([a-z][\w-]*)`/g)) {
        const name = match[1] ?? '';
        if (!handlers.includes(name) && !NOT_FIELDS.has(name) && !fields.has(name)) {
          failures.push(`${where}  handler-inventory: \`${name}\` is listed among route handlers but the schema defines no such handler.`);
        }
      }
    }

    // 3. A field the reader is told to declare that the schema does not define.
    for (const match of text.matchAll(TEACHES)) {
      const name = match[1] ?? '';
      if (NOT_FIELDS.has(name) || fields.has(name)) continue;
      if (name.includes('.') && name.split('.').every(part => fields.has(part))) continue;
      failures.push(`${where}  taught-field: this text tells the reader to declare \`${name}\`, which the schema does not define.`);
    }
  }
}

if (failures.length) {
  console.error(`Guidance-claims check: ${failures.length} contradiction(s) between agent guidance and schemas/urlcode.schema.json\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error('\nFix the guidance, or mark deliberately version-specific text with <!-- guidance-claims: ignore -->.');
  process.exit(1);
}

console.log(`Guidance-claims check: ${scanned} agent-facing file(s) scanned against ${fields.size} schema fields, no contradictions.`);
