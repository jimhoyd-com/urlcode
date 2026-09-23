// Enforcing guard that agent-visible capability and status claims agree with the
// implementation that owns them (#541).
//
// scripts/check-guidance-claims.ts compares guidance with the YAML schema, and
// the generators' --check modes compare generated files byte for byte. Neither
// notices a sentence that is well-formed, schema-clean and simply false about
// the product -- "forms is not in a signed bundle", "auth/admin currently use
// the primitives", "`auth,admin,ui` is refused for ordering", "twenty-two read
// tools", "no supported package provides stored short links" -- and
// scripts/build-llms-full.ts then concatenates the contradiction into
// llms-full.txt, the skills and the packaged guidance. Each of those shipped.
//
// This check does two things:
//
//   1. It derives a compact inventory of those facts from the implementation
//      sources (never from prose), and fails if the sources disagree with each
//      other. `node scripts/check-agent-facts.ts --inventory` prints it as JSON.
//   2. For each fact it scans every agent-visible prose surface for the claim
//      forms that contradict it, and FAILS (exit 1) on a match.
//
// Nuance stays possible, but it has to be explicit: a paragraph preceded by, or
// containing, `<!-- agent-facts: exempt REASON -->` is skipped, and REASON must
// be non-empty. A bare marker is itself a failure, so an exemption always says
// why the sentence is right despite reading like a contradiction. Changelogs
// are skipped: they describe past releases by design.
import { readdir, readFile, stat } from 'node:fs/promises';
import { mcpToolInventory } from '../packages/core/src/mcp.ts';
import { BUNDLE_CATALOG_NAMES } from '../packages/core/src/extension-bundles.ts';
import { storeAuthoring } from '../packages/store/src/store.ts';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFile(new URL(path, root), 'utf8');
const exists = (path: string) => stat(new URL(path, root)).then(() => true, () => false);

// ---------------------------------------------------------------------------
// 1. The inventory, derived from implementation sources.
// ---------------------------------------------------------------------------

const sourceProblems: string[] = [];

// Extension bundles: what the release script actually builds, and the static
// catalog core answers `extension-bundles list` from. They must agree.
const bundleScript = await read('scripts/prepare-extension-bundles.ts');
const builtBundles = /const packageNames=\[([^\]]*)\] as const;/.exec(bundleScript)?.[1]
  ?.split(',').map(name => name.trim().replace(/^'|'$/g, '')).filter(Boolean) ?? [];
if (!builtBundles.length) sourceProblems.push('scripts/prepare-extension-bundles.ts: could not read `packageNames`; update this check with the new shape');
const catalogBundles = BUNDLE_CATALOG_NAMES.map(entry => entry.name);
if ([...builtBundles].sort().join() !== [...catalogBundles].sort().join()) {
  sourceProblems.push(`bundle sets disagree: prepare-extension-bundles.ts builds ${builtBundles.join(', ')}, but BUNDLE_CATALOG_NAMES lists ${catalogBundles.join(', ')}`);
}

// UI integration: auth and admin each own a module rendering through the kit.
const kitAdopters: string[] = [];
for (const [pkg, file] of [['auth', 'packages/auth/src/auth-ui.ts'], ['admin', 'packages/admin/src/admin-ui.ts']] as const) {
  if ((await exists(file)) && /from '@jimhoyd\/urlcode-ui'/.test(await read(file))) kitAdopters.push(pkg);
}

// Scaffold ordering: `--with` is canonicalized before scaffolds run, so the
// order a user names extensions in cannot change the outcome.
const initWith = await read('packages/core/src/init-with.ts');
const withIsUnordered = /const sorted = \[\.\.\.requested\]\.sort\(\);/.test(initWith) && /orderScaffolds\(results\)/.test(initWith);
if (!withIsUnordered) sourceProblems.push('packages/core/src/init-with.ts: `--with` canonicalization not found; update this check with the new ordering semantics');

// Store short links: the store's machine-readable authoring contract.
const storeShortLinks = storeAuthoring.surfaces.some(surface => surface.name === 'shortLinks');

