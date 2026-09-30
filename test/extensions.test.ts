import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,mkdtemp,mkdir,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {project,request,byReplyId} from './helpers.ts';
import {loadDocument} from '../packages/core/src/config.ts';
import {createRuntime} from '../packages/core/src/runtime.ts';
import {assertExtensionMountsDisjoint} from '../packages/core/src/router.ts';
import {startServer} from '../packages/core/src/server.ts';
import {createLambdaHandler} from '../packages/core/src/aws.ts';
import {buildCloudflare} from '../packages/core/src/build-cloudflare.ts';
import {inspectExtensionRevision,effectiveExtensionPolicies} from '../packages/core/src/extensions.ts';
import {ConfigError,asConfigError,describeError} from '../packages/core/src/errors.ts';
import type {RuntimeExtension} from '../packages/core/src/extensions.ts';
import type {ProjectDocument} from '../packages/core/src/types.ts';
import {inspectExtensions,describeExtensions,validateProject} from '../packages/core/src/tooling.ts';
import {serveMcp} from '../packages/core/src/mcp.ts';
import {Readable,Writable} from 'node:stream';
const origin='https://extensions.example.test';
const declarations={demo:{version:'1',config:{label:'hello'}}};
const mount={extension:'demo',methods:['GET','HEAD','POST']};
async function registration(root:string,extra:Partial<RuntimeExtension>={}):Promise<RuntimeExtension>{const resolvedRoot=await realpath(root);return {
  name:'demo',version:'1',projectSha256:await inspectExtensionRevision(root),targets:['node','aws','vercel'],
  schema:{type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false},
  policySchema:{type:'object',properties:{role:{const:'member'}},required:['role'],additionalProperties:false},
  hooks:[{name:'transform',kind:'filter',description:'Transforms a demo value.',inputSchema:{type:'object'},outputSchema:{type:'object'}}],
  authoring:{description:'Customize the installed extension before replacing its behavior.',surfaces:[{kind:'configuration',name:'label',description:'Set the label.',path:'extensions.demo.config.label'}],fastChecks:['urlcode validate --local']},
  // `context.root` is the project's resolved directory (loadDocument's own
  // realpath), the reliable source for an extension resolving project-relative
  // paths — never `process.cwd()`, which `--project`/`--host-file` are
  // independent of.
  activate(config,context){assert.ok(Object.isFrozen(config));assert.ok(Object.isFrozen(context.mounts));assert.equal(context.root,resolvedRoot);return {
    handle(req){return{status:200,headers:[['content-type','application/json'],['cdn-cache-control','public, max-age=100']],body:JSON.stringify({label:config.label,path:req.path,mount:req.mount,body:Buffer.from(req.body).toString(),origin:req.origin,cookie:req.headers.get('cookie')})};},
    authorize(_policy,req){if(req.headers.get('cookie')!=='session=yes')return{status:401,headers:[],body:'sign in'};},
  };},...extra,
};}
test('versioned extension config composes safely without loading operator modules',async t=>{
  const root=await project(t,{}, {'routes.yaml':'version: "1"\nextensions:\n  demo: {version: "1", config: {label: hello}}\nroutes:\n  /demo/*: {extension: demo}\n'},{includes:['routes.yaml']});
  const loaded=await loadDocument(root);assert.equal(loaded.document.extensions?.demo?.config.label,'hello');
  const duplicate=await project(t,{}, {'routes.yaml':'version: "1"\nextensions:\n  demo: {version: "1", config: {label: other}}\nroutes: {}\n'},{includes:['routes.yaml'],extensions:declarations});
  await assert.rejects(loadDocument(duplicate),/Duplicate extension/);
});
test('extension hook entry bytes participate in the reviewed project revision',async t=>{
  const root=await project(t,{}, {'hook.mjs':'export default value => value;\n'},{extensions:{demo:{version:'1',config:{hooks:{transform:'./hook.mjs'}}}}});
  const first=await inspectExtensionRevision(root);
  await writeFile(join(root,'hook.mjs'),'export default value => ({...value, changed: true});\n');
  assert.notEqual(await inspectExtensionRevision(root),first);
});
test('missing registrations, unsupported versions, invalid config and stale grants fail before activation',async t=>{
  const root=await project(t,{'/demo/*':mount},{},{extensions:declarations});
  // With no resolved registration set at all, the capability preflight now
  // refuses before activation ever reaches prepareExtensions (packages/core/src/capabilities.ts:
  // extension/policies.extensions report conditional/unknown without a host file).
  await assert.rejects(createRuntime(root,{origin}),/capability: extension/);
  let activations=0;const extension=await registration(root,{activate(){activations++;throw new Error('must not run');}});
  await assert.rejects(createRuntime(root,{origin,extensions:[{...extension,projectSha256:'0'.repeat(64)}]}),/pin mismatch/);
  await assert.rejects(createRuntime(root,{extensions:[extension]}),/explicit operator origin/);
  await assert.rejects(createRuntime(root,{origin,extensions:[extension,extension]}),/Duplicate extension/);
  await assert.rejects(createRuntime(root,{origin,extensions:[{...extension,schema:{type:'object',additionalProperties:false}}]}),{message:'Invalid extension configuration at /extensions/demo/config (additionalProperties): unknown key "label"; no keys are allowed here (run urlcode extensions --json for its configuration schema)'});
  // The failing field and check are named; the rejected value (which may be a secret) never is.
  await assert.rejects(createRuntime(root,{origin,extensions:[{...extension,schema:{type:'object',properties:{label:{type:'integer'}}}}]}),(error:Error)=>/^Invalid extension configuration at \/extensions\/demo\/config\/label \(type\): must be integer$/.test(error.message)&&!error.message.includes('hello'));
  // A route policy that fails the policy schema names its effective location and check, never the value (#696).
  const policed=await project(t,{'/demo/*':mount,'/private':{respond:{text:'p'},policies:{extensions:{demo:{role:'secret-admin'}}}}},{},{extensions:declarations});
  const policedExtension=await registration(policed,{activate(){activations++;throw new Error('must not run');}});
  await assert.rejects(createRuntime(policed,{origin,extensions:[policedExtension]}),(error:Error)=>error.message==='Invalid extension policy at route /private, policies.extensions.demo.role (const): must be "member"'&&!error.message.includes('secret-admin'));
  await assert.rejects(createRuntime(policed,{origin,extensions:[{...policedExtension,policySchema:{type:'object',properties:{role:{type:'string'},tier:{type:'string'}},required:['tier']}}]}),{message:'Invalid extension policy at route /private, policies.extensions.demo (required): missing required key "tier"'});
  await assert.rejects(createRuntime(policed,{origin,extensions:[(({policySchema:_,...rest})=>rest)(policedExtension)]}),{message:'Invalid extension policy at route /private, policies.extensions.demo: extension "demo" declares no route policy'});
  await assert.rejects(createRuntime(root,{origin,extensions:[{...extension,authoring:{description:'Customize it.',surfaces:[{kind:'widget' as never,name:'widget',description:'Unsupported surface.'}]}}]}),/Invalid extension authoring surface kind/);
  assert.equal(activations,0);
  await assert.rejects(buildCloudflare(root,{out:join(root,'out')}),/extension/);
  const first=await inspectExtensionRevision(root);
  await writeFile(join(root,'urlcode.yaml'),'version: "1"\nextensions:\n  demo: {version: "1", config: {label: changed}}\nroutes:\n  /demo/*: {extension: demo}\n');
  assert.notEqual(await inspectExtensionRevision(root),first);
  await assert.rejects(createRuntime(root,{origin,extensions:[extension]}),/pin mismatch/);
});
test('extension mounts receive bounded bodies, preserve cookies in host code and force private responses',async t=>{
  const root=await project(t,{'/demo/*':mount,'/other':{respond:{text:'other'}}},{},{extensions:declarations});
  const app=await startServer({project:root,origin,port:0,extensions:[await registration(root)],log:()=>{}});t.after(()=>app.close());
  const response=await request(app,'/demo/login',{method:'POST',body:'body',headers:{cookie:'session=yes','x-forwarded-host':'attacker.test'}});
  assert.equal(response.status,200);assert.deepEqual(JSON.parse(response.body),{label:'hello',path:'/demo/login',mount:'/demo',body:'body',origin,cookie:'session=yes'});
  assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.headers['cdn-cache-control'],undefined);
  assert.equal((await request(app,'/demo')).status,200);assert.equal((await request(app,'/demonstration')).status,404);
  assert.equal((await request(app,'/demo',{method:'HEAD'})).body,'');assert.equal((await request(app,'/demo',{method:'DELETE'})).status,405);
  assert.equal(app.testPlan().inventory.find(item=>item.path==='/demo/*')?.handler,'extension');assert.ok(!app.testPlan().cases.some(item=>item.path.startsWith('/demo')));
});
test('extension mount ownership rejects shadowing, dynamic collisions and nested mounts',async t=>{
  for(const routes of [
    {'/demo/*':mount,'/demo':{respond:{text:'shadow'}}},
    {'/demo/*':mount,'/demo/login':{respond:{text:'shadow'}}},
    {'/demo/*':mount,'/{id}':{parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}],respond:{text:'shadow'}}},
    {'/demo/*':mount,'/demo/nested/*':{...mount,methods:[...mount.methods]}},
  ]){const root=await project(t,routes,{},{extensions:declarations});await assert.rejects(createRuntime(root,{origin,extensions:[await registration(root)]}),/overlaps/);}
});
test('an extension mount overlap names both routes, before a stale pin can hide it, and a pure check finds it (#912)',async t=>{
  const shadowed=await project(t,{'/demo/*':mount,'/demo/login':{respond:{text:'shadow'}}},{},{extensions:declarations});
  const expected={message:'Extension mount /demo/* overlaps route /demo/login: extension "demo" answers /demo and every path below it, so move /demo/login outside it',details:{code:'extension-mount-overlap',route:'/demo/*',pointer:'/routes/~1demo~1*'}};
  await assert.rejects(createRuntime(shadowed,{origin,extensions:[await registration(shadowed)]}),expected);
  await assert.rejects(createRuntime(shadowed,{origin,extensions:[{...await registration(shadowed),projectSha256:'0'.repeat(64)}]}),expected);
  const nested=await project(t,{'/demo/*':mount,'/demo/nested/*':{...mount,methods:[...mount.methods]}},{},{extensions:declarations});
  await assert.rejects(createRuntime(nested,{origin,extensions:[await registration(nested)]}),{message:/^Extension mount \/demo\/\* overlaps route \/demo\/nested\/\*: extension "demo" answers \/demo /});
  const routes=(value:Record<string,object>)=>value as Parameters<typeof assertExtensionMountsDisjoint>[0];
  assert.throws(()=>assertExtensionMountsDisjoint(routes({'/api/*':{extension:'demo'},'/api/auth/*':{extension:'auth'}})),{message:/^Extension mount \/api\/\* overlaps route \/api\/auth\/\*/});
  assert.throws(()=>assertExtensionMountsDisjoint(routes({'/api/auth/*':{extension:'auth'},'/{section}/{page}':{respond:{text:'x'}}})),{message:/overlaps route \/\{section\}\/\{page\}/});
  assert.throws(()=>assertExtensionMountsDisjoint(routes({'/api/auth/*':{extension:'auth'},'/api/auth/x/**':{redirect:{url:'/y/{**}'}}})),{message:/overlaps route \/api\/auth\/x\/\*\*/});
  // A shorter route and a non-extension mount strictly enclosing the extension's are allowed: mounts select the longest prefix.
  assertExtensionMountsDisjoint(routes({'/*':{static:{directory:'public'}},'/api/*':{static:{directory:'api'}},'/api/**':{redirect:{url:'/x/{**}'}},'/api':{respond:{text:'a'}},'/{page}':{respond:{text:'p'}},'/api/auth/*':{extension:'auth'},'/api/requests/*':{extension:'store'}}));
});
test('validate without a host file refuses an extension mount overlap, naming both routes, and admits a root static site (#912)',async t=>{
  const site=await mkdtemp(join(tmpdir(),'urlcode-mount-overlap-'));t.after(()=>rm(site,{recursive:true,force:true}));
  const app=join(site,'app'),installed=join(site,'node_modules','@jimhoyd','urlcode-store');
  await mkdir(join(app,'public'),{recursive:true});await mkdir(installed,{recursive:true});await writeFile(join(app,'public','index.html'),'home');
  await writeFile(join(installed,'urlcode.json'),await readFile(new URL('../packages/store/urlcode.json',import.meta.url),'utf8'));
  const write=(routes:object)=>writeFile(join(app,'urlcode.yaml'),JSON.stringify({version:'1',extensions:{store:{version:'1',config:{collections:{todos:{mount:'/api/todos',schema:{type:'object',additionalProperties:false,required:['title'],properties:{title:{type:'string',maxLength:80}}}}}}}},routes:{'/api/todos/*':{extension:'store',methods:['GET','HEAD','POST']},...routes}}));
  const validate=()=>spawnSync(process.execPath,['--conditions=development',fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url)),'validate','--local','--project',app],{encoding:'utf8',timeout:20000});
  await write({'/api/todos/export':{respond:{text:'shadow'}}});
  const refused=validate();assert.equal(refused.status,1,refused.stdout);
  const error=JSON.parse(refused.stderr.trim().split('\n').at(-1)!) as {message:string;code:string;route:string};
  assert.equal(error.message,'Extension mount /api/todos/* overlaps route /api/todos/export: extension "store" answers /api/todos and every path below it, so move /api/todos/export outside it');
  assert.equal(error.code,'extension-mount-overlap');assert.equal(error.route,'/api/todos/*');
  await write({'/*':{static:{directory:'public',index:'index.html'}}});
  const valid=validate();assert.equal(valid.status,0,valid.stderr);assert.equal((JSON.parse(valid.stdout) as {static:boolean}).static,true);
});
test('a root static site coexists with extension mounts below it; the longest mount prefix wins (#912)',async t=>{
  const root=await project(t,{'/*':{static:{directory:'public',index:'index.html'}},'/demo/*':mount},{'public/index.html':'home','public/app.js':'app','public/demo.html':'sibling'},{extensions:declarations});
  const app=await startServer({project:root,origin,port:0,extensions:[await registration(root)],log:()=>{}});t.after(()=>app.close());
  assert.equal((await request(app,'/')).body,'home');assert.equal((await request(app,'/app.js')).body,'app');assert.equal((await request(app,'/demo.html')).body,'sibling');
  for(const path of ['/demo','/demo/','/demo/login'])assert.equal(JSON.parse((await request(app,path)).body).mount,'/demo',path);
  assert.equal((await request(app,'/demo/missing.html')).status,200,'the extension answers its namespace; the static site never falls through into it');
  assert.equal((await request(app,'/missing.html')).status,404);
});
test('an undeclared method is 405 with Allow before an extension authorize(), on a mount and on a core route alike (#915)',async t=>{
  const protectedMount={...mount,methods:['GET','HEAD'],policies:{extensions:{demo:{role:'member'}}}};
  const root=await project(t,{'/demo/*':protectedMount,'/private':{methods:['POST'],respond:{text:'private'},policies:{extensions:{demo:{role:'member'}}}},'/api/private':{methods:['GET'],errors:{format:'json'},respond:{text:'private'},policies:{extensions:{demo:{role:'member'}}}}},{},{extensions:declarations});
  let authorizations=0;const base=await registration(root);
  const app=await startServer({project:root,origin,port:0,extensions:[{...base,activate(config,context){const instance=base.activate(config,context) as Awaited<ReturnType<RuntimeExtension['activate']>>;return {...instance,authorize(policy,req){authorizations++;return instance.authorize!(policy,req);}};}}],log:()=>{}});t.after(()=>app.close());
  for(const [path,method,allow] of [['/demo','POST','GET, HEAD'],['/demo/x','DELETE','GET, HEAD'],['/private','GET','POST'],['/api/private','DELETE','GET']] as const){
    const refused=await request(app,path,{method});assert.equal(refused.status,405,`${method} ${path}`);assert.equal(refused.headers.allow,allow,`${method} ${path}`);
  }
  assert.equal(authorizations,0,'authorize() never runs for an undeclared method');
  const json=await request(app,'/api/private',{method:'DELETE'});assert.match(String(json.headers['content-type']),/json/);assert.equal(JSON.parse(json.body).error.code,"METHOD_NOT_ALLOWED");
  // A declared method still meets the gate, and passes it with a session.
  assert.equal((await request(app,'/demo/x')).status,401);assert.equal((await request(app,'/private',{method:'POST'})).status,401);assert.equal(authorizations,2);
  assert.equal((await request(app,'/demo/x',{headers:{cookie:'session=yes'}})).status,200);
  assert.equal((await request(app,'/private',{method:'POST',headers:{cookie:'session=yes'}})).body,'private');
});
test('authorization inherits per extension, rejects cache sharing and precedes trusted plugin answers',async t=>{
  const root=await project(t,{'/demo/*':mount,'/private':{respond:{text:'private'},policies:{profile:'member'}}},{},{extensions:declarations,profiles:{member:{extensions:{demo:{role:'member'}}}}});
  const app=await startServer({project:root,origin,port:0,extensions:[await registration(root)],plugins:[{name:'early',version:'1',targets:['node'],onRequest:()=>({status:200,headers:[['cdn-cache-control','public']],body:'early'})}],log:()=>{}});t.after(()=>app.close());
  assert.equal((await request(app,'/private')).status,401);
  const admitted=await request(app,'/private',{headers:{cookie:'session=yes'}});assert.equal(admitted.status,200);assert.equal(admitted.headers['cache-control'],'no-store');assert.equal(admitted.headers['cdn-cache-control'],undefined);
  assert.ok(app.testPlan().inventory.find(item=>item.path==='/private')?.policies.includes('extensions.demo'));assert.ok(!app.testPlan().cases.some(item=>item.path==='/private'));
  const cached=await project(t,{'/demo/*':mount,'/private':{respond:{text:'private'},policies:{extensions:{demo:{role:'member'}},cache:{strategy:'micro'}}}},{},{extensions:declarations});
  await assert.rejects(createRuntime(cached,{origin,extensions:[await registration(cached)]}),{message:'/private: routes protected by extension "demo" cannot be cached; use cache: {strategy: no-store} or remove cache'});
});
test('extension credentials never reach guests, including recreated header defaults',async t=>{
  const root=await project(t,{'/demo/*':mount,'/guest':{parameters:[{name:'cookie',in:'header',schema:{type:'string',default:'default-cookie'}}],function:{source:'guest.mjs'}}},{'guest.mjs':'export default (request, context) => Response.json({cookie:request.headers.get("cookie"),authorization:request.headers.get("authorization"),input:context.inputs.header.cookie??null});'},{extensions:declarations});
  const app=await startServer({project:root,origin,port:0,extensions:[await registration(root)],log:()=>{}});t.after(()=>app.close());
  const result=await request(app,'/guest',{headers:{cookie:'session=yes',authorization:'Bearer credential'}});assert.deepEqual(JSON.parse(result.body),{cookie:null,authorization:null,input:null});
});
/** A synthetic middleware-only extension: wraps `next()`, tagging the response header with `name` and, when `mode==='block'`, never calling `next()` at all. */
async function middlewareExtension(root:string,name:string,mode:'wrap'|'block'='wrap',order?:string[]):Promise<RuntimeExtension>{return {
  name,version:'1',projectSha256:await inspectExtensionRevision(root),targets:['node','aws','vercel'],
  schema:{type:'object',additionalProperties:false},policySchema:{type:'object',additionalProperties:false},
  activate(){return {handle(){return{status:404,headers:[],body:''};},
    async middleware(_config,_req,next){
      if(mode==='block')return{status:403,headers:[['x-mw',name]],body:'blocked'};
      order?.push(`${name}:before`);
      const result=await next();
      order?.push(`${name}:after`);
      return{...result,headers:[...result.headers,['x-mw',name]]};
    },
  };},
};}
test('extension middleware wraps the pipeline via next(), after the response is finished',async t=>{
  const root=await project(t,{'/h':{respond:{text:'ok'},policies:{extensions:{mw:{}}}}},{},{extensions:{mw:{version:'1',config:{}}}});
  const runtime=await createRuntime(root,{origin,extensions:[await middlewareExtension(root,'mw')]});t.after(()=>runtime.close());
  const result=await runtime.handle({target:'/h',method:'GET'});
  assert.equal(result.status,200);assert.equal(Buffer.from(result.body as Uint8Array).toString(),'ok');
  assert.deepEqual(result.headers.filter(([n])=>n==='x-mw'),[['x-mw','mw']]);
  assert.equal(result.headers.find(([n])=>n==='cache-control')?.[1],'no-store');
});
test('extension middleware short-circuits without calling next(), so the wrapped handler never runs',async t=>{
  const root=await project(t,{'/f':{function:{source:'f.mjs'},policies:{extensions:{mw:{}}}}},{'f.mjs':'export default ()=>{globalThis.__mwBlockedCalls=(globalThis.__mwBlockedCalls||0)+1;return new Response("ran");}'},{extensions:{mw:{version:'1',config:{}}}});
  const before=(globalThis as {__mwBlockedCalls?:number}).__mwBlockedCalls??0;
  const runtime=await createRuntime(root,{origin,extensions:[await middlewareExtension(root,'mw','block')]});t.after(()=>runtime.close());
  const result=await runtime.handle({target:'/f',method:'GET'});
  assert.equal(result.status,403);assert.equal(Buffer.from(result.body as Uint8Array).toString(),'blocked');
  assert.equal(result.headers.find(([n])=>n==='cache-control')?.[1],'no-store');
  assert.equal((globalThis as {__mwBlockedCalls?:number}).__mwBlockedCalls??0,before);
});
test('two extensions declaring middleware on the same route nest in declaration order',async t=>{
  const order:string[]=[];
  const root=await project(t,{'/n':{respond:{text:'ok'},policies:{extensions:{outer:{},inner:{}}}}},{},{extensions:{outer:{version:'1',config:{}},inner:{version:'1',config:{}}}});
  const runtime=await createRuntime(root,{origin,extensions:[await middlewareExtension(root,'outer','wrap',order),await middlewareExtension(root,'inner','wrap',order)]});t.after(()=>runtime.close());
  const result=await runtime.handle({target:'/n',method:'GET'});
  assert.equal(result.status,200);
  assert.deepEqual(order,['outer:before','inner:before','inner:after','outer:after']);
  assert.deepEqual(result.headers.filter(([n])=>n==='x-mw'),[['x-mw','inner'],['x-mw','outer']]);
});
test('an extension implementing both authorize and middleware runs authorize first, then middleware wraps the rest',async t=>{
  const calls:string[]=[];
  const both=async(root:string):Promise<RuntimeExtension>=>({
    name:'both',version:'1',projectSha256:await inspectExtensionRevision(root),targets:['node','aws','vercel'],
    schema:{type:'object',additionalProperties:false},policySchema:{type:'object',additionalProperties:false},
    activate(){return{handle(){return{status:404,headers:[],body:''};},
      authorize(_policy,req){calls.push('authorize');if(req.headers.get('cookie')!=='session=yes')return{status:401,headers:[],body:'sign in'};return undefined;},
      async middleware(_config,_req,next){calls.push('middleware:before');const result=await next();calls.push('middleware:after');return{...result,headers:[...result.headers,['x-both','1']]};},
    };},
  });
  const root=await project(t,{'/g':{respond:{text:'ok'},policies:{extensions:{both:{}}}}},{},{extensions:{both:{version:'1',config:{}}}});
  const runtime=await createRuntime(root,{origin,extensions:[await both(root)]});t.after(()=>runtime.close());
  const denied=await runtime.handle({target:'/g',method:'GET'});
  assert.equal(denied.status,401);assert.deepEqual(calls,['authorize']);assert.ok(!denied.headers.some(([n])=>n==='x-both'));
  calls.length=0;
  const admitted=await runtime.handle({target:'/g',method:'GET',headers:new Headers({cookie:'session=yes'})});
  assert.equal(admitted.status,200);assert.deepEqual(calls,['authorize','middleware:before','middleware:after']);
  assert.deepEqual(admitted.headers.filter(([n])=>n==='x-both'),[['x-both','1']]);
});
test('a route naming an extension via policies.extensions may implement only middleware, only authorize, or both',async t=>{
  const root=await project(t,{'/m':{respond:{text:'m'},policies:{extensions:{mw:{}}}}},{},{extensions:{mw:{version:'1',config:{}}}});
  const runtime=await createRuntime(root,{origin,extensions:[await middlewareExtension(root,'mw')]});t.after(()=>runtime.close());
  assert.equal((await runtime.handle({target:'/m',method:'GET'})).status,200);
  const neither:RuntimeExtension={name:'mw',version:'1',projectSha256:await inspectExtensionRevision(root),targets:['node','aws','vercel'],schema:{type:'object',additionalProperties:false},policySchema:{type:'object',additionalProperties:false},activate(){return{handle:()=>({status:200,headers:[]})};}};
  await assert.rejects(createRuntime(root,{origin,extensions:[neither]}),/lacks a required handler, authorization hook or middleware hook/);
});
/** A trusted, identity pass-through extension: implements only `middleware()`, forwarding whatever `next()` returns unchanged. `cacheSensitive` is left unset (default, sensitive) unless given. */
async function passThroughExtension(root:string,name:string,cacheSensitive?:boolean):Promise<RuntimeExtension>{return {
  name,version:'1',projectSha256:await inspectExtensionRevision(root),targets:['node','aws','vercel'],
  schema:{type:'object',additionalProperties:false},policySchema:{type:'object',additionalProperties:false},
  ...(cacheSensitive===undefined?{}:{cacheSensitive}),
  activate(){return {handle(){return{status:404,headers:[],body:''};},async middleware(_config,_req,next){return await next();}};},
};}
test('a native middleware: array pass-through preserves the response\'s own Cache-Control',async t=>{
  const root=await project(t,{'/native':{function:{source:'f.mjs'},middleware:['pass.mjs']}},{
    'f.mjs':'export default ()=>new Response("ok",{headers:{"cache-control":"public, max-age=60"}});',
    'pass.mjs':'export default (request,context,next)=>next();',
  });
  const runtime=await createRuntime(root,{origin});t.after(()=>runtime.close());
  const result=await runtime.handle({target:'/native',method:'GET'});
  assert.equal(result.status,200);
  assert.equal(result.headers.find(([n])=>n==='cache-control')?.[1],'public, max-age=60');
});
test('a security-sensitive extension policy forces no-store even over a permissive response header, whether declared or defaulted',async t=>{
  const files={'f.mjs':'export default ()=>new Response("ok",{headers:{"cache-control":"public, max-age=60"}});'};
  for(const cacheSensitive of [true,undefined]){
    const root=await project(t,{'/sensitive':{function:{source:'f.mjs'},policies:{extensions:{mw:{}}}}},files,{extensions:{mw:{version:'1',config:{}}}});
    const runtime=await createRuntime(root,{origin,extensions:[await passThroughExtension(root,'mw',cacheSensitive)]});t.after(()=>runtime.close());
    const result=await runtime.handle({target:'/sensitive',method:'GET'});
    assert.equal(result.status,200,String(cacheSensitive));
    assert.equal(result.headers.find(([n])=>n==='cache-control')?.[1],'no-store',String(cacheSensitive));
  }
});
test('an extension explicitly declared cacheSensitive: false preserves the wrapped response\'s own cache headers',async t=>{
  const root=await project(t,{'/transparent':{function:{source:'f.mjs'},policies:{extensions:{mw:{}}}}},{
    'f.mjs':'export default ()=>new Response("ok",{headers:{"cache-control":"public, max-age=60"}});',
  },{extensions:{mw:{version:'1',config:{}}}});
  const runtime=await createRuntime(root,{origin,extensions:[await passThroughExtension(root,'mw',false)]});t.after(()=>runtime.close());
  const result=await runtime.handle({target:'/transparent',method:'GET'});
  assert.equal(result.status,200);
  assert.equal(result.headers.find(([n])=>n==='cache-control')?.[1],'public, max-age=60');
});
test('a route compiling a static permissive Cache-Control still requires no-store unless its extension is declared cache-transparent',async t=>{
  const routes={'/static':{respond:{text:'ok'},response:{headers:{'cache-control':'public, max-age=60'}},policies:{extensions:{mw:{}}}}};
  const sensitive=await project(t,routes,{},{extensions:{mw:{version:'1',config:{}}}});
  await assert.rejects(createRuntime(sensitive,{origin,extensions:[await passThroughExtension(sensitive,'mw')]}),{message:'/static: routes protected by extension "mw" cannot send a cacheable response header; set it to no-store or remove it'});
  const transparent=await project(t,routes,{},{extensions:{mw:{version:'1',config:{}}}});
  const runtime=await createRuntime(transparent,{origin,extensions:[await passThroughExtension(transparent,'mw',false)]});t.after(()=>runtime.close());
  const result=await runtime.handle({target:'/static',method:'GET'});
  assert.equal(result.status,200);
  assert.equal(result.headers.find(([n])=>n==='cache-control')?.[1],'public, max-age=60');
});
test('extension policy maps merge by logical owner and false disables explicitly',()=>{
  const document={version:'1',routes:{},policies:{extensions:{demo:{role:'member',extra:'base'}}},profiles:{local:{extensions:{demo:{extra:'profile'}}}}} as ProjectDocument;
  assert.deepEqual({...effectiveExtensionPolicies(document,{policies:{profile:'local',extensions:{demo:{extra:'route'}}}})},{demo:{role:'member',extra:'route'}});
  assert.deepEqual({...effectiveExtensionPolicies(document,{policies:{extensions:{demo:false}}})},{});
});
test('AWS adapter receives explicit operator extensions and configured origin',async t=>{
  const root=await project(t,{'/demo/*':mount},{},{extensions:declarations});
  const handler=createLambdaHandler({project:root,origin,extensions:[await registration(root)],environment:{}});
  const result=await handler({version:'2.0',rawPath:'/demo/login',rawQueryString:'',headers:{},body:'json',requestContext:{http:{method:'POST'}}});
  assert.equal(result.statusCode,200);assert.equal(JSON.parse(Buffer.from(result.body,'base64').toString()).origin,origin);
});
test('extension body bounds apply to direct embedding',async t=>{
  const root=await project(t,{'/demo/*':mount},{},{extensions:declarations});
  const runtime=await createRuntime(root,{origin,extensions:[await registration(root)]});t.after(()=>runtime.close());
  await assert.rejects(runtime.handle({target:'/demo',method:'POST',body:Buffer.alloc(1048577)}),/body too large/);
});
test('checked-in extension example runs with an explicit operator registry',async t=>{
  const root=fileURLToPath(new URL('../examples/extensions/',import.meta.url));
  const demo=await registration(root);
  const runtime=await createRuntime(root,{origin,extensions:[demo,{...demo,name:'auth',providesPrincipal:true,schema:{type:'object',additionalProperties:false}}]});t.after(()=>runtime.close());
  assert.equal((await runtime.handle({target:'/demo',method:'GET'})).status,200);
  assert.equal((await runtime.handle({target:'/private',method:'GET'})).status,401);
  assert.equal((await runtime.handle({target:'/account',method:'GET'})).status,401);
  assert.equal((await runtime.handle({target:'/account',method:'GET',headers:new Headers({cookie:'session=yes'})})).status,200);
});
test('route auth short form expands to the canonical policies.extensions.<principal provider> requirement',async t=>{
  const auth={version:'1',config:{}};
  const short=await loadDocument(await project(t,{'/a':{respond:{text:'a'},auth:{role:'member',onDeny:403}},'/b':{respond:{text:'b'},auth:true},'/c':{respond:{text:'c'},auth:{required:false,role:'member'}},'/d':{respond:{text:'d'},auth:{role:'member'},policies:{extensions:{other:{x:1}},cache:false}}},{},{extensions:{auth}}));
  const long=await loadDocument(await project(t,{'/a':{respond:{text:'a'},policies:{extensions:{auth:{role:'member',onDeny:403}}}},'/b':{respond:{text:'b'},policies:{extensions:{auth:{}}}},'/c':{respond:{text:'c'}},'/d':{respond:{text:'d'},policies:{extensions:{other:{x:1},auth:{role:'member'}},cache:false}}},{},{extensions:{auth}}));
  assert.deepEqual(short.routes,long.routes);assert.deepEqual(short.document.routes,long.document.routes);assert.equal(short.version,long.version);
  for(const path of ['/a','/b','/c','/d'])assert.equal('auth' in short.routes[path]!,false);
  assert.deepEqual({...effectiveExtensionPolicies(short.document,short.routes['/a']!)},{auth:{role:'member',onDeny:403}});
  assert.deepEqual({...effectiveExtensionPolicies(short.document,short.routes['/c']!)},{});
  await assert.rejects(loadDocument(await project(t,{'/a':{respond:{text:'a'},auth:true}})),/Route \/a declares auth, but no declared extension provides a principal/);
  await assert.rejects(loadDocument(await project(t,{'/a':{respond:{text:'a'},auth:true,policies:{extensions:{auth:{role:'member'}}}}},{},{extensions:{auth}})),/Route \/a declares both auth and policies\.extensions\.auth/);
  await assert.rejects(loadDocument(await project(t,{'/a':{respond:{text:'a'},auth:true,policies:{extensions:false}}},{},{extensions:{auth}})),/Route \/a declares auth alongside policies\.extensions: false/);
  // Core owns only the mapping: the object's keys belong to the auth extension, so loading admits any object and
  // refuses only a value that is neither `true` nor an object, or a non-boolean `required` (#710).
  const loose=await loadDocument(await project(t,{'/a':{respond:{text:'a'},auth:{roles:['member']}}},{},{extensions:{auth}}));
  assert.deepEqual(loose.routeAuth,{'/a':{extension:'auth',required:true,requirement:{roles:['member']}}});
  assert.equal(short.routeAuth?.['/c']?.required,false);assert.equal(long.routeAuth,undefined);
  await assert.rejects(loadDocument(await project(t,{'/a':{respond:{text:'a'},auth:'yes'}},{},{extensions:{auth}})),/Invalid configuration at route \/a, auth \((const|type)\)/);
  await assert.rejects(loadDocument(await project(t,{'/a':{respond:{text:'a'},auth:{required:'no'}}},{},{extensions:{auth}})),/Invalid configuration at route \/a, auth\.required \(type\)/);
});
/** A stand-in for the auth extension's own policy schema; core's schema no longer carries this vocabulary. */
const authPolicySchema={type:'object',additionalProperties:false,properties:{role:{type:'string',minLength:1,maxLength:64},freshWithinSeconds:{type:'integer',minimum:1,maximum:3600},bearer:{type:'object',additionalProperties:false,required:['scopes'],properties:{scopes:{type:'array',items:{type:'string'}},quota:{type:'object',additionalProperties:false,required:['requests','window'],properties:{requests:{type:'integer',minimum:1,maximum:1000000},window:{type:'integer',minimum:1,maximum:2592000}}}}}}};
test('the auth extension policy schema judges the auth short form and errors name the auth key',async t=>{
  const auth={version:'1',config:{label:'hello'}};
  const refuse=async(route:Record<string,unknown>,path:string,message:RegExp,pointer:string)=>{
    const root=await project(t,{'/auth/*':{extension:'auth'},[path]:{respond:{text:'x'},...route}},{},{extensions:{auth}});
    const extension={...await registration(root),name:'auth',providesPrincipal:true,policySchema:authPolicySchema};
    for(const attempt of [()=>createRuntime(root,{origin,extensions:[extension]}),()=>validateProject(root,{origin,extensions:[extension]})])
      await assert.rejects(attempt,(error:Error&{details?:{pointer?:string;route?:string}})=>{assert.match(error.message,message);assert.equal(error.details?.pointer,pointer);assert.equal(error.details?.route,path);return true;});
  };
  // An unknown key under `auth:` is refused by the extension's schema, at the key the author wrote (#702, #710).
  await refuse({auth:{roles:['member']}},'/a',/^Invalid extension policy at route \/a, auth \(additionalProperties\): unknown key "roles"; did you mean "role"\? \(run urlcode extensions --json for its policy schema\)$/,'/routes/~1a/auth');
  await refuse({auth:{bearer:{scopes:['items:read'],quota:{requests:0,window:60}}}},'/api/items',/^Invalid extension policy at route \/api\/items, auth\.bearer\.quota\.requests \(minimum\): must be >= 1$/,'/routes/~1api~1items/auth/bearer/quota/requests');
  await refuse({auth:{freshWithinSeconds:0}},'/a',/^Invalid extension policy at route \/a, auth\.freshWithinSeconds \(minimum\): must be >= 1$/,'/routes/~1a/auth/freshWithinSeconds');
  // `required: false` emits no policy, but the keys written beside it are still the extension's to judge.
  await refuse({auth:{required:false,rol:'member'}},'/a',/^Invalid extension policy at route \/a, auth \(additionalProperties\): unknown key "rol"; did you mean "role"\?/,'/routes/~1a/auth');
  // The canonical long form is still located under policies.extensions.
  await refuse({policies:{extensions:{auth:{freshWithinSeconds:0}}}},'/a',/^Invalid extension policy at route \/a, policies\.extensions\.auth\.freshWithinSeconds \(minimum\): must be >= 1$/,'/routes/~1a/policies/extensions/auth/freshWithinSeconds');
  // Without a host file, validateProject judges the requirement against the installed package's static descriptor.
  const site=await mkdtemp(join(tmpdir(),'urlcode-auth-site-'));t.after(()=>rm(site,{recursive:true,force:true}));
  const app=join(site,'app'),descriptor=join(site,'node_modules','@jimhoyd','urlcode-auth');
  await mkdir(app);await mkdir(descriptor,{recursive:true});
  await writeFile(join(descriptor,'urlcode.json'),await readFile(new URL('../packages/auth/urlcode.json',import.meta.url),'utf8'));
  const write=(value:unknown)=>writeFile(join(app,'urlcode.yaml'),JSON.stringify({version:'1',extensions:{auth:{version:'1',config:{}}},routes:{'/api/auth/*':{extension:'auth'},'/api/items':{respond:{text:'x'},auth:value}}}));
  // The Better Auth extension's policy is closed and empty: `auth: true` is the whole vocabulary.
  await write(true);assert.equal((await validateProject(app)).valid,true);
  await write({role:'admin'});
  await assert.rejects(validateProject(app),/Invalid extension policy at route \/api\/items, auth \(additionalProperties\): unknown key "role"/);
});
test('core types and schema carry no auth policy vocabulary',async()=>{
  const schema=JSON.parse(await readFile(new URL('../schemas/urlcode.schema.json',import.meta.url),'utf8')) as {$defs:{routeAuth:{properties:Record<string,unknown>}}};
  assert.deepEqual(Object.keys(schema.$defs.routeAuth.properties),['required']);
  const text=JSON.stringify(schema.$defs.routeAuth),types=await readFile(new URL('../packages/core/src/types.ts',import.meta.url),'utf8');
  const declaration=types.split('\n').find(line=>line.startsWith('type RouteAuthConfig'));assert.ok(declaration);
  for(const key of ['role','permission','verified','freshWithinSeconds','onDeny','bearer','scopes','quota']){assert.doesNotMatch(text,new RegExp(`"${key}"`));assert.ok(!declaration.includes(key),key);}
});
test('runtime protects a short-form auth route with the demo registry',async t=>{
  const root=await project(t,{'/auth/*':{extension:'auth',methods:['GET','HEAD','POST']},'/private':{respond:{text:'private'},auth:{role:'member'}},'/open':{respond:{text:'open'},auth:{required:false}}},{},{extensions:{auth:{version:'1',config:{label:'hello'}}}});
  const runtime=await createRuntime(root,{origin,extensions:[{...await registration(root),name:'auth',providesPrincipal:true}]});t.after(()=>runtime.close());
  assert.equal((await runtime.handle({target:'/private',method:'GET'})).status,401);
  assert.equal((await runtime.handle({target:'/private',method:'GET',headers:new Headers({cookie:'session=yes'})})).status,200);
  assert.equal((await runtime.handle({target:'/open',method:'GET'})).status,200);
});
/**
 * A site whose app/ declares one extension per entry of `providers`, each installed as an independent package
 * (`@example/urlcode-<name>`) whose urlcode.json declares providesPrincipal when its entry is true (#888).
 */
