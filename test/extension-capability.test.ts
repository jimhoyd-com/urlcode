import test from 'node:test';import assert from 'node:assert/strict';
import {project} from './helpers.ts';
import {createRuntime} from '../packages/core/src/runtime.ts';
import {inspectExtensionRevision} from '../packages/core/src/extensions.ts';
import type {InvocationContext,RuntimeExtension} from '../packages/core/src/extensions.ts';
// RIM-EXT-CAPABILITY-001 (docs/RUNTIME-IMPLEMENTATION.md, urlcode#837): an operator-installed extension that
// declares `capabilities` may bind a request-scoped object into an ordinary trusted function/middleware route's
// `context.capabilities.<extension>.<capability>`, resolved once per declared name per request through
// `ExtensionInstance.provide(capability, invocation)`. The provider here is deliberately not a first-party package:
// a synthetic "vault" extension proves the mechanism needs no core import of any real extension.
const origin='https://ext-capability.example.test';
const echo='export default (req,ctx)=>Response.json({capabilities:ctx.capabilities??null,requestId:ctx.requestId});';
interface Seen { calls:{capability:string;invocation:InvocationContext}[] }
/** A synthetic capability provider: `stamp` echoes the invocation it was given; a capability requiring a principal is named `owned`. */
async function vault(root:string,seen:Seen,opts:{names?:string[];withProvide?:boolean}={}):Promise<RuntimeExtension>{return {
  name:'vault',version:'1',projectSha256:await inspectExtensionRevision(root),targets:['node'],
  schema:{type:'object',additionalProperties:false},policySchema:{type:'object',additionalProperties:false},
  capabilities:opts.names??['stamp','owned'],
  activate(){return {
    handle(){return{status:404,headers:[],body:''};},
    // A route naming an extension in policies.extensions must have it actually gate the route (authorize or
    // middleware); this always admits, so the fixture exercises capability binding, not admission.
    authorize(){return undefined;},
    ...(opts.withProvide===false?{}:{provide(capability:string,invocation:InvocationContext){
      seen.calls.push({capability,invocation});
      if(capability==='owned')return invocation.principal?{owner:invocation.principal.id}:undefined;
      return {requestId:invocation.requestId,route:invocation.route.pattern};
    }}),
  };},
};}
const routeFor=(extensions:Record<string,unknown> = {vault:{}})=>({'/h':{function:{source:'echo.mjs'},policies:{extensions}}});
const body=(result:{body?:unknown}):{capabilities:Record<string,Record<string,unknown>>|null;requestId:string}=>JSON.parse(Buffer.from(result.body as Uint8Array).toString());

