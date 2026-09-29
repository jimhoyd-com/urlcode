// #902 item 6: the plumbing the declared `intervals` and `transfers` remove. test/plumbing/ holds the host-transaction
// counterexamples of the store-booking and store-credits recipes: the same API served by trusted operator extensions
// through StoreExports.transaction. This proves they are equivalent where the fixtures can tell (each runs the recipe's
// own tests/requests.json and seed through the CLI, twice, exactly as recipes.test.ts runs the recipe), so the line counts
// scripts/measure-plumbing.ts takes of both compare like with like. Not recipes: the declarations are what to use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { addRecipe } from '@jimhoyd/urlcode';
import { cleanup } from './cleanup.ts';

const cli = fileURLToPath(new URL('../../core/src/cli.ts', import.meta.url));
const hostModule = pathToFileURL(fileURLToPath(new URL('../../core/src/host.ts', import.meta.url))).href;
const storeModule = pathToFileURL(fileURLToPath(new URL('../src/extension.ts', import.meta.url))).href;
const plumbing = (...parts: string[]) => fileURLToPath(new URL(`plumbing/${parts.join('/')}`, import.meta.url));
const recipes = { booking: 'store-booking', credits: 'store-credits' } as const;
const extensions = { booking: 'bookings.mjs', credits: 'wallets.mjs' } as const;
type Kind = keyof typeof recipes;

/** recipes.test.ts's host (the store and the README's stand-in bearer principal), plus the counterexample's extension. */
function hostFile(database: string, extension?: string): string {
  return `import { composeHost } from ${JSON.stringify(hostModule)};
import store from ${JSON.stringify(storeModule)};
${extension === undefined ? '' : `import counterexample from ${JSON.stringify(pathToFileURL(extension).href)};\n`}const schema = { type: 'object', properties: {}, additionalProperties: false };
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
export default await composeHost(import.meta.url, [standIn, store({ database: ${JSON.stringify(database)} })${extension === undefined ? '' : ', counterexample()'}]);
`;
}

/** The recipe itself (`declared`) or its counterexample: the counterexample's urlcode.yaml, with the recipe's fixtures. */
async function site(t: Parameters<typeof cleanup>[0], kind: Kind, version: 'declared' | 'host') {
  const root = await mkdtemp(join(tmpdir(), 'store-plumbing-'));
  cleanup(t, () => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app'), database = join(root, 'data', 'store.sqlite');
  await addRecipe(recipes[kind], project);
  if (version === 'host') await copyFile(plumbing(kind, 'urlcode.yaml'), join(project, 'urlcode.yaml'));
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'host.mjs'), hostFile(database, version === 'host' ? plumbing(kind, extensions[kind]) : undefined));
  const { PROJECT_SHA256: _pin, URLCODE_ORIGIN: _origin, URLCODE_POLICY: _policy, ...env } = process.env;
  const run = (...args: string[]) => spawnSync(process.execPath, ['--conditions=development', cli, ...args, '--project', project, '--host-file', join(root, 'host.mjs'), '--local-review'], { cwd: root, encoding: 'utf8', timeout: 120000, env });
  // The credits recipe's tests/seed.json seeds its issuer into each run's throwaway database, for both versions.
  return { project, database, run };
}
type Site = Awaited<ReturnType<typeof site>>;
function passes(run: Site['run'], label: string) {
  const tested = run('test');
  assert.equal(tested.status, 0, `${label}: ${tested.stdout}${tested.stderr}`);
  assert.match(tested.stdout, /"failed":0/, label);
}
/** Validate, the recipe's fixtures twice (they leave nothing behind) and the audit. */
function commands({ run }: Site, routes: number) {
  const validated = run('validate', '--local');
  assert.equal(validated.status, 0, validated.stdout + validated.stderr);
  for (const round of [1, 2]) passes(run, `round ${round}`);
  const audited = run('audit', '--expect-routes', String(routes));
  assert.equal(audited.status, 0, audited.stdout + audited.stderr);
  assert.match(audited.stdout, /"ready":true/, audited.stdout);
}

test('the booking counterexample passes the store-booking recipe fixtures through a host transaction', async t => {
  const host = await site(t, 'booking', 'host');
  commands(host, 2);
  assert.equal(existsSync(host.database), false, 'validate, test and audit under --local-review never open the configured database (#954)');
});

test('the credits counterexample passes the store-credits recipe fixtures, and both versions replay a retried transfer', async t => {
  const retries = JSON.parse(await readFile(plumbing('credits-retries.json'), 'utf8')) as unknown[];
  for (const version of ['declared', 'host'] as const) {
    const current = await site(t, 'credits', version);
    if (version === 'host') commands(current, 3);
    // Idempotency is part of the contract the recipe declares, and its fixtures send no Idempotency-Key: run the
    // same retry cases against both versions.
    const fixtures = join(current.project, 'tests', 'requests.json');
    await writeFile(fixtures, JSON.stringify(retries));
    passes(current.run, `${version} retries`);
    if (version === 'host') assert.equal(existsSync(current.database), false, 'validate, test and audit under --local-review never open the configured database (#954)');
  }
});