async function principalSite(t:{after(fn:()=>unknown):void},providers:Record<string,boolean>,routes:Record<string,unknown>):Promise<{site:string;app:string;write(routes:Record<string,unknown>):Promise<void>;describe(providers:Record<string,boolean>):Promise<void>}>{
  const site=await mkdtemp(join(tmpdir(),'urlcode-principal-site-'));t.after(()=>rm(site,{recursive:true,force:true}));
  const app=join(site,'app');await mkdir(app);
  const describe=async(current:Record<string,boolean>)=>{for(const [name,provides]of Object.entries(current)){
    const directory=join(site,'node_modules','@example',`urlcode-${name}`);await mkdir(directory,{recursive:true});
    await writeFile(join(directory,'urlcode.json'),JSON.stringify({kind:'extension',name,description:`${name} stand-in`,contract:2,requires:[],targets:['node','aws','vercel'],...(provides?{providesPrincipal:true}:{}),schema:{type:'object'}}));
  }};
  await describe(providers);
  await writeFile(join(site,'package.json'),JSON.stringify({private:true,dependencies:Object.fromEntries(Object.keys(providers).map(name=>[`@example/urlcode-${name}`,'1.0.0']))}));
  const write=(current:Record<string,unknown>)=>writeFile(join(app,'urlcode.yaml'),JSON.stringify({version:'1',extensions:Object.fromEntries(Object.keys(providers).map(name=>[name,{version:'1',config:{label:'hello'}}])),routes:current}));
  await write(routes);
  return {site,app,write,describe};
}
test('the auth short form follows providesPrincipal, not the name auth: an independent provider named authjs (#888)',async t=>{
  const routes={'/signin/*':{extension:'authjs',methods:['GET','HEAD','POST']},'/private':{respond:{text:'private'},auth:true},'/open':{respond:{text:'open'},auth:{required:false}}};
  const {app,write}=await principalSite(t,{authjs:true},routes);
  const short=await loadDocument(app);
  assert.deepEqual({...effectiveExtensionPolicies(short.document,short.routes['/private']!)},{authjs:{}});
  assert.deepEqual({...effectiveExtensionPolicies(short.document,short.routes['/open']!)},{});
  assert.deepEqual(short.routeAuth,{'/private':{extension:'authjs',required:true,requirement:{}},'/open':{extension:'authjs',required:false,requirement:{}}});
  // Static validation reads the same descriptor; no host file is loaded.
  assert.equal((await validateProject(app)).valid,true);
  // The expansion target is in the reviewed revision: the short form and the long form it names are one revision.
  const shortRevision=await inspectExtensionRevision(app);
  await write({...routes,'/private':{respond:{text:'private'},policies:{extensions:{authjs:{}}}},'/open':{respond:{text:'open'}}});
  const long=await loadDocument(app);
  assert.deepEqual(long.routes,short.routes);assert.equal(long.version,short.version);assert.equal(await inspectExtensionRevision(app),shortRevision);
  await write(routes);
  const provider=await registration(app,{name:'authjs',providesPrincipal:true,policySchema:{type:'object',additionalProperties:false}});
  const runtime=await createRuntime(app,{origin,extensions:[provider]});t.after(()=>runtime.close());
  assert.equal((await runtime.handle({target:'/private',method:'GET'})).status,401);
  assert.equal((await runtime.handle({target:'/private',method:'GET',headers:new Headers({cookie:'session=yes'})})).status,200);
  assert.equal((await runtime.handle({target:'/open',method:'GET'})).status,200);
  // A registration that does not provide a principal cannot be the target the descriptor named.
  const {providesPrincipal:_provides,...plain}=provider;
  await assert.rejects(createRuntime(app,{origin,extensions:[plain]}),/The auth: short form expanded to authjs from static descriptors, but the declared registrations providing a principal are none/);
});
test('the auth short form refuses no principal provider and more than one, and the explicit form still works (#888)',async t=>{
  const none=await principalSite(t,{demo:false},{'/private':{respond:{text:'private'},auth:true}});
  await assert.rejects(loadDocument(none.app),/Route \/private declares auth, but no declared extension provides a principal; declare one under extensions \(its urlcode\.json declares providesPrincipal\), or name the extension with policies\.extensions\.<name>/);
  const two=await principalSite(t,{authjs:true,passkeys:true},{'/private':{respond:{text:'private'},auth:true}});
  await assert.rejects(loadDocument(two.app),/Route \/private declares auth, but authjs and passkeys each provide a principal; name one with policies\.extensions\.<name> instead of auth/);
  await two.write({'/private':{respond:{text:'private'},policies:{extensions:{passkeys:{}}}}});
  const explicit=await loadDocument(two.app);
  assert.deepEqual({...effectiveExtensionPolicies(explicit.document,explicit.routes['/private']!)},{passkeys:{}});
});
test('a package change that moves the auth short form target changes the reviewed revision (#888)',async t=>{
  const {app,describe}=await principalSite(t,{authjs:true,passkeys:false},{'/private':{respond:{text:'private'},auth:true}});
  const before=await loadDocument(app),revision=await inspectExtensionRevision(app);
  await describe({authjs:false,passkeys:true});
  const after=await loadDocument(app);
  assert.deepEqual(Object.keys(effectiveExtensionPolicies(after.document,after.routes['/private']!)),['passkeys']);
  // Every registration and binding grant pinned to the old revision now refuses it until the operator re-reviews.
  assert.notEqual(after.version,before.version);assert.notEqual(await inspectExtensionRevision(app),revision);
});
test('activation failure closes already activated providers',async t=>{
  const root=await project(t,{'/demo/*':mount},{},{extensions:{...declarations,other:{version:'1',config:{label:'other'}}}});
  let closed=0;const first=await registration(root,{activate(){return{handle:()=>({status:200,headers:[]}),close(){closed++;}};}});
  const second={...first,name:'other',activate(){throw new Error('activation failed');}};
  await assert.rejects(createRuntime(root,{origin,extensions:[first,second]}),/activation failed/);assert.equal(closed,1);
});

