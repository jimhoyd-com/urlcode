import test from 'node:test';import assert from 'node:assert/strict';
import {project} from './helpers.ts';
import {createRuntime} from '../packages/core/src/runtime.ts';
import {inspectExtensionRevision,installPrincipalSlot,validatePrincipal,principalIdPattern} from '../packages/core/src/extensions.ts';
import type {ExtensionActivation,ExtensionRequest,RuntimeExtension} from '../packages/core/src/extensions.ts';
// RIM-EXT-PRINCIPAL-001 (docs/RUNTIME-IMPLEMENTATION.md, urlcode#331): an operator-installed extension that declares
// `providesPrincipal` may set an opaque, bounded, frozen principal from its own authorize(); other extensions on the
// same route read it. The provider here is deliberately not auth (authoring rule 5: a second provider): a synthetic
// "badge" extension that recognizes `Authorization: Badge <id>` tokens by its own rule.
const origin='https://ext-principal.example.test';
type Behaviour=(request:ExtensionRequest)=>unknown;
interface Seen { principal?:unknown; handled:number; activation?:ExtensionActivation }
async function badge(root:string,options:{name?:string;provides?:boolean;behaviour?:Behaviour;middleware?:Behaviour;withoutAuthorize?:boolean}={}):Promise<RuntimeExtension>{
  const behaviour:Behaviour=options.behaviour??(request=>{
    const match=/^Badge (\S+)$/.exec(request.headers.get('authorization')??'');
    if(!match)return {status:401,headers:[],body:'no badge'};
    request.setPrincipal!({id:match[1]!});
    return undefined;
  });
  return {
    name:options.name??'badge',version:'1',projectSha256:await inspectExtensionRevision(root),targets:['node'],
    ...(options.provides===false?{}:{providesPrincipal:true}),
    schema:{type:'object',additionalProperties:false},policySchema:{type:'object',additionalProperties:false},
    activate(){return {
      handle(){return {status:404,headers:[],body:''};},
      ...(options.withoutAuthorize?{middleware:async(_config:unknown,_request:ExtensionRequest,next:()=>Promise<never>)=>await next()}:{authorize:async(_policy:unknown,request:ExtensionRequest)=>await behaviour(request) as undefined}),
      ...(options.middleware?{async middleware(_config:unknown,request:ExtensionRequest,next:()=>Promise<never>){await options.middleware!(request);return await next();}}:{}),
    };},
  } as RuntimeExtension;
}
/** A consumer mount that answers with the principal it was handed, and records its activation context. */
async function vault(root:string,seen:Seen,handle?:(request:ExtensionRequest)=>void):Promise<RuntimeExtension>{return {
  name:'vault',version:'1',projectSha256:await inspectExtensionRevision(root),targets:['node'],
  schema:{type:'object',additionalProperties:false},
  activate(_config,context){seen.activation=context;return {handle(request){seen.handled++;seen.principal=request.principal;handle?.(request);return {status:200,headers:[['content-type','application/json']],body:JSON.stringify({principal:request.principal??null})};}};},
};}
const body=(result:{body?:unknown}):unknown=>JSON.parse(Buffer.from(result.body as Uint8Array).toString());
const declarations={badge:{version:'1',config:{}},vault:{version:'1',config:{}}};
const guarded={'/v/*':{extension:'vault',policies:{extensions:{badge:{}}}}};

