import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { collectFunctionSources, routeFunctions, MODULE_BYTE_LIMIT, MODULE_LIMIT, TOTAL_BYTE_LIMIT } from '../packages/core/src/function-sources.ts';
import { project } from './helpers.ts';

// The per-module byte budget is checked before the file is read, so the
// rejection names the module and the limit without loading a sandbox.
test('a module over MODULE_BYTE_LIMIT is refused before any sandbox starts', async t => {
  const prefix = 'export default () => 1;';
  const root = await project(t, {}, { 'small.mjs': 'export default () => new Response("ok")', 'big.mjs': `${prefix}${'/'.repeat(MODULE_BYTE_LIMIT)}` });
  assert.ok(MODULE_BYTE_LIMIT < TOTAL_BYTE_LIMIT && MODULE_LIMIT > 1);
  const small = await collectFunctionSources([{ function: { source: join(root, 'small.mjs'), export: 'default' } }], root);
  assert.deepEqual(small.entries, [['/small.mjs','default']]); assert.deepEqual(Object.keys(small.sources), ['/small.mjs']);
  await assert.rejects(collectFunctionSources([{ function: { source: join(root, 'big.mjs'), export: 'default' } }], root), new RegExp(`Function source limit exceeded: /big.mjs is ${MODULE_BYTE_LIMIT + prefix.length} bytes, over the per-module limit of ${MODULE_BYTE_LIMIT} bytes`));
  assert.deepEqual(routeFunctions({ middleware: [{ source: 'a', export: 'x' }], function: { source: 'b', export: 'default' } }), [{ source: 'a', export: 'x' }, { source: 'b', export: 'default' }]);
});