test('activation errors name the extension, keep the message bounded and stay out of request-time answers (#714)',async t=>{
  const root=await project(t,{'/demo/*':mount},{},{extensions:declarations});
  const failing=await registration(root,{activate(){throw new Error('tool lookup inputSchema: maxLength must be an integer from 0 to 8192');}});
  await assert.rejects(createRuntime(root,{origin,extensions:[failing]}),(error:unknown)=>{
    assert.ok(error instanceof ConfigError);
    assert.equal(error.message,'Extension "demo" failed to activate: tool lookup inputSchema: maxLength must be an integer from 0 to 8192');
    assert.deepEqual(error.details,{code:'extension-activation',extension:'demo'});
    assert.ok(!error.message.includes('    at '));return true;});
  const noisy=await registration(root,{activate(){throw new Error(`first\nsecond\u0007 ${'x'.repeat(2000)}`);}});
  await assert.rejects(createRuntime(root,{origin,extensions:[noisy]}),(error:unknown)=>{
    assert.ok(error instanceof ConfigError);assert.match(error.message,/^Extension "demo" failed to activate: first second x+\.\.\.$/);assert.ok(error.message.length<600);return true;});
  // A registration schema Ajv refuses is the operator's too, named before activation runs.
  const badSchema=await registration(root,{schema:{type:'object',notAKeyword:true},activate(){throw new Error('must not run');}});
  await assert.rejects(createRuntime(root,{origin,extensions:[badSchema]}),/^Error: Extension "demo" registration could not be prepared: strict mode: unknown keyword: "notAKeyword"/);
  // The hosted adapters answer a request with fixed text; the reason goes to the operator's function log only.
  const logged:unknown[]=[];const consoleError=console.error;console.error=(...args:unknown[])=>{logged.push(...args);};t.after(()=>{console.error=consoleError;});
  const handler=createLambdaHandler({project:root,origin,extensions:[failing],environment:{}});
  const result=await handler({version:'2.0',rawPath:'/demo',rawQueryString:'',headers:{},requestContext:{http:{method:'GET'}}});
  console.error=consoleError;
  assert.equal(result.statusCode,500);const body=Buffer.from(result.body,'base64').toString();assert.equal(body,'Internal server error\n');assert.ok(!body.includes('maxLength'));
  assert.ok(logged.some(entry=>entry instanceof ConfigError&&entry.details.extension==='demo'));
});
test('validate, test and dev print an extension activation error with its name (#714)',async t=>{
  const root=await project(t,{'/demo/*':mount},{'tests/demo.test.yaml':'version: "1"\ncases:\n  - {request: {path: /demo}, expect: {status: 200}}\n'},{extensions:declarations});
  const dir=await mkdtemp(join(tmpdir(),'urlcode-host-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const {activate:_activate,...data}=await registration(root);
  const failing=join(dir,'failing.mjs'),broken=join(dir,'broken.mjs');
  // Composed, as a hermetic test run requires (#976): composeHost confirms the data directory it gave host().
  await writeFile(failing,`import {composeHost} from ${JSON.stringify(new URL('../packages/core/src/host.ts',import.meta.url).href)};
const data=${JSON.stringify(data)};
const demo={definition:{name:'demo',contract:2,targets:data.targets,schema:data.schema,host(context){return {registration:{...data,projectSha256:context.projectSha256,activate(){throw new Error('MCP server hosted: tool urlcode_yaml_validate inputSchema: maxLength must be an integer from 0 to 8192');}}};}},options:{}};
export default await composeHost(import.meta.url,[demo]);
`);
  // Loading the host module itself is not extension activation: it reports as the host file's own failure (#724).
  await writeFile(broken,`throw new Error('internal detail /secret/path');\n`);
  const cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));
  const env={...process.env,PROJECT_SHA256:data.projectSha256};
  const run=(command:string,...args:string[])=>spawnSync(process.execPath,[cli,command,'--project',root,'--origin',origin,...args],{encoding:'utf8',timeout:20000,env});
  const lastError=(stderr:string)=>JSON.parse(stderr.trim().split('\n').at(-1)!) as {event:string;message:string;code?:string;extension?:string};
  for(const command of ['validate','test'])await t.test(command,()=>{
    const out=run(command,'--host-file',failing);assert.equal(out.status,1,out.stderr);
    assert.deepEqual(lastError(out.stderr),{event:'error',message:'Extension "demo" failed to activate: MCP server hosted: tool urlcode_yaml_validate inputSchema: maxLength must be an integer from 0 to 8192',code:'extension-activation',extension:'demo'});
    assert.ok(!out.stderr.includes('    at '));
  });
  await t.test('dev',()=>{
    const out=run('dev','--port','0','--host-file',failing);assert.equal(out.status,1,out.stderr);
    assert.match(lastError(out.stderr).message,/^Extension "demo" failed to activate: MCP server hosted/);
  });
  await t.test('host file failure',()=>{
    const out=run('validate','--host-file',broken);assert.equal(out.status,1);
    assert.deepEqual(lastError(out.stderr),{event:'error',message:'Host file failed to load: internal detail /secret/path',code:'host-load'});
  });
  assert.equal(describeError(new Error('internal detail')),'Operation failed; check project files, module dependencies and command options');
});
test('validate, test and dev print a host file load failure and an extension host() failure; requests never see them (#724)',async t=>{
  const root=await project(t,{'/demo/*':mount},{'tests/demo.test.yaml':'version: "1"\ncases:\n  - {request: {path: /demo}, expect: {status: 200}}\n'},{extensions:declarations});
  const dir=await mkdtemp(join(tmpdir(),'urlcode-host-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const hostModule=new URL('../packages/core/src/host.ts',import.meta.url).href;
  const files={
    topLevel:[`throw new Error('host.mjs setup failed:\\n  line two');\n`],
    missing:[`import '@jimhoyd/urlcode-not-installed/extension';\nexport default {};\n`],
    hook:[`import {composeHost} from ${JSON.stringify(hostModule)};\nconst demo={definition:{name:'demo',contract:2,host(){throw new Error('CSRF key data/csrf.key must be 32 bytes\\n'+'x'.repeat(2000));}},options:{}};\nexport default await composeHost(import.meta.url,[demo]);\n`],
    refusal:[`import {composeHost} from ${JSON.stringify(hostModule)};\nconst demo={definition:{name:'demo',contract:2,host(){return {registration:{name:'other'}};}},options:{}};\nexport default await composeHost(import.meta.url,[demo]);\n`],
  };
  const paths=Object.fromEntries(await Promise.all(Object.entries(files).map(async([name,[text]])=>{const file=join(dir,`${name}.mjs`);await writeFile(file,text!);return [name,file] as const;})));
  const cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));
  const env={...process.env,PROJECT_SHA256:await inspectExtensionRevision(root)};
  const run=(command:string,host:string,...args:string[])=>spawnSync(process.execPath,[cli,command,'--project',root,'--origin',origin,'--host-file',host,...args],{encoding:'utf8',timeout:20000,env});
  const lastError=(stderr:string)=>JSON.parse(stderr.trim().split('\n').at(-1)!) as {event:string;message:string;code?:string;extension?:string};
  for(const command of ['validate','test','dev'])await t.test(command,()=>{
    const extra=command==='dev'?['--port','0']:[];
    const top=run(command,paths.topLevel!,...extra);assert.equal(top.status,1,top.stderr);
    assert.deepEqual(lastError(top.stderr),{event:'error',message:'Host file failed to load: host.mjs setup failed: line two',code:'host-load'});
    const hook=run(command,paths.hook!,...extra);assert.equal(hook.status,1,hook.stderr);
    const error=lastError(hook.stderr);
    assert.match(error.message,/^Extension "demo" host\(\) failed: CSRF key data\/csrf\.key must be 32 bytes x+\.\.\.$/);assert.ok(error.message.length<600);
    assert.deepEqual({...error,message:undefined},{event:'error',message:undefined,code:'extension-host',extension:'demo'});
    for(const out of [top,hook])assert.ok(!out.stderr.includes('    at '));
  });
  await t.test('module resolution names the missing specifier',()=>{
    const out=run('validate',paths.missing!);assert.equal(out.status,1);
    const error=lastError(out.stderr);assert.equal(error.code,'host-load');
    assert.match(error.message,/^Host file failed to load: Cannot find package '@jimhoyd\/urlcode-not-installed'/);
  });
  await t.test('core refusals inside composeHost keep their own message',()=>{
    const out=run('validate',paths.refusal!);assert.equal(out.status,1);
    assert.equal(lastError(out.stderr).message,'demo host() must return {registration} for extension demo');
  });
  // A second copy of core (the published package imported by host.mjs while the CLI runs from a checkout) is recognized by its brand only.
  const foreign=Object.assign(new Error('Set PROJECT_SHA256'),{details:{code:'x',extension:'demo',line:'1'},[Symbol.for('urlcode.ConfigError')]:true});
  const rebuilt=asConfigError(foreign);assert.ok(rebuilt instanceof ConfigError);assert.equal(rebuilt.message,'Set PROJECT_SHA256');assert.deepEqual(rebuilt.details,{code:'x',extension:'demo'});
  assert.equal(asConfigError(Object.assign(new Error('look-alike'),{details:{code:'x'}})),undefined);
});

