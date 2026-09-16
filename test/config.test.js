import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { parseYaml, validateDocument, loadDocument, loadBindings } from '../src/config.js';
import { createRuntime } from '../src/runtime.js';
import { project, redirect, param } from './helpers.js';

test('YAML rejects ambiguity and nonportable constructs', () => {
  for (const source of ['x: 1\nx: 2','x: &x 1\ny: *x','x: !custom yes','x: .inf','x: .NaN','__proto__: bad','constructor: bad','x: 1\n---\ny: 2','x: !!str hi','x: {<<: bad}']) assert.throws(() => parseYaml(source));
  assert.deepEqual(parseYaml('version: "1"\nroutes: {}'),{ version:'1',routes:{} });
});
test('strict schema rejects unknown features and multiple handlers', () => {
  for (const doc of [ { version:1,routes:{} },{ version:'1',routes:{},lambda:{} },{ version:'1',routes:{ '/':{ redirect:{ url:'https://example.com' },function:{ source:'x.mjs' } } } },{ version:'1',routes:{ '/':{ signals:{} } } } ]) assert.throws(() => validateDocument(doc));
});
test('explicit route files compose and duplicates fail', async t => {
  const root = await project(t, { '/a':redirect() }, { 'routes/more.yaml':stringify({ version:'1',routes:{ '/b':redirect() } }) });
  await writeFile(join(root,'urlcode.yaml'),stringify({ version:'1',routes:{ '/a':redirect() },includes:['routes/more.yaml'] }));
  assert.equal(Object.keys((await loadDocument(root)).routes).length,2);
  await writeFile(join(root,'routes/more.yaml'),stringify({ version:'1',routes:{ '/a':redirect() } }));
  await assert.rejects(loadDocument(root),/Duplicate/);
});
test('file escape via traversal or symlink is rejected', async t => {
  const root = await project(t,{},{}), other = await project(t,{}, { 'outside.mjs':'export default () => new Response("bad")' });
  await symlink(join(other,'outside.mjs'),join(root,'escape.mjs'));
  await writeFile(join(root,'urlcode.yaml'),stringify({ version:'1',routes:{ '/':{ function:{ source:'escape.mjs' } } } }));
  await assert.rejects(createRuntime(root),/escapes/);
});
test('dotenv is local only; process wins; required secrets fail closed', async t => {
  const root = await project(t,{ '/':{ function:{ source:'f.mjs' },secrets:{ KEY:{ secret:'token' } } } },{ 'f.mjs':'export default () => new Response("ok")','.env.local':'token="local-value"\nA=$(not-executed)\n' });
  assert.equal((await loadBindings(root,true,{ token:'process-value' })).token,'process-value');
  assert.equal((await loadBindings(root,true,{})).A,'$(not-executed)');
  assert.equal((await loadBindings(root,false,{})).token,undefined);
  await assert.rejects(createRuntime(root,{ environment:{} }),/Missing required secret/);
  const runtime = await createRuntime(root,{ local:true,environment:{} }); await runtime.close();
  await writeFile(join(root,'.env.local'),'token=one\ntoken=two');
  await assert.rejects(loadBindings(root,true,{}),/Duplicate/);
});
test('semantic validation rejects ambiguous routes and unsafe redirects', async t => {
  const invalid = [
    { '/{a}/x':{ ...redirect(),parameters:[param('a')] },'/x/{b}':{ ...redirect(),parameters:[param('b')] } },
    { '/{id}':redirect() },
    { '/':redirect('javascript:alert(1)') },
    { '/':redirect('https://user:password@example.com') },
    { '/{id}':{ ...redirect('https://{id}.example.com'),parameters:[param('id')] } },
    { '/':{ redirect:{ url:'https://example.com/?x=1',query:{ pass:['x'] } } } },
    { '/_urlcode/health':redirect() },
    { '/':{ ...redirect(),expires:'2026-02-30T00:00:00Z' } },
  ];
  for (const routes of invalid) {
    const root = await project(t,routes); await assert.rejects(createRuntime(root));
  }
});
