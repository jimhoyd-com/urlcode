// Release workflows in one repository must not answer to the same tag.
//
// Core and every extension arrived here triggering on `tags: ['v*']`, and their
// alpha tags overlap outright -- ui shipped v0.1.0-alpha.2 through -alpha.5,
// admin v0.1.0-alpha.1 and -alpha.3, auth v0.1.0-alpha.1 through -alpha.3. In
// four separate repositories that was fine. In one it means a single bare tag
// push starts more than one release. Each fails closed on its own
// tag-matches-manifest check, so nothing mis-publishes, but "two workflows race
// and one errors" is not a release process.
//
// Decided (docs/OPEN-DECISIONS.md, "Accepted: per-package release tags"):
// workspace packages use Changesets' own `<package name>@<version>` form, and
// core -- the repository root, not a workspace member -- keeps bare `v*`. The
// two are disjoint because a scoped package name begins with `@`, which `v*`
// cannot match. This script is what keeps that true when the next package
// lands, since the argument above is exactly the kind of prose that rots.
import { readdir, readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const root = new URL('../', import.meta.url);

const ROOT_TAG_FILTER = 'v*';
const ARTIFACT_TAG_FILTER = 'extensions@v*';
const ARTIFACT_WORKFLOW = '.github/workflows/extension-artifacts.yml';

async function packageNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const entries = await readdir(new URL('packages/', root), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = await readFile(new URL(`packages/${entry.name}/package.json`, root), 'utf8').catch(() => null);
    if (manifest === null) continue;
    const name = (JSON.parse(manifest) as { name?: unknown }).name;
    if (typeof name === 'string') names.set(name, entry.name);
  }
  return names;
}

async function workflowFiles(): Promise<string[]> {
  const found: string[] = [];
  const directories = ['.github/workflows'];
  const entries = await readdir(new URL('packages/', root), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) directories.push(`packages/${entry.name}/.github/workflows`);
  }
  for (const directory of directories) {
    const files = await readdir(new URL(`${directory}/`, root)).catch(() => []);
    for (const file of files) if (/\.ya?ml$/.test(file)) found.push(`${directory}/${file}`);
  }
  return found.sort();
}

// GitHub's filter patterns: `*` matches any run of characters except `/`.
function filterMatches(pattern: string, ref: string): boolean {
  const source = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
  return new RegExp(`^${source}$`).test(ref);
}

const names = await packageNames();
const failures: string[] = [];
const filters: { where: string; pattern: string; example: string }[] = [];

for (const file of await workflowFiles()) {
  const text = await readFile(new URL(file, root), 'utf8');
  let document: unknown;
  try { document = parse(text); } catch { continue; }
  const tags = (document as { on?: { push?: { tags?: unknown } } })?.on?.push?.tags;
  if (!Array.isArray(tags)) continue;

  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    if (tag === ROOT_TAG_FILTER) {
      if (file !== '.github/workflows/release.yml') {
        failures.push(`${file} triggers on '${ROOT_TAG_FILTER}', which is reserved for core's own release at .github/workflows/release.yml`);
        continue;
      }
      filters.push({ where: file, pattern: tag, example: 'v0.0.0' });
      continue;
    }
    if (tag === ARTIFACT_TAG_FILTER) {
      if (file !== ARTIFACT_WORKFLOW) failures.push(`${file} triggers on '${ARTIFACT_TAG_FILTER}', which is reserved for the declarative artifact publisher at ${ARTIFACT_WORKFLOW}`);
      else filters.push({ where:file, pattern:tag, example:'extensions@v0.0.0' });
      continue;
    }
    const scoped = /^(.+)@\*$/.exec(tag);
    const owner = scoped?.[1];
    if (owner === undefined || !names.has(owner)) {
      failures.push(
        `${file} triggers on '${tag}'. A workspace package releases on '<package name>@*' (one of: ${[...names.keys()].join(', ') || 'none'}), core on '${ROOT_TAG_FILTER}', and declarative artifacts on '${ARTIFACT_TAG_FILTER}'.`,
      );
      continue;
    }
    filters.push({ where: file, pattern: tag, example: `${owner}@0.0.0` });
  }
}

// Belt and braces: the rules above imply disjointness, but assert it directly
// rather than trusting the implication to survive an edit to the rules.
for (const a of filters) {
  for (const b of filters) {
    if (a.where === b.where) continue;
    if (filterMatches(a.pattern, b.example)) {
      failures.push(`${a.where}'s tag filter '${a.pattern}' also matches ${b.where}'s tags (e.g. ${b.example}); one tag push would start both`);
    }
  }
}

if (failures.length > 0) {
  console.error('Release tag filters collide or do not follow the decided scheme:\n');
  for (const failure of failures) console.error(`  ${failure}`);
  console.error('\nSee docs/OPEN-DECISIONS.md, "Accepted: per-package release tags".');
  process.exit(1);
}

console.log(`Release tag check: ${filters.length} tag filter(s) across ${new Set(filters.map((f) => f.where)).size} workflow(s), all disjoint.`);
