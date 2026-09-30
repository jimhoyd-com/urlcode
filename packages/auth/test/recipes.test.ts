// The catalog recipes authenticated-json-api and protected-download are core artifacts that need this package to
// activate, so their fixtures run here (#1001): through the CLI's own validate, test and audit with --local-review,
// exactly as the recipes' commands list them, against the real auth extension a site's `urlcode extensions add auth`
// registers, with the account each recipe's tests/seed.json declares and no revision pin or origin given. The store
// recipes run the same way in packages/store/test/recipe-*.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { addRecipe, showRecipe } from '@jimhoyd/urlcode';

const cli = fileURLToPath(new URL('../../core/src/cli.ts', import.meta.url));
const hostModule = pathToFileURL(fileURLToPath(new URL('../../core/src/host.ts', import.meta.url))).href;
const authModule = pathToFileURL(fileURLToPath(new URL('../src/extension.ts', import.meta.url))).href;

async function site(t: test.TestContext, name: 'authenticated-json-api' | 'protected-download') {
  const root = await mkdtemp(join(tmpdir(), 'auth-recipe-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const project = join(root, 'app'), host = join(root, 'host.mjs');
  await addRecipe(name, project);
  // The host.mjs a site's `urlcode extensions add auth` writes, with the specifiers pointed at this checkout.
  await writeFile(host, `import { composeHost } from ${JSON.stringify(hostModule)};\nimport auth from ${JSON.stringify(authModule)};\nexport default await composeHost(import.meta.url, [auth()]);\n`);
  const { PROJECT_SHA256: _pin, URLCODE_ORIGIN: _origin, URLCODE_POLICY: _policy, BETTER_AUTH_SECRET: _secret, ...env } = process.env;
  const run = (args: string[], extra: Record<string, string> = {}) => spawnSync(process.execPath, ['--conditions=development', cli, ...args, '--project', project, '--host-file', host], { cwd: root, encoding: 'utf8', timeout: 120000, env: { ...env, ...extra } });
  return { root, project, run, routes: (await showRecipe(name)).routes! };
}

/** Each recipe command, as recipe.yaml lists it; every run starts from a fresh seeded auth database, so they run twice. */
async function commands({ root, project, run, routes }: Awaited<ReturnType<typeof site>>) {
  assert.doesNotMatch(await readFile(join(project, 'tests', 'requests.json'), 'utf8'), /"authorization"/i, 'no fixture names its caller but by signing in');
  const validated = run(['validate', '--local', '--local-review']);
  assert.equal(validated.status, 0, validated.stdout + validated.stderr);
  for (const round of [1, 2]) {
    const tested = run(['test', '--local-review']);
    assert.equal(tested.status, 0, `round ${round}: ${tested.stdout}${tested.stderr}`);
    assert.match(tested.stdout, /"failed":0/);
  }
  const audited = run(['audit', '--expect-routes', String(routes), '--local-review']);
  assert.equal(audited.status, 0, audited.stdout + audited.stderr);
  assert.match(audited.stdout, /"ready":true/, audited.stdout);
  assert.equal(existsSync(join(root, 'data', 'auth.sqlite')), false, 'test and audit never open the site\'s own accounts');
}

test('the authenticated-json-api recipe signs in through the auth mount and its function reads the user id', async t => {
  const api = await site(t, 'authenticated-json-api');
  await commands(api);
  assert.match(await readFile(join(api.project, 'urlcode.yaml'), 'utf8'), /^\s+auth: true$/m);
  // Serving takes the reviewed revision, never one the host recomputes (#784): no pin refuses, and an edit after the
  // review refuses the pin the operator supplied until they review again.
  const pinned = ['validate', '--local', '--origin', 'https://api.example.com'];
  const unpinned = api.run(pinned);
  assert.equal(unpinned.status, 1);
  assert.match(unpinned.stdout + unpinned.stderr, /"code":"revision-pin-required"/);
  const printed = spawnSync(process.execPath, ['--conditions=development', cli, 'extensions', '--project', api.project], { encoding: 'utf8', timeout: 60000 });
  const reviewed = /Project revision: ([a-f0-9]{64})/.exec(printed.stdout)?.[1];
  assert.ok(reviewed, printed.stdout + printed.stderr);
  await writeFile(join(api.project, 'urlcode.yaml'), (await readFile(join(api.project, 'urlcode.yaml'), 'utf8')) + '  /api/health:\n    respond:\n      text: ok\n');
  const stale = api.run(pinned, { PROJECT_SHA256: reviewed, BETTER_AUTH_SECRET: 's'.repeat(40) });
  assert.equal(stale.status, 1);
  assert.match(stale.stdout + stale.stderr, /Extension revision pin mismatch: auth/);
});

test('the protected-download recipe serves the attachment only to a signed-in caller', async t => {
  await commands(await site(t, 'protected-download'));
});

test('a site whose fixtures sign in more than ten times passes urlcode test on every run (#1019)', async t => {
  const api = await site(t, 'authenticated-json-api');
  // Twelve copies of the recipe's fixtures sign in twelve times from one client address within seconds, past the
  // ten a minute a served mount allows; a hermetic run allows ten times that on its throwaway database.
  const fixtures = join(api.project, 'tests', 'requests.json'), once = JSON.parse(await readFile(fixtures, 'utf8')) as unknown[];
  await writeFile(fixtures, JSON.stringify(Array.from({ length: 12 }, () => once).flat()));
  for (const round of [1, 2]) {
    const tested = api.run(['test', '--local-review']);
    assert.equal(tested.status, 0, `round ${round}: ${tested.stdout}${tested.stderr}`);
    assert.match(tested.stdout, /"failed":0/);
    assert.doesNotMatch(tested.stdout, /"status":429/);
  }
});
