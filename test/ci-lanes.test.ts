// The lanes of .github/workflows/ci.yml, evaluated from the workflow itself: the changed paths are matched against
// .github/ci-filters.yml by scripts/ci-changes.ts, and the plan outputs, job conditions and matrices are evaluated with
// the small subset of GitHub's expression language they use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { filters as readFilters, match } from '../scripts/ci-changes.ts';
import { addons } from '../scripts/workspaces.ts';

interface Step { id?: string; if?: string; run?: string; env?: Record<string, string>; 'continue-on-error'?: boolean }
interface Job { if?: string; needs?: string | string[]; outputs?: Record<string, string>; strategy?: { matrix: Record<string, unknown> }; steps?: Step[] }
const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8')) as { jobs: Record<string, Job> };
const step = (id: string): Step => workflow.jobs.plan!.steps!.find(candidate => candidate.id === id)!;
const ci = readFilters();
const filters = (id: 'lanes' | 'packages') => ci[id];

type Value = string | boolean | null;
const truthy = (value: Value): boolean => value !== null && value !== false && value !== '';
/** `&&`, `||`, `!`, `==`, `!=`, parentheses, string and boolean literals and context lookups; no functions. */
function evaluate(expression: string, context: Record<string, Value>): Value {
  const tokens = expression.match(/'(?:[^']|'')*'|&&|\|\||==|!=|[()!]|[\w.-]+/g)!;
  let at = 0;
  const primary = (): Value => {
    const token = tokens[at++]!;
    if (token === '(') { const value = or(); assert.equal(tokens[at++], ')'); return value; }
    if (token === '!') return !truthy(primary());
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (token === 'true' || token === 'false') return token === 'true';
    assert(Object.hasOwn(context, token), `unknown context ${token}`);
    return context[token]!;
  };
  const equality = (): Value => {
    let left = primary();
    while (tokens[at] === '==' || tokens[at] === '!=') { const negate = tokens[at++] === '!=', right = primary(); left = (left === right) !== negate; }
    return left;
  };
  const and = (): Value => { let left = equality(); while (tokens[at] === '&&') { at++; const right = equality(); left = truthy(left) ? right : left; } return left; };
  const or = (): Value => { let left = and(); while (tokens[at] === '||') { at++; const right = and(); left = truthy(left) ? left : right; } return left; };
  const value = or();
  assert.equal(at, tokens.length, expression);
  return value;
}
const unwrap = (text: string): string => /^\$\{\{ (.*) \}\}$/.exec(text)?.[1] ?? text;
const asOutput = (value: Value): string => value === null ? '' : String(value);

interface Scenario { event: string; paths?: string[]; release?: boolean; filterFails?: boolean }
/** The plan job's outputs for an event and its changed paths. */
function plan({ event, paths = [], release, filterFails = false }: Scenario): Record<string, string> {
  const context: Record<string, Value> = { 'github.event_name': event, 'inputs.release': release ?? null };
  const classified = truthy(evaluate(step('changes').if!, context)), ran = classified && !filterFails;
  context['steps.changes.outcome'] = !classified ? 'skipped' : filterFails ? 'failure' : 'success';
  const lanes = ran ? match(filters('lanes'), paths) : {}, packages = ran ? match(filters('packages'), paths) : {};
  for (const name of Object.keys(filters('lanes'))) context[`steps.changes.outputs.${name}`] = ran ? String(lanes[name]) : null;
  context['steps.changes.outputs.packages'] = ran ? JSON.stringify(Object.keys(packages).filter(name => packages[name])) : null;
  return Object.fromEntries(Object.entries(workflow.jobs.plan!.outputs!).map(([name, expression]) => [name, asOutput(evaluate(unwrap(expression), context))]));
}
/** Every job this plan runs, with its matrix legs as `os/node[/shard|/package]`. */
function jobs(scenario: Scenario): Record<string, string[]> {
  const outputs = plan(scenario);
  const context: Record<string, Value> = { 'github.event_name': scenario.event, 'inputs.release': scenario.release ?? null };
  for (const [name, value] of Object.entries(outputs)) context[`needs.plan.outputs.${name}`] = value;
  const selected: Record<string, string[]> = {};
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name === 'plan' || name === 'verify-complete' || (job.if && !truthy(evaluate(job.if, context)))) continue;
    const axes = Object.entries(job.strategy?.matrix ?? {}).map(([axis, values]) => {
      if (Array.isArray(values)) return values.map(String);
      const ref = /^\$\{\{ fromJSON\(needs\.plan\.outputs\.(\w+)\) \}\}$/.exec(String(values))?.[1];
      assert(ref, `${name}.${axis}`);
      return JSON.parse(outputs[ref]!) as string[];
    });
    selected[name] = axes.reduce<string[]>((legs, values) => legs.flatMap(leg => values.map(value => leg ? `${leg}/${value}` : value)), ['']);
  }
  return selected;
}
const code = ['static', 'verify', 'checks', 'package-floor-smoke', 'workspace-verify', 'disk-full', 'audit', 'action', 'build-fidelity', 'container'];
const coreJobs = ['verify', 'checks', 'package-floor-smoke', 'audit', 'action', 'build-fidelity', 'container'];
const shards = (...legs: string[]): string[] => legs.flatMap(leg => [1, 2, 3].map(shard => `${leg}/${shard}`));
const EVERY_LEG = ['ubuntu-latest', 'macos-latest', 'windows-latest'].flatMap(os => ['22', '24', '26'].map(node => `${os}/${node}`));
const ALL = ['auth', 'store', 'mcp'];

