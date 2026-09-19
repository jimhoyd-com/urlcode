import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,lstat,symlink,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {buildTypeScriptProject} from '../src/typescript-authoring.ts';
import {startServer} from '../src/server.ts';
import {project,request} from './helpers.ts';

test('TypeScript guest graph builds with rewritten imports and executes only in QuickJS',async t=>{
  const root=await project(t,{'/hello':{function:{source:'functions/hello.ts'}}},{
    'functions/hello.ts':"import {greeting} from './greeting.ts'; interface Result { message: string }; export default (): Response => {const result: Result={message:greeting};return Response.json(result);};",
    'functions/greeting.ts':"export const greeting: string = 'compiled';",
    '.env.local':'DO_NOT_COPY=synthetic-secret','tsconfig.json':'invalid config is never read',
  });
  const out=join(root,'built'),preview=await buildTypeScriptProject(root,out,{dryRun:true});
  assert.equal(preview.typeChecked,false);await assert.rejects(lstat(out),{code:'ENOENT'});
  const result=await buildTypeScriptProject(root,out);assert.deepEqual(result.modules,preview.modules);
  assert.match(await readFile(join(out,'functions/hello.js'),'utf8'),/greeting\.js/);
  await assert.rejects(lstat(join(out,'.env.local')),{code:'ENOENT'});await assert.rejects(lstat(join(out,'tsconfig.json')),{code:'ENOENT'});
  const app=await startServer({project:out,port:0,log:()=>{}});t.after(()=>app.close());
  assert.deepEqual(JSON.parse((await request(app,'/hello')).body),{message:'compiled'});
  await assert.rejects(buildTypeScriptProject(root,out),/already exists/);
});

test('TypeScript build flattens includes and copies only explicitly referenced assets',async t=>{
  const root=await project(t,{'/page':{page:{file:'public/index.html'}},'/static/*':{static:{directory:'public/assets'}},'/f':{function:{source:'f.ts'}}},{
    'public/index.html':'<h1>snapshot</h1>','public/assets/style.css':'body {}','unused.txt':'not copied','f.ts':'export default () => new Response("ok");',
    'extra.yaml':'version: "1"\nroutes:\n  /r:\n    redirect:\n      url: https://example.com\n',
  },{includes:['extra.yaml']});
  const out=join(root,'built');await buildTypeScriptProject(root,out);
  assert.equal(await readFile(join(out,'public/index.html'),'utf8'),'<h1>snapshot</h1>');
  await assert.rejects(lstat(join(out,'unused.txt')),{code:'ENOENT'});
  const config=await readFile(join(out,'urlcode.yaml'),'utf8');assert.doesNotMatch(config,/includes:/);assert.match(config,/\/r:/);
});

test('TypeScript build rejects unsafe imports and source/output collisions before publication',async t=>{
  for(const source of [
    "import fs from 'node:fs'; export default () => fs;",
    "import type {Thing} from 'external'; export default () => new Response('ok');",
    "export default () => import('./dependency.ts');",
    "export default () => import.meta;",
    "import '../../outside.ts'; export default () => new Response('ok');",
    'export const broken: = ;',
  ]){
    // Bare imports, dynamic import() and import.meta are only refused for a
    // `sandbox: true` route; the module-outside-project and syntax-error cases
    // below are refused regardless of trust (see the trust-aware test).
    const root=await project(t,{'/':{sandbox:true,function:{source:'f.ts'}}},{'f.ts':source});const out=join(root,'built');
    await assert.rejects(buildTypeScriptProject(root,out));await assert.rejects(lstat(out),{code:'ENOENT'});
  }
  const root=await project(t,{'/':{function:{source:'f.ts'}}},{'f.ts':"import './f.js'; export default () => new Response('ok');",'f.js':'export const collision = true;'});
  await assert.rejects(buildTypeScriptProject(root,join(root,'built')),/collision/);
});

