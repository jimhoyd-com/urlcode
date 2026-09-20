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
    const base = process.argv[2], head = process.argv[3];
    if (base && head && /^[a-f0-9]{40}$/.test(base) && /^[a-f0-9]{40}$/.test(head)) {
      try {
        // No rename detection: both the removed and added paths affect selection.
        const paths = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', `${base}...${head}`], { encoding: 'utf8' }).split('\0').filter(Boolean);
        if (docsOnly(paths)) lane = 'docs';
        console.log(JSON.stringify({ lane, paths }));
      } catch { console.log('Diff unavailable; selecting full verification'); }
    }
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `lane=${lane}\n`);
    console.log(`CI plan: ${lane}`);
  }
}
