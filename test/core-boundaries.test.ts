import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkCoreBoundaries } from '../scripts/check-core-boundaries.ts';

async function fixture(t: test.TestContext, source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-core-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'packages/core/src'), { recursive: true });
  await mkdir(join(root, 'packages/auth/src'), { recursive: true });
  await writeFile(join(root, 'packages/auth/package.json'), JSON.stringify({ name: '@jimhoyd/urlcode-auth' }));
  await writeFile(join(root, 'packages/core/src/entry.ts'), source);
  return root;
}

test('core boundary check permits core and third-party imports', async t => {
  const root = await fixture(t, "import { readFile } from 'node:fs/promises';\nimport value from 'third-party';\nvoid [readFile, value];\n");
  assert.deepEqual(await checkCoreBoundaries(root), []);
});

test('core boundary check rejects package-name and relative optional extension imports', async t => {
  const root = await fixture(t, "import '@jimhoyd/urlcode-auth';\nexport * from '../../auth/src/index.ts';\nawait import('@jimhoyd/urlcode-auth/internal');\n");
  const problems = await checkCoreBoundaries(root);
  assert.deepEqual(problems.map(problem => problem.specifier), [
    '@jimhoyd/urlcode-auth',
    '../../auth/src/index.ts',
    '@jimhoyd/urlcode-auth/internal',
  ]);
  assert.ok(problems.every(problem => problem.extension === 'auth'));
});

async function reported(t: test.TestContext, source: string): Promise<Array<[string, string | undefined]>> {
  return (await checkCoreBoundaries(await fixture(t, source))).map(problem => [problem.specifier, problem.extension]);
}

test('core boundary check rejects require() of an optional extension', async t => {
  assert.deepEqual(await reported(t, "declare const require: (id: string) => unknown;\nrequire('@jimhoyd/urlcode-auth');\nrequire.resolve('../../auth/src/index.ts');\nrequire('third-party');\n"), [
    ['@jimhoyd/urlcode-auth', 'auth'],
    ['../../auth/src/index.ts', 'auth'],
  ]);
});

test('core boundary check rejects a require made by createRequire', async t => {
  assert.deepEqual(await reported(t, "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nload('@jimhoyd/urlcode-auth');\ncreateRequire(import.meta.url)('@jimhoyd/urlcode-auth/x');\nload('node:fs');\n"), [
    ['@jimhoyd/urlcode-auth', 'auth'],
    ['@jimhoyd/urlcode-auth/x', 'auth'],
  ]);
});

test('core boundary check rejects import.meta.resolve of an optional extension', async t => {
  assert.deepEqual(await reported(t, "import.meta.resolve('@jimhoyd/urlcode-auth');\nimport.meta.resolve('./own.ts');\n"), [['@jimhoyd/urlcode-auth', 'auth']]);
});

test('core boundary check resolves template dynamic imports and checks their static prefix', async t => {
  assert.deepEqual(await reported(t, "const name = 'x';\nlet file = 'y';\nawait import(`@jimhoyd/urlcode-auth/${name}`);\nawait import(`../../auth/src/${file}.ts`);\nawait import(`ajv/dist/runtime/${file}.js`);\nawait import(`./own/${file}.ts`);\n"), [
    ['@jimhoyd/urlcode-auth/x', 'auth'],
    ['`../../auth/src/${file}.ts`', 'auth'],
  ]);
});

test('core boundary check follows const-bound variable dynamic import specifiers', async t => {
  assert.deepEqual(await reported(t, "const loader = '../../auth/src/index.ts';\nconst local = './local.ts';\nawait import(loader);\nawait import(local);\n"), [['../../auth/src/index.ts', 'auth']]);
});

test('core boundary check reports partial specifiers that could name any extension', async t => {
  assert.deepEqual(await reported(t, "let dir = 'auth';\nawait import(`../../${dir}/src/index.ts`);\nawait import('@jimhoyd/urlcode-' + dir);\n"), [
    ['`../../${dir}/src/index.ts`', 'auth'],
    ["'@jimhoyd/urlcode-'+dir", 'auth'],
  ]);
});

test('core boundary check rejects unanalysable dynamic imports that are not reviewed runtime loaders', async t => {
  assert.deepEqual(await reported(t, "import { pathToFileURL } from 'node:url';\nlet path = process.argv[2]!;\nawait import(pathToFileURL(path).href);\n"), [['pathToFileURL(path).href', undefined]]);
});

test('core boundary check rejects typeof import() types of an optional extension but permits core ones', async t => {
  assert.deepEqual(await reported(t, "export type Auth = typeof import('@jimhoyd/urlcode-auth');\nexport type Own = typeof import('./own.ts');\nconst loader = './own.ts';\nexport const load = () => import(loader).then(({ value }: typeof import('./own.ts')) => value);\n"), [['@jimhoyd/urlcode-auth', 'auth']]);
});

test('core boundary check also reads JavaScript sources in core', async t => {
  const root = await fixture(t, '');
  await writeFile(join(root, 'packages/core/src/legacy.cjs'), "require('@jimhoyd/urlcode-auth');\n");
  assert.deepEqual((await checkCoreBoundaries(root)).map(problem => problem.file), ['packages/core/src/legacy.cjs']);
});

test('core boundary check passes the repository core, including its reviewed runtime loaders', async () => {
  assert.deepEqual(await checkCoreBoundaries(), []);
});