test('the prose lane is narrow: every changed path must be reviewed contributor prose', () => {
  for (const path of ['docs/CI.md', 'docs/nested/page.md', 'AGENTS.md', 'llms-full.txt', 'packages/auth/CONTRIBUTING.md']) {
    assert.deepEqual(Object.keys(jobs({ event: 'pull_request', paths: [path] })), ['docs'], path);
  }
  for (const path of ['packages/core/src/runtime.ts', 'package-lock.json', 'docs/fixture.json', 'starters/default/AGENTS.md', '.github/workflows/ci.yml', 'packages/store/README.md', 'unknown.md', 'CHANGELOG.md']) {
    assert.equal(plan({ event: 'pull_request', paths: ['docs/CI.md', path] }).lane, 'full', path);
  }
  // git diff --no-renames reports both sides of a rename, so a move out of docs/ is code.
  assert.equal(plan({ event: 'push', paths: ['docs/old.md', 'packages/core/src/renamed.ts'] }).lane, 'full');
});

test('classification fails closed: exact-commit events, a failed filter and an empty diff run everything', () => {
  for (const scenario of [
    { event: 'schedule', paths: ['docs/CI.md'] }, { event: 'workflow_dispatch', paths: ['docs/CI.md'] }, { event: 'merge_group', paths: ['docs/CI.md'] },
    { event: 'push', paths: ['docs/CI.md'], release: true },
    { event: 'pull_request', paths: ['docs/CI.md'], filterFails: true }, { event: 'push', paths: ['docs/CI.md'], filterFails: true },
    { event: 'pull_request', paths: [] }, { event: 'push', paths: [] },
  ]) {
    const outputs = plan(scenario), selected = jobs(scenario);
    assert.equal(outputs.lane, 'full', JSON.stringify(scenario));
    for (const name of code) assert(selected[name], `${name}: ${JSON.stringify(scenario)}`);
    assert.deepEqual(selected['workspace-verify']!.map(leg => leg.split('/').at(-1)).filter((pkg, index, all) => all.indexOf(pkg) === index), ALL);
  }
  // A job skips only on an explicit value from a successful plan: with no plan outputs at all, every job runs.
  const context = Object.fromEntries(Object.keys(workflow.jobs.plan!.outputs!).map(name => [`needs.plan.outputs.${name}`, '']));
  for (const name of code) assert(truthy(evaluate(workflow.jobs[name]!.if!, context)), name);
});