test('a verified --policy pins the extension host; PROJECT_SHA256 must agree and a stale or missing policy still refuses (#723)',async t=>{
  const root=await project(t,{'/demo/*':mount},{'tests/requests.json':JSON.stringify([{path:'/demo/x',status:200}])},{extensions:declarations});
  const revision=await inspectExtensionRevision(root);
  const dir=await mkdtemp(join(tmpdir(),'urlcode-host-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const {activate:_activate,projectSha256:_pin,...data}=await registration(root);
  const host=join(dir,'host.mjs'),policy=join(dir,'policy.json'),stale=join(dir,'stale.json');
  // host() sees the revision, the site, its data directory and whether the run is hermetic: no policy grants, no policy path.
  await writeFile(host,`import {composeHost} from ${JSON.stringify(new URL('../packages/core/src/host.ts',import.meta.url).href)};
const data=${JSON.stringify(data)};
const demo={definition:{name:'demo',contract:2,targets:data.targets,schema:data.schema,host(context){
  if(Object.keys(context).sort().join()!=='data,get,hermetic,projectSha256,site')throw new Error('unexpected host context '+Object.keys(context));
  return {registration:{...data,projectSha256:context.projectSha256,activate(){return {handle(){return {status:200,headers:[['content-type','text/plain']],body:'pinned '+context.projectSha256};}};}}};
}},options:{}};
export default await composeHost(import.meta.url,[demo]);
`);
  await writeFile(policy,JSON.stringify({version:1,projectSha256:revision,routes:{}}));
  await writeFile(stale,JSON.stringify({version:1,projectSha256:'c'.repeat(64),routes:{}}));
  const cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));
  const {PROJECT_SHA256:_unset,...base}=process.env;
  const run=(command:string,env:Record<string,string>,...args:string[])=>spawnSync(process.execPath,[cli,command,'--project',root,'--origin',origin,'--host-file',host,...args],{encoding:'utf8',timeout:20000,env:{...base,...env}});
  const lastError=(stderr:string)=>JSON.parse(stderr.trim().split('\n').at(-1)!) as {event:string;message:string;code?:string};
  for(const command of ['validate','test'])await t.test(`${command} takes the pin from --policy`,()=>{
    const out=run(command,{},'--policy',policy);assert.equal(out.status,0,out.stderr);
    const agreeing=run(command,{PROJECT_SHA256:revision},'--policy',policy);assert.equal(agreeing.status,0,agreeing.stderr);
  });
  await t.test('a different PROJECT_SHA256 refuses',()=>{
    const out=run('validate',{PROJECT_SHA256:'b'.repeat(64)},'--policy',policy);assert.equal(out.status,1);
    assert.deepEqual(lastError(out.stderr),{event:'error',code:'revision-pin-mismatch',message:`PROJECT_SHA256 (${'b'.repeat(64)}) differs from the --policy revision (${revision}); with --policy the host is pinned to the policy's projectSha256, so unset PROJECT_SHA256 or set it to the same reviewed revision`});
  });
  await t.test('no policy and no PROJECT_SHA256 still refuses; PROJECT_SHA256 alone still works',()=>{
    const out=run('validate',{});assert.equal(out.status,1);
    const error=lastError(out.stderr) as {message:string;code?:string;command?:string};
    assert.match(error.message,/^The extension host needs the reviewed project revision: pass the reviewed operator policy with --policy/);
    // One complete command: the actual invocation plus a placeholder for the one missing value (#834).
    assert.equal(error.code,"revision-pin-required",out.stderr);
    assert.ok(error.command?.endsWith(` validate --project ${root} --origin ${origin} --host-file ${host} --policy <operator/policy.json>`),out.stderr);
    assert.ok(error.message.includes(`Run: ${error.command} where <operator/policy.json>`),error.message);
    // URLCODE_POLICY stands in for an absent --policy.
    const fromEnv=run('validate',{URLCODE_POLICY:policy});assert.equal(fromEnv.status,0,fromEnv.stderr);
    assert.equal(run('validate',{PROJECT_SHA256:revision}).status,0);
  });
  await t.test('a policy for another revision refuses',()=>{
    const out=run('validate',{},'--policy',stale);assert.equal(out.status,1);
    const error=lastError(out.stderr);assert.equal(error.code,'revision-pin-mismatch');
    assert.match(error.message,new RegExp(`^The extension host is pinned by --policy: the policy is pinned to project revision ${'c'.repeat(64)}, but the project is now revision ${revision}`));
  });
  await t.test('commands without --policy support do not derive a pin: extensions inspects unpinned (#910)',()=>{
    const out=spawnSync(process.execPath,[cli,'extensions','--project',root,'--host-file',host,'--policy',policy],{encoding:'utf8',timeout:20000,env:base});
    assert.equal(out.status,0,out.stderr);
    assert.match(out.stdout,/Registered: demo \(contract 1; targets [^)]*; declared; revision NOT pinned\)/);
    assert.match(out.stdout,/unpinned inspection\): serve, dev, validate and test refuse until the reviewed revision is pinned/);
  });
  // #910: reading registrations never needs the pin; activating or serving always does.
  for(const args of [['explain'],['explain','/demo/x'],['plan-feature','store records for signed-in users'],['context'],['review'],['openapi'],['report','--json']])await t.test(`${args.join(' ')} inspects the host without a pin`,()=>{
    const out=spawnSync(process.execPath,[cli,...args,'--project',root,'--origin',origin,'--host-file',host],{encoding:'utf8',timeout:20000,env:base});
    assert.equal(out.status,0,out.stderr);
  });
  await t.test('an unpinned inspection reports the registration as not matching the revision',()=>{
    const out=spawnSync(process.execPath,[cli,'explain','/demo/x','--project',root,'--host-file',host,'--json'],{encoding:'utf8',timeout:20000,env:base});
    assert.equal(out.status,0,out.stderr);
    assert.match(out.stdout,/"revisionMatch":false/);
  });
  for(const args of [['serve','--port','0'],['dev','--port','0'],['validate','--local'],['validate'],['test'],['routes'],['audit']])await t.test(`${args.join(' ')} still refuses without a pin, naming a command that prints it`,()=>{
    const out=spawnSync(process.execPath,[cli,...args,'--project',root,'--origin',origin,'--host-file',host],{encoding:'utf8',timeout:30000,env:base});
    assert.equal(out.status,1,out.stdout+out.stderr);
    const error=lastError(out.stderr);
    assert.equal(error.code,'revision-pin-required',out.stderr);
    assert.ok(error.message.includes('`urlcode permissions --project app` prints it as projectSha256'),error.message);
  });
  // The inspection commands take the reviewed policy too (#834).
  await t.test('explain derives the pin from a verified --policy',()=>{
    const out=spawnSync(process.execPath,[cli,'explain','--project',root,'--host-file',host,'--policy',policy],{encoding:'utf8',timeout:20000,env:base});
    assert.equal(out.status,0,out.stderr);
  });
  await t.test('the project YAML cannot supply the pin',async()=>{
    const pinned=await project(t,{'/demo/*':mount},{},{extensions:declarations,projectSha256:revision} as Parameters<typeof project>[3]);
    const out=spawnSync(process.execPath,[cli,'validate','--project',pinned,'--origin',origin,'--host-file',host],{encoding:'utf8',timeout:20000,env:base});
    // The host is composed before the YAML is read, and nothing in the project is consulted for the pin.
    assert.equal(out.status,1);assert.match(lastError(out.stderr).message,/^The extension host needs the reviewed project revision: pass the reviewed operator policy with --policy/);
  });
  // The slot is set only while the host file is imported.
  const {loadOperatorHost,operatorRevisionKey,inspectionHostKey,unpinnedInspectionRevision}=await import('../packages/core/src/operator-host.ts');
  const loaded=await loadOperatorHost(host,root,{revision});
  assert.equal(loaded.extensions?.[0]?.projectSha256,revision);assert.equal((globalThis as Record<symbol,unknown>)[operatorRevisionKey],undefined);
  await loaded.close?.();
  // An inspection load without a pin composes the unpinned revision, and no activation accepts it (#910).
  const {PROJECT_SHA256:saved}=process.env;delete process.env.PROJECT_SHA256;
  // A module is imported once per process, so each load below reads its own copy of the host file.
  const copy=async(name:string)=>{const file=join(dir,name);await writeFile(file,await readFile(host,'utf8'));return file;};
  try {
    const inspected=await loadOperatorHost(await copy('inspect.mjs'),root,{inspection:true});
    assert.equal(inspected.extensions?.[0]?.projectSha256,unpinnedInspectionRevision);assert.equal((globalThis as Record<symbol,unknown>)[inspectionHostKey],undefined);
    await assert.rejects(createRuntime(root,{extensions:inspected.extensions,origin}),(error:ConfigError)=>error.details.code==='revision-pin-required'&&/composed for read-only inspection without a revision pin and cannot activate/.test(error.message));
    await inspected.close?.();
    // With a pin an inspection load is pinned as before.
    const pinned=await loadOperatorHost(await copy('pinned.mjs'),root,{revision,inspection:true});
    assert.equal(pinned.extensions?.[0]?.projectSha256,revision);
    await pinned.close?.();
    // Without the inspection flag the host still refuses to compose.
    await assert.rejects(loadOperatorHost(await copy('serving.mjs'),root),/The extension host needs the reviewed project revision/);
  } finally {if(saved!==undefined)process.env.PROJECT_SHA256=saved;}
});

