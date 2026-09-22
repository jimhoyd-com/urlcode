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
// This check FAILS (exit 1). Four rules, each derived from the schema rather
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
//   4. closed-object-keys    An inline mapping written against a schema
//                            definition that closes its key set
//                            (`additionalProperties: false`) may not carry a
//                            key that definition does not declare.
//
// Rules 1-3 read the agent-facing surfaces listed in TARGETS. Rule 4 reads
// every authored Markdown file instead, because the example a human copies is
// usually in reference or explanatory prose that no agent surface contains:
// #168 found `auth: { required: true, roles: [admin] }` in a planning document,
// where `routeAuth` closes its key set and the shipped field is `role`
// singular. That YAML is rejected by the validator, and nothing flagged it.
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
  'packages/core/src/agents-guide.ts',
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

// Every authored Markdown file in the checkout, for rule 4. Walked from disk
// rather than listed, for the same reason packageTargets() is: a hand-maintained
// list goes stale silently, and the failure mode is a page that looks covered
// while nothing scans it. Build output and dependencies carry no authored prose.
// Dotted directories are skipped, matching check-trust-model-prose.ts -- which
// also keeps the walk out of `.claude/worktrees`, where each entry is a full
// second copy of this repository.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage']);
async function markdownFiles(prefix = ''): Promise<string[]> {
  const entries = await readdir(new URL(prefix, root), { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      found.push(...(await markdownFiles(`${prefix}${entry.name}/`)));
    } else if (entry.name.endsWith('.md')) {
      found.push(`${prefix}${entry.name}`);
    }
  }
  return found;
}

const schema = JSON.parse(await readFile(new URL('schemas/urlcode.schema.json', root), 'utf8'));
const fields = schemaNames(schema, new Set<string>());
const handlers = Object.keys(schema.$defs?.route?.properties ?? {});
// A JSON Schema node, narrowed only where this check reads it.
type Node = Record<string, unknown>;
const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null;
const defs: Node = isNode(schema.$defs) ? schema.$defs : {};

// Rule 4's table: field name -> the keys its schema definition declares, for
// every field whose object form closes its key set. Derived by walking the
// schema, so a new closed definition is covered the day it lands.
function deref(node: unknown): unknown {
  if (!isNode(node)) return node;
  const ref = node.$ref;
  return typeof ref === 'string' && ref.startsWith('#/$defs/') ? defs[ref.slice(8)] : node;
}
const propertiesOf = (node: Node): Node | undefined => (isNode(node.properties) ? node.properties : undefined);

// A field may be written as `false`, `true` or an object; collect the object
// shapes it can take, flattening oneOf/anyOf.
function objectShapes(node: unknown): Node[] {
  const out: Node[] = [];
  const seen = new Set<Node>();
  const visit = (candidate: unknown) => {
    const value = deref(candidate);
    if (!isNode(value) || seen.has(value)) return;
    seen.add(value);
    const union = value.oneOf ?? value.anyOf;
    if (Array.isArray(union)) union.forEach(visit);
    else out.push(value);
  };
  visit(node);
  return out.filter(shape => propertiesOf(shape) || shape.type === 'object' || shape.propertyNames);
}

const closedKeys = new Map<string, Set<string>>();
(function collect(node: unknown) {
  if (!isNode(node)) return;
  const properties = propertiesOf(node);
  if (properties) {
    for (const [name, value] of Object.entries(properties)) {
      const shapes = objectShapes(value);
      if (!shapes.length) continue;
      if (!shapes.every(shape => shape.additionalProperties === false && propertiesOf(shape))) continue;
      const known = closedKeys.get(name) ?? new Set<string>();
      for (const shape of shapes) for (const key of Object.keys(propertiesOf(shape) ?? {})) known.add(key);
      closedKeys.set(name, known);
    }
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(collect);
    else collect(value);
  }
})(schema);

const failures: string[] = [];
let scanned = 0;
let markdownScanned = 0;

