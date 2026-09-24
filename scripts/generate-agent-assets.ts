// Regenerates every checked-in asset derived from agent-facing source. Keep the
// source of truth in .claude/skills/ and packages/core/src/agents-guide.ts;
// these copies are shipped/distributed artifacts, never hand-edited prose.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadDocument } from '../packages/core/src/config.ts';
import { renderAgentsGuide, renderMcpConfig } from '../packages/core/src/agents-guide.ts';

const check = process.argv.includes('--check');
const root = fileURLToPath(new URL('../', import.meta.url));
const starter = new URL('../starters/default/', import.meta.url);
const plugin = fileURLToPath(new URL('./generate-claude-plugin.ts', import.meta.url));

const pluginResult = spawnSync(process.execPath, [plugin, ...(check ? ['--check'] : [])], {
  cwd: root,
  encoding: 'utf8',
});
if (pluginResult.stdout) process.stdout.write(pluginResult.stdout);
if (pluginResult.stderr) process.stderr.write(pluginResult.stderr);
if (pluginResult.error) throw pluginResult.error;

// The starter is a site: its route project is app/, which is also what its .mcp.json registers (npx form, as init writes).
const routes = Object.keys((await loadDocument(fileURLToPath(new URL('app/', starter)))).routes).length;
const files = new Map<string, string>([
  ['starters/default/AGENTS.md', renderAgentsGuide({ routes })],
  ['starters/default/.mcp.json', renderMcpConfig('app', { local: true })],
]);
const stale: string[] = [];
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
if (!check && process.exitCode === undefined) console.log(`Wrote ${files.size} starter agent asset(s); Claude marketplace assets are current.`);