const inventory = {
  extensionBundles: builtBundles,
  kitAdopters,
  scaffoldWithUnordered: withIsUnordered,
  mcpTools: { read: mcpToolInventory.read.length, hostFile: mcpToolInventory.hostFile.length, authoring: mcpToolInventory.authoring.length },
  storeShortLinks,
};

if (process.argv.includes('--inventory')) {
  console.log(JSON.stringify(inventory, null, 2));
  process.exit(sourceProblems.length ? 1 : 0);
}

// ---------------------------------------------------------------------------
// 2. Claims that contradict the inventory.
// ---------------------------------------------------------------------------

// `context` is the sentence's paragraph (a Markdown table row counts as its own
// paragraph) and `surface` its file, so a claim can tell which subject a
// sentence is about when the sentence itself does not repeat the name.
interface Claim { fact: string; test: (sentence: string, context: string, surface: string) => string | undefined }

const NUMBERS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40 };
function toNumber(word: string): number | undefined {
  const lower = word.toLowerCase();
  if (/^\d+$/.test(lower)) return Number(lower);
  const direct = NUMBERS.indexOf(lower);
  if (direct !== -1) return direct;
  const [tens, ones] = lower.split('-');
  if (tens && TENS[tens] !== undefined) return TENS[tens]! + (ones ? Math.max(NUMBERS.indexOf(ones), 0) : 0);
  return undefined;
}
const NUMBER = String.raw`(\d+|[a-z]+(?:-[a-z]+)?)`;

const claims: Claim[] = [];

for (const bundle of builtBundles) {
  const named = new RegExp(String.raw`\b(?:urlcode-)?${bundle}\b`, 'i');
  claims.push({
    fact: `extensionBundles includes ${bundle}`,
    test: (sentence, context, surface) => (named.test(context) || surface.startsWith(`packages/${bundle}/`))
      && /\bunreleased\b[^.|]*\bbundle|\bnot\s+(?:yet\s+)?(?:published|released|included)\b[^.|]*\b(?:bundle|extension-bundles)\b/i.test(sentence)
      ? `says the ${bundle} bundle is unreleased, but scripts/prepare-extension-bundles.ts builds it into every extension-bundles catalog` : undefined,
  });
}

if (kitAdopters.length) {
  claims.push({
    fact: `kitAdopters = ${kitAdopters.join(', ')}`,
    test: sentence => /\b(?:auth|admin)\b[^.]{0,60}\bcurrently\s+use\s+(?:the\s+)?(?:shared\s+)?primitives\b/i.test(sentence)
      ? `says auth/admin still use the primitives, but ${kitAdopters.map(name => `packages/${name}/src/${name}-ui.ts`).join(' and ')} render through the kit` : undefined,
  });
}

