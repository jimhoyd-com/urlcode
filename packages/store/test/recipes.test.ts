// The catalog recipes store-booking and store-credits (#932) are core artifacts that need this package to activate, so
// their fixtures run here: through the CLI's own validate, test and audit with --local-review, exactly as the recipes'
// commands list them, against the real store and the README's stand-in bearer principal, with no revision pin and no
// origin given and the database outside the project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { addRecipe } from '@jimhoyd/urlcode';
import { cleanup } from './cleanup.ts';

const cli = fileURLToPath(new URL('../../core/src/cli.ts', import.meta.url));
const hostModule = pathToFileURL(fileURLToPath(new URL('../../core/src/host.ts', import.meta.url))).href;
const storeModule = pathToFileURL(fileURLToPath(new URL('../src/extension.ts', import.meta.url))).href;

/** The README's host: the store, and a stand-in `auth` whose principal is the id in `Authorization: Bearer <id>`. */
function hostFile(database: string): string {
  return `import { composeHost } from ${JSON.stringify(hostModule)};
import store from ${JSON.stringify(storeModule)};
const schema = { type: 'object', properties: {}, additionalProperties: false };
const standIn = { definition: { name: 'auth', contract: 2, targets: ['node'], schema, policySchema: schema, providesPrincipal: true,
  host({ projectSha256 }) {
    return { registration: { name: 'auth', version: '1', projectSha256, targets: ['node'], schema, policySchema: schema, providesPrincipal: true,
      activate() {
        return {
          handle() { return { status: 404, headers: [] }; },
          authorize(_requirement, request) {
            const match = /^Bearer ([a-z]{1,32})$/.exec(request.headers.get('authorization') ?? '');
            if (!match) return { status: 401, headers: [['content-type', 'text/plain']], body: 'sign in' };
            request.setPrincipal({ id: match[1] });
            return undefined;
          },
        };
      } } };
  } }, options: {} };
export default await composeHost(import.meta.url, [standIn, store({ database: ${JSON.stringify(database)} })]);
`;
}

async function site(t: Parameters<typeof cleanup>[0], name: 'store-booking' | 'store-credits') {
  const root = await mkdtemp(join(tmpdir(), 'store-recipe-'));
  cleanup(t, () => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app'), database = join(root, 'data', 'store.sqlite');
  await addRecipe(name, project);
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'host.mjs'), hostFile(database));
  const { PROJECT_SHA256: _pin, URLCODE_ORIGIN: _origin, URLCODE_POLICY: _policy, ...env } = process.env;
  const run = (...args: string[]) => spawnSync(process.execPath, ['--conditions=development', cli, ...args, '--project', project, '--host-file', join(root, 'host.mjs'), '--local-review'], { cwd: root, encoding: 'utf8', timeout: 120000, env });
  return { project, database, run };
}
/** Each recipe command, as recipe.yaml lists it; the fixtures leave nothing behind, so they run twice. */
type Run = Awaited<ReturnType<typeof site>>['run'];
function commands(run: Run) {
  const validated = run('validate', '--local');
  assert.equal(validated.status, 0, validated.stdout + validated.stderr);
  for (const round of [1, 2]) {
    const tested = run('test');
    assert.equal(tested.status, 0, `round ${round}: ${tested.stdout}${tested.stderr}`);
    assert.match(tested.stdout, /"failed":0/);
  }
  const audited = run('audit', '--expect-routes', '1');
  assert.equal(audited.status, 0, audited.stdout + audited.stderr);
  assert.match(audited.stdout, /"ready":true/, audited.stdout);
}

test('the store-booking recipe refuses overlapping bookings of a room and frees a cancelled slot, with no pin given', async t => {
  const { database, run } = await site(t, 'store-booking');
  commands(run);
  assert.equal(existsSync(database), false, 'validate, test and audit under --local-review never open the configured database (#954)');
});

test('the store-credits recipe funds wallets from a members-only issuer and keeps the total, with no pin given', async t => {
  const { database, run } = await site(t, 'store-credits');
  // Who may issue is data: tests/seed.json seeds the issuer the fixtures sign in as into each run's throwaway database.
  commands(run);
  assert.equal(existsSync(database), false, 'validate, test and audit under --local-review never open the configured database (#954)');
});
