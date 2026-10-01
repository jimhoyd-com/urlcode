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
//                            invented, unsupported or nonexistent -- including
//                            the plain negative forms "there is no `X` key",
//                            "has no `X`", "`X` is not a key" and "no `X`
//                            field" (#1008), which the first version missed:
//                            docs/AI-AUTHORING.md said "There is no `json` or
//                            `expectJson` key" while the fixture schema had
//                            `expectJson`.
//   2. handler-inventory     A line enumerating route handlers may name only
//                            handlers the schema still defines, so a removed
//                            one (`link`, extracted to the since-retired
//                            urlcode-dynamic-link package in
//                            f7dbe54) cannot linger in generated guidance.
//   3. taught-field          A field the guidance instructs the reader to
//                            declare or use ("use the `X` key") must resolve
//                            in the schema.
//
// "The schema" for rules 1 and 3 is every key set an agent writes against:
// schemas/urlcode.schema.json, the request fixtures in
// schemas/requests.schema.json and each workspace extension's
// descriptor (packages/*/urlcode.json). A claim that names its scope is checked
// against that scope alone: "no `json` request key" against the fixture keys,
// "`auth` has no `roles` key" against the `auth` policy's closed key set. Text
// inside fenced blocks is example code, not a claim, and a negative claim
// inside double quotes is being quoted, not made.
//   4. closed-object-keys    An inline mapping written against a schema
//                            definition that closes its key set
//                            (`additionalProperties: false`) may not carry a
//                            key that definition does not declare.
//
// Rules 1-3 read the agent-facing surfaces listed in TARGETS. Rule 4 reads
// every authored Markdown file instead, because the example a human copies is
// usually in reference or explanatory prose that no agent surface contains:
// #168 found `auth: { required: true, roles: [admin] }` in a planning document,
// where the auth policy closes its key set and the shipped field is `role`
// singular. That YAML is rejected by the validator, and nothing flagged it.
// Since #710 the `auth:` short form's keys belong to the auth extension, not
// the core schema, so its closed set comes from the auth package's
// `policySchema` (packages/auth/urlcode.json) plus core's own `required`.
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
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fenceLines } from '../packages/core/src/markdown-fences.ts';

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
  'recipes', 'examples', 'permissions', 'doctor', 'mcp',
  'true', 'false', 'null', 'Response', 'Request', 'args', 'context.state',
]);