test('exact-commit coverage is the full OS x Node matrix whatever changed', () => {
  for (const scenario of [{ event: 'schedule' }, { event: 'workflow_dispatch' }, { event: 'merge_group' }, { event: 'push', release: true, paths: ['docs/CI.md'] }]) {
    const selected = jobs(scenario);
    assert.deepEqual(selected.verify, shards(...EVERY_LEG));
    assert.deepEqual(selected.checks, EVERY_LEG);
    assert.equal(selected['workspace-verify']!.length, 9 * ALL.length);
    // The packed integration runs on every OS before a release and on dispatch; the sweep and the queue skip it.
    const integration = scenario.event === 'workflow_dispatch' || scenario.release ? ['ubuntu-latest/24', 'macos-latest/24', 'windows-latest/24'] : undefined;
    assert.deepEqual(selected['workspace-integration'], integration, JSON.stringify(scenario));
  }
});

test('routine pull requests and main pushes are Linux Node 24', () => {
  for (const event of ['pull_request', 'push']) {
    const selected = jobs({ event, paths: ['packages/core/src/runtime.ts'] });
    assert.deepEqual(selected.verify, shards('ubuntu-latest/24'));
    assert.deepEqual(selected.checks, ['ubuntu-latest/24']);
    assert.deepEqual(selected['workspace-verify'], ALL.map(pkg => `ubuntu-latest/24/${pkg}`));
    assert.equal(selected['workspace-integration'], undefined);
  }
  // A main push never gets the pull request's Windows legs, even for a high-impact or extension change.
  const push = jobs({ event: 'push', paths: ['package-lock.json', 'packages/auth/src/auth.ts'] });
  assert.deepEqual(push.verify, shards('ubuntu-latest/24'));
  assert(push['workspace-verify']!.every(leg => leg.startsWith('ubuntu-latest/')));
  assert.equal(push['workspace-integration'], undefined);
});

test('an extension-only change skips the core proofs and runs the extension with its dependents', () => {
  for (const [path, packages] of [
    ['packages/auth/src/auth.ts', ['auth']], ['packages/store/src/query.ts', ['store']], ['packages/mcp/src/mcp.ts', ['mcp']],
    ['packages/store/README.md', ['store']],
  ] as const) {
    const selected = jobs({ event: 'push', paths: [path] });
    for (const name of coreJobs) assert.equal(selected[name], undefined, `${name}: ${path}`);
    assert(selected.static && selected['disk-full'], path);
    assert.deepEqual(selected['workspace-verify'], packages.map(pkg => `ubuntu-latest/24/${pkg}`), path);
  }
  assert.deepEqual(jobs({ event: 'push', paths: ['packages/auth/src/a.ts', 'packages/mcp/src/b.ts'] })['workspace-verify'], ['ubuntu-latest/24/auth', 'ubuntu-latest/24/mcp']);
  // Any path outside the extensions runs the core proofs and every extension.
  for (const path of ['packages/core/src/cli.ts', 'package-lock.json', 'action/action.yml', 'test/ci-lanes.test.ts', 'docs/CI.md']) {
    const selected = jobs({ event: 'push', paths: ['packages/auth/src/auth.ts', path] });
    for (const name of coreJobs) assert(selected[name], `${name}: ${path}`);
    assert.equal(selected['workspace-verify']!.length, ALL.length, path);
  }
});

test('the package filters encode every extension and the extensions that build against it', async () => {
  const extensions = (await addons()).filter(addon => addon.kind === 'extension');
  assert.deepEqual(Object.keys(filters('packages')).sort(), extensions.map(addon => addon.name).sort());
  for (const changed of extensions) {
    const dependents = new Set([changed.name]);
    for (let grown = true; grown;) {
      grown = false;
      for (const addon of extensions) {
        if (dependents.has(addon.name) || ![...addon.requires, ...addon.uses, ...addon.testsWith].some(name => dependents.has(name))) continue;
        dependents.add(addon.name); grown = true;
      }
    }
    const matched = match(filters('packages'), [`packages/${changed.name}/src/index.ts`]);
    assert.deepEqual(Object.keys(matched).filter(name => matched[name]).sort(), [...dependents].sort(), changed.name);
  }
  // The lane filters name the same extensions.
  const sets = JSON.stringify(filters('lanes')).match(/packages\/\{[a-z,]+\}/g)!.map(glob => glob.slice('packages/{'.length, -1).split(',').sort().join());
  assert.deepEqual(new Set(sets), new Set([extensions.map(addon => addon.name).sort().join()]));
});

