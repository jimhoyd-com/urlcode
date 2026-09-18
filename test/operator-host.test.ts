import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { loadOperatorHost } from '../src/operator-host.ts';
import { project } from './helpers.ts';

test('operator host loading is explicit, external and never discovers project host files', async t => {
  const root = await project(t, {}, {'host.mjs': 'throw new Error("must not execute")'});
  assert.deepEqual(await loadOperatorHost(undefined, root), {});
  await assert.rejects(loadOperatorHost(join(root, 'host.mjs'), root), /outside the application/);
  await assert.rejects(loadOperatorHost('host.mjs', root), /absolute/);
  const operator = await project(t, {});
  await writeFile(join(operator, 'host.mjs'), 'export default {plugins: [], extensions: []};');
  assert.deepEqual(await loadOperatorHost(join(operator, 'host.mjs'), root), {plugins: [], extensions: []});
  await symlink(join(root, 'host.mjs'), join(operator, 'link.mjs'));
  await assert.rejects(loadOperatorHost(join(operator, 'link.mjs'), root), /outside the application/);
});

test('operator configuration rejects unsupported values and preserves cleanup callback', async t => {
  const root = await project(t, {}), operator = await project(t, {});
  for (const [name, source] of Object.entries({array:'[]',unknown:'{env: {SECRET: "synthetic"}}',extensions:'{extensions:{}}',plugins:'{plugins: 1}',close:'{close: true}'})) {
    const file = join(operator, `${name}.mjs`); await writeFile(file, `export default ${source};`);
    await assert.rejects(loadOperatorHost(file, root));
  }
  const file = join(operator, 'cleanup.mjs');
  await writeFile(file, 'export default {close(){globalThis.__operatorHostClosed = true;}};');
  const host = await loadOperatorHost(file, root);
  assert.equal(typeof host.close, 'function');
});
