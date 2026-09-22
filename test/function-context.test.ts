import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../packages/core/src/server.ts';
import { project, request } from './helpers.ts';

// Agent-efficiency plan, phase 3: benchmark arm B lost a rewrite cycle to `function: {source}` receiving empty args,
// and had to read request.url to learn which route it served.
const idParam = () => ({ name: 'id', in: 'path', required: true, schema: { type: 'string', minLength: 1 } });
const routes = {
  '/long/{id}': { parameters: [idParam()], function: { source: 'f.mjs' } },
  '/none/{id}': { parameters: [idParam()], function: { source: 'f.mjs', args: {} } },
  '/short/{id}': { function: 'f.mjs' },
  '/box/{id}': { sandbox: true, parameters: [idParam()], function: { source: 'f.mjs' } },
};
const files = { 'f.mjs': 'export default (req, ctx) => Response.json({ args: ctx.args, pattern: ctx.route && ctx.route.pattern });' };

test('a long-form function without args is bound to its declared path inputs, like the short form', async t => {
  const app = await startServer({ project: await project(t, routes as never, files), port: 0, log: () => {} }); t.after(() => app.close());
  const get = async (path: string) => JSON.parse((await request(app, path)).body) as { args: Record<string, string>; pattern: string };
  assert.deepEqual(await get('/long/7'), { args: { id: '7' }, pattern: '/long/{id}' });
  assert.deepEqual(await get('/short/7'), { args: { id: '7' }, pattern: '/short/{id}' });
  assert.deepEqual(await get('/none/7'), { args: {}, pattern: '/none/{id}' }, 'an explicit args: {} still binds nothing');
});
test('the matched route pattern reaches a sandboxed function too', async t => {
  const app = await startServer({ project: await project(t, routes as never, files), port: 0, log: () => {} }); t.after(() => app.close());
  assert.deepEqual(JSON.parse((await request(app, '/box/9')).body), { args: { id: '9' }, pattern: '/box/{id}' });
});