// #744: one representative path per high-impact area.
const HIGH_IMPACT_PATHS = {
  installer: ['packages/core/src/addon-install.ts', 'packages/core/src/extensions-cli.ts', 'packages/core/src/upgrade.ts', 'packages/core/src/scaffold.ts', 'packages/core/src/init-with.ts', 'scripts/create-extension.ts', 'starters/default/app/urlcode.yaml'],
  manifests: ['package.json', 'package-lock.json', 'packages/core/package.json', 'packages/auth/package.json', 'packages/store/urlcode.json', 'examples/hello/package.json', 'scripts/workspaces.ts', 'scripts/build-addon-manifest.ts'],
  release: ['scripts/npm-command.ts', 'scripts/release-versions.ts', 'scripts/release-pack.ts', 'scripts/release-publish.ts', 'scripts/pack-addons.ts', 'scripts/package-smoke.ts', 'scripts/package-audit.ts', '.github/workflows/publish.yml'],
  integration: ['test/addons.integration.ts', 'scripts/test-addons.ts', 'packages/auth/test/cleanup.ts', 'packages/store/test/cleanup.ts', 'test/private-requests.integration.ts', 'proofs/private-requests/app/urlcode.yaml', 'test/authjs-provider.integration.ts', 'test/native-storage.integration.ts', 'proofs/native-storage/app/functions/notes.mjs', 'test/ecosystem.integration.ts', 'proofs/ecosystem/hono/server.mjs'],
  shared: ['.github/workflows/ci.yml', '.github/dependabot.yml', 'tsconfig.json', 'eslint.config.js', '.node-version', '.gitattributes', 'install.sh', 'Makefile', 'release-please-config.json', 'unknown-root-file'],
};
const ORDINARY = ['packages/core/src/runtime.ts', 'packages/core/src/server.ts', 'test/runtime.test.ts', 'examples/hello/urlcode.yaml', 'schemas/urlcode.schema.json', 'scripts/ci-build-fidelity.ts'];

test('a high-impact pull request adds Windows core shards and the Linux packed integration (#744)', () => {
  for (const [area, paths] of Object.entries(HIGH_IMPACT_PATHS)) {
    for (const path of paths) {
      const selected = jobs({ event: 'pull_request', paths: ['packages/core/src/runtime.ts', 'docs/CI.md', path] });
      assert.deepEqual(selected.verify, shards('ubuntu-latest/24', 'windows-latest/24'), `${area}: ${path}`);
      assert.deepEqual(selected['workspace-integration'], ['ubuntu-latest/24'], path);
      // The rest of the routine lane stays on Linux.
      assert.deepEqual(selected.checks, ['ubuntu-latest/24'], path);
    }
  }
  for (const paths of [['docs/CI.md', 'packages/core/src/runtime.ts'], ORDINARY, ...ORDINARY.map(path => [path])]) {
    const selected = jobs({ event: 'pull_request', paths });
    assert.deepEqual(selected.verify, shards('ubuntu-latest/24'), paths.join());
    assert.equal(selected['workspace-integration'], undefined, paths.join());
    assert(selected['workspace-verify']!.every(leg => leg.startsWith('ubuntu-latest/')), paths.join());
  }
  // An unclassifiable pull request is high-impact.
  assert.deepEqual(jobs({ event: 'pull_request', paths: ['docs/CI.md'], filterFails: true }).verify, shards('ubuntu-latest/24', 'windows-latest/24'));
});

