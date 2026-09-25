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

/**
 * High-impact pull request paths (#744). A change here has previously passed
 * the Linux feedback lane and then failed on Windows or at the packed add-on
 * boundary during release coverage (#668, #669, #673), so a pull request that
 * touches one also gets a Windows Node 24 test leg and the packed add-on
 * integration before merge. Each rule is deliberately broad within its area.
 */
const HIGH_IMPACT: readonly RegExp[] = [
  // Installer, upgrade and scaffolding: code that writes a user's files,
  // spawns npm, links packages or copies a starter onto disk.
  /^packages\/core\/src\/(?:addon-install|extensions-cli|init-with|scaffold|recipes)\.ts$/,
  /^packages\/core\/src\/upgrade[^/]*$/,
  /^scripts\/create-extension[^/]*$/,
  /^starters\//,
  // Package manifests and dependency wiring: every package.json and lockfile
  // (root, workspace, starter and example), add-on descriptors, and the
  // scripts that link, order and describe the workspaces.
  /(?:^|\/)package(?:-lock)?\.json$/,
  /^packages\/[^/]+\/urlcode\.json$/,
  /^scripts\/(?:workspaces|build-addon-manifest|check-workspace-links)\.ts$/,
  // Release tooling: bump, pack, publish, the add-on packer, package
  // smoke/audit, the Windows-aware npm launcher they share, and the release
  // workflow.
  /^scripts\/(?:release-[^/]+|pack-addons|package-[^/]+|npm-command)\.ts$/,
  /^\.github\/workflows\/publish\.yml$/,
  // Integration and cleanup: the packed add-on suite and the per-package
  // fixture cleanup whose Windows SQLite ordering delayed a release (#673).
  /^test\/addons\.integration\.ts$/,
  /^scripts\/test-addons[^/]*$/,
  /^packages\/[^/]+\/test\/cleanup\.ts$/,
  // Shared inputs fail closed: any workflow, action or repository automation
  // under .github/. Root-level files are handled by ROOT_FILE below.
  /^\.github\//,
];
// Shared root configuration fails closed: any root-level file that is not
// admitted prose (tsconfig*, eslint config, .node-version, .npmrc,
// .gitattributes, install.sh, Makefile, and whatever is added there later).
const ROOT_FILE = /^[^/]+$/;
/**
 * Whether a change touches a high-impact area. Fails closed: an unclassifiable
 * (null) or empty diff is high-impact. Prose never is, so a docs-only change
 * keeps the compact lane.
 */
export function highImpact(paths: string[] | null): boolean {
  if (!paths?.length) return true;
  return paths.some(path => !PROSE.test(path) && (ROOT_FILE.test(path) || HIGH_IMPACT.some(rule => rule.test(path))));
}
/**
 * The legs a high-impact pull request adds to its tests: Windows on the default
 * Node, where process spawning, path separators, file locking and cleanup
 * ordering differ from Linux. Only pull requests: main pushes keep the feedback
 * lane, and exact-commit runs already cover every OS and Node.
 */
export function platformLegs(event: string, paths: string[] | null): { os: string; node: string }[] {
  return event === 'pull_request' && highImpact(paths) ? [{ os: 'windows-latest', node: '24' }] : [];
}

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
// `node --test-shard` splits by file, not by subject, so a Windows leg runs all
// three shards: the process- and filesystem-sensitive tests are spread across them.
export function shardMatrix(event: string, paths: string[] | null): { include: { os: string; node: string; shard: number }[] } {
  return { include: [...testMatrix(event, paths).include, ...platformLegs(event, paths)].flatMap(leg => Array.from({ length: SHARDS }, (_, index) => ({ ...leg, shard: index + 1 }))) };
}
/**
 * A core archive smoke is unnecessary for an extension-only edit: extensions
 * are private workspaces and do not alter the root package's packed tree.
 * Everything else, including an unknown or empty diff, is conservative: core
 * source can change installed behavior even when its manifest is unchanged.
 */
