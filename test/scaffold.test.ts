import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,symlink,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {stringify} from 'yaml';
import {scaffoldProject} from '../packages/core/src/scaffold.ts';
import {createRuntime} from '../packages/core/src/runtime.ts';
import {startServer} from '../packages/core/src/server.ts';
import {project,request} from './helpers.ts';

test('YAML scaffolds modules with shared named exports, assets and directories; placeholders fail closed',async t=>{
 const root=await project(t,{'/f':{function:{source:'functions/shared.mjs',export:'handle'},middleware:[{source:'functions/shared.mjs',export:'guard'}]},'/page':{page:{file:'public/index.html'}},'/assets/*':{static:{directory:'public/assets',index:'index.html'}}});
 const preview=await scaffoldProject(root,{dryRun:true});assert.ok(preview.created.includes('functions/shared.mjs'));
 await assert.rejects(lstat(join(root,'functions')),{code:'ENOENT'});
 const result=await scaffoldProject(root);assert.deepEqual(result.created,preview.created);
 const app=await startServer({project:root,port:0,log:()=>{}});t.after(()=>app.close());
 assert.equal((await request(app,'/f')).status,501);assert.equal((await request(app,'/page')).status,200);assert.equal((await request(app,'/assets/')).status,200);
 await writeFile(join(root,'functions/shared.mjs'),'// existing user content');
 const again=await scaffoldProject(root);assert.deepEqual(again.created,[]);assert.equal(await readFile(join(root,'functions/shared.mjs'),'utf8'),'// existing user content');
 assert.equal(preview.needsImplementation,true);assert.equal(result.needsImplementation,true);
 assert.equal(again.needsImplementation,false,'nothing new was created and nothing is unresolved');
});
test('scaffold reports no implementation work for a project with only native routes (#592)',async t=>{
 const root=await project(t,{'/go':{redirect:{url:'https://example.com'}},'/hi':{respond:{status:200,text:'hi'}}});
 for(const dryRun of [true,false]) {
  const report=await scaffoldProject(root,{dryRun});
  assert.deepEqual(report.created,[]);assert.deepEqual(report.unresolved,[]);assert.equal(report.needsImplementation,false);
 }
});
test('missing includes become empty YAML; binary assets and credentials are reported, not invented',async t=>{
 const root=await project(t,{});
 await writeFile(join(root,'urlcode.yaml'),stringify({version:'1',includes:['routes/more.yaml'],routes:{'/file':{download:{file:'public/manual.pdf'}},'/f':{function:{source:'f.js'},secrets:{KEY:{secret:'API_KEY'}}}}}));
 const result=await scaffoldProject(root);assert.equal(result.unresolved.length,2);assert.deepEqual(result.requiredBindings,['API_KEY']);
 assert.equal(await readFile(join(root,'routes/more.yaml'),'utf8'),'version: "1"\nroutes: {}\n');
 await assert.rejects(lstat(join(root,'public/manual.pdf')),{code:'ENOENT'});
 await assert.rejects(createRuntime(root));
});
test('scaffold rejects unsafe paths and conflicting uses before creating files',async t=>{
 for(const bad of ['../escape.mjs','/absolute.mjs','.env.local','nested/../escape.mjs']){
  const root=await project(t,{'/first':{function:{source:'first.mjs'}},'/bad':{function:{source:bad}}});
  await assert.rejects(scaffoldProject(root));await assert.rejects(lstat(join(root,'first.mjs')),{code:'ENOENT'});
 }
 const root=await project(t,{'/f':{function:{source:'public/file.mjs'}},'/a/*':{static:{directory:'public/file.mjs/child'}}});
 await assert.rejects(scaffoldProject(root));await assert.rejects(lstat(join(root,'public')),{code:'ENOENT'});
});
test('scaffold refuses symlink directories, even inside the project',async t=>{
 const root=await project(t,{'/f':{function:{source:'alias/new.mjs'}}},{'actual/existing.txt':'keep'});
 await symlink(join(root,'actual'),join(root,'alias'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(scaffoldProject(root),/symlink/);await assert.rejects(lstat(join(root,'actual/new.mjs')),{code:'ENOENT'});
});
