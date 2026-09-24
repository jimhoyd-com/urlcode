import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { initSite } from '../packages/core/src/authoring.ts';
import { planUpgrade, upgradeSite } from '../packages/core/src/upgrade.ts';

const fixtures = fileURLToPath(new URL('./fixtures/addons/', import.meta.url));
const sha = 'b'.repeat(64);
process.env.URLCODE_NPM = join(fixtures, 'fake-npm.mjs');

/**
 * A registry of fake core releases. Each core carries its own dist/addons.json (pinning its own copy of the alpha
 * extension) and a dist/cli.js that answers `validate` and `explain` like the real one, so upgrade can be exercised
 * without publishing anything.
 */
async function registry(t: TestContext, releases: Record<string, { addons: string[]; validate?: 'fail' }>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [version, release] of Object.entries(releases)) {
    const pins: Record<string, unknown> = {};
    for (const name of release.addons) {
      const dir = join(root, `addon-${name}-${version}`);
      await cp(join(fixtures, name), dir, { recursive: true });
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { version: string };
      pkg.version = version;
      await writeFile(join(dir, 'package.json'), JSON.stringify(pkg));
      pins[name] = { kind: name === 'notes' ? 'artifact' : 'extension', package: `@jimhoyd/urlcode-${name}`, description: name, requires: [], url: `file:${dir}`, integrity: null };
    }
    const core = join(root, `@jimhoyd+urlcode@${version}`);
    await mkdir(join(core, 'dist'), { recursive: true });
    await writeFile(join(core, 'package.json'), JSON.stringify({ name: '@jimhoyd/urlcode', version }));
    await writeFile(join(core, 'dist', 'addons.json'), JSON.stringify({ format: 1, version, addons: pins }));
    await writeFile(join(core, 'dist', 'cli.js'), `const [command] = process.argv.slice(2);
if (command === 'validate') { if (${JSON.stringify(release.validate === 'fail')}) { process.stderr.write('invalid under ${version}'); process.exit(1); } console.log('{"event":"valid"}'); }
else if (command === 'explain') console.log(JSON.stringify({ projectSha256: '${sha}' }));
`);
  }
  return root;
}
/** A site on core `version` with `addons` installed from that release. */
async function site(t: TestContext, registryDir: string, version: string, addons: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = (await initSite(join(root, 'site'))).site;
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  pkg.dependencies['@jimhoyd/urlcode'] = version;
  for (const name of addons) pkg.dependencies[`@jimhoyd/urlcode-${name}`] = `file:${join(registryDir, `addon-${name}-${version}`)}`;
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  const workflow = join(dir, '.github', 'workflows', 'urlcode.yml');
  await writeFile(workflow, (await readFile(workflow, 'utf8')).replace(/action@v[^\s#]+/, `action@v${version}`));
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [process.env.URLCODE_NPM!, 'install'], { cwd: dir });
  return dir;
}
function env(t: TestContext, values: Record<string, string>): void {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const dependencies = async (dir: string): Promise<Record<string, string>> => (JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies;

test('--check reports the latest stable release and changes nothing', async t => {
  const reg = await registry(t, { '1.0.0': { addons: ['alpha'] }, '2.0.0': { addons: ['alpha'] } });
  env(t, { FAKE_NPM_REGISTRY: reg, FAKE_NPM_VIEW: '"2.0.0"' });
  const dir = await site(t, reg, '1.0.0', ['alpha']);
  const before = await readFile(join(dir, 'package.json'), 'utf8');
  assert.deepEqual(await planUpgrade(dir), { site: dir, current: '1.0.0', target: '2.0.0', upToDate: false, addons: ['alpha'] });
  assert.equal(await readFile(join(dir, 'package.json'), 'utf8'), before);
  env(t, { FAKE_NPM_VIEW: '"2.0.0-alpha.1"' });
  await assert.rejects(planUpgrade(dir), /expected a stable version/);
});

test('upgrade moves core, then every add-on to the pins of the new core, and the workflow to the same action', async t => {
  const reg = await registry(t, { '1.0.0': { addons: ['alpha', 'notes'] }, '2.0.0': { addons: ['alpha', 'notes'] } });
  env(t, { FAKE_NPM_REGISTRY: reg, FAKE_NPM_VIEW: '"2.0.0"' });
  const dir = await site(t, reg, '1.0.0', ['alpha', 'notes']);
  const result = await upgradeSite(dir);
  assert.equal(result.upgraded, true);
  assert.deepEqual([result.current, result.target, result.addons], ['1.0.0', '2.0.0', ['alpha', 'notes']]);
  assert.deepEqual(result.workflows, ['.github/workflows/urlcode.yml']);
  assert.equal(result.projectSha256, sha);
  const deps = await dependencies(dir);
  assert.equal(deps['@jimhoyd/urlcode'], '2.0.0');
  assert.equal(deps['@jimhoyd/urlcode-alpha'], `file:${join(reg, 'addon-alpha-2.0.0')}`);
  assert.equal(deps['@jimhoyd/urlcode-notes'], `file:${join(reg, 'addon-notes-2.0.0')}`);
  assert.match(await readFile(join(dir, '.github', 'workflows', 'urlcode.yml'), 'utf8'), /jimhoyd-com\/urlcode\/action@v2\.0\.0/);
  assert.equal((await upgradeSite(dir)).upgraded, false, 'a second run is a no-op');
});

test('--to selects any release, including a prerelease or an older one', async t => {
  const reg = await registry(t, { '1.0.0': { addons: [] }, '2.0.0': { addons: [] }, '2.1.0-alpha.1': { addons: [] } });
  env(t, { FAKE_NPM_REGISTRY: reg, FAKE_NPM_VIEW: '"2.0.0"' });
  const dir = await site(t, reg, '2.0.0', []);
  assert.equal((await upgradeSite(dir, { to: '2.1.0-alpha.1' })).target, '2.1.0-alpha.1');
  assert.equal((await upgradeSite(dir, { to: '1.0.0' })).target, '1.0.0');
  await assert.rejects(upgradeSite(dir, { to: 'latest' }), /Use --to X\.Y\.Z/);
});

test('an add-on the target core does not release, or a project the new runtime rejects, rolls everything back', async t => {
  const reg = await registry(t, { '1.0.0': { addons: ['alpha'] }, '2.0.0': { addons: [] }, '3.0.0': { addons: ['alpha'], validate: 'fail' } });
  env(t, { FAKE_NPM_REGISTRY: reg, FAKE_NPM_VIEW: '"2.0.0"' });
  const dir = await site(t, reg, '1.0.0', ['alpha']);
  const files = ['package.json', 'package-lock.json', '.github/workflows/urlcode.yml'];
  const before = await Promise.all(files.map(file => readFile(join(dir, file), 'utf8')));
  await assert.rejects(upgradeSite(dir), /@jimhoyd\/urlcode@2\.0\.0 does not release alpha; remove it first/);
  assert.deepEqual(await Promise.all(files.map(file => readFile(join(dir, file), 'utf8'))), before);
  await assert.rejects(upgradeSite(dir, { to: '3.0.0' }), /validate --project app failed with the new runtime:\ninvalid under 3\.0\.0/);
  assert.deepEqual(await Promise.all(files.map(file => readFile(join(dir, file), 'utf8'))), before);
  assert.equal(JSON.parse(await readFile(join(dir, 'node_modules', '@jimhoyd', 'urlcode', 'package.json'), 'utf8')).version, '1.0.0', 'the previous install is restored');
});

test('a core that is not an exact registry version is refused', async t => {
  const reg = await registry(t, { '1.0.0': { addons: [] } });
  env(t, { FAKE_NPM_REGISTRY: reg });
  const dir = await site(t, reg, '1.0.0', []);
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  pkg.dependencies['@jimhoyd/urlcode'] = '^1.0.0';
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg));
  await assert.rejects(planUpgrade(dir), /upgrade moves an exact registry version/);
});
