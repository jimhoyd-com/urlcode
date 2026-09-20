import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Intentionally narrow. Executable examples, starters, skills, package docs,
// manifests, scripts and unknown paths keep the complete code lane.
export function docsOnly(paths: string[]): boolean {
  return paths.length > 0 && paths.every(path =>
    /^(?:docs\/[^\0]+\.md|(?:README|CONTRIBUTING|SECURITY|GOVERNANCE|CODE_OF_CONDUCT|AGENTS|ROADMAP)\.md|llms(?:-full)?\.txt)$/.test(path));
}
const nodes = ['22', '24', '26'];
const operatingSystems = ['ubuntu-latest', 'macos-latest', 'windows-latest'];

// Only known platform-independent edits omit the extra PR platform legs.
// Runtime, CLI, SQLite, fixtures, dependencies, workflows and unknown paths
// conservatively keep them. A rename supplies both its old and new paths.
export function platformChecks(paths: string[] | null): boolean {
  return !paths?.length || paths.some(path => !docsOnly([path]) &&
    !/^packages\/ui\/src\/(?:catalogue|components|document|escape|forms|icons|index|kit|kit-styles|partials|presentation|styles|template|theme|theme-script)\.ts$/.test(path) &&
    !/^\.changeset\/[^/]+\.md$/.test(path));
}
export function testMatrix(event: string, paths: string[] | null): { include: { os: string; node: string }[] } {
  if (!['pull_request', 'push'].includes(event)) {
    return { include: operatingSystems.flatMap(os => nodes.map(node => ({ os, node }))) };
  }
  const include = nodes.map(node => ({ os: 'ubuntu-latest', node }));
  if (event === 'push' || platformChecks(paths)) {
    include.push({ os: 'windows-latest', node: '24' }, { os: 'macos-latest', node: '24' });
  }
  return { include };
}
export function gate(plan: string, results: Record<string, { result: string }>): void {
  if (!['docs', 'full'].includes(plan)) throw new Error('Missing or invalid CI plan');
  const always = ['plan', 'docs', 'audit', 'container'];
  const code = ['static', 'verify', 'workspaces', 'action', 'build-fidelity'];
  for (const name of [...always, ...code]) {
    const expected = plan === 'docs' && code.includes(name) ? 'skipped' : 'success';
    if (results[name]?.result !== expected) throw new Error(`${name}: expected ${expected}, received ${results[name]?.result ?? 'missing'}`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'gate') {
    gate(process.env.CI_PLAN ?? '', JSON.parse(process.env.CI_RESULTS ?? '{}'));
    console.log('All planned checks passed');
  } else {
    let lane = 'full';
    let paths: string[] | null = null;
    const base = process.argv[2], head = process.argv[3];
    if (base && head && /^[a-f0-9]{40}$/.test(base) && /^[a-f0-9]{40}$/.test(head)) {
      try {
        // No rename detection: both the removed and added paths affect selection.
        paths = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', `${base}...${head}`], { encoding: 'utf8' }).split('\0').filter(Boolean);
        if (docsOnly(paths)) lane = 'docs';
        console.log(JSON.stringify({ lane, paths }));
      } catch { console.log('Diff unavailable; selecting full verification'); }
    }
    const matrix = testMatrix(process.env.GITHUB_EVENT_NAME ?? '', paths);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `lane=${lane}\nmatrix=${JSON.stringify(matrix)}\n`);
    console.log(`Test matrix: ${JSON.stringify(matrix)}`);
    console.log(`CI plan: ${lane}`);
  }
}
