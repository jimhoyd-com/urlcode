// Generates the Claude plugin/marketplace distribution of the authoring skill and
// checks the skill for drift. The skill under .claude/skills/ is the single source
// of truth: it is what a clone of this repository loads directly. The plugin copy
// exists only so the same revision can also be installed from a marketplace, so a
// stale copy is a correctness bug and fails npm run check.
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const check = process.argv.includes('--check');
const root = new URL('../', import.meta.url);
const skillPath = '.claude/skills/urlcode-authoring/SKILL.md';
const skill = await readFile(new URL(skillPath, root), 'utf8');
// JSON boundary: the repository's own manifest.
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as {
  version: string; description: string; repository: { url: string }; license: string;
};

// A skill that names a documentation path the runtime no longer ships sends the
// reader to nothing, which is exactly the drift this check exists to catch. Only
// backticked repository-relative paths are claims about this revision; bare prose
// and shell snippets are not.
const referenced = new Set<string>();
for (const [, path] of skill.matchAll(/`((?:docs|schemas|examples|src|starters|test|scripts)\/[A-Za-z0-9._/-]+)`/g)) {
  if (path !== undefined) referenced.add(path.replace(/\/$/, ''));
}
referenced.add('llms.txt');
const missing: string[] = [];
for (const path of [...referenced].sort()) {
  try { await access(new URL(path, root)); } catch { missing.push(path); }
}
if (missing.length > 0) {
  console.error(`${skillPath} references paths that do not exist at this revision:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

const description = 'Authoring support for URLCode projects: the implemented YAML contract, capability limits and verification commands for the pinned runtime revision.';
const files: Record<string, string> = {
  'packaging/claude-plugin/skills/urlcode-authoring/SKILL.md': skill,
  'packaging/claude-plugin/.claude-plugin/plugin.json': `${JSON.stringify({
    name: 'urlcode',
    description,
    version: pkg.version,
    author: { name: 'jimhoyd-com', url: 'https://github.com/jimhoyd-com' },
    homepage: 'https://github.com/jimhoyd-com/urlcode',
    repository: pkg.repository.url,
    license: pkg.license,
    keywords: ['urlcode', 'routing', 'yaml', 'redirects', 'short-links'],
  }, null, 2)}\n`,
  '.claude-plugin/marketplace.json': `${JSON.stringify({
    name: 'urlcode',
    owner: { name: 'jimhoyd-com', url: 'https://github.com/jimhoyd-com' },
    metadata: {
      description: 'Claude plugins published from the URLCode repository.',
      version: pkg.version,
    },
    plugins: [{ name: 'urlcode', source: './packaging/claude-plugin', description }],
  }, null, 2)}\n`,
};

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
  console.error(`Claude plugin distribution is stale; run npm run docs:plugin:\n  ${stale.join('\n  ')}`);
  process.exit(1);
}
console.log(check
  ? `Claude skill references ${referenced.size} existing paths; plugin distribution matches version ${pkg.version}`
  : `Wrote Claude plugin distribution for version ${pkg.version}`);
