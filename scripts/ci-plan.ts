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

export function testMatrix(event: string, _paths: string[] | null): { include: { os: string; node: string }[] } {
  // PRs and main pushes are the feedback lane. The queue and an explicit
  // dispatch are exact-commit coverage, while the scheduled run detects
  // environment drift, so each retains the complete supported matrix.
  if (!['pull_request', 'push'].includes(event)) {
    return { include: operatingSystems.flatMap(os => nodes.map(node => ({ os, node }))) };
  }
  return { include: [{ os: 'ubuntu-latest', node: '24' }] };
}
// `npm test` is split into this many `node --test --test-shard=N/M` jobs per
// leg, so the suite's wall time is a third of the serial run plus setup.
export const SHARDS = 3;
export function shardMatrix(event: string, paths: string[] | null): { include: { os: string; node: string; shard: number }[] } {
  return { include: testMatrix(event, paths).include.flatMap(leg => Array.from({ length: SHARDS }, (_, index) => ({ ...leg, shard: index + 1 }))) };
}
/**
 * A core archive smoke is unnecessary for an extension-only edit: extensions
 * are private workspaces and do not alter the root package's packed tree.
 * Everything else, including an unknown or empty diff, is conservative: core
 * source can change installed behavior even when its manifest is unchanged.
 */