export function packageSmokeRelevant(paths: string[] | null): boolean {
  return !paths?.length || paths.some(path => !/^packages\/(ui|auth|admin|store|forms|form-records|mcp)\//.test(path));
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
const WORKSPACE_PACKAGES = ['ui', 'auth', 'admin', 'store', 'forms', 'form-records', 'mcp'] as const;
// Cross-package `@jimhoyd/urlcode-*` dependencies, in the build order each
// package's own typecheck/build needs: `admin` imports both `auth` and `ui`,
// and `auth` itself imports `ui`, so `ui` must be built before `auth` here.
// The serial script used to get this for free from running packages in order;
// a package's own job now has to build its declared dependencies first.
// `mcp` only peers on core. `form-records` imports `forms`, `store` and `ui`
// (which renders its list page), so all three are built before it.
const WORKSPACE_DEPS: Record<string, readonly string[]> = { ui: [], auth: ['ui'], admin: ['ui', 'auth'], store: ['ui'], forms: ['ui'], 'form-records': ['ui', 'forms', 'store'], mcp: [] };
const WORKSPACE_DEPENDENTS: Record<string, readonly string[]> = {
  ui: ['auth', 'admin', 'store', 'forms', 'form-records'], auth: ['admin'], admin: [], store: ['form-records'], forms: ['form-records'], 'form-records': [], mcp: [],
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
    const match = /^packages\/(ui|auth|admin|store|forms|form-records|mcp)\//.exec(path);
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

/**
 * A high-impact extension-only change (an add-on's manifest, descriptor or
 * fixture cleanup) skips the core `verify` shards, so its Windows leg runs the
 * selected packages' own suites instead. Any other high-impact change puts the
 * Windows leg on the core shards and leaves extension suites on Linux.
 */
export function workspacePackageMatrix(event: string, paths: string[] | null): { include: { os: string; node: string; package: string; deps: string }[] } {
  const legs = [...testMatrix(event, paths).include, ...(coreChecksRelevant(paths) ? [] : platformLegs(event, paths))];
  return { include: legs.flatMap(leg => workspacePackages(paths).map(pkg => ({ ...leg, package: pkg, deps: WORKSPACE_DEPS[pkg]!.join(' ') }))) };
}

/**
 * The cross-workspace scaffold and package-boundary test. A release run
 * (publish.yml calling ci.yml with `release: true`, planned as a dispatch) and
 * an explicit dispatch cover every supported OS on the default Node runtime
 * before anything is published. A high-impact pull request (#744) runs it on
 * Linux Node 24 before merge; every other routine run skips it.
 */
export function workspaceIntegrationMatrix(event: string, paths: string[] | null): { include: { os: string; node: string }[] } {
  if (event === 'workflow_dispatch') {
    return { include: [
      { os: 'ubuntu-latest', node: '24' },
      { os: 'macos-latest', node: '24' },
      { os: 'windows-latest', node: '24' },
    ] };
  }
  if (event === 'pull_request' && highImpact(paths)) return { include: [{ os: 'ubuntu-latest', node: '24' }] };
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
/**
 * The event the plan classifies. A commit publish.yml is about to release
 * (`CI_RELEASE=true`, from ci.yml's `release` input) gets exact-commit
 * coverage, exactly like an explicit dispatch. Actions always sets the event
 * name; outside Actions it is absent, so the documented
 * `npm run ci:plan -- BASE HEAD` preview reads as a pull request, while an
 * event name missing inside Actions selects full verification.
 */
export function planEvent(env: Record<string, string | undefined>): string {
  if (env.CI_RELEASE === 'true') return 'workflow_dispatch';
  return env.GITHUB_EVENT_NAME ?? (env.GITHUB_ACTIONS ? '' : 'pull_request');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'gate') {
    gate(process.env.CI_PLAN ?? '', JSON.parse(process.env.CI_RESULTS ?? '{}'), process.env.CI_WORKSPACE_INTEGRATION === 'true', process.env.CI_CORE_CHECKS === 'true', process.env.CI_ACTION === 'true', process.env.CI_BUILD_FIDELITY === 'true', process.env.CI_CONTAINER === 'true', process.env.CI_PACKAGE_FLOOR_SMOKE === 'true');
    console.log('All planned checks passed');
  } else {
    const event = planEvent(process.env);
    const { lane, paths } = classify(event, process.argv[2], process.argv[3]);
    if (!paths) console.log(`No classifiable diff for ${event || 'this event'}; selecting full verification`);
    else console.log(JSON.stringify({ lane, paths }));
    const matrix = testMatrix(event, paths);
    const impact = highImpact(paths);
    const legs = platformLegs(event, paths);
    const integrationMatrix = workspaceIntegrationMatrix(event, paths);
    const integration = integrationMatrix.include.length > 0;
    const coreChecks = coreChecksRelevant(paths);
    const action = actionRelevant(paths);
    const buildFidelity = buildFidelityRelevant(paths);
    const container = containerRelevant(paths);
    const packageFloorSmoke = packageFloorSmokeRelevant(paths);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `lane=${lane}\nmatrix=${JSON.stringify(matrix)}\nshards=${JSON.stringify(shardMatrix(event, paths))}\nchecks=${JSON.stringify(checksMatrix(event, paths))}\nworkspacePackages=${JSON.stringify(workspacePackageMatrix(event, paths))}\nworkspaceIntegration=${integration}\nworkspaceIntegrationMatrix=${JSON.stringify(integrationMatrix)}\nhighImpact=${impact}\nplatformLegs=${JSON.stringify(legs)}\ncoreChecks=${coreChecks}\naction=${action}\nbuildFidelity=${buildFidelity}\ncontainer=${container}\npackageFloorSmoke=${packageFloorSmoke}\n`);
    console.log(`Test matrix: ${JSON.stringify(matrix)}`);
    console.log(`CI plan: ${lane}; high-impact: ${impact}; extra platform legs: ${JSON.stringify(legs)}; packed integration: ${integration}`);
  }
}
