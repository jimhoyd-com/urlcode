import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,symlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {addRecipe} from '../packages/core/src/recipes.ts';
import {startServer} from '../packages/core/src/server.ts';
import {inspectExtensionRevision} from '../packages/core/src/extensions.ts';
import type {RuntimeExtension} from '../packages/core/src/extensions.ts';
import {project,request} from './helpers.ts';
import {readmeHost} from './spa-shell-host.ts';
const cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));

// #809: no native SPA fallback; the recipe composes a root static mount with the README's operator plugin.
async function added(t: Parameters<typeof project>[0]) {
  const root=await project(t,{}),out=join(root,'app');await addRecipe('spa-shell',out);
  const host=await readmeHost(join(root,'operator'));
  return {root,out,host,shell:await readFile(join(out,'public/index.html'),'utf8')};
}

test('spa-shell answers unseen client paths of any depth with the shell, and nothing else (#809)',async t=>{
  const {out,host,shell}=await added(t);
  const app=await startServer({project:out,port:0,log:()=>{},plugins:host.default.plugins});t.after(()=>app.close());
  for(const path of ['/a','/a/b/c/d','/a/b/c/d/e/f/g/h','/projects/42/settings?tab=members&q=%20x','/trailing/slash/','/unicode/%C3%A9t%C3%A9','/a?next=/api/x.json']){
    const reply=await request(app,path);
    assert.equal(reply.status,200,path);assert.equal(reply.headers['content-type'],'text/html; charset=utf-8',path);
    assert.equal(reply.headers['cache-control'],'no-cache',path);assert.equal(reply.body,shell,path);
    const head=await request(app,path,{method:'HEAD'});
    assert.equal(head.status,200,path);assert.equal(head.body,'',path);assert.equal(head.headers['content-type'],'text/html; charset=utf-8',path);
  }
  // Other methods on a client path are the mount's 405, never HTML.
  for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS']){
    const reply=await request(app,'/projects/42',{method,headers:{'content-type':'application/json'},body:['POST','PUT','PATCH'].includes(method)?'{}':undefined});
    assert.equal(reply.status,405,method);assert.equal(reply.headers.allow,'GET, HEAD',method);
    assert.doesNotMatch(String(reply.headers['content-type']),/html/,method);assert.notEqual(reply.body,shell,method);
  }
  // Assets: the file, or 404; never the shell, at any depth or without the slash.
  assert.equal((await request(app,'/assets/app.js')).headers['content-type'],'text/javascript; charset=utf-8');
  for(const path of ['/assets/missing.js','/assets/client/route','/assets/a/b/c','/assets','/assets/']){
    const reply=await request(app,path);assert.equal(reply.status,404,path);assert.notEqual(reply.body,shell,path);
  }
  // API: declared endpoints answer natively; site.errors writes every runtime error under /api/* as the JSON envelope (#821).
  const envelope=(code:string,message:string)=>JSON.stringify({error:{code,message}});
  const status=await request(app,'/api/status');assert.equal(status.status,200);assert.deepEqual(JSON.parse(status.body),{ok:true,service:'spa-shell'});
  const refused=await request(app,'/api/status',{method:'POST'});
  assert.equal(refused.status,405,'a declared API route keeps its own method contract');assert.equal(refused.headers.allow,'GET, HEAD');
  assert.equal(refused.headers['content-type'],'application/json; charset=utf-8');assert.equal(refused.body,envelope('METHOD_NOT_ALLOWED','Method not allowed'));
  for(const [method,path] of [['GET','/api'],['GET','/api/'],['GET','/api/missing'],['GET','/api/a/b/c?x=1'],['HEAD','/api/missing'],['GET','/api/app.js']]){
    const reply=await request(app,path!,{method:method!});
    assert.equal(reply.status,404,`${method} ${path}`);assert.equal(reply.headers['content-type'],'application/json; charset=utf-8',`${method} ${path}`);
    assert.equal(reply.headers['cache-control'],'no-store');assert.equal(reply.body,method==='HEAD'?'':envelope('NOT_FOUND','Not found'));
  }
  // The catch-all matches every path, so another method on an undeclared API path is its 405, still JSON and never HTML.
  for(const [method,path] of [['POST','/api/orders'],['DELETE','/api/orders/7']]){
    const reply=await request(app,path!,{method:method!});
    assert.equal(reply.status,405,`${method} ${path}`);assert.equal(reply.headers.allow,'GET, HEAD');
    assert.equal(reply.headers['content-type'],'application/json; charset=utf-8');assert.equal(reply.body,envelope('METHOD_NOT_ALLOWED','Method not allowed'));
  }
  // Client paths outside /api keep the text 405.
  assert.equal((await request(app,'/projects/42',{method:'DELETE'})).body,'Method not allowed\n');
  // File-like paths go to the mount: the file under public/, or 404; hidden names are never published.
  assert.equal((await request(app,'/robots.txt')).body,'User-agent: *\nAllow: /\n');
  assert.equal((await request(app,'/index.html')).body,shell);
  for(const path of ['/missing.png','/deep/path/missing.js','/.env','/.well-known/thing','/a/.hidden/b','/robots.txt/extra.txt']){
    const reply=await request(app,path);assert.equal(reply.status,404,path);assert.notEqual(reply.body,shell,path);
  }
  // Traversal is normalized or refused before any route; it never reaches a file outside public/.
  for(const path of ['/../urlcode.yaml','/%2e%2e/urlcode.yaml','/a/%2e%2e/%2e%2e/urlcode.yaml']){
    const reply=await request(app,path);assert.doesNotMatch(reply.body,/version: "1"/,path);
  }
});

