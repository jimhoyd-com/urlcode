import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { loadOperatorHost } from '../packages/core/src/operator-host.ts';
import { composeHost } from '../packages/core/src/host.ts';
import { defineExtension } from '../packages/core/src/extensions.ts';
import type { ExtensionEntry, HostContext } from '../packages/core/src/extensions.ts';
import { project } from './helpers.ts';

test('operator host loading is explicit, external and never discovers project host files', async t => {
  const root = await project(t, {}, {'host.mjs': 'throw new Error("must not execute")'});
  assert.deepEqual(await loadOperatorHost(undefined, root), {});
  await assert.rejects(loadOperatorHost(join(root, 'host.mjs'), root), /outside the application/);
  // A relative name is still explicit: it resolves against the working directory, and the outside-project rule holds.
  const cwd = process.cwd(); t.after(() => process.chdir(cwd));
  process.chdir(root);
  await assert.rejects(loadOperatorHost('host.mjs', root), /outside the application/);
  await assert.rejects(loadOperatorHost('host.json', root), /\.mjs or \.js/);
  const operator = await project(t, {});
  await writeFile(join(operator, 'host.mjs'), 'export default {plugins: [], extensions: []};');
  assert.deepEqual(await loadOperatorHost(join(operator, 'host.mjs'), root), {plugins: [], extensions: []});
  process.chdir(operator);
  assert.deepEqual(await loadOperatorHost('host.mjs', root), {plugins: [], extensions: []}, 'a site passes --host-file host.mjs');
  process.chdir(cwd);
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

// `uses`: an optional host edge (RIM-ADDON-001), shown with a synthetic producer/consumer pair and no package.
const pin = 'b'.repeat(64);
const schema = { type: 'object' };
function synthetic(name: string, edges: { requires?: string[]; uses?: string[] } = {}, read: (ctx: HostContext) => unknown = () => undefined) {
  return defineExtension({
    name, description: `Synthetic ${name}`, schema, ...edges,
    host(ctx) {
      const seen = read(ctx);
      return { registration: { name, version: '1' as const, projectSha256: ctx.projectSha256, targets: ['node' as const], schema, activate: () => ({ handle: () => ({ status: 404, headers: [] }) }) }, exports: { from: name, seen } };
    },
  });
}
async function composed(t: TestContext, entries: ExtensionEntry[]) {
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = pin;
  t.after(() => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
  return composeHost(pathToFileURL(join(await project(t, {}), 'host.mjs')), entries);
}

test('a used extension that is installed is hosted first and read through get', async t => {
  const producer = synthetic('producer'), consumer = synthetic('consumer', { uses: ['producer'] }, ctx => ctx.get('producer'));
  const host = await composed(t, [consumer(), producer()]);
  assert.deepEqual(host.extensions!.map(item => item.name), ['producer', 'consumer'], 'the used extension orders like a requirement');
  // The second composition of the same consumer: without its producer.
  const alone = await composed(t, [consumer()]);
  assert.deepEqual(alone.extensions!.map(item => item.name), ['consumer']);
});

test('get returns the producer exports when present and undefined when absent', async t => {
  let saw: unknown = 'unset';
  const consumer = synthetic('consumer', { uses: ['producer'] }, ctx => { saw = ctx.get('producer'); return saw; });
  await composed(t, [consumer(), synthetic('producer')()]);
  assert.deepEqual(saw, { from: 'producer', seen: undefined });
  saw = 'unset';
  await composed(t, [consumer()]);
  assert.equal(saw, undefined);
});

test('get of a name outside requires and uses still throws', async t => {
  const nosy = synthetic('nosy', { uses: ['producer'] }, ctx => ctx.get('other'));
  await assert.rejects(composed(t, [nosy(), synthetic('other')(), synthetic('producer')()]), /nosy reads other from the host but does not declare it in requires or uses/);
});

test('a cycle through uses among installed extensions is refused; an absent used extension is no edge', async t => {
  const left = synthetic('left', { uses: ['right'] }), right = synthetic('right', { requires: ['left'] });
  await assert.rejects(composed(t, [left(), right()]), /Extension requirements form a cycle among left, right/);
  const host = await composed(t, [left()]);
  assert.deepEqual(host.extensions!.map(item => item.name), ['left']);
});

test('defineExtension refuses a uses entry that is invalid, repeated, itself or also required', () => {
  const base = { description: 'Synthetic', schema, host: () => { throw new Error('unused'); } };
  assert.throws(() => defineExtension({ ...base, name: 'both', requires: ['x'], uses: ['x'] }), /Extension both lists x in both requires and uses/);
  assert.throws(() => defineExtension({ ...base, name: 'self', uses: ['self'] }), /Extension self uses must list other extension names once each/);
  assert.throws(() => defineExtension({ ...base, name: 'twice', uses: ['x', 'x'] }), /uses must list other extension names once each/);
  assert.throws(() => defineExtension({ ...base, name: 'bad', uses: ['Not A Name'] }), /uses must list other extension names/);
  assert.doesNotThrow(() => defineExtension({ ...base, name: 'fine', requires: ['a'], uses: ['b'] }));
});
