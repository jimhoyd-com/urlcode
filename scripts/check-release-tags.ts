// Only core publishes to npm. Extension workspaces are release inputs for the
// signed bundle workflow, so a scoped package tag must never gain a publisher.
import { readdir, readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const root = new URL('../', import.meta.url);

// Both immutable-tag rulesets must protect every tag filter a release
// workflow actually triggers on; #472 found that a workflow's filter had
// drifted ahead of the checked-in ruleset JSON undetected.
const RULESET_FILES = ['.github/rulesets/release-tags.json', '.github/rulesets/release-tag-creations.json'];
interface RulesetFile { name?: unknown; conditions?: { ref_name?: { include?: unknown } } }
async function rulesetIncludes(file: string): Promise<string[]> {
  const text = await readFile(new URL(file, root), 'utf8');
  const document = JSON.parse(text) as RulesetFile;
  const include = document.conditions?.ref_name?.include;
  if (!Array.isArray(include)) return [];
  return include.filter((entry): entry is string => typeof entry === 'string');
}
// GitHub ruleset ref_name patterns are full ref paths (e.g. `refs/tags/v*`);
// a workflow's `on.push.tags` filter is the bare tag pattern (e.g. `v*`).
const asRefPattern = (tagFilter: string): string => `refs/tags/${tagFilter}`;

const ROOT_TAG_FILTER = 'v*';
const ARTIFACT_TAG_FILTER = 'extensions@v*';
const ARTIFACT_WORKFLOW = '.github/workflows/artifacts.yml';
const BUNDLE_TAG_FILTER = 'extension-bundles@v*';
const BUNDLE_WORKFLOW = '.github/workflows/extension-bundles.yml';

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
    if (tag === BUNDLE_TAG_FILTER) {
      if (file !== BUNDLE_WORKFLOW) failures.push(`${file} triggers on '${BUNDLE_TAG_FILTER}', which is reserved for the executable bundle publisher at ${BUNDLE_WORKFLOW}`);
      else filters.push({ where:file, pattern:tag, example:'extension-bundles@v0.0.0' });
      continue;
    }
    failures.push(`${file} triggers on '${tag}'. Only core's '${ROOT_TAG_FILTER}', declarative artifacts' '${ARTIFACT_TAG_FILTER}', and executable bundles' '${BUNDLE_TAG_FILTER}' tag namespaces may publish releases; extension npm publishers are retired.`);
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

// Drift check: every workflow tag filter above must appear, verbatim as a
// ref pattern, in both immutable-tag rulesets' `include` list.
const rulesetIncludesByFile = new Map<string, string[]>();
for (const file of RULESET_FILES) {
  try { rulesetIncludesByFile.set(file, await rulesetIncludes(file)); }
  catch (error) { failures.push(`Unable to read ${file}: ${error instanceof Error ? error.message : String(error)}`); }
}
for (const { where, pattern } of filters) {
  const ref = asRefPattern(pattern);
  for (const [rulesetFile, include] of rulesetIncludesByFile) {
    if (!include.includes(ref)) {
      failures.push(`${rulesetFile} does not include '${ref}', but ${where} triggers on it. Add it to conditions.ref_name.include in ${rulesetFile} and apply the change to the live ruleset.`);
    }
  }
}
if (failures.length > 0) {
  console.error('Release tag filters collide or do not follow the decided scheme:\n');
  for (const failure of failures) console.error(`  ${failure}`);
  console.error('\nSee docs/DEVELOPMENT-PIPELINE.md for the core and signed-bundle release paths.');
  process.exit(1);
}

console.log(`Release tag check: ${filters.length} tag filter(s) across ${new Set(filters.map((f) => f.where)).size} workflow(s), all disjoint and covered by both immutable-tag rulesets.`);