for (const target of [...TARGETS, ...(await packageTargets())]) {
  let source: string;
  try { source = await readFile(new URL(target, root), 'utf8'); } catch { continue; }
  scanned += 1;
  if (source.includes('<!-- guidance-claims: ignore-file -->')) continue;

  let carried = false;
  for (const { text, line } of paragraphs(source)) {
    const exempt = carried || text.includes('<!-- guidance-claims: ignore -->');
    // A marker standing alone exempts the paragraph after it too -- the header
    // has always promised this, and rule 4 needs it: a fenced block cannot hold
    // an HTML comment without the comment becoming part of the example.
    carried = text.trim() === '<!-- guidance-claims: ignore -->';
    if (exempt) continue;
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

// Rule 4 over every authored Markdown file. Kept as a separate pass because its
// scope is the whole documentation set, not the agent surfaces above.
//
// It fires only on a mapping that mixes declared and undeclared keys. That
// mixed-key test is what makes the rule safe to run this widely, and it was
// measured rather than assumed: matching on an undeclared key alone flags 15
// lines across the repository and 14 are false, because a key name means
// different things at different depths -- `page: {from: query, name: page}` is
// a function argument named `page`, not the `page` handler, and
// `auth: {signedIn: true}` is an extension's own policy under
// `policies.extensions`, not the closed `routeAuth`. Requiring at least one
// declared key alongside the undeclared one identifies the mapping as the
// closed shape and drops all 14, while still catching the #168 defect, where
// `required` sits beside `roles`.
// The walk skips dotted directories, so the skill copies under `.claude/` are
// added back explicitly -- they teach YAML too.
const rule4Targets = [
  ...(await markdownFiles()),
  ...[...TARGETS, ...(await packageTargets())].filter(target => target.endsWith('.md')),
];
const seenMarkdown = new Set<string>();
for (const target of rule4Targets) {
  if (seenMarkdown.has(target)) continue;
  seenMarkdown.add(target);
  let source: string;
  try { source = await readFile(new URL(target, root), 'utf8'); } catch { continue; }
  markdownScanned += 1;
  if (source.includes('<!-- guidance-claims: ignore-file -->')) continue;

  // A marker on its own line exempts whatever comes next: the rest of a fenced
  // block if the next content is a fence, otherwise the paragraph up to the
  // next blank line. A marker sharing a line exempts just that line.
  let pending = false;
  let exemptFence = false;
  let exemptParagraph = false;
  for (const [index, line] of source.split('\n').entries()) {
    const trimmed = line.trim();
    const isFence = trimmed.startsWith('```');
    const isMarker = trimmed === '<!-- guidance-claims: ignore -->';

    if (exemptFence) {
      if (isFence) exemptFence = false;
      continue;
    }
    if (isMarker) { pending = true; continue; }
    if (pending && trimmed === '') continue;
    if (pending) {
      pending = false;
      if (isFence) { exemptFence = true; continue; }
      exemptParagraph = true;
    }
    if (exemptParagraph) {
      if (trimmed === '') exemptParagraph = false;
      else continue;
    }
    if (line.includes('<!-- guidance-claims: ignore -->')) continue;
    if (isFence) continue;

    for (const [name, allowed] of closedKeys) {
      // Innermost mappings only: `[^{}]*` refuses to span a nested brace, so
      // `policies: { cache: { ... } }` is read at `cache`, where the keys are.
      for (const match of line.matchAll(new RegExp(`\\b${name}:\\s*\\{([^{}]*)\\}`, 'g'))) {
        // A key starts the mapping or follows a comma. Anchoring this way keeps
        // a URL scheme in a value (`url: https://example.com`) from reading as
        // a key named `https`.
        const keys = [...(match[1] ?? '').matchAll(/(?:^|,)\s*([A-Za-z][\w-]*)\s*:/g)].map(entry => entry[1] ?? '');
        const undeclared = keys.filter(key => !allowed.has(key));
        if (!undeclared.length || !keys.some(key => allowed.has(key))) continue;
        failures.push(`${target}:${index + 1}  closed-object-keys: \`${name}\` closes its key set in schemas/urlcode.schema.json, which does not declare ${undeclared.map(key => `\`${key}\``).join(', ')}. This example is rejected by the validator.`);
      }
    }
  }
}

if (failures.length) {
  console.error(`Guidance-claims check: ${failures.length} contradiction(s) between agent guidance and schemas/urlcode.schema.json\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error('\nFix the guidance, or mark deliberately version-specific text with <!-- guidance-claims: ignore -->.');
  process.exit(1);
}

console.log(`Guidance-claims check: ${scanned} agent-facing file(s) scanned against ${fields.size} schema fields, and ${markdownScanned} Markdown file(s) against ${closedKeys.size} closed key sets, no contradictions.`);