test('spa-shell never turns a denial into the shell: a protected catch-all is authorized first (#809)',async t=>{
  const {out,host,shell}=await added(t);
  const yaml=await readFile(join(out,'urlcode.yaml'),'utf8');
  await writeFile(join(out,'urlcode.yaml'),yaml.replace('version: "1"\n','version: "1"\nextensions:\n  auth:\n    version: "1"\n    config: {}\n'));
  assert.ok(yaml.trimEnd().endsWith('cacheControl: no-cache'),'the catch-all is the last route');
  await writeFile(join(out,'urlcode.yaml'),(await readFile(join(out,'urlcode.yaml'),'utf8'))+'    auth: true\n');
  const auth: RuntimeExtension={
    name:'auth',version:'1',projectSha256:await inspectExtensionRevision(out),targets:['node'],
    schema:{type:'object',additionalProperties:false},policySchema:{type:'object',additionalProperties:false},
    activate(){return {
      handle(){return {status:404,headers:[],body:'no auth mount declared'};},
      authorize(_requirement,request){return request.headers.get('authorization')==='Bearer demo-token'?undefined:{status:401,headers:[['www-authenticate','Bearer realm="app"']],body:'sign in'};},
    };},
  };
  const app=await startServer({project:out,port:0,log:()=>{},origin:'https://spa.example.test',extensions:[auth],plugins:host.default.plugins});t.after(()=>app.close());
  const denied=await request(app,'/projects/42/settings');
  assert.equal(denied.status,401);assert.equal(denied.headers['www-authenticate'],'Bearer realm="app"');assert.notEqual(denied.body,shell);
  const apiDenied=await request(app,'/api/missing');assert.equal(apiDenied.status,401,'the JSON 404 is behind authorization too');
  const allowed=await request(app,'/projects/42/settings',{headers:{authorization:'Bearer demo-token'}});
  assert.equal(allowed.status,200);assert.equal(allowed.body,shell);
  // The unprotected routes are untouched by either.
  assert.equal((await request(app,'/api/status')).status,200);
  assert.equal((await request(app,'/assets/missing.js')).status,404);
});

test('spa-shell refuses a shell outside the project and a catch-all that is not a static route (#809)',async t=>{
  const {root,out,host}=await added(t);
  await writeFile(join(root,'outside.html'),'<p>outside</p>');
  await symlink(join(root,'outside.html'),join(out,'linked.html'));
  const start=(plugin: ReturnType<typeof host.spaShell>)=>startServer({project:out,port:0,log:()=>{},plugins:[plugin]});
  await assert.rejects(start(host.spaShell({shell:'../outside.html'})),/shell must be a file inside the project/);
  await assert.rejects(start(host.spaShell({shell:'linked.html'})),/shell must be a file inside the project/);
  await assert.rejects(start(host.spaShell({shell:'public/missing.html'})),/ENOENT/);
  await assert.rejects(start(host.spaShell({route:'/app/*'})),/needs a static \/app\/\* route/);
  await assert.rejects(start(host.spaShell({route:'/'})),/needs a static \/ route/);
  // The prefixes are options: an app whose client routes include /docs keeps them out of the shell.
  const app=await start(host.spaShell({exclude:['/assets','/docs']}));t.after(()=>app.close());
  assert.equal((await request(app,'/docs/guide')).status,404);
  assert.equal((await request(app,'/docsite')).status,200,'a prefix matches whole segments');
});

test('spa-shell fixtures pass through the CLI with the README host file, and fail without it (#809)',async t=>{
  const {out,host}=await added(t);
  const run=(...args: string[])=>spawnSync(process.execPath,[cli,...args,'--project',out],{encoding:'utf8',timeout:30000});
  const tested=run('test','--host-file',host.path);assert.equal(tested.status,0,tested.stdout+tested.stderr);
  assert.match(tested.stdout,/"total":17,"failed":0/);
  const audited=run('audit','--expect-routes','4','--host-file',host.path);assert.equal(audited.status,0,audited.stdout+audited.stderr);
  // Without the host file only the two client-path fixtures fail; the API's JSON errors are YAML.
  const bare=run('test');assert.equal(bare.status,1);assert.match(bare.stdout,/"failed":2/);
});
