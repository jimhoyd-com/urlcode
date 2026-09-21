import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Intentionally narrow. Executable examples, starters, skills, shipped package
// documents, manifests, scripts and unknown paths keep the
// complete code lane. The additions beyond repository-root prose are:
//   packages/*/{CONTRIBUTING,CODE_OF_CONDUCT,GOVERNANCE}.md  contributor
//     policy. None of the three appears in any package's published `files`,
//     and no generator or runtime module reads them. A package's README,
//     SECURITY, CONTRACT, THREAT-MODEL, IMPLEMENTATION-STATUS, AGENTS and
//     CHANGELOG are shipped or agent-facing, so they stay in the code lane.
// Everything admitted here is still checked by the always-run `docs` job
// (`npm run check:docs`), which walks every authored Markdown file.
const PROSE = /^(?:docs\/[^\0]+\.md|(?:README|CONTRIBUTING|SECURITY|GOVERNANCE|CODE_OF_CONDUCT|AGENTS|ROADMAP)\.md|llms(?:-full)?\.txt|packages\/[^/]+\/(?:CONTRIBUTING|CODE_OF_CONDUCT|GOVERNANCE)\.md)$/;
export function docsOnly(paths: string[]): boolean {
  return paths.length > 0 && paths.every(path => PROSE.test(path));
}
const SHA = /^[a-f0-9]{40}$/;
// A branch creation or deletion reports this in place of a commit.
const ABSENT_SHA = '0'.repeat(40);

/**
 * The `git diff` range this event may be classified from, or null when it must
 * not be classified from paths at all and therefore selects full verification.
 *
 * A pull request is compared against its merge base (`...`), so commits that
 * landed on main meanwhile are not counted as part of it. A push is compared
 * tip to tip (`..`, which `git diff` reads as two trees), because that is what
 * the push moved; a merge base would understate a force-push or a rewrite.
 *
 * Scheduled and manually dispatched runs are release coverage for one exact
 * commit, so they stay full whatever their paths are. So does any event whose
 * before/after SHAs are missing, malformed or absent.
 */
export function diffRange(event: string, base: string | undefined, head: string | undefined): string | null {
  if (event !== 'pull_request' && event !== 'push') return null;
  for (const sha of [base, head]) if (!sha || !SHA.test(sha) || sha === ABSENT_SHA) return null;
  return `${base}${event === 'pull_request' ? '...' : '..'}${head}`;
}
// No rename detection: both the removed and added paths affect selection.
function gitDiff(range: string): string[] {
  return execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', range, '--'], { encoding: 'utf8' }).split('\0').filter(Boolean);
}
export interface Plan { lane: 'docs' | 'full'; paths: string[] | null }
/**
 * Fails closed: an unclassifiable event, and history git cannot read (a shallow
 * or rewritten checkout, or a commit this clone does not have), select full.
 */
export function classify(event: string, base: string | undefined, head: string | undefined, diff: (range: string) => string[] = gitDiff): Plan {
  const range = diffRange(event, base, head);
  if (!range) return { lane: 'full', paths: null };
  let paths: string[];
  try { paths = diff(range); } catch { return { lane: 'full', paths: null }; }
  return { lane: docsOnly(paths) ? 'docs' : 'full', paths };
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
    // Actions always sets the event name. Outside Actions it is absent, so the
    // documented `npm run ci:plan -- BASE HEAD` preview reads as a pull
    // request; an event name missing inside Actions selects full verification.
    const event = process.env.GITHUB_EVENT_NAME ?? (process.env.GITHUB_ACTIONS ? '' : 'pull_request');
    const { lane, paths } = classify(event, process.argv[2], process.argv[3]);
    if (!paths) console.log(`No classifiable diff for ${event || 'this event'}; selecting full verification`);
    else console.log(JSON.stringify({ lane, paths }));
    const matrix = testMatrix(event, paths);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `lane=${lane}\nmatrix=${JSON.stringify(matrix)}\n`);
    console.log(`Test matrix: ${JSON.stringify(matrix)}`);
    console.log(`CI plan: ${lane}`);
  }
}
