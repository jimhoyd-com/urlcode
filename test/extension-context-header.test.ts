import test from 'node:test';import assert from 'node:assert/strict';
import {project,approveBindings} from './helpers.ts';
import {createRuntime} from '../packages/core/src/runtime.ts';
import {inspectExtensionRevision} from '../packages/core/src/extensions.ts';
import type {RuntimeExtension} from '../packages/core/src/extensions.ts';
// RIM-EXT-CONTEXT-001 (docs/RUNTIME-IMPLEMENTATION.md, urlcode#618): the reserved
// `x-urlcode-context-*` header namespace lets an extension's authorize()/middleware()
// hand a derived value forward into a route's own trusted function/middleware
// context, without ever letting a client inject or spoof it, and without ever
// exempting an actual credential from the existing withholding rule.
const origin='https://ext-context.example.test';
const echo='export default (req,ctx)=>Response.json({principal:req.headers.get("x-urlcode-context-auth-principal"),other:req.headers.get("x-urlcode-context-other"),cookie:req.headers.get("cookie"),authorization:req.headers.get("authorization"),header:ctx.inputs.header});';
const parameters=[{in:'header' as const,name:'x-urlcode-context-auth-principal',schema:{type:'string' as const}}];
/** Writes a fixed principal into the reserved namespace from authorize(), and separately from middleware() when asked. */
async function principalExtension(root:string,opts:{fromMiddleware?:boolean}={}):Promise<RuntimeExtension>{return {
  name:'principal',version:'1',projectSha256:await inspectExtensionRevision(root),targets:['node','aws','vercel'],
  schema:{type:'object',additionalProperties:false},policySchema:{type:'object',additionalProperties:false},
  activate(){return {
    handle(){return{status:404,headers:[],body:''};},
    ...(opts.fromMiddleware?{
      async middleware(_config,req,next){req.headers.set('x-urlcode-context-auth-principal','{"id":"key_1"}');return await next();},
    }:{
      authorize(_policy,req){req.headers.set('x-urlcode-context-auth-principal','{"id":"key_1"}');return undefined;},
    }),
  };},
};}
test('a value an extension writes into the reserved namespace carries into the guest function context',async t=>{
  const root=await project(t,{'/h':{function:{source:'echo.mjs',args:{}},parameters,policies:{extensions:{principal:{}}}}},{'echo.mjs':echo},{extensions:{principal:{version:'1',config:{}}}});
  const runtime=await createRuntime(root,{origin,extensions:[await principalExtension(root)]});t.after(()=>runtime.close());
  const result=await runtime.handle({target:'/h',method:'GET'});
  const body=JSON.parse(Buffer.from(result.body as Uint8Array).toString()) as {principal:string|null;other:string|null;header:Record<string,string>};
  assert.equal(body.principal,'{"id":"key_1"}');
  assert.equal(body.header['x-urlcode-context-auth-principal'],'{"id":"key_1"}');
});
test('a value a middleware() hook writes into the reserved namespace carries into the guest function context too',async t=>{
  const root=await project(t,{'/h':{function:{source:'echo.mjs',args:{}},parameters,policies:{extensions:{principal:{}}}}},{'echo.mjs':echo},{extensions:{principal:{version:'1',config:{}}}});
  const runtime=await createRuntime(root,{origin,extensions:[await principalExtension(root,{fromMiddleware:true})]});t.after(()=>runtime.close());
  const result=await runtime.handle({target:'/h',method:'GET'});
  const body=JSON.parse(Buffer.from(result.body as Uint8Array).toString()) as {principal:string|null};
  assert.equal(body.principal,'{"id":"key_1"}');
});
test('a client can never inject or spoof a value in the reserved namespace',async t=>{
  const root=await project(t,{'/h':{function:{source:'echo.mjs',args:{}},parameters,policies:{extensions:{principal:{}}}}},{'echo.mjs':echo},{extensions:{principal:{version:'1',config:{}}}});
  const runtime=await createRuntime(root,{origin,extensions:[await principalExtension(root)]});t.after(()=>runtime.close());
  const result=await runtime.handle({target:'/h',method:'GET',headers:new Headers({'x-urlcode-context-auth-principal':'{"id":"attacker"}'})});
  const body=JSON.parse(Buffer.from(result.body as Uint8Array).toString()) as {principal:string|null};
  // The extension still writes its own value; a client-supplied one is
  // never visible anywhere along the way, including to the extension itself.
  assert.equal(body.principal,'{"id":"key_1"}');
});
test('the reserved namespace is absent, not a client value, on a route with no authorize()/middleware() writer',async t=>{
  const root=await project(t,{'/h':{function:{source:'echo.mjs',args:{}},parameters}},{'echo.mjs':echo});
  const runtime=await createRuntime(root);t.after(()=>runtime.close());
  const result=await runtime.handle({target:'/h',method:'GET',headers:new Headers({'x-urlcode-context-other':'{"id":"attacker"}'})});
  const body=JSON.parse(Buffer.from(result.body as Uint8Array).toString()) as {other:string|null};
  assert.equal(body.other,null);
});
test('declared credential headers stay withheld from the guest even on a route an extension writes reserved context into',async t=>{
  const root=await project(t,{'/h':{function:{source:'echo.mjs',args:{}},policies:{extensions:{principal:{}}}}},{'echo.mjs':echo},{extensions:{principal:{version:'1',config:{}}}});
  const runtime=await createRuntime(root,{origin,extensions:[await principalExtension(root)]});t.after(()=>runtime.close());
  const result=await runtime.handle({target:'/h',method:'GET',headers:new Headers({cookie:'session=synthetic',authorization:'Bearer synthetic'})});
  const body=JSON.parse(Buffer.from(result.body as Uint8Array).toString()) as {cookie:string|null;authorization:string|null;principal:string|null};
  assert.equal(body.cookie,null);assert.equal(body.authorization,null);assert.equal(body.principal,'{"id":"key_1"}');
});
test('a proxy route can never name a reserved-namespace header in requestHeaders or responseHeaders',async()=>{
  const {validateProxy}=await import('../packages/core/src/proxy.ts');
  assert.throws(()=>validateProxy({url:'https://example.com',requestHeaders:['x-urlcode-context-auth-principal']}),/denied/);
  assert.throws(()=>validateProxy({url:'https://example.com',responseHeaders:['x-urlcode-context-auth-principal']}),/denied/);
  assert.doesNotThrow(()=>validateProxy({url:'https://example.com',requestHeaders:['accept']}));
});
test('a route cannot smuggle reserved-namespace values to a proxied upstream even by naming them explicitly',async t=>{
  const root=await project(t,{'/p':{proxy:{url:'https://example.com',requestHeaders:['x-urlcode-context-auth-principal']}}});
  await assert.rejects(createRuntime(root,{permissions:await approveBindings(root)}),/Egress denied/);
});
