import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { collectionSchema } from '../packages/store/src/collection.ts';
import { prepareArtifacts } from '../scripts/prepare-artifacts.ts';
import { extractArtifact, parseCatalog } from '../packages/core/src/artifacts.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tag = 'extensions@v1.0.0';
const commit = 'a'.repeat(40);

test('release preparation deterministically builds a source-pinned store schema artifact', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'urlcode-artifact-release-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const first = join(temporary, 'first'), second = join(temporary, 'second');
  const left = await prepareArtifacts(root, first, tag, commit);
  const right = await prepareArtifacts(root, second, tag, commit);
  assert.deepEqual(left, right);
  assert.equal(left.tag, tag);
  assert.equal(left.commit, commit);
  assert.deepEqual((await readdir(first)).sort(), ['extensions-catalog.json', 'store-schema-1.1.0.tgz']);
  assert.deepEqual(await readFile(join(first, 'extensions-catalog.json')), await readFile(join(second, 'extensions-catalog.json')));
  assert.deepEqual(await readFile(join(first, left.artifacts[0]!.asset)), await readFile(join(second, right.artifacts[0]!.asset)));
  assert.deepEqual(parseCatalog(await readFile(join(first, 'extensions-catalog.json')), tag), left);
  const installed = join(temporary, 'installed');
  await extractArtifact(await readFile(join(first, left.artifacts[0]!.asset)), left.artifacts[0]!, installed);
  assert.deepEqual(JSON.parse(await readFile(join(installed, 'schemas/config.json'), 'utf8')), {
    type: 'object', additionalProperties: false, required: ['collections'], properties: {
      collections: { type: 'object', minProperties: 1, maxProperties: 32, propertyNames: { pattern: '^[a-z][a-z0-9_-]{0,63}$' }, additionalProperties: collectionSchema },
      shortLinks: { type: 'object', maxProperties: 32, propertyNames: { pattern: '^[a-z][a-z0-9_-]{0,63}$' }, additionalProperties: {
        type: 'object', additionalProperties: false, required: ['mount', 'collection', 'destination', 'clicks'], properties: {
          mount: { type: 'string', pattern: '^/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$', maxLength: 256 },
          collection: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' }, destination: { type: 'string', pattern: '^[a-z][A-Za-z0-9_]{0,63}$' }, clicks: { type: 'string', pattern: '^[a-z][A-Za-z0-9_]{0,63}$' },
        },
      } },
    },
  });
});

test('release preparation refuses executable source files before producing assets', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'urlcode-artifact-source-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await cp(join(root, 'artifacts'), join(temporary, 'artifacts'), { recursive: true });
  await writeFile(join(temporary, 'artifacts', 'store-schema', 'index.js'), 'export default 1;\n');
  await assert.rejects(prepareArtifacts(temporary, join(temporary, 'output'), tag, commit), /unsupported file/);
});
