// Generates the Claude plugin/marketplace distribution of the authoring and
// operations skills, and checks both for drift. The skills under .claude/skills/
// are the single source of truth: they are what a clone of this repository loads
// directly. The plugin copy exists only so the same revision can also be
// installed from a marketplace, so a stale copy is a correctness bug and fails
// npm run check.
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const check = process.argv.includes('--check');
const root = new URL('../', import.meta.url);
const skillNames = ['urlcode-authoring', 'urlcode-operations'];
const skillPaths = skillNames.map(name => `.claude/skills/${name}/SKILL.md`);
const skills = await Promise.all(skillPaths.map(path => readFile(new URL(path, root), 'utf8')));
// JSON boundary: the repository's own manifest.
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as {
  version: string; description: string; repository: { url: string }; license: string;
};

// A skill that names a documentation path the runtime no longer ships sends the
// reader to nothing, which is exactly the drift this check exists to catch. Only
// backticked repository-relative paths are claims about this revision; bare prose
// and shell snippets are not.
const referenced = new Set<string>();
for (const skill of skills) {
  for (const [, path] of skill.matchAll(/`((?:docs|schemas|examples|src|starters|test|scripts)\/[A-Za-z0-9._/-]+)`/g)) {
    if (path !== undefined) referenced.add(path.replace(/\/$/, ''));
  }
}
referenced.add('llms.txt');
const missing: string[] = [];
for (const path of [...referenced].sort()) {
  try { await access(new URL(path, root)); } catch { missing.push(path); }
}
if (missing.length > 0) {
  console.error(`One of ${skillPaths.join(', ')} references paths that do not exist at this revision:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

const description = 'Authoring and operating URLCode projects: the implemented YAML contract, capability limits, deployment and verification commands for the pinned runtime revision.';
const files: Record<string, string> = {};
for (const [name, skill] of skillNames.map((name, i) => [name, skills[i]!] as const))
  files[`packaging/claude-plugin/skills/${name}/SKILL.md`] = skill;
files['packaging/claude-plugin/.claude-plugin/plugin.json'] = `${JSON.stringify({
  name: 'urlcode',
  description,
  version: pkg.version,
  author: { name: 'jimhoyd-com', url: 'https://github.com/jimhoyd-com' },
  homepage: 'https://github.com/jimhoyd-com/urlcode',
  repository: pkg.repository.url,
  license: pkg.license,
  keywords: ['urlcode', 'routing', 'yaml', 'redirects', 'middleware'],
}, null, 2)}\n`;
files['.claude-plugin/marketplace.json'] = `${JSON.stringify({
  name: 'urlcode',
  owner: { name: 'jimhoyd-com', url: 'https://github.com/jimhoyd-com' },
  metadata: {
    description: 'Claude plugins published from the URLCode repository.',
    version: pkg.version,
  },
  plugins: [{ name: 'urlcode', source: './packaging/claude-plugin', description }],
}, null, 2)}\n`;

const stale: string[] = [];
for (const [path, content] of Object.entries(files)) {
  const target = new URL(path, root);
  if (check) {
    let current: string | undefined;
    try { current = await readFile(target, 'utf8'); } catch { current = undefined; }
    if (current !== content) stale.push(path);
  } else {
    await mkdir(dirname(new URL(path, root).pathname), { recursive: true });
    await writeFile(target, content);
  }
}
if (stale.length > 0) {
  console.error(`Claude plugin distribution is stale; edit .claude/skills/, then run npm run docs:agents (or npm run docs:plugin for this distribution only):\n  ${stale.join('\n  ')}`);
  process.exit(1);
}
console.log(check
  ? `Claude skills reference ${referenced.size} existing paths across ${skillNames.length} skills; plugin distribution matches version ${pkg.version}`
  : `Wrote Claude plugin distribution for version ${pkg.version} with ${skillNames.length} skills`);