test('a provider sets a frozen principal from authorize() and the mount on the same route reads it, stamped with the provider name',async t=>{
  const root=await project(t,guarded,{},{extensions:declarations});
  const seen:Seen={handled:0};
  const runtime=await createRuntime(root,{origin,extensions:[await badge(root),await vault(root,seen,request=>{
    assert.throws(()=>{(request as {principal:unknown}).principal={id:'mallory',provider:'badge'};},TypeError);
    assert.throws(()=>request.setPrincipal!({id:'mallory'}),/only callable/);
  })]});t.after(()=>runtime.close());
  const result=await runtime.handle({target:'/v/x',method:'GET',headers:new Headers({authorization:'Badge alice'})});
  assert.equal(result.status,200);
  assert.deepEqual(body(result),{principal:{id:'alice',provider:'badge'}});
  assert.ok(Object.isFrozen(seen.principal));
  // Each request gets its own slot: the next one has its own principal, not the previous one.
  assert.deepEqual(body(await runtime.handle({target:'/v/x',method:'GET',headers:new Headers({authorization:'Badge bob'})})),{principal:{id:'bob',provider:'badge'}});
});
test('no request header, cookie or query value can set a principal: without a provider policy it stays null',async t=>{
  const root=await project(t,{'/v/*':{extension:'vault'}},{},{extensions:{vault:{version:'1',config:{}}}});
  const seen:Seen={handled:0};
  const runtime=await createRuntime(root,{origin,extensions:[await vault(root,seen)]});t.after(()=>runtime.close());
  const result=await runtime.handle({target:'/v/x?principal=alice',method:'GET',headers:new Headers({authorization:'Badge alice','x-urlcode-principal':'{"id":"alice"}','x-urlcode-context-principal':'{"id":"alice"}',cookie:'principal=alice'})});
  assert.deepEqual(body(result),{principal:null});
  assert.equal(seen.principal,null);
  assert.deepEqual(seen.activation?.principalMounts,[]);
});
test('a denied request commits no principal and never reaches the mount',async t=>{
  const root=await project(t,guarded,{},{extensions:declarations});
  const seen:Seen={handled:0};
  const runtime=await createRuntime(root,{origin,extensions:[await badge(root,{behaviour:request=>{request.setPrincipal!({id:'alice'});return {status:403,headers:[],body:'denied'};}}),await vault(root,seen)]});t.after(()=>runtime.close());
  const result=await runtime.handle({target:'/v/x',method:'GET'});
  assert.equal(result.status,403);assert.equal(seen.handled,0);
});
test('an extension that does not declare providesPrincipal cannot set one',async t=>{
  const root=await project(t,guarded,{},{extensions:declarations});
  const seen:Seen={handled:0};
  const runtime=await createRuntime(root,{origin,extensions:[await badge(root,{provides:false}),await vault(root,seen)]});t.after(()=>runtime.close());
  await assert.rejects(runtime.handle({target:'/v/x',method:'GET',headers:new Headers({authorization:'Badge alice'})}),/does not declare providesPrincipal/);
  assert.equal(seen.handled,0);
  assert.deepEqual(seen.activation?.principalMounts,[]);
});
test('a second provider on the same route cannot replace the principal: the request is refused',async t=>{
  const root=await project(t,{'/v/*':{extension:'vault',policies:{extensions:{badge:{},second:{}}}}},{},{extensions:{...declarations,second:{version:'1',config:{}}}});
  const seen:Seen={handled:0};
  const second=await badge(root,{name:'second',behaviour:request=>{request.setPrincipal!({id:'mallory'});return undefined;}});
  const runtime=await createRuntime(root,{origin,extensions:[await badge(root),second,await vault(root,seen)]});t.after(()=>runtime.close());
  await assert.rejects(runtime.handle({target:'/v/x',method:'GET',headers:new Headers({authorization:'Badge alice'})}),/extension badge already set one/);
  assert.equal(seen.handled,0);
});
test('a provider cannot set twice in one call, from middleware(), or after its authorize() returned',async t=>{
  const root=await project(t,guarded,{},{extensions:declarations});
  const seen:Seen={handled:0};
  let stashed:ExtensionRequest['setPrincipal'];
  const twice=await badge(root,{behaviour:request=>{request.setPrincipal!({id:'alice'});request.setPrincipal!({id:'alice'});return undefined;}});
  let runtime=await createRuntime(root,{origin,extensions:[twice,await vault(root,seen)]});
  await assert.rejects(runtime.handle({target:'/v/x',method:'GET'}),/already set a principal/);await runtime.close();
  const late=await badge(root,{behaviour:request=>{stashed=request.setPrincipal;return undefined;},middleware:request=>request.setPrincipal!({id:'alice'})});
  runtime=await createRuntime(root,{origin,extensions:[late,await vault(root,seen)]});t.after(()=>runtime.close());
  await assert.rejects(runtime.handle({target:'/v/x',method:'GET'}),/only callable/);
  assert.throws(()=>stashed!({id:'alice'}),/only callable/);
  assert.equal(seen.handled,0);
});
test('principal ids are bounded and the value must be exactly {id}',async t=>{
  for(const bad of [{id:''},{id:'a'.repeat(129)},{id:'alice@example.com'},{id:'-leading'},{id:'white space'},{id:'ünïcode'},{id:42},{id:'alice',role:'admin'},{id:'alice',provider:'auth'},null,'alice',['alice'],Object.assign(Object.create({inherited:true}) as object,{id:'alice'})]){
    assert.throws(()=>validatePrincipal(bad,'badge'),/invalid principal/,JSON.stringify(bad));
  }
  const accepted=validatePrincipal({id:'apikey:0f0e-11.a_b'},'badge');
  assert.deepEqual(accepted,{id:'apikey:0f0e-11.a_b',provider:'badge'});assert.ok(Object.isFrozen(accepted));
  assert.ok(principalIdPattern.test('a'.repeat(128)));
  // Over HTTP the same refusal fails the request before the mount runs.
  const root=await project(t,guarded,{},{extensions:declarations});
  const seen:Seen={handled:0};
  const runtime=await createRuntime(root,{origin,extensions:[await badge(root),await vault(root,seen)]});t.after(()=>runtime.close());
  await assert.rejects(runtime.handle({target:'/v/x',method:'GET',headers:new Headers({authorization:'Badge alice@example.com'})}),/invalid principal id/);
  assert.equal(seen.handled,0);
});
test('activation lists only the mounts guarded by a principal-providing policy',async t=>{
  const root=await project(t,{'/v/*':{extension:'vault',policies:{extensions:{badge:{}}}},'/open/*':{extension:'vault'},'/plain/*':{extension:'vault',policies:{extensions:{plain:{}}}}},{},{extensions:{...declarations,plain:{version:'1',config:{}}}});
  const seen:Seen={handled:0};
  const runtime=await createRuntime(root,{origin,extensions:[await badge(root),await badge(root,{name:'plain',provides:false,behaviour:()=>undefined}),await vault(root,seen)]});t.after(()=>runtime.close());
  assert.deepEqual(seen.activation?.principalMounts,['/v']);
  assert.ok(Object.isFrozen(seen.activation?.principalMounts));
});
test('a registration that declares providesPrincipal and guards a route without authorize() refuses activation',async t=>{
  const root=await project(t,guarded,{},{extensions:declarations});
  await assert.rejects(createRuntime(root,{origin,extensions:[await badge(root,{withoutAuthorize:true}),await vault(root,{handled:0})]}),/declares providesPrincipal but has no authorization hook/);
  const invalid={...await badge(root),providesPrincipal:'yes'} as unknown as RuntimeExtension;
  await assert.rejects(createRuntime(root,{origin,extensions:[invalid,await vault(root,{handled:0})]}),/Invalid extension providesPrincipal/);
});
test('installPrincipalSlot on its own: null by default, committed only on allow',async()=>{
  const request={headers:new Headers()} as ExtensionRequest;
  const slot=installPrincipalSlot(request);
  // Read through a function: an assertion on the property would narrow its type for the rest of the test.
  const current=():ExtensionRequest['principal']=>request.principal;
  assert.equal(current(),null);
  assert.equal(await slot.authorize('badge',true,()=>{request.setPrincipal!({id:'alice'});return {status:401,headers:[]};}).then(result=>result?.status),401);
  assert.equal(current(),null);
  await assert.rejects(slot.authorize('badge',true,()=>{request.setPrincipal!({id:'alice'});throw new Error('boom');}),/boom/);
  assert.equal(current(),null);
  assert.equal(await slot.authorize('badge',true,()=>{request.setPrincipal!({id:'alice'});return undefined;}),undefined);
  assert.deepEqual(current(),{id:'alice',provider:'badge'});
  // A provider that allows without setting one leaves the committed principal as is.
  assert.equal(await slot.authorize('other',true,()=>undefined),undefined);
  assert.equal(current()?.id,'alice');
});