// #932: the generated validate, test, routes and audit scripts pass --local-review, so an edit needs no new pin; serving
// still does, an operator pin always wins, and a local review reads no policy, so it holds no grant.
test('--local-review pins a non-serving run to the current revision, never serves, never outranks an operator pin and grants nothing (#932)',async t=>{
  const root=await project(t,{'/demo/*':{...mount,methods:['GET','HEAD']}},{'tests/requests.json':JSON.stringify([{path:'/demo/x',status:200,expectBody:'pinned'}])},{extensions:declarations});
  const dir=await mkdtemp(join(tmpdir(),'urlcode-host-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const {activate:_activate,projectSha256:_pin,...data}=await registration(root);
  const host=join(dir,'host.mjs'),stale=join(dir,'stale.json');
  await writeFile(host,`import {composeHost} from ${JSON.stringify(new URL('../packages/core/src/host.ts',import.meta.url).href)};
const data=${JSON.stringify(data)};
const demo={definition:{name:'demo',contract:2,targets:data.targets,schema:data.schema,host(context){
  // Stands in for an extension whose serving data is not set up yet (auth's unmigrated tables, #954).
  if(process.env.DEMO_SITE_DATA_UNSET&&!context.hermetic)throw new Error('demo: the site data is not set up; run demo migrate');
  return {registration:{...data,projectSha256:context.projectSha256,activate(){return {handle(){return {status:200,headers:[['content-type','text/plain']],body:'pinned'};}};}}};
}},options:{}};
export default await composeHost(import.meta.url,[demo]);
`);
  await writeFile(stale,JSON.stringify({version:1,projectSha256:'c'.repeat(64),routes:{}}));
  const cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));
  const {PROJECT_SHA256:_unset,URLCODE_ORIGIN:_origin,URLCODE_POLICY:_policy,...base}=process.env;
  const run=(args:string[],env:Record<string,string>={})=>spawnSync(process.execPath,[cli,...args,'--project',root,'--host-file',host],{encoding:'utf8',timeout:30000,env:{...base,...env}});
  const lines=(stderr:string)=>stderr.trim().split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line) as {event:string;message?:string;code?:string;revision?:string;origin?:string});
  for(const args of [['validate','--local'],['test'],['routes'],['audit','--expect-routes','1']])await t.test(`${args[0]} --local-review needs no pin and no origin`,async()=>{
    const out=run([...args,'--local-review']);assert.equal(out.status,0,out.stdout+out.stderr);
    const notice=lines(out.stderr).find(line=>line.event==='local_review');
    assert.deepEqual({revision:notice?.revision,origin:notice?.origin},{revision:await inspectExtensionRevision(root),origin:'http://localhost'},out.stderr);
  });
  await t.test('an edit is reviewed at its new revision with no new pin',async()=>{
    const before=await inspectExtensionRevision(root);
    await writeFile(join(root,'urlcode.yaml'),(await readFile(join(root,'urlcode.yaml'),'utf8')).replace('label: hello','label: edited'));
    const after=await inspectExtensionRevision(root);assert.notEqual(after,before);
    const out=run(['validate','--local','--local-review']);assert.equal(out.status,0,out.stderr);
    assert.equal(lines(out.stderr).find(line=>line.event==='local_review')?.revision,after);
    // Without the flag nothing changed: the run still needs the reviewed pin.
    assert.equal(lines(run(['validate','--local']).stderr).at(-1)?.code,'revision-pin-required');
  });
  for(const [args,message] of [[['serve','--port','0'],/^serve does not take --local-review: serving always needs the reviewed revision pin/],[['dev','--port','0'],/^dev does not take --local-review: serving always needs the reviewed revision pin/],[['verify-deployment'],/^verify-deployment does not take --local-review; it is for the checks validate\/test\/routes\/audit and the pin-free read-only commands explain\/.*openapi$/]] as const)await t.test(`${args[0]} refuses --local-review, naming itself`,()=>{
    const out=run([...args,'--local-review']);assert.equal(out.status,1,out.stdout+out.stderr);
    const error=lines(out.stderr).at(-1)!;
    assert.equal(error.code,'local-review-unsupported',out.stderr);
    assert.match(error.message!,message);
    assert.equal(lines(out.stderr).some(line=>line.event==='local_review'),false);
  });
  // #958: a read-only command that needs no pin takes the flag the check scripts pass, and ignores it.
  for(const args of [['openapi','--check'],['explain','/demo/x'],['review']])await t.test(`${args[0]} needs no pin and ignores --local-review`,()=>{
    const out=run([...args,'--local-review']);assert.equal(out.status,0,out.stdout+out.stderr);
    assert.equal(lines(out.stderr).some(line=>line.event==='local_review'),false);
  });
  // #954: a local review activates on throwaway data, as test and audit do; the reviewed pin checks the data serve uses.
  await t.test('a local review never needs the site data set up; the pinned validate still checks it',async()=>{
    for(const args of [['validate','--local'],['routes']]){
      const out=run([...args,'--local-review'],{DEMO_SITE_DATA_UNSET:'1'});assert.equal(out.status,0,out.stdout+out.stderr);
    }
    const pinned=run(['validate','--local','--origin',origin],{DEMO_SITE_DATA_UNSET:'1',PROJECT_SHA256:await inspectExtensionRevision(root)});
    assert.equal(pinned.status,1);assert.match(lines(pinned.stderr).at(-1)!.message!,/the site data is not set up; run demo migrate/,pinned.stderr);
    const flagged=run(['validate','--local','--local-review','--origin',origin],{DEMO_SITE_DATA_UNSET:'1',PROJECT_SHA256:await inspectExtensionRevision(root)});
    assert.equal(flagged.status,1,'with an operator pin the flag changes nothing');
  });
  await t.test('an operator pin wins: a stale --policy or PROJECT_SHA256 still refuses',()=>{
    const policy=run(['validate','--local','--local-review','--origin',origin],{URLCODE_POLICY:stale});assert.equal(policy.status,1);
    assert.equal(lines(policy.stderr).at(-1)?.code,'revision-pin-mismatch',policy.stderr);
    const pinned=run(['validate','--local','--local-review','--origin',origin],{PROJECT_SHA256:'b'.repeat(64)});assert.equal(pinned.status,1);
    assert.match(lines(pinned.stderr).at(-1)!.message!,/Extension revision pin mismatch: demo/,pinned.stderr);
    for(const out of [policy,pinned])assert.equal(lines(out.stderr).some(line=>line.event==='local_review'),false);
  });
  // #940: the authoring MCP runners pass --local-review too, so an agent's edit is checked without a new pin; the same
  // CLI rule decides, so a pin the operator gave the server still wins. #964: the in-process run_tests follows it too.
  await t.test('the MCP runners and run_tests review an edit locally and an operator pin still wins (#940, #964)',async()=>{
    type InProcess={total:number;failed:number;localReview?:{revision:string;origin:string};events:{event:string;revision?:string;origin?:string}[]};
    const mcp=(env:Record<string,string>={},args:string[]=[])=>{
      const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},
        ...['run_validate','run_test','run_audit','run_tests'].map((name,index)=>({jsonrpc:'2.0',id:index+2,method:'tools/call',params:{name,arguments:{}}}))];
      const out=spawnSync(process.execPath,[cli,'mcp','--allow-authoring','--project',root,'--host-file',host,...args],{encoding:'utf8',timeout:120000,input:messages.map(message=>JSON.stringify(message)).join('\n')+'\n',env:{...base,...env}});
      const replies=out.stdout.trim().split('\n').map(line=>JSON.parse(line) as {id?:number;result?:{isError?:boolean;content:{text:string}[]}});
      const reply=(id:number)=>{const found=replies.find(message=>message.id===id);assert.ok(found?.result,out.stdout+out.stderr);return found.result;};
      return {runners:[2,3,4].map(id=>JSON.parse(reply(id).content[0]!.text) as {command:string;exitCode:number;stdout:string;stderr:string}),inProcess:reply(5)};
    };
    await writeFile(join(root,'urlcode.yaml'),(await readFile(join(root,'urlcode.yaml'),'utf8')).replace(/label: \w+/,'label: agent'));
    const revision=await inspectExtensionRevision(root);
    const reviewed=mcp();
    for(const result of reviewed.runners){
      assert.equal(result.exitCode,0,result.command+result.stdout+result.stderr);
      const notice=lines(result.stderr).find(line=>line.event==='local_review');
      assert.deepEqual({revision:notice?.revision,origin:notice?.origin},{revision,origin:'http://localhost'},result.stderr);
    }
    assert.equal(reviewed.inProcess.isError,undefined,reviewed.inProcess.content[0]!.text);
    const tests=JSON.parse(reviewed.inProcess.content[0]!.text) as InProcess;
    assert.deepEqual({total:tests.total,failed:tests.failed,localReview:tests.localReview},{total:1,failed:0,localReview:{revision,origin:'http://localhost'}});
    const notice=tests.events.find(event=>event.event==='local_review');
    assert.deepEqual({revision:notice?.revision,origin:notice?.origin},{revision,origin:'http://localhost'});
    const pinned=mcp({PROJECT_SHA256:'b'.repeat(64),URLCODE_ORIGIN:origin});
    for(const result of pinned.runners){
      assert.notEqual(result.exitCode,0,result.command+result.stdout);
      assert.match(result.stderr,/Extension revision pin mismatch: demo/,result.command);
      assert.equal(lines(result.stderr).some(line=>line.event==='local_review'),false,result.stderr);
    }
    assert.equal(pinned.inProcess.isError,true);assert.match(pinned.inProcess.content[0]!.text,/Extension revision pin mismatch: demo/);
    // A stale --policy given to the server wins the same way: run_tests refuses and reports no local review.
    const policy=mcp({URLCODE_ORIGIN:origin},['--policy',stale]);
    assert.equal(policy.inProcess.isError,true);assert.match(policy.inProcess.content[0]!.text,/Extension revision pin mismatch: demo/);
  });
  await t.test('a local review holds no grant: egress a policy has not approved is still denied',async()=>{
    const upstream=await project(t,{'/demo/*':mount,'/up':{proxy:{url:'https://upstream.example.test/'}}},{},{extensions:declarations});
    const out=spawnSync(process.execPath,[cli,'validate','--local','--local-review','--project',upstream,'--host-file',host],{encoding:'utf8',timeout:30000,env:base});
    assert.equal(out.status,1);assert.match(lines(out.stderr).at(-1)!.message!,/^Egress denied by revision-pinned operator policy/,out.stderr);
    // The reviewed policy that grants it is used as given, with its own pin.
    const granted=join(dir,'granted.json');
    await writeFile(granted,JSON.stringify({version:1,projectSha256:await inspectExtensionRevision(upstream),routes:{'/up':{env:[],secrets:[],egress:{proxy:['https://upstream.example.test']}}}}));
    const reviewed=spawnSync(process.execPath,[cli,'validate','--local','--local-review','--project',upstream,'--host-file',host,'--origin',origin,'--policy',granted],{encoding:'utf8',timeout:30000,env:base});
    assert.equal(reviewed.status,0,reviewed.stderr);assert.equal(lines(reviewed.stderr).some(line=>line.event==='local_review'),false);
  });
});

