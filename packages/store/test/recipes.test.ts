// The catalog recipes store-booking, store-credits (#932) and store-approval (#957) are core artifacts that need this
// package to activate, so their fixtures run here: through the CLI's own validate, test and audit with --local-review,
// exactly as the recipes' commands list them, against the real store and the real auth extension (Better Auth) that
// `urlcode extensions add auth store` installs (#1001), with no revision pin and no origin given, the accounts and
// members each recipe's tests/seed.json names, and the databases outside the project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { addRecipe, showRecipe } from '@jimhoyd/urlcode';
import { cleanup } from './cleanup.ts';

const cli = fileURLToPath(new URL('../../core/src/cli.ts', import.meta.url));
const hostModule = pathToFileURL(fileURLToPath(new URL('../../core/src/host.ts', import.meta.url))).href;
const authModule = pathToFileURL(fileURLToPath(new URL('../../auth/src/extension.ts', import.meta.url))).href;
const storeModule = pathToFileURL(fileURLToPath(new URL('../src/extension.ts', import.meta.url))).href;

/** The host a site's `urlcode extensions add auth store` writes: the real auth extension and the store. */
function hostFile(database: string): string {
  return `import { composeHost } from ${JSON.stringify(hostModule)};
import auth from ${JSON.stringify(authModule)};
import store from ${JSON.stringify(storeModule)};
export default await composeHost(import.meta.url, [auth(), store({ database: ${JSON.stringify(database)} })]);
`;
}

async function site(t: Parameters<typeof cleanup>[0], name: 'store-booking' | 'store-credits' | 'store-approval') {
  const root = await mkdtemp(join(tmpdir(), 'store-recipe-'));
  cleanup(t, () => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app'), database = join(root, 'data', 'store.sqlite');
  await addRecipe(name, project);
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'host.mjs'), hostFile(database));
  const { PROJECT_SHA256: _pin, URLCODE_ORIGIN: _origin, URLCODE_POLICY: _policy, ...env } = process.env;
  const run = (...args: string[]) => spawnSync(process.execPath, ['--conditions=development', cli, ...args, '--project', project, '--host-file', join(root, 'host.mjs'), '--local-review'], { cwd: root, encoding: 'utf8', timeout: 120000, env });
  return { project, database, run, routes: (await showRecipe(name)).routes! };
}
/** Each recipe command, as recipe.yaml lists it; every run starts from a fresh seeded database, so they run twice. */
type Site = Awaited<ReturnType<typeof site>>;
function commands({ run, routes, project }: Site) {
  // Every member a recipe seeds is an account its fixtures sign in as, and no fixture names its caller any other way.
  const seed = JSON.parse(readFileSync(join(project, 'tests', 'seed.json'), 'utf8')) as { auth: { users: { id: string }[] }; store: { members: Record<string, string[]> } };
  const accounts = new Set(seed.auth.users.map(user => user.id));
  for (const member of Object.values(seed.store.members).flat()) assert.ok(accounts.has(member), `${member} is a member with no account`);
  assert.doesNotMatch(readFileSync(join(project, 'tests', 'requests.json'), 'utf8'), /"authorization"/i);
  const validated = run('validate', '--local');
  assert.equal(validated.status, 0, validated.stdout + validated.stderr);
  for (const round of [1, 2]) {
    const tested = run('test');
    assert.equal(tested.status, 0, `round ${round}: ${tested.stdout}${tested.stderr}`);
    assert.match(tested.stdout, /"failed":0/);
  }
  const audited = run('audit', '--expect-routes', String(routes));
  assert.equal(audited.status, 0, audited.stdout + audited.stderr);
  assert.match(audited.stdout, /"ready":true/, audited.stdout);
  assert.equal(existsSync(join(project, '..', 'data', 'auth.sqlite')), false, 'test and audit never open the site\'s own accounts');
}

test('the store-booking recipe books one-hour slots for staff only, refuses overlaps and frees a cancelled slot, with no pin given', async t => {
  const booking = await site(t, 'store-booking');
  const { database } = booking;
  commands(booking);
  assert.equal(existsSync(database), false, 'validate, test and audit under --local-review never open the configured database (#954)');
});

test('the store-credits recipe funds wallets from a members-only issuer, pays by a unique handle and keeps the total, with no pin given', async t => {
  const credits = await site(t, 'store-credits');
  const { database } = credits;
  // Who may issue is data: tests/seed.json seeds the issuer the fixtures sign in as into each run's throwaway database.
  commands(credits);
  assert.equal(existsSync(database), false, 'validate, test and audit under --local-review never open the configured database (#954)');
});

test('the store-approval recipe locks an approved request and serves reviewers a queue, with no handler code and no pin given', async t => {
  const approval = await site(t, 'store-approval');
  commands(approval);
  assert.equal(existsSync(approval.database), false, 'validate, test and audit under --local-review never open the configured database (#954)');
  // YAML only: the recipe copies no module a route could run.
  const { files } = await showRecipe('store-approval');
  assert.deepEqual(files.filter(file => !/\.(ya?ml|json|md)$/.test(file)), []);
  assert.doesNotMatch(await readFile(join(approval.project, 'urlcode.yaml'), 'utf8'), /\b(function|middleware|module):/);
});
