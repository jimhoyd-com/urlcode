import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
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
  const root=new URL('../examples/extensions/',import.meta.url).pathname;
  const runtime=await createRuntime(root,{origin,extensions:[await registration(root)]});t.after(()=>runtime.close());
  assert.equal((await runtime.handle({target:'/demo',method:'GET'})).status,200);
  assert.equal((await runtime.handle({target:'/private',method:'GET'})).status,401);
});
test('activation failure closes already activated providers',async t=>{
  const root=await project(t,{'/demo/*':mount},{},{extensions:{...declarations,other:{version:'1',config:{label:'other'}}}});
  let closed=0;const first=await registration(root,{activate(){return{handle:()=>({status:200,headers:[]}),close(){closed++;}};}});
  const second={...first,name:'other',activate(){throw new Error('activation failed');}};
  await assert.rejects(createRuntime(root,{origin,extensions:[first,second]}),/activation failed/);assert.equal(closed,1);
});