/** A demo registry written as a host file outside the project, matching the in-process registration above. */
async function hostFile(t:import('node:test').TestContext,root:string):Promise<string>{
  const dir=await mkdtemp(join(tmpdir(),'urlcode-host-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const {activate:_activate,...data}=await registration(root);const file=join(dir,'host.mjs');
  await writeFile(file,`export default {extensions:[{...${JSON.stringify(data)},activate(){throw new Error('inspection must not activate');}}],close(){globalThis.__demoHostClosed=(globalThis.__demoHostClosed??0)+1;}};`);
  return file;
}
test('extension schema discovery reports registrations, declarations and mounts without activation',async t=>{
  const root=fileURLToPath(new URL('../examples/extensions/',import.meta.url)),file=await hostFile(t,root);
  const report=await inspectExtensions({project:root,hostFile:file});
  assert.equal(report.hostLoaded,true);assert.equal(report.projectSha256,await inspectExtensionRevision(root));assert.equal((globalThis as {__demoHostClosed?:number}).__demoHostClosed,1);
  assert.equal(report.extensions.length,1);const [demo]=report.extensions;
  assert.equal(demo!.name,'demo');assert.equal(demo!.version,'1');assert.deepEqual(demo!.targets,['node','aws','vercel']);assert.equal(demo!.declared,true);assert.equal(demo!.revisionPinned,true);
  assert.deepEqual(demo!.mounts,['/demo']);assert.deepEqual(demo!.policyRoutes,['/private']);
  assert.deepEqual(demo!.hooks,[{name:'transform',kind:'filter',description:'Transforms a demo value.',inputSchema:{type:'object'},outputSchema:{type:'object'}}]);
  assert.deepEqual(demo!.authoring,{description:'Customize the installed extension before replacing its behavior.',surfaces:[{kind:'configuration',name:'label',description:'Set the label.',path:'extensions.demo.config.label'}],fastChecks:['urlcode validate --local']});
  assert.deepEqual(demo!.schema,{type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false});assert.equal((demo!.policySchema as {required:string[]}).required[0],'role');
  assert.deepEqual(report.declared,[{name:'demo',version:'1',registered:true,mounts:['/demo'],policyRoutes:['/private']},{name:'auth',version:'1',registered:false,mounts:[],policyRoutes:['/account']}]);
  const bare=await inspectExtensions({project:root});assert.equal(bare.hostLoaded,false);assert.deepEqual(bare.extensions,[]);assert.equal(bare.declared[0]?.registered,false);assert.match(bare.note,/--host-file/);
  await assert.rejects(inspectExtensions({project:root,hostFile:join(root,'urlcode.yaml')}),/outside|absolute|\.mjs/);
  const stale=await describeExtensions(root,[{...(await registration(root)),name:'other',projectSha256:'0'.repeat(64)}]);
  assert.equal(stale.extensions[0]?.declared,false);assert.equal(stale.extensions[0]?.revisionPinned,false);assert.equal(stale.declared[0]?.registered,false);
});
test('urlcode extensions prints schemas only with an explicit host file',async t=>{
  const root=fileURLToPath(new URL('../examples/extensions/',import.meta.url)),file=await hostFile(t,root),cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));
  const run=(...args:string[])=>spawnSync(process.execPath,[cli,'extensions','--project',root,...args],{encoding:'utf8',timeout:20000});
  const plain=run();assert.equal(plain.status,0);assert.match(plain.stdout,/Declared: demo .*schemas need --host-file/);assert.match(plain.stdout,/Declared: auth .*schemas need --host-file/);assert.ok(!plain.stdout.includes('configuration schema'));
  const json=run('--json');assert.equal(json.status,0);assert.equal(JSON.parse(json.stdout).hostLoaded,false);
  const withHost=run('--host-file',file);assert.equal(withHost.status,0);assert.match(withHost.stdout,/Declared: auth .*NOT registered by the host file/);assert.match(withHost.stdout,/Registered: demo \(contract 1; targets node, aws, vercel; declared; revision pinned\)/);assert.match(withHost.stdout,/configuration schema: \{"type":"object"/);assert.match(withHost.stdout,/policy schema: \{/);
  assert.match(withHost.stdout,/hooks: transform \(filter\)/);
  assert.match(withHost.stdout,/authoring: \{"description":"Customize the installed extension/);
  const report=JSON.parse(run('--host-file',file,'--json').stdout) as {extensions:{name:string;mounts:string[]}[]};assert.equal(report.extensions[0]?.name,'demo');assert.deepEqual(report.extensions[0]?.mounts,['/demo']);
  assert.equal(run('--host-file',join(root,'urlcode.yaml')).status,1);
  assert.ok(run('--help').stdout.includes('urlcode extensions'));
});
test('MCP exposes get_extensions only when the operator started it with a host file',async t=>{
  const root=fileURLToPath(new URL('../examples/extensions/',import.meta.url)),file=await hostFile(t,root);
  const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_extensions',arguments:{}}},{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'get_extensions',arguments:{hostFile:file}}}];
  const session=async(hostFile?:string)=>{let text='';await serveMcp({project:root,...(hostFile===undefined?{}:{hostFile}),input:Readable.from([messages.map(value=>JSON.stringify(value)+'\n').join('')]),output:new Writable({write(chunk,_encoding,done){text+=String(chunk);done();}})});return text.trim().split('\n').map(line=>JSON.parse(line) as {error?:{code:number};result:{tools:{name:string}[];content:{text:string}[]}}).sort(byReplyId);};
  const absent=await session();assert.ok(!absent[1]!.result.tools.some(tool=>tool.name==='get_extensions'));assert.equal(absent[2]!.error?.code,-32602);assert.equal(absent[3]!.error?.code,-32602);
  const present=await session(file);assert.ok(present[1]!.result.tools.some(tool=>tool.name==='get_extensions'));
  const report=JSON.parse(present[2]!.result.content[0]!.text) as {extensions:{name:string;schema:object}[]};assert.equal(report.extensions[0]?.name,'demo');assert.ok('properties' in report.extensions[0]!.schema);
  assert.equal(present[3]!.error?.code,-32602);
});
test('an extension mount answer is always no-store, whatever cache headers it sets',async t=>{
  const root=await project(t,{'/demo/*':mount},{},{extensions:declarations});
  const hashed=await registration(root,{activate(){return{handle(){return{status:200,headers:[['content-type','text/css'],['etag','"abc123"'],['cache-control','public, max-age=31536000, immutable'],['cdn-cache-control','public, max-age=100']],body:'css'};},authorize(){return undefined;}};}});
  const app=await startServer({project:root,origin,port:0,extensions:[hashed],log:()=>{}});t.after(()=>app.close());
  const asset=await request(app,'/demo/static/app.abc123.css');
  assert.equal(asset.status,200);assert.equal(asset.headers['cache-control'],'no-store');assert.equal(asset.headers['cdn-cache-control'],undefined);assert.equal(asset.headers.etag,'"abc123"');
  const cached=await project(t,{'/demo/*':{...mount,policies:{cache:{strategy:'immutable'}}}},{},{extensions:declarations});
  await assert.rejects(createRuntime(cached,{origin,extensions:[await registration(cached)]}),{message:'/demo/*: routes served by extension "demo" cannot be cached; use cache: {strategy: no-store} or remove cache'});
});
test('ExtensionActivation.root is the resolved project directory, independent of process.cwd()',async t=>{
  const root=await project(t,{'/demo/*':mount},{},{extensions:declarations});
  const resolvedRoot=await realpath(root);
  const previousCwd=process.cwd();
  // A server started from an unrelated directory, or a project loaded
  // programmatically, must not change what an extension resolves
  // project-relative paths against.
  process.chdir(tmpdir());
  t.after(()=>process.chdir(previousCwd));
  let observedRoot:string|undefined;
  const extension=await registration(root,{activate(config,context){observedRoot=context.root;return {handle:()=>({status:200,headers:[]})};}});
  const runtime=await createRuntime(root,{origin,extensions:[extension]});t.after(()=>runtime.close());
  assert.equal(observedRoot,resolvedRoot);
  assert.notEqual(observedRoot,previousCwd);
});
test('extensions activate in registration order, whatever order the YAML declares them in, and close in reverse',async t=>{
  // The YAML declares b before a; the host registered a first because b requires it.
  const root=await project(t,{},{},{extensions:{b:{version:'1',config:{label:'b'}},a:{version:'1',config:{label:'a'}}}});
  const events:string[]=[];const exports={active:false};
  const base=await registration(root);
  const a:RuntimeExtension={...base,name:'a',activate(){events.push('activate a');exports.active=true;return{handle:()=>({status:404,headers:[]}),close(){events.push('close a');}};}};
  const b:RuntimeExtension={...base,name:'b',activate(){events.push(`activate b (a active: ${exports.active})`);return{handle:()=>({status:404,headers:[]}),close(){events.push('close b');}};}};
  // An undeclared registration is skipped, not activated.
  const spare:RuntimeExtension={...base,name:'spare',activate(){throw new Error('must not run');}};
  const runtime=await createRuntime(root,{origin,extensions:[a,spare,b]});
  await runtime.close();
  assert.deepEqual(events,['activate a','activate b (a active: true)','close b','close a']);
});
