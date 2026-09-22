import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {stringify} from 'yaml';
import {importBulkProject} from '../packages/core/src/bulk.ts';
import {loadDocument} from '../packages/core/src/config.ts';
import {createRuntime} from '../packages/core/src/runtime.ts';
import {project} from './helpers.ts';

test('bulk import shards routes deterministically and preserves input provenance without copying input',async t=>{
  const root=await project(t,{}),output=join(root,'built');
  const input='path,url,status\n'+Array.from({length:1001},(_,i)=>`/r${String(i).padStart(4,'0')},https://example.com/${i},301`).reverse().join('\n')+'\n';
  const preview=await importBulkProject(input,'csv',output,{dryRun:true,source:'redirects.csv'});
  assert.equal(preview.ok,true);assert.equal(preview.routeCount,1001);assert.deepEqual(preview.files.map(file=>file.routeCount),[0,1000,1,0]);
  await assert.rejects(lstat(output),{code:'ENOENT'});
  const built=await importBulkProject(input,'csv',output,{source:'redirects.csv'});assert.deepEqual(built.files,preview.files);
  const loaded=await loadDocument(output);assert.equal(Object.keys(loaded.routes).length,1001);assert.equal(loaded.document.includes?.length,2);
  const provenance: {source:{name:string;sha256:string};routeCount:number}=JSON.parse(await readFile(join(output,'provenance.json'),'utf8'));
  assert.equal(provenance.source.name,'redirects.csv');assert.match(provenance.source.sha256,/^[a-f0-9]{64}$/);assert.equal(provenance.routeCount,1001);
  const runtime=await createRuntime(output);t.after(()=>runtime.close());
  const reply=await runtime.handle({target:'/r1000'});assert.equal(reply.status,301);assert.ok(reply.headers.some(([key,value])=>key.toLowerCase()==='location'&&value==='https://example.com/1000'));
});

test('bulk JSON and YAML row forms have equivalent output and support empty catalogs',async t=>{
  const root=await project(t,{}),rows=[{path:'/a',url:'https://example.com',status:307}];
  const json=await importBulkProject(JSON.stringify(rows),'json',join(root,'json'));
  const yaml=await importBulkProject(stringify(rows),'yaml',join(root,'yaml'));
  assert.deepEqual(json.files,yaml.files);
  assert.equal(await readFile(join(root,'json/routes/redirects-001.yaml'),'utf8'),await readFile(join(root,'yaml/routes/redirects-001.yaml'),'utf8'));
  const empty=await importBulkProject('[]','json',join(root,'empty'));assert.equal(empty.routeCount,0);assert.equal((await loadDocument(join(root,'empty'))).document.includes,undefined);
});

test('bulk failures retain row diagnostics and never overwrite or publish a partial project',async t=>{
  const root=await project(t,{}),output=join(root,'built');
  const duplicate=await importBulkProject('path,url,status\n/a,https://example.com,301\n/a,https://example.org,302\n','csv',output,{source:'fixture.csv'});
  assert.equal(duplicate.ok,false);assert.ok(duplicate.diagnostics.some(item=>item.code==='duplicate-path'&&item.row===3&&item.source==='fixture.csv'));
  await assert.rejects(lstat(output),{code:'ENOENT'});
  const invalid=await importBulkProject('[{"path":"/a","url":"javascript:alert(1)"}]','json',output);
  assert.equal(invalid.ok,false);await assert.rejects(lstat(output),{code:'ENOENT'});
  await importBulkProject('[]','json',output);const original=await readFile(join(output,'urlcode.yaml'),'utf8');
  await assert.rejects(importBulkProject('[]','json',output),/already exists/);assert.equal(await readFile(join(output,'urlcode.yaml'),'utf8'),original);
});
