import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,mkdtemp,mkdir,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {project,request} from './helpers.ts';
import {loadDocument} from '../packages/core/src/config.ts';
import {createRuntime} from '../packages/core/src/runtime.ts';
import {startServer} from '../packages/core/src/server.ts';
import {createLambdaHandler} from '../packages/core/src/aws.ts';
import {buildCloudflare} from '../packages/core/src/build-cloudflare.ts';
import {inspectExtensionRevision,effectiveExtensionPolicies} from '../packages/core/src/extensions.ts';
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
test('authorization inherits per extension, rejects cache sharing and precedes trusted plugin answers',async t=>{
  const root=await project(t,{'/demo/*':mount,'/private':{respond:{text:'private'},policies:{profile:'member'}}},{},{extensions:declarations,profiles:{member:{extensions:{demo:{role:'member'}}}}});
  const app=await startServer({project:root,origin,port:0,extensions:[await registration(root)],plugins:[{name:'early',version:'1',targets:['node'],onRequest:()=>({status:200,headers:[['cdn-cache-control','public']],body:'early'})}],log:()=>{}});t.after(()=>app.close());
  assert.equal((await request(app,'/private')).status,401);
  const admitted=await request(app,'/private',{headers:{cookie:'session=yes'}});assert.equal(admitted.status,200);assert.equal(admitted.headers['cache-control'],'no-store');assert.equal(admitted.headers['cdn-cache-control'],undefined);
  assert.ok(app.testPlan().inventory.find(item=>item.path==='/private')?.policies.includes('extensions.demo'));assert.ok(!app.testPlan().cases.some(item=>item.path==='/private'));
  const cached=await project(t,{'/demo/*':mount,'/private':{respond:{text:'private'},policies:{extensions:{demo:{role:'member'}},cache:{strategy:'micro'}}}},{},{extensions:declarations});
  await assert.rejects(createRuntime(cached,{origin,extensions:[await registration(cached)]}),/no-store/);
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
  await assert.rejects(createRuntime(sensitive,{origin,extensions:[await passThroughExtension(sensitive,'mw')]}),/no-store/);
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
  const runtime=await createRuntime(root,{origin,extensions:[demo,{...demo,name:'auth',schema:{type:'object',additionalProperties:false}}]});t.after(()=>runtime.close());
  assert.equal((await runtime.handle({target:'/demo',method:'GET'})).status,200);
  assert.equal((await runtime.handle({target:'/private',method:'GET'})).status,401);
  assert.equal((await runtime.handle({target:'/account',method:'GET'})).status,401);
  assert.equal((await runtime.handle({target:'/account',method:'GET',headers:new Headers({cookie:'session=yes'})})).status,200);
});
test('route auth short form expands to the canonical policies.extensions.auth requirement',async t=>{
  const auth={version:'1',config:{}};
  const short=await loadDocument(await project(t,{'/a':{respond:{text:'a'},auth:{role:'member',onDeny:403}},'/b':{respond:{text:'b'},auth:true},'/c':{respond:{text:'c'},auth:{required:false,role:'member'}},'/d':{respond:{text:'d'},auth:{role:'member'},policies:{extensions:{other:{x:1}},cache:false}}},{},{extensions:{auth}}));
  const long=await loadDocument(await project(t,{'/a':{respond:{text:'a'},policies:{extensions:{auth:{role:'member',onDeny:403}}}},'/b':{respond:{text:'b'},policies:{extensions:{auth:{}}}},'/c':{respond:{text:'c'}},'/d':{respond:{text:'d'},policies:{extensions:{other:{x:1},auth:{role:'member'}},cache:false}}},{},{extensions:{auth}}));
  assert.deepEqual(short.routes,long.routes);assert.deepEqual(short.document.routes,long.document.routes);assert.equal(short.version,long.version);
  for(const path of ['/a','/b','/c','/d'])assert.equal('auth' in short.routes[path]!,false);
  assert.deepEqual({...effectiveExtensionPolicies(short.document,short.routes['/a']!)},{auth:{role:'member',onDeny:403}});
  assert.deepEqual({...effectiveExtensionPolicies(short.document,short.routes['/c']!)},{});
  await assert.rejects(loadDocument(await project(t,{'/a':{respond:{text:'a'},auth:true}})),/Route \/a declares auth but the project declares no extensions\.auth/);
  await assert.rejects(loadDocument(await project(t,{'/a':{respond:{text:'a'},auth:true,policies:{extensions:{auth:{role:'member'}}}}},{},{extensions:{auth}})),/Route \/a declares both auth and policies\.extensions\.auth/);
  await assert.rejects(loadDocument(await project(t,{'/a':{respond:{text:'a'},auth:true,policies:{extensions:false}}},{},{extensions:{auth}})),/Route \/a declares auth alongside policies\.extensions: false/);
  // Core owns only the mapping: the object's keys belong to the auth extension, so loading admits any object and
  // refuses only a value that is neither `true` nor an object, or a non-boolean `required` (#710).
  const loose=await loadDocument(await project(t,{'/a':{respond:{text:'a'},auth:{roles:['member']}}},{},{extensions:{auth}}));
  assert.deepEqual(loose.routeAuth,{'/a':{required:true,requirement:{roles:['member']}}});
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
    const extension={...await registration(root),name:'auth',policySchema:authPolicySchema};
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
  const write=(value:unknown)=>writeFile(join(app,'urlcode.yaml'),JSON.stringify({version:'1',extensions:{auth:{version:'1',config:{registration:'off'}}},routes:{'/account/*':{extension:'auth'},'/api/items':{respond:{text:'x'},auth:value}}}));
  await write({bearer:{scopes:['items.read'],quota:{requests:100,window:60}}});assert.equal((await validateProject(app)).valid,true);
  await write({bearer:{scopes:['items.read'],quota:{requests:100,window:60,burst:5}}});
  await assert.rejects(validateProject(app),/Invalid extension policy at route \/api\/items, auth\.bearer\.quota \(additionalProperties\): unknown key "burst"/);
  await write({roles:['admin']});
  await assert.rejects(validateProject(app),/Invalid extension policy at route \/api\/items, auth \(additionalProperties\): unknown key "roles"; did you mean "role"\?/);
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
  const runtime=await createRuntime(root,{origin,extensions:[{...await registration(root),name:'auth'}]});t.after(()=>runtime.close());
  assert.equal((await runtime.handle({target:'/private',method:'GET'})).status,401);
  assert.equal((await runtime.handle({target:'/private',method:'GET',headers:new Headers({cookie:'session=yes'})})).status,200);
  assert.equal((await runtime.handle({target:'/open',method:'GET'})).status,200);
});
test('activation failure closes already activated providers',async t=>{
  const root=await project(t,{'/demo/*':mount},{},{extensions:{...declarations,other:{version:'1',config:{label:'other'}}}});
  let closed=0;const first=await registration(root,{activate(){return{handle:()=>({status:200,headers:[]}),close(){closed++;}};}});
  const second={...first,name:'other',activate(){throw new Error('activation failed');}};
  await assert.rejects(createRuntime(root,{origin,extensions:[first,second]}),/activation failed/);assert.equal(closed,1);
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
  const session=async(hostFile?:string)=>{let text='';await serveMcp({project:root,...(hostFile===undefined?{}:{hostFile}),input:Readable.from([messages.map(value=>JSON.stringify(value)+'\n').join('')]),output:new Writable({write(chunk,_encoding,done){text+=String(chunk);done();}})});return text.trim().split('\n').map(line=>JSON.parse(line) as {error?:{code:number};result:{tools:{name:string}[];content:{text:string}[]}});};
  const absent=await session();assert.ok(!absent[1]!.result.tools.some(tool=>tool.name==='get_extensions'));assert.equal(absent[2]!.error?.code,-32602);assert.equal(absent[3]!.error?.code,-32602);
  const present=await session(file);assert.ok(present[1]!.result.tools.some(tool=>tool.name==='get_extensions'));
  const report=JSON.parse(present[2]!.result.content[0]!.text) as {extensions:{name:string;schema:object}[]};assert.equal(report.extensions[0]?.name,'demo');assert.ok('properties' in report.extensions[0]!.schema);
  assert.equal(present[3]!.error?.code,-32602);
});
const assetHeaders:[string,string][]=[['content-type','text/css'],['etag','"abc123"'],['cdn-cache-control','public, max-age=100']];
async function assetRegistration(root:string,extra:Partial<RuntimeExtension>={}):Promise<RuntimeExtension>{return registration(root,{immutableAssets:{prefix:'/static'},activate(){return{
  handle(req){
    const extras:[string,string][]=[];
    if(req.query.has('cookie'))extras.push(['set-cookie','a=b']);
    if(req.query.has('weak'))return{status:200,headers:[['content-type','text/css'],['etag','W/"abc123"']],body:'css'};
    if(req.query.has('vary'))extras.push(['vary','Cookie']);
    if(req.query.has('shorter'))extras.push(['cache-control','public, max-age=60']);
    if(req.query.has('private'))extras.push(['cache-control','private, max-age=31536000']);
    if(req.query.has('noetag'))return{status:200,headers:[['content-type','text/css']],body:'css'};
    if(req.headers.get('if-none-match')==='"abc123"')return{status:304,headers:assetHeaders};
    return{status:200,headers:[...assetHeaders,...extras],body:'css'};
  },
  authorize(){return undefined;},
};},...extra});}
test('declared immutable asset prefix relaxes no-store only for qualifying GET/HEAD answers',async t=>{
  const root=await project(t,{'/demo/*':mount},{},{extensions:declarations});
  const app=await startServer({project:root,origin,port:0,extensions:[await assetRegistration(root)],log:()=>{}});t.after(()=>app.close());
  const asset=await request(app,'/demo/static/app.abc123.css');
  assert.equal(asset.status,200);assert.equal(asset.headers['cache-control'],'public, max-age=31536000, immutable');assert.equal(asset.headers['cdn-cache-control'],undefined);assert.equal(asset.headers.etag,'"abc123"');
  assert.equal((await request(app,'/demo/static/app.abc123.css',{method:'HEAD'})).headers['cache-control'],'public, max-age=31536000, immutable');
  const revalidated=await request(app,'/demo/static/app.abc123.css',{headers:{'if-none-match':'"abc123"'}});assert.equal(revalidated.status,304);assert.equal(revalidated.headers['cache-control'],'public, max-age=31536000, immutable');
  assert.equal((await request(app,'/demo/static/app.abc123.css?shorter')).headers['cache-control'],'public, max-age=60');
  assert.equal((await request(app,'/demo/static/app.abc123.css?private')).headers['cache-control'],'private, max-age=31536000');
  for(const [target,init]of [['/demo/static/app.abc123.css',{method:'POST'}],['/demo/static/app.abc123.css?noetag',{}],['/demo/static/app.abc123.css?weak',{}],['/demo/static/app.abc123.css?cookie',{}],['/demo/static/app.abc123.css?vary',{}],['/demo/staticfile.css',{}],['/demo/login',{}],['/demo/static',{}]] as const){
    const response=await request(app,target,{...init});assert.equal(response.status,200,target);assert.equal(response.headers['cache-control'],'no-store',JSON.stringify([target,init]));
  }
});
test('immutable assets stay no-store without a declaration and never widen cache policy or plugin answers',async t=>{
  const root=await project(t,{'/demo/*':mount},{},{extensions:declarations});
  const {immutableAssets:_declared,...plain}=await assetRegistration(root);
  const undeclared=await startServer({project:root,origin,port:0,extensions:[plain],log:()=>{}});t.after(()=>undeclared.close());
  assert.equal((await request(undeclared,'/demo/static/app.abc123.css')).headers['cache-control'],'no-store');
  // A response hook adding a cookie after the extension answered turns the asset back into a private answer.
  const hooked=await startServer({project:root,origin,port:0,extensions:[await assetRegistration(root)],plugins:[{name:'late',version:'1',targets:['node'],onResponse:(_request,result)=>({...result,headers:[...result.headers,['set-cookie','late=1']]})}],log:()=>{}});t.after(()=>hooked.close());
  assert.equal((await request(hooked,'/demo/static/app.abc123.css')).headers['cache-control'],'no-store');
  const cached=await project(t,{'/demo/*':{...mount,policies:{cache:{strategy:'immutable'}}}},{},{extensions:declarations});
  await assert.rejects(createRuntime(cached,{origin,extensions:[await assetRegistration(cached)]}),/no-store/);
});
test('immutable asset prefixes are validated and belong to the operator registration, not the pinned revision',async t=>{
  const root=await project(t,{'/demo/*':mount},{},{extensions:declarations});
  for(const prefix of ['static','/','/static/','/a/../b','/./x','/a//b','/sta tic','',42])await assert.rejects(createRuntime(root,{origin,extensions:[await assetRegistration(root,{immutableAssets:{prefix:prefix as string}})]}),/immutableAssets\.prefix/,String(prefix));
  const pinned=await inspectExtensionRevision(root);
  const runtime=await createRuntime(root,{origin,extensions:[await assetRegistration(root,{immutableAssets:{prefix:'/hashed'}})]});t.after(()=>runtime.close());
  assert.equal(await inspectExtensionRevision(root),pinned);
  assert.equal((await runtime.handle({target:'/demo/hashed/app.abc123.css',method:'GET'})).headers.find(([name])=>name==='cache-control')?.[1],'public, max-age=31536000, immutable');
  assert.equal((await runtime.handle({target:'/demo/static/app.abc123.css',method:'GET'})).headers.find(([name])=>name==='cache-control')?.[1],'no-store');
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
