import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {listRecipes,showRecipe,addRecipe} from '../src/recipes.ts';
import {buildTypeScriptProject} from '../src/typescript-authoring.ts';
import {startServer} from '../src/server.ts';
import {project,request} from './helpers.ts';

test('local recipe catalog is defensive and rejects arbitrary paths',async()=>{
  const catalog=listRecipes();assert.equal(catalog.length,4);catalog[0]!.files.push('mutated');
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

test('the middleware recipe serves every pattern and mirrors the cookbook modules',async t=>{
  const root=await project(t,{});await addRecipe('middleware',join(root,'mw'));
  const app=await startServer({project:join(root,'mw'),port:0,log:()=>{}});t.after(()=>app.close());
  assert.equal((await request(app,'/api/private')).status,401);
  assert.equal((await request(app,'/api/private',{headers:{authorization:'Bearer cookbook-token'}})).body,'{"private":true}');
  assert.equal((await request(app,'/admin/panel',{headers:{authorization:'Basic '+Buffer.from('admin:cookbook-password').toString('base64')}})).body,'Admin panel');
  const preflight=await request(app,'/cors/data',{method:'OPTIONS',headers:{origin:'https://app.example.com'}});
  assert.equal(preflight.status,204);assert.equal(preflight.headers['access-control-allow-origin'],'https://app.example.com');
  assert.equal((await request(app,'/traced',{headers:{'x-correlation-id':'abc'}})).headers['x-correlation-id'],'abc');
  assert.equal((await request(app,'/maintenance')).status,503);
  assert.deepEqual(JSON.parse((await request(app,'/fragile?fail=true',{headers:{'x-correlation-id':'r-9'}})).body),{error:'Temporarily unavailable',correlationId:'r-9'});
  assert.equal(JSON.parse((await request(app,'/api/items')).body).meta.count,2);
  assert.equal((await request(app,'/negotiated',{headers:{accept:'image/png'}})).status,406);
  assert.deepEqual(JSON.parse((await request(app,'/resource',{method:'POST',headers:{'x-http-method-override':'PATCH'}})).body),{method:'PATCH',tunneled:true});
  const versioned=await request(app,'/versioned');assert.match(versioned.headers.etag!,/^W\/"[0-9a-f]{8}"$/);
  assert.equal((await request(app,'/versioned',{headers:{'if-none-match':versioned.headers.etag!}})).status,304);
  assert.equal((await request(app,'/experiment',{headers:{cookie:'bucket=b'}})).headers.location,'https://example.com/landing-b');
  assert.equal((await request(app,'/welcome',{headers:{'accept-language':'de'}})).headers.location,'https://example.com/de/welcome');
  assert.equal((await request(app,'/downloads/report')).status,403);
  assert.equal((await request(app,'/profile',{method:'POST',headers:{'content-type':'application/json'},body:'{"name":""}'})).status,422);
  assert.equal((await request(app,'/inspect',{headers:{'x-debug':'1'}})).headers['content-type'],'application/json');
  // The recipe and the runnable cookbook must not drift apart.
  const recipe=await showRecipe('middleware'),cookbook=fileURLToPath(new URL('../examples/cookbook/',import.meta.url));
  for(const file of recipe.files.filter(f=>f.startsWith('middleware/')||f.startsWith('functions/')))assert.equal(recipe.content[file],await readFile(join(cookbook,file),'utf8'),file);
});