if (withIsUnordered) {
  claims.push({
    fact: 'scaffoldWithUnordered',
    test: sentence => /\brefused\b[^.|]*\b(?:must\s+come\s+(?:before|first)|order(?:ing)?\b)/i.test(sentence) || /--with`?[^.|]*\border(?:ing)?\s+(?:matters|is\s+significant)\b/i.test(sentence)
      ? 'says `--with` order is significant, but init-with.ts canonicalizes the set and derives activation order from declared requirements' : undefined,
  });
}

claims.push({
  fact: `mcpTools.read = ${inventory.mcpTools.read}, authoring = ${inventory.mcpTools.authoring}`,
  test: sentence => {
    for (const match of sentence.matchAll(new RegExp(String.raw`\b${NUMBER}\s+read(?:-only)?\s+tools\b`, 'gi'))) {
      const count = toNumber(match[1] ?? '');
      if (count !== undefined && count !== inventory.mcpTools.read) return `counts ${count} read tools, but packages/core/src/mcp.ts defines ${inventory.mcpTools.read}`;
    }
    for (const match of sentence.matchAll(new RegExp(String.raw`--allow-authoring\b[^.]*?\badds\s+${NUMBER}\s+tools\b`, 'gi'))) {
      const count = toNumber(match[1] ?? '');
      if (count !== undefined && count !== inventory.mcpTools.authoring) return `counts ${count} authoring tools, but packages/core/src/mcp-authoring.ts defines ${inventory.mcpTools.authoring}`;
    }
    return undefined;
  },
});

if (storeShortLinks) {
  claims.push({
    fact: 'storeShortLinks',
    test: sentence => /\bno\s+supported\b[^.|]*\b(?:stored[- ]links?|short[- ]links?)\b|\bstored\s+short\s+links\b[^.|]*\bno\s+supported\b|\breport\s+stored\s+short\s+links\s+as\s+a\s+gap\b|\btreat\s+stored\s+short\s+links\s+as\s+unsupported\b|\bstored\s+short\s+links\b[^.|]*\bowns\s+that\s+storage\s+itself\b/i.test(sentence)
      ? 'says stored short links are unsupported, but the store extension\'s authoring contract declares `extensions.store.config.shortLinks`' : undefined,
  });
}

// ---------------------------------------------------------------------------
// Surfaces: every authored Markdown file, the skill copies, and every llms.txt.
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage']);
async function walk(prefix = ''): Promise<string[]> {
  const entries = await readdir(new URL(prefix || './', root), { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      found.push(...(await walk(`${prefix}${entry.name}/`)));
    } else if (entry.name.endsWith('.md') || entry.name === 'llms.txt' || entry.name === 'llms-full.txt') {
      if (entry.name !== 'CHANGELOG.md') found.push(`${prefix}${entry.name}`);
    }
  }
  return found;
}
const skillDirs = await readdir(new URL('.claude/skills/', root)).catch(() => []);
const surfaces = [...new Set([...(await walk()), ...skillDirs.map(name => `.claude/skills/${name}/SKILL.md`)])].sort();

const MARKER = /<!--\s*agent-facts:\s*exempt\b([^>]*?)-->/;
function paragraphs(text: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let buffer: string[] = [];
  let start = 1;
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') {
      if (buffer.length) out.push({ text: buffer.join(' '), line: start });
      buffer = [];
      return;
    }
    if (line.trimStart().startsWith('|')) {
      if (buffer.length) out.push({ text: buffer.join(' '), line: start });
      buffer = [];
      out.push({ text: line.trim(), line: index + 1 });
      return;
    }
    if (!buffer.length) start = index + 1;
    buffer.push(line.trim());
  });
  if (buffer.length) out.push({ text: buffer.join(' '), line: start });
  return out;
}

const failures: string[] = [...sourceProblems];
let scanned = 0;
for (const surface of surfaces) {
  let source: string;
  try { source = await read(surface); } catch { continue; }
  scanned += 1;
  let carried = false;
  for (const paragraph of paragraphs(source)) {
    const marker = MARKER.exec(paragraph.text);
    if (marker && !(marker[1] ?? '').replace(/^[\s:—-]+/, '').trim()) {
      failures.push(`${surface}:${paragraph.line}  exemption without a reason: write <!-- agent-facts: exempt REASON -->`);
    }
    const exempt = carried || Boolean(marker);
    carried = Boolean(marker) && paragraph.text.replace(MARKER, '').trim() === '';
    if (exempt) continue;
    for (const sentence of paragraph.text.split(/(?<=\.)\s+|\s*\|\s*/)) {
      for (const claim of claims) {
        const problem = claim.test(sentence, paragraph.text, surface);
        if (problem) failures.push(`${surface}:${paragraph.line}  [${claim.fact}] ${problem}\n    ${sentence.length > 200 ? `${sentence.slice(0, 197)}...` : sentence}`);
      }
    }
  }
}

if (failures.length) {
  console.error(`Agent-facts check: ${failures.length} contradiction(s) with implementation-owned facts\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error('\nFix the prose (or the inventory, if the implementation changed). For a sentence that is right');
  console.error('despite matching, add <!-- agent-facts: exempt REASON --> with the reason.');
  process.exitCode = 1;
} else {
  console.log(`Agent-facts check: ${scanned} agent-visible file(s) agree with ${claims.length} implementation-derived fact(s): ${JSON.stringify(inventory)}`);
}