test('TypeScript build is sandbox-aware: trusted routes allow bare/dynamic imports a sandboxed route still refuses',async t=>{
  const source="import {createHash} from 'node:crypto'; export default async () => {const mod=await import('./dep.ts');return new Response(createHash('sha256').update(mod.value).digest('hex'));};";
  const dep="export const value='trusted';";
  const trusted=await project(t,{'/':{function:{source:'f.ts'}}},{'f.ts':source,'dep.ts':dep});
  const out=join(trusted,'built');const built=await buildTypeScriptProject(trusted,out);
  assert.match(await readFile(join(out,'f.js'),'utf8'),/node:crypto/);
  const app=await startServer({project:out,port:0,log:()=>{}});t.after(()=>app.close());
  assert.equal((await request(app,'/')).body,createHash('sha256').update('trusted').digest('hex'));
  assert.deepEqual(built.modules,['dep.js','f.js']);
  const sandboxed=await project(t,{'/':{sandbox:true,function:{source:'f.ts'}}},{'f.ts':source,'dep.ts':dep});
  await assert.rejects(buildTypeScriptProject(sandboxed,join(sandboxed,'built')),/relative guest module imports are supported/);
  await assert.rejects(lstat(join(sandboxed,'built')),{code:'ENOENT'});
});

test('authoring rejects symlinks, sensitive asset references and oversized sources',async t=>{
  const root=await project(t,{'/':{function:{source:'alias/f.ts'}}},{'actual/f.ts':"export default () => new Response('ok');"});
  await symlink(join(root,'actual'),join(root,'alias'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(buildTypeScriptProject(root,join(root,'built')),/symlink/);
  const sensitive=await project(t,{'/':{page:{file:'.env.local'}}},{'.env.local':'SYNTHETIC=value'});
  await assert.rejects(buildTypeScriptProject(sensitive,join(sensitive,'built')),/non-sensitive/);
  // The 1 MiB per-module budget is the sandbox's own guest limit.
  const large=await project(t,{'/':{sandbox:true,function:{source:'f.ts'}}},{'f.ts':' '.repeat(1048577)});
  await assert.rejects(buildTypeScriptProject(large,join(large,'built')),/size limit/);
});

test('output creation is exclusive, case-portable and never overwrites existing projects',async t=>{
  const root=await project(t,{'/':{function:{source:'f.ts'}}},{'f.ts':'export default () => new Response("ok");'});
  const output=join(root,'existing');await mkdir(output);await writeFile(join(output,'keep.txt'),'preserved');
  await assert.rejects(buildTypeScriptProject(root,output),/already exists/);
  assert.equal(await readFile(join(output,'keep.txt'),'utf8'),'preserved');
  const collision=await project(t,{'/a':{function:{source:'f.ts'}},'/b':{function:{source:'F.js'}}},{'f.ts':'export default () => new Response("ok");','F.js':'export default () => new Response("ok");'});
  await assert.rejects(buildTypeScriptProject(collision,join(collision,'built')),/Conflicting authoring output/);
  await assert.rejects(lstat(join(collision,'built')),{code:'ENOENT'});
});


test('TypeScript source graph handles cycles and enforces its module budget',async t=>{
  const root=await project(t,{'/':{function:{source:'a.ts'}}},{
    'a.ts':"import {message} from './b.ts'; export const suffix: string='!'; export default () => new Response(message());",
    'b.ts':"import {suffix} from './a.ts'; export const message = (): string => 'cycle'+suffix;",
  });
  const output=join(root,'built');const built=await buildTypeScriptProject(root,output);assert.equal(built.modules.length,2);
  const app=await startServer({project:output,port:0,log:()=>{}});t.after(()=>app.close());assert.equal((await request(app,'/')).body,'cycle!');
  const files: Record<string,string>={};
  for(let i=0;i<129;i++)files[`module${i}.ts`]=i<128?`import './module${i+1}.ts'; export default () => new Response('ok');`:"export default () => new Response('ok');";
  // The 128-module budget is the sandbox's own guest limit, so only a
  // `sandbox: true` route enforces it; see the trust-aware test above for the
  // corresponding trusted-route behavior.
  const excessive=await project(t,{'/':{sandbox:true,function:{source:'module0.ts'}}},files);
  await assert.rejects(buildTypeScriptProject(excessive,join(excessive,'built')),/module limit/);
  await assert.rejects(lstat(join(excessive,'built')),{code:'ENOENT'});
});