test('a pull request that changes extension code runs the selected suites on Windows Node 24 too (#824)', () => {
  // The #819/#820 case: a package test that only fails on Windows.
  assert.deepEqual(jobs({ event: 'pull_request', paths: ['packages/store/test/store.test.ts'] })['workspace-verify'], ['ubuntu-latest/24/store', 'windows-latest/24/store']);
  assert.deepEqual(jobs({ event: 'pull_request', paths: ['packages/auth/src/auth.ts'] })['workspace-verify'], ['ubuntu-latest/24/auth', 'windows-latest/24/auth']);
  // An extension-only high-impact change gets its Windows leg from the package suites; the core shards skip.
  const manifest = jobs({ event: 'pull_request', paths: ['packages/auth/package.json'] });
  assert.equal(manifest.verify, undefined);
  assert.deepEqual(manifest['workspace-verify'], ['ubuntu-latest/24/auth', 'windows-latest/24/auth']);
  assert.deepEqual(manifest['workspace-integration'], ['ubuntu-latest/24']);
  // A core change beside it widens the suites to every extension, on both.
  assert.equal(jobs({ event: 'pull_request', paths: ['packages/core/src/runtime.ts', 'packages/mcp/src/mcp.ts'] })['workspace-verify']!.length, 2 * ALL.length);
  // Core-only and contributor-prose-only package paths add no Windows suites.
  for (const paths of [['packages/core/src/runtime.ts'], ['scripts/ci-build-fidelity.ts'], ['packages/auth/CONTRIBUTING.md', 'packages/core/src/cli.ts']]) {
    assert(jobs({ event: 'pull_request', paths })['workspace-verify']!.every(leg => leg.startsWith('ubuntu-latest/')), paths.join());
  }
});

test('the gate fails on a failed plan, a failed or cancelled job and a skip caused by a failure', () => {
  const gate = workflow.jobs['verify-complete']!;
  assert.equal(gate.if, 'always()');
  assert.deepEqual([...gate.needs as string[]].sort(), Object.keys(workflow.jobs).filter(name => name !== 'verify-complete').sort());
  assert.equal(gate.steps![0]!.if, "needs.plan.result != 'success' || needs.docs.result != 'success' || contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')");
  assert.equal((gate.steps![0] as { run?: string }).run, 'exit 1');
  // The install and the classification may fail without failing the plan: the outcome then selects full verification.
  const steps = workflow.jobs.plan!.steps!;
  assert.equal(steps.find(candidate => candidate.run === 'npm ci --ignore-scripts')!['continue-on-error'], true);
  assert.equal(step('changes')['continue-on-error'], true);
  assert.equal(step('changes').run, 'node scripts/ci-changes.ts "$RANGE"');
  assert.match(step('changes').env!.RANGE!, /pull_request\.base\.sha, github\.event\.pull_request\.head\.sha\).*github\.event\.before, github\.event\.after/);
  assert.equal((steps[0] as { with?: Record<string, unknown> }).with!['fetch-depth'], 0);
});

test('ci-changes.ts classifies a real git range and refuses what it cannot read', async t => {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-ci-changes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'ci@example.invalid'); git('config', 'user.name', 'ci'); git('config', 'commit.gpgsign', 'false');
  const commit = async (path: string, text: string): Promise<string> => {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text); git('add', '-A'); git('commit', '-q', '-m', path); return git('rev-parse', 'HEAD');
  };
  const start = await commit('docs/CI.md', 'one\n'), prose = await commit('docs/CI.md', 'two\n'), store = await commit('packages/store/src/a.ts', 'x\n');
  const script = join(process.cwd(), 'scripts', 'ci-changes.ts');
  const run = (range: string) => {
    const output = join(root, `.output-${Math.random()}`);
    const result = spawnSync(process.execPath, [script, range], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output } });
    return { status: result.status, outputs: result.status === 0 ? Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => line.split('=') as [string, string])) : {} };
  };
  assert.deepEqual(run(`${start}..${prose}`), { status: 0, outputs: { any: 'true', code: 'false', core: 'true', extensionCode: 'false', highImpact: 'false', packages: '["auth","store","mcp"]' } });
  assert.deepEqual(run(`${prose}...${store}`).outputs, { any: 'true', code: 'true', core: 'false', extensionCode: 'true', highImpact: 'false', packages: '["store"]' });
  // A malformed range, an absent before-SHA and a commit this clone does not have fail, and the plan then runs everything.
  for (const range of ['', `${start}..HEAD`, `${'0'.repeat(40)}..${store}`, `${'a'.repeat(40)}..${store}`]) assert.notEqual(run(range).status, 0, range);
});
