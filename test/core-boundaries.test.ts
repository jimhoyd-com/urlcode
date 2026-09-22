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