test('a declared capability is bound per request via provide(), keyed by extension then capability name',async t=>{
  const root=await project(t,routeFor(),{'echo.mjs':echo},{extensions:{vault:{version:'1',config:{}}}});
  const seen:Seen={calls:[]};
  const runtime=await createRuntime(root,{origin,extensions:[await vault(root,seen)]});t.after(()=>runtime.close());
  const result=await runtime.handle({target:'/h',method:'GET'});
  const parsed=body(result);
  assert.equal(parsed.capabilities?.vault?.stamp && (parsed.capabilities.vault.stamp as {requestId:string}).requestId,parsed.requestId);
  // `owned` needed a principal this request never had: provide() returned undefined, so it is simply absent.
  assert.equal(Object.hasOwn(parsed.capabilities?.vault??{},'owned'),false);
});
test('each request gets its own invocation: two requests never share a bound object or requestId',async t=>{
  const root=await project(t,routeFor(),{'echo.mjs':echo},{extensions:{vault:{version:'1',config:{}}}});
  const seen:Seen={calls:[]};
  const runtime=await createRuntime(root,{origin,extensions:[await vault(root,seen)]});t.after(()=>runtime.close());
  const first=body(await runtime.handle({target:'/h',method:'GET'}));
  const second=body(await runtime.handle({target:'/h',method:'GET'}));
  assert.notEqual(first.requestId,second.requestId);
  assert.notEqual((first.capabilities!.vault!.stamp as {requestId:string}).requestId,(second.capabilities!.vault!.stamp as {requestId:string}).requestId);
  assert.equal(seen.calls.length,4); // stamp + owned, twice
});
test('a route that does not name the extension in policies.extensions gets no capabilities at all',async t=>{
  const root=await project(t,{'/h':{function:{source:'echo.mjs'}}},{'echo.mjs':echo},{extensions:{vault:{version:'1',config:{}}}});
  const seen:Seen={calls:[]};
  const runtime=await createRuntime(root,{origin,extensions:[await vault(root,seen)]});t.after(()=>runtime.close());
  assert.equal(body(await runtime.handle({target:'/h',method:'GET'})).capabilities,null);
  assert.equal(seen.calls.length,0);
});
test('an extension with no declared capabilities offers nothing, even when named in policies.extensions',async t=>{
  const root=await project(t,routeFor(),{'echo.mjs':echo},{extensions:{vault:{version:'1',config:{}}}});
  const seen:Seen={calls:[]};
  const runtime=await createRuntime(root,{origin,extensions:[await vault(root,seen,{names:[]})]});t.after(()=>runtime.close());
  assert.equal(body(await runtime.handle({target:'/h',method:'GET'})).capabilities,null);
});
test('a registration that declares capabilities but implements no provide() just yields nothing, not a crash',async t=>{
  const root=await project(t,routeFor(),{'echo.mjs':echo},{extensions:{vault:{version:'1',config:{}}}});
  const seen:Seen={calls:[]};
  const runtime=await createRuntime(root,{origin,extensions:[await vault(root,seen,{withProvide:false})]});t.after(()=>runtime.close());
  assert.equal(body(await runtime.handle({target:'/h',method:'GET'})).capabilities,null);
});
test('sandbox: true refuses activation before serving when the route names a capability-declaring extension',async t=>{
  const root=await project(t,{'/h':{function:{source:'echo.mjs'},sandbox:true,policies:{extensions:{vault:{}}}}},{'echo.mjs':echo},{extensions:{vault:{version:'1',config:{}}}});
  const seen:Seen={calls:[]};
  await assert.rejects(createRuntime(root,{origin,extensions:[await vault(root,seen)]}),/capabilities/);
  assert.equal(seen.calls.length,0);
});
test('sandbox: true still activates a route naming an extension that declares no capabilities',async t=>{
  const root=await project(t,{'/h':{function:{source:'echo.mjs'},sandbox:true,policies:{extensions:{vault:{}}}}},{'echo.mjs':echo},{extensions:{vault:{version:'1',config:{}}}});
  const seen:Seen={calls:[]};
  const runtime=await createRuntime(root,{origin,extensions:[await vault(root,seen,{names:[]})]});t.after(()=>runtime.close());
  const result=await runtime.handle({target:'/h',method:'GET'});
  assert.equal(result.status,200);
});
test('the extension registration validates capabilities: distinct lowercase names only',async()=>{
  const {prepareExtensions}=await import('../packages/core/src/extensions.ts');
  const bad=(capabilities:unknown):RuntimeExtension=>({name:'vault',version:'1',projectSha256:'a'.repeat(64),targets:['node'],schema:{type:'object',additionalProperties:false},capabilities:capabilities as string[],activate:()=>({handle:()=>({status:404,headers:[],body:''})})});
  const document={version:'1' as const,routes:{},extensions:{}};
  for(const capabilities of [['Stamp'],['stamp','stamp'],Array.from({length:33},(_,i)=>`c${i}`)]) {
    assert.throws(()=>prepareExtensions(document,{},[bad(capabilities)],{origin,target:'node',projectSha256:'a'.repeat(64),root:'/'}),/Invalid extension capabilities/);
  }
});