// "is not a key" is left to NEGATIVE below, which reads which name it denies
// and in which scope, where a proximity guess would also blame the parent in
// "`roles` is not a key of `auth`".
const DENIAL = /\b(?:never invent|do not invent|don't invent|does not exist|do not exist|no such (?:field|key)|unsupported field|invented (?:field|key))\b/i;
// The building blocks of the negative and instructive claims below. A claim may
// list several names ("`json` or `expectJson`"), may qualify its noun with one
// word that scopes it ("request key"), and may name the parent it is about.
const SPAN = '`[A-Za-z][\\w.-]*`';
const LIST = `${SPAN}(?:\\s*,\\s*(?:(?:or|and|nor)\\s+)?${SPAN}|\\s+(?:or|and|nor)\\s+${SPAN})*`;
const NOUN = '(?:keys?|fields?|propert(?:y|ies)|options?)\\b';
const QUALIFIED_NOUN = `(?:(?<qual>[A-Za-z-]+|${SPAN})\\s+)?${NOUN}`;
const PARENT_AFTER = `(?:\\s+(?:in|on|under|of|for)\\s+(?:the\\s+|an?\\s+)?(?<parent>${SPAN}))?`;
// Each pattern captures `names`; `qual` and `parent` when the text scopes the
// claim. A name list with no noun after it is a claim only when the clause
// ends there ("There is no `expectJson`."), so "there is no `cache` on this
// route" -- a statement about one route -- is not read as one.
const NEGATIVE = [
  new RegExp(`\\b(?:there\\s+(?:is|are)|there's)\\s+no\\s+(?:such\\s+)?(?<names>${LIST})(?:\\s+${QUALIFIED_NOUN}${PARENT_AFTER}|(?=\\s*(?:[:;.)]|$)))`, 'gi'),
  new RegExp(`\\bno\\s+(?:such\\s+)?(?<names>${LIST})\\s+${QUALIFIED_NOUN}${PARENT_AFTER}`, 'gi'),
  new RegExp(`(?:(?<parent>${SPAN})\\s+)?\\b(?:has|have)\\s+no\\s+(?:such\\s+)?(?<names>${LIST})(?:\\s+${QUALIFIED_NOUN}|(?=\\s*(?:[:;.)]|$)))`, 'gi'),
  new RegExp(`(?<names>${LIST})\\s+(?:is|are)(?:\\s+not|n't)\\s+(?:an?\\s+)?(?:(?:valid|supported|recogni[sz]ed|known|real|YAML|schema)\\s+)?${QUALIFIED_NOUN}${PARENT_AFTER}`, 'gi'),
];
// Words before a negative that make it describe one instance rather than the
// schema: "a route with no `auth` field", "if there is no `cache` key",
// "a case that has no `expectBody`".
const INSTANCE_LEAD = /\b(?:with|without|if|when|whenever|unless|where|while|that|which|whose|who)\s+$/i;
// Qualifiers that name the request-fixture key set.
const REQUEST_QUALIFIERS = new Set(['request', 'requests', 'fixture', 'fixtures', 'case', 'step', 'steps', 'test']);
const TEACHES = new RegExp(`\\b(?:declare|add|set|write|use|include|pass)\\s+(?:the\\s+|an?\\s+)?\`(?<name>[A-Za-z][\\w.]*)\`\\s+(?:(?<qual>[A-Za-z-]+)\\s+)?(?:field|key|block)\\b`, 'gi');
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
// Every other key set an agent writes against, and where each name comes from,
// so a failure can say which schema defines the name it denies.
const requestSchema = JSON.parse(await readFile(new URL('schemas/requests.schema.json', root), 'utf8'));
const requestKeys = schemaNames(requestSchema, new Set<string>());
// A "request key" is a key of a case or a step, not a name nested deeper (a
// `capture` entry's `json` pointer is not a request key).
const requestCaseKeys = new Set(['case', 'step', 'steps'].flatMap(name => Object.keys(requestSchema.$defs?.[name]?.properties ?? {})));
const sources = new Map<string, Set<string>>([
  ['schemas/urlcode.schema.json', fields],
  ['schemas/requests.schema.json', requestKeys],
]);
for (const entry of await readdir(new URL('packages/', root), { withFileTypes: true }).catch(() => [])) {
  if (!entry.isDirectory()) continue;
  const path = `packages/${entry.name}/urlcode.json`;
  let descriptor: Record<string, unknown>;
  try { descriptor = JSON.parse(await readFile(new URL(path, root), 'utf8')); } catch { continue; }
  sources.set(path, schemaNames([descriptor.schema, descriptor.policySchema], new Set<string>()));
}
const allKeys = new Set([...sources.values()].flatMap(set => [...set]));
const definedIn = (name: string) => [...sources].filter(([, set]) => set.has(name)).map(([path]) => path).join(', ');
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
// The `auth:` short form is open in the core schema (#710): the auth extension
// owns its keys, so they are read from the auth package's generated descriptor.
{
  const descriptor = JSON.parse(await readFile(new URL('packages/auth/urlcode.json', root), 'utf8'));
  const policy = deref(descriptor.policySchema);
  if (isNode(policy) && policy.additionalProperties === false && propertiesOf(policy)) {
    closedKeys.set('auth', new Set(['required', ...Object.keys(propertiesOf(policy) ?? {})]));
    for (const [name, value] of Object.entries(propertiesOf(policy) ?? {})) {
      const shapes = objectShapes(value);
      if (shapes.length && shapes.every(shape => shape.additionalProperties === false && propertiesOf(shape)) && !closedKeys.has(name)) closedKeys.set(name, new Set(shapes.flatMap(shape => Object.keys(propertiesOf(shape) ?? {}))));
    }
  }
}

// The key set a claim is about. A scoped claim is checked against its scope
// alone; a claim scoped to a parent this check has no closed key set for
// cannot be verified, so it is skipped rather than checked against every key.
function scopeOf(qual: string | undefined, parent: string | undefined): { keys: Set<string>; label: string } | undefined {
  const named = parent ?? (qual?.startsWith('`') ? qual : undefined);
  if (named) {
    const name = named.slice(1, -1);
    const closed = closedKeys.get(name);
    if (closed) return { keys: closed, label: `the closed \`${name}\` key set` };
    if (REQUEST_QUALIFIERS.has(name)) return { keys: requestCaseKeys, label: 'schemas/requests.schema.json' };
    return undefined;
  }
  if (qual && REQUEST_QUALIFIERS.has(qual.toLowerCase())) return { keys: requestCaseKeys, label: 'schemas/requests.schema.json' };
  return { keys: allKeys, label: '' };
}

// Is `index` inside a double-quoted passage of `sentence`? A negative claim in
// quotes is being cited ("the old guide said \"there is no `x` key\""), not made.
function quoted(sentence: string, index: number): boolean {
  const before = sentence.slice(0, index);
  const straight = (before.match(/"/g) ?? []).length;
  const open = (before.match(/“/g) ?? []).length;
  const close = (before.match(/”/g) ?? []).length;
  return straight % 2 === 1 || open > close;
}

// Fenced blocks are example code, not claims about the schema: a documented
// "don't write this" block names wrong keys on purpose. Each fenced line is
// blanked so line numbers hold; the opening fence stays, as a paragraph of its
// own, so a marker standing before the fence still exempts the fence and not
// the prose after it.
// Fences follow packages/core/src/markdown-fences.ts.
export function withoutFences(source: string): string {
  const fences = fenceLines(source);
  return source.split('\n').map((line, index) => {
    const fence = fences[index]!;
    if (fence.kind === 'text') return line;
    return fence.kind === 'open' ? fence.fence.char.repeat(fence.fence.length) : '';
  }).join('\n');
}

// Rules 1-3 over one paragraph of agent-facing prose. Exported so the test
// suite can hold the exact sentences that escaped the check.
export function proseFailures(text: string, where: string): string[] {
  const failures: string[] = [];
  for (const sentence of text.split(/(?<=[.;])\s+/)) {
    // 1. A schema-defined field described as invented or nonexistent. Scoped to
    //    the sentence, and to a field named within PROXIMITY characters of the
    //    denial, so a general rule ("report unsupported requirements instead of
    //    inventing fields") standing beside an unrelated field name is clean.
    const reported = new Set<string>();
    const denial = DENIAL.exec(sentence);
    if (denial && !quoted(sentence, denial.index)) {
      for (const match of sentence.matchAll(/`([A-Za-z][\w.]*)`/g)) {
        const name = match[1] ?? '';
        if (!allKeys.has(name) || NOT_FIELDS.has(name)) continue;
        const distance = Math.abs((match.index ?? 0) - denial.index);
        if (distance > PROXIMITY) continue;
        reported.add(name);
        failures.push(`${where}  no-denied-field: \`${name}\` is defined in ${definedIn(name)}, but this text calls it invented or unsupported.`);
      }
    }
    //    ...and the plain negative forms (#1008): "there is no `X` key", "has
    //    no `X`", "`X` is not a key", "no `X` field". Each names exactly the
    //    keys it denies, so no proximity guess is needed.
    for (const [kind, pattern] of NEGATIVE.entries()) {
      // "a project with no `policies` key and no `profiles` key": a negative
      // joined to an instance description by and/or describes the instance too.
      let previousInstance = false;
      for (const match of sentence.matchAll(pattern)) {
        const lead = sentence.slice(0, match.index);
        const instance: boolean = INSTANCE_LEAD.test(lead) || (previousInstance && /\b(?:and|or|nor)\s+$/i.test(lead));
        previousInstance = instance;
        if (instance || quoted(sentence, match.index)) continue;
        // "no `X` key" inside "there is no" or "has no" belongs to those patterns.
        if (kind === 1 && /\b(?:is|are|there's|has|have)\s+$/i.test(lead)) continue;
        const scope = scopeOf(match.groups?.qual, match.groups?.parent);
        if (!scope) continue;
        for (const span of (match.groups?.names ?? '').matchAll(/`([A-Za-z][\w.-]*)`/g)) {
          const name = span[1] ?? '';
          if (reported.has(name) || NOT_FIELDS.has(name) || !scope.keys.has(name)) continue;
          reported.add(name);
          failures.push(`${where}  no-denied-field: \`${name}\` is defined in ${scope.label || definedIn(name)}, but this text says there is no such key.`);
        }
      }
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

  // 3. A field the reader is told to declare or use that the schema does not
  //    define -- the reverse of rule 1.
  for (const match of text.matchAll(TEACHES)) {
    const name = match.groups?.name ?? '';
    const qual = match.groups?.qual?.toLowerCase();
    const keys = qual && REQUEST_QUALIFIERS.has(qual) ? requestCaseKeys : allKeys;
    if (NOT_FIELDS.has(name) || keys.has(name)) continue;
    if (name.includes('.') && name.split('.').every(part => keys.has(part))) continue;
    failures.push(`${where}  taught-field: this text tells the reader to declare or use \`${name}\`, which the schema does not define.`);
  }
  return failures;
}

async function main(): Promise<void> {
  const failures: string[] = [];
  let scanned = 0;
  let markdownScanned = 0;

  for (const target of [...TARGETS, ...(await packageTargets())]) {
    let source: string;
    try { source = await readFile(new URL(target, root), 'utf8'); } catch { continue; }
    scanned += 1;
    if (source.includes('<!-- guidance-claims: ignore-file -->')) continue;
    // The generated guide is a template literal, so its code spans are escaped.
    if (target.endsWith('.ts')) source = source.replaceAll('\\`', '`');

    let carried = false;
    for (const { text, line } of paragraphs(withoutFences(source))) {
      const exempt = carried || text.includes('<!-- guidance-claims: ignore -->');
      // A marker standing alone exempts the paragraph after it too -- the header
      // has always promised this, and rule 4 needs it: a fenced block cannot hold
      // an HTML comment without the comment becoming part of the example.
      carried = text.trim() === '<!-- guidance-claims: ignore -->';
      if (exempt) continue;
      failures.push(...proseFailures(text, `${target}:${line}`));
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
  // `policies.extensions`, not the closed `auth:` short form. Requiring at least one
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
    const fences = fenceLines(source);
    for (const [index, line] of source.split('\n').entries()) {
      const trimmed = line.trim();
      const fenceKind = fences[index]!.kind;
      const isFence = fenceKind === 'open' || fenceKind === 'close';
      const isMarker = trimmed === '<!-- guidance-claims: ignore -->';

      if (exemptFence) {
        if (fenceKind === 'close') exemptFence = false;
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
          failures.push(`${target}:${index + 1}  closed-object-keys: \`${name}\` closes its key set in ${name === 'auth' ? 'the auth extension\'s policySchema (packages/auth/urlcode.json)' : 'schemas/urlcode.schema.json'}, which does not declare ${undeclared.map(key => `\`${key}\``).join(', ')}. This example is rejected by the validator.`);
        }
      }
    }
  }

  if (failures.length) {
    console.error(`Guidance-claims check: ${failures.length} contradiction(s) between agent guidance and the schemas\n`);
    for (const failure of failures) console.error(`  ${failure}`);
    console.error('\nFix the guidance, or mark deliberately version-specific text with <!-- guidance-claims: ignore -->.');
    process.exit(1);
  }

  console.log(`Guidance-claims check: ${scanned} agent-facing file(s) scanned against ${allKeys.size} schema keys, and ${markdownScanned} Markdown file(s) against ${closedKeys.size} closed key sets, no contradictions.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
