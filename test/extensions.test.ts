import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {project,request} from './helpers.ts';
import {loadDocument} from '../src/config.ts';
import {createRuntime} from '../src/runtime.ts';
import {startServer} from '../src/server.ts';
import {createLambdaHandler} from '../src/aws.ts';
import {buildCloudflare} from '../src/build-cloudflare.ts';
import {inspectExtensionRevision,effectiveExtensionPolicies} from '../src/extensions.ts';
import type {RuntimeExtension} from '../src/extensions.ts';
import type {ProjectDocument} from '../src/types.ts';
const origin='https://extensions.example.test';
const declarations={demo:{version:'1',config:{label:'hello'}}};
const mount={extension:'demo',methods:['GET','HEAD','POST']};
async function registration(root:string,extra:Partial<RuntimeExtension>={}):Promise<RuntimeExtension>{return {
  name:'demo',version:'1',projectSha256:await inspectExtensionRevision(root),targets:['node','aws','vercel'],
  schema:{type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false},
  policySchema:{type:'object',properties:{role:{const:'member'}},required:['role'],additionalProperties:false},
  activate(config,context){assert.ok(Object.isFrozen(config));assert.ok(Object.isFrozen(context.mounts));return {
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
test('missing registrations, unsupported versions, invalid config and stale grants fail before activation',async t=>{
  const root=await project(t,{'/demo/*':mount},{},{extensions:declarations});
  await assert.rejects(createRuntime(root,{origin}),/Missing operator extension/);
  let activations=0;const extension=await registration(root,{activate(){activations++;throw new Error('must not run');}});
  await assert.rejects(createRuntime(root,{origin,extensions:[{...extension,projectSha256:'0'.repeat(64)}]}),/pin mismatch/);
  await assert.rejects(createRuntime(root,{extensions:[extension]}),/explicit operator origin/);
  await assert.rejects(createRuntime(root,{origin,extensions:[extension,extension]}),/Duplicate extension/);
  await assert.rejects(createRuntime(root,{origin,extensions:[{...extension,schema:{type:'object',additionalProperties:false}}]}),/Invalid extension configuration/);
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
  const response=await request(app,'/demo/login',{method:'POST',body:'body',headers:{cookie:'session=yes',host:'attacker.test'}});
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
  await assert.rejects(loadDocument(await project(t,{'/a':{respond:{text:'a'},auth:{roles:['member']}}},{},{extensions:{auth}})),/Invalid configuration at \/routes\/~1a\/auth/);
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
