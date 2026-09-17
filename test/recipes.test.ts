import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {listRecipes,showRecipe,addRecipe} from '../src/recipes.ts';
import {buildTypeScriptProject} from '../src/typescript-authoring.ts';
import {startServer} from '../src/server.ts';
import {project,request} from './helpers.ts';

test('local recipe catalog is defensive and rejects arbitrary paths',async()=>{
  const catalog=listRecipes();assert.equal(catalog.length,3);catalog[0]!.files.push('mutated');
  assert.ok(!listRecipes()[0]!.files.includes('mutated'));
  for(const name of ['../redirect','unknown','https://example.com/recipe'])await assert.rejects(showRecipe(name),/Unknown/);
});

test('recipe add previews, creates ordinary files and refuses existing destinations',async t=>{
  const root=await project(t,{}),out=join(root,'recipe');
  const preview=await addRecipe('redirect',out,{dryRun:true});await assert.rejects(lstat(out),{code:'ENOENT'});
  const added=await addRecipe('redirect',out);assert.deepEqual(added.files,preview.files);
  const original=await readFile(join(out,'urlcode.yaml'),'utf8');await assert.rejects(addRecipe('json-api',out),/already exists/);
  assert.equal(await readFile(join(out,'urlcode.yaml'),'utf8'),original);
  const app=await startServer({project:out,port:0,log:()=>{}});t.after(()=>app.close());
  const reply=await request(app,'/docs?campaign=launch&private=ignored');assert.equal(reply.status,301);assert.equal(reply.headers.location,'https://example.com/documentation?campaign=launch');
});

test('every executable recipe works through the real isolated runtime',async t=>{
  const root=await project(t,{});
  await addRecipe('json-api',join(root,'json'));const json=await startServer({project:join(root,'json'),port:0,log:()=>{}});t.after(()=>json.close());
  const reply=await request(json,'/echo',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"hello":"world"}'});
  assert.equal(reply.status,200);assert.deepEqual(JSON.parse(reply.body),{received:{hello:'world'}});
  assert.equal((await request(json,'/echo')).status,405);
  await addRecipe('typescript',join(root,'ts'));await buildTypeScriptProject(join(root,'ts'),join(root,'built'));
  const compiled=await startServer({project:join(root,'built'),port:0,log:()=>{}});t.after(()=>compiled.close());
  assert.equal((await request(compiled,'/hello')).status,200);
});
