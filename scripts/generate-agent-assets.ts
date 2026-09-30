// Regenerates every checked-in asset derived from agent-facing source. Keep the
// source of truth in .claude/skills/, skills/, scripts/skill-shared-sections.md
// and packages/core/src/agents-guide.ts; these copies are shipped/distributed
// artifacts, never hand-edited prose.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadDocument } from '../packages/core/src/config.ts';
import { renderAgentsGuide } from '../packages/core/src/agents-guide.ts';

const check = process.argv.includes('--check');
const root = fileURLToPath(new URL('../', import.meta.url));
const starter = new URL('../starters/default/', import.meta.url);
const plugin = fileURLToPath(new URL('./generate-claude-plugin.ts', import.meta.url));

// The sections the agent-context skill and the Claude authoring skill share
// (#1095) have one authored copy, scripts/skill-shared-sections.md. Each skill
// marks a section's place with a `shared:NAME` comment pair and keeps its client-
// and mode-specific sections hand-written around it. Rendered before the plugin
// generator runs, because the marketplace copy is taken from the rendered skill.
const sharedSource = 'scripts/skill-shared-sections.md';
const sharedSkills = ['skills/urlcode/SKILL.md', '.claude/skills/urlcode-authoring/SKILL.md'];
const sections = new Map<string, string>();
for (const [, name, body] of (await readFile(new URL(`../${sharedSource}`, import.meta.url), 'utf8'))
  .matchAll(/^<!-- section:([a-z-]+) -->\n([\s\S]*?)(?=^<!-- section:|(?![\s\S]))/gm)) {
  if (name === undefined || body === undefined || sections.has(name)) throw new Error(`${sharedSource}: section ${name} is empty or declared twice`);
  sections.set(name, body.trimEnd());
}
const staleSkills: string[] = [];
const used = new Set<string>();
for (const path of sharedSkills) {
  const target = new URL(`../${path}`, import.meta.url);
  const current = await readFile(target, 'utf8');
  const opened = [...current.matchAll(/^<!-- shared:([a-z-]+) -->$/gm)].map(match => match[1]);
  const rendered = current.replace(/^<!-- shared:([a-z-]+) -->\n[\s\S]*?^<!-- \/shared:\1 -->$/gm, (_, name: string) => {
    const section = sections.get(name);
    if (section === undefined) throw new Error(`${path}: shared:${name} names no section of ${sharedSource}`);
    used.add(name);
    return `<!-- shared:${name} -->\n${section}\n<!-- /shared:${name} -->`;
  });
  const closed = [...rendered.matchAll(/^<!-- \/shared:([a-z-]+) -->$/gm)].map(match => match[1]);
  if (opened.join() !== closed.join()) throw new Error(`${path}: every shared:NAME marker needs its own /shared:NAME line`);
  if (rendered === current) continue;
  if (check) staleSkills.push(path);
  else await writeFile(target, rendered);
}
const unused = [...sections.keys()].filter(name => !used.has(name));
if (unused.length > 0) throw new Error(`${sharedSource}: no skill renders section(s) ${unused.join(', ')}`);

const pluginResult = spawnSync(process.execPath, [plugin, ...(check ? ['--check'] : [])], {
  cwd: root,
  encoding: 'utf8',
});
if (pluginResult.stdout) process.stdout.write(pluginResult.stdout);
if (pluginResult.stderr) process.stderr.write(pluginResult.stderr);
if (pluginResult.error) throw pluginResult.error;

// The starter is a site whose route project is app/. It carries no .mcp.json: init renders that file (#825), and a
// packaged copy of agent configuration is what an agent sandbox refuses to unpack.
const routes = Object.keys((await loadDocument(fileURLToPath(new URL('app/', starter)))).routes).length;
const files = new Map<string, string>([
  ['starters/default/AGENTS.md', renderAgentsGuide({ routes })],
]);
const stale: string[] = [...staleSkills];
for (const [path, content] of files) {
  const target = new URL(`../${path}`, import.meta.url);
  if (check) {
    if (await readFile(target, 'utf8') !== content) stale.push(path);
  } else {
    await writeFile(target, content);
  }
}
if (stale.length > 0) {
  console.error(`Derived agent assets are stale; edit their source, then run npm run docs:agents:\n  ${stale.join('\n  ')}`);
  process.exitCode = 1;
}
if (pluginResult.status !== 0) process.exitCode = pluginResult.status ?? 1;
if (!check && process.exitCode === undefined) console.log(`Wrote ${files.size} starter agent asset(s) and ${sections.size} shared skill section(s); Claude marketplace assets are current.`);
