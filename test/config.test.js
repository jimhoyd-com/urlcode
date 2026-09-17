import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { parseYaml, validateDocument, loadDocument, loadBindings } from '../src/config.js';
import { createRuntime } from '../src/runtime.js';
import { project, redirect, param, approveBindings } from './helpers.js';

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
  await assert.rejects(createRuntime(root,{ environment:{} }),/denied by operator policy/);
  const permissions = await approveBindings(root);
  await assert.rejects(createRuntime(root,{ environment:{},permissions }),/Missing required secret/);
  const runtime = await createRuntime(root,{ local:true,environment:{},permissions }); await runtime.close();
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
test('dynamic-link opt-in affects identity but false and omitted are equivalent',async t=>{
 const {prepareFunctionSnapshot}=await import('../src/policy.js');
 const root=await project(t,{'/go':redirect()});
 const before=await loadDocument(root);const digest=(await prepareFunctionSnapshot(before)).projectSha256;
 await writeFile(join(root,'urlcode.yaml'),stringify({version:'1',dynamicLinks:false,routes:before.routes}));
 const disabled=await loadDocument(root);assert.equal(disabled.version,before.version);assert.equal((await prepareFunctionSnapshot(disabled)).projectSha256,digest);
 await writeFile(join(root,'urlcode.yaml'),stringify({version:'1',dynamicLinks:true,routes:before.routes}));
 const enabled=await loadDocument(root);assert.notEqual(enabled.version,before.version);assert.notEqual((await prepareFunctionSnapshot(enabled)).projectSha256,digest);
});

test('configuration worker deadline terminates loading and releases admission',async t=>{
  const root=await project(t,{'/':redirect()});
  await assert.rejects(loadDocument(root,{timeoutMs:1}),/deadline/);
  assert.equal(Object.keys((await loadDocument(root)).routes).length,1);
  await assert.rejects(loadDocument(root,{timeoutMs:0}),/deadline/);
});
test('configuration worker enforces aggregate source budget across includes',async t=>{
  const root=await project(t,{}, {},{includes:['one.yaml','two.yaml','three.yaml']});
  const content='version: "1"\nroutes: {}\n#'+'x'.repeat(22*1024*1024)+'\n';
  for(const file of ['one.yaml','two.yaml','three.yaml'])await writeFile(join(root,file),content);
  await assert.rejects(loadDocument(root),/aggregate 64 MiB/);
});