export function packageSmokeRelevant(paths: string[] | null): boolean {
  return !paths?.length || paths.some(path => !/^packages\/(ui|auth|admin|store|forms)\//.test(path));
}

/** Core tests, examples, drills, and dependency audit exercise the root
 * runtime. An extension-only change gets its own workspace proof instead. */
export function coreChecksRelevant(paths: string[] | null): boolean {
  return packageSmokeRelevant(paths);
}

/** The project action packs core and runs the cookbook, so it is likewise
 * independent of a clearly extension-only edit and fail-closed otherwise. */
export function actionRelevant(paths: string[] | null): boolean {
  return packageSmokeRelevant(paths);
}

/**
 * The documented package floor (`engines`: `>=22.13.0` on core and every
 * first-party extension) is never the exact version any other leg's
 * `setup-node` installs: `'22'` resolves whatever the newest 22.x patch
 * happens to be that day, which can silently drift ahead of the floor a
 * consumer on an older 22.x actually runs. Same fail-closed relevance as the
 * package smoke it extends: independent of an extension-only edit,
 * conservative otherwise.
 */
export function packageFloorSmokeRelevant(paths: string[] | null): boolean {
  return packageSmokeRelevant(paths);
}

/** The container only copies core/package inputs; private extension workspaces
 * are excluded by .dockerignore and cannot change the resulting image. */
export function containerRelevant(paths: string[] | null): boolean {
  return packageSmokeRelevant(paths);
}

/**
 * Reproducibility is a shipping proof. Extension source is covered by its
 * workspace build/test in PRs and by compatibility/release verification.
 * Unknown, empty, and every core/shared path fail closed.
 */
export function buildFidelityRelevant(paths: string[] | null): boolean {
  return packageSmokeRelevant(paths);
}

// Example/CLI/drill steps run on Ubuntu Node 24 for PRs and pushes; exact
// coverage runs them on every full-matrix leg. Package smoke is selected only
// where the core archive can be affected.
export function checksMatrix(event: string, paths: string[] | null): { include: { os: string; node: string; full: boolean; packageSmoke: boolean }[] } {
  const routine = ['pull_request', 'push'].includes(event);
  return { include: testMatrix(event, paths).include.map(leg => ({
    ...leg,
    full: !routine || (leg.os === 'ubuntu-latest' && leg.node === '24'),
    packageSmoke: packageSmokeRelevant(paths),
  })) };
}
// `verify --workspace ...` for the five extension packages, run one at a time
// in a single job, put windows-latest workspaces close to 6 minutes: package
// `auth`'s own suite (SQLite-backed, ~200 tests) alone was over half of that.
// One job per (leg, package) instead runs them in parallel; each still needs
// its own install and the root build (packages import `@jimhoyd/urlcode`, the
// workspace-linked root package, resolved through its built `dist/`).
const WORKSPACE_PACKAGES = ['ui', 'auth', 'admin', 'store', 'forms'] as const;
// Cross-package `@jimhoyd/urlcode-*` dependencies, in the build order each
// package's own typecheck/build needs: `admin` imports both `auth` and `ui`,
// and `auth` itself imports `ui`, so `ui` must be built before `auth` here.
// The serial script used to get this for free from running packages in order;
// a package's own job now has to build its declared dependencies first.
const WORKSPACE_DEPS: Record<string, readonly string[]> = { ui: [], auth: ['ui'], admin: ['ui', 'auth'], store: [], forms: ['ui'] };
const WORKSPACE_DEPENDENTS: Record<string, readonly string[]> = {
  ui: ['auth', 'admin', 'forms'], auth: ['admin'], admin: [], store: [], forms: [],
};

/**
 * Limit extension verification to an extension changed in the diff and its
 * reverse dependencies. Core, repository-wide, unknown, or unavailable diffs
 * fail closed to every extension: each consumes the generic core contract or
 * can change the build/release environment shared by all of them.
 */
export function workspacePackages(paths: string[] | null): readonly string[] {
  if (!paths?.length) return WORKSPACE_PACKAGES;
  const changed = new Set<string>();
  for (const path of paths) {
    const match = /^packages\/(ui|auth|admin|store|forms)\//.exec(path);
    if (!match) return WORKSPACE_PACKAGES;
    changed.add(match[1]!);
  }
  const selected = new Set(changed);
  const addDependents = (pkg: string): void => {
    for (const dependent of WORKSPACE_DEPENDENTS[pkg] ?? []) {
      if (!selected.has(dependent)) { selected.add(dependent); addDependents(dependent); }
    }
  };
  for (const pkg of changed) addDependents(pkg);
  return WORKSPACE_PACKAGES.filter(pkg => selected.has(pkg));
}

export function workspacePackageMatrix(event: string, paths: string[] | null): { include: { os: string; node: string; package: string; deps: string }[] } {
  return { include: testMatrix(event, paths).include.flatMap(leg => workspacePackages(paths).map(pkg => ({ ...leg, package: pkg, deps: WORKSPACE_DEPS[pkg]!.join(' ') }))) };
}

/**
 * The cross-workspace scaffold and package-boundary test is release-only. The
 * release coordinator's explicit workflow dispatch covers every supported OS
 * on the default Node runtime before a tag can be created.
 */
export function workspaceIntegrationMatrix(event: string): { include: { os: string; node: string }[] } {
  if (event === 'workflow_dispatch') {
    return { include: [
      { os: 'ubuntu-latest', node: '24' },
      { os: 'macos-latest', node: '24' },
      { os: 'windows-latest', node: '24' },
    ] };
  }
  return { include: [] };
}
export function gate(plan: string, results: Record<string, { result: string }>, workspaceIntegration = false, coreChecks = false, action = false, buildFidelity = false, container = false, packageFloorSmoke = false): void {
  if (!['docs', 'full'].includes(plan)) throw new Error('Missing or invalid CI plan');
  const always = ['plan', 'docs'];
  const code = ['static', 'verify', 'checks', 'workspace-verify', 'workspace-integration', 'audit', 'action', 'build-fidelity', 'container', 'package-floor-smoke'];
  for (const name of [...always, ...code]) {
    const skipped = (plan === 'docs' && code.includes(name)) ||
      (name === 'workspace-integration' && !workspaceIntegration) ||
      (['verify', 'checks', 'audit'].includes(name) && !coreChecks) ||
      (name === 'action' && !action) ||
      (name === 'build-fidelity' && !buildFidelity) ||
      (name === 'container' && !container) ||
      (name === 'package-floor-smoke' && !packageFloorSmoke);
    const expected = skipped ? 'skipped' : 'success';
    if (results[name]?.result !== expected) throw new Error(`${name}: expected ${expected}, received ${results[name]?.result ?? 'missing'}`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'gate') {
    gate(process.env.CI_PLAN ?? '', JSON.parse(process.env.CI_RESULTS ?? '{}'), process.env.CI_WORKSPACE_INTEGRATION === 'true', process.env.CI_CORE_CHECKS === 'true', process.env.CI_ACTION === 'true', process.env.CI_BUILD_FIDELITY === 'true', process.env.CI_CONTAINER === 'true', process.env.CI_PACKAGE_FLOOR_SMOKE === 'true');
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
    const integration = event === 'workflow_dispatch';
    const coreChecks = coreChecksRelevant(paths);
    const action = actionRelevant(paths);
    const buildFidelity = buildFidelityRelevant(paths);
    const container = containerRelevant(paths);
    const packageFloorSmoke = packageFloorSmokeRelevant(paths);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `lane=${lane}\nmatrix=${JSON.stringify(matrix)}\nshards=${JSON.stringify(shardMatrix(event, paths))}\nchecks=${JSON.stringify(checksMatrix(event, paths))}\nworkspacePackages=${JSON.stringify(workspacePackageMatrix(event, paths))}\nworkspaceIntegration=${integration}\nworkspaceIntegrationMatrix=${JSON.stringify(workspaceIntegrationMatrix(event))}\ncoreChecks=${coreChecks}\naction=${action}\nbuildFidelity=${buildFidelity}\ncontainer=${container}\npackageFloorSmoke=${packageFloorSmoke}\n`);
    console.log(`Test matrix: ${JSON.stringify(matrix)}`);
    console.log(`CI plan: ${lane}`);
  }
}
