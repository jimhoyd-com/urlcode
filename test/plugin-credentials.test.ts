import test from 'node:test';import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.ts';import {validatePlugins} from '../src/plugins.ts';import type {Plugin} from '../src/plugins.ts';import {project,redirect} from './helpers.ts';
const echo='export default (req,ctx)=>Response.json({cookie:req.headers.get("cookie"),authorization:req.headers.get("authorization"),other:req.headers.get("x-visible"),header:ctx.inputs.header,args:ctx.args});';
const parameters=[{in:'header' as const,name:'cookie',schema:{type:'string' as const}},{in:'header' as const,name:'authorization',schema:{type:'string' as const}},{in:'header' as const,name:'x-visible',schema:{type:'string' as const}}];
const args={cookie:{from:'header' as const,name:'cookie'},authorization:{from:'header' as const,name:'authorization'},other:{from:'header' as const,name:'x-visible'}};
function plugin(extra:Partial<Plugin>={}):Plugin{return {name:'credential-owner',version:'1',targets:['node'],credentialHeaders:['Cookie','AUTHORIZATION'],onRequest(){},...extra};}
function body(result:Awaited<ReturnType<Awaited<ReturnType<typeof createRuntime>>['handle']>>){return JSON.parse(Buffer.from(result.body as Uint8Array).toString()) as unknown;}
test('plugin credentials are withheld on public guest routes and derived context while host hooks keep originals',async t=>{
 const observed:string[]=[];const root=await project(t,{'/public':{function:{source:'echo.mjs',args},parameters}},{'echo.mjs':echo});
 const owner=plugin({onRequest(request){observed.push(request.headers.get('cookie')!,request.headers.get('authorization')!);},onResponse(request){observed.push(request.headers.get('cookie')!,request.headers.get('authorization')!);}});
 const runtime=await createRuntime(root,{plugins:[owner]});t.after(()=>runtime.close());const headers=new Headers({cookie:'session=synthetic-cookie',authorization:'Bearer synthetic-token','x-visible':'kept'});
 assert.deepEqual(body(await runtime.handle({target:'/public',headers})),{cookie:null,authorization:null,other:'kept',header:{'x-visible':'kept'},args:{other:'kept'}});
 assert.deepEqual(observed,['session=synthetic-cookie','Bearer synthetic-token','session=synthetic-cookie','Bearer synthetic-token']);assert.equal(headers.get('cookie'),'session=synthetic-cookie');
});
test('middleware receives neither credential headers nor native redirect values derived from them',async t=>{
 const root=await project(t,{'/wrapped':{...redirect(),redirect:{url:'https://example.com',query:{map:{credential:{from:'header',name:'cookie'}}}},parameters,middleware:[{source:'wrap.mjs'}]}},{'wrap.mjs':'export default async(req,ctx,next)=>{const result=await next();return Response.json({cookie:req.headers.get("cookie"),authorization:req.headers.get("authorization"),header:ctx.inputs.header,location:result.headers.get("location")});}'});
 const runtime=await createRuntime(root,{plugins:[plugin()]});t.after(()=>runtime.close());assert.deepEqual(body(await runtime.handle({target:'/wrapped',headers:new Headers({cookie:'synthetic-cookie',authorization:'synthetic-auth','x-visible':'kept'})})),{cookie:null,authorization:null,header:{'x-visible':'kept'},location:'https://example.com/'});
});
test('withheld headers cannot enter validation or defaults and required inputs fail generically',async t=>{
 const root=await project(t,{'/default':{function:{source:'echo.mjs',args:{cookie:args.cookie}},parameters:[{in:'header',name:'cookie',schema:{type:'integer',default:7}}]},'/required':{function:{source:'echo.mjs'},parameters:[{in:'header',name:'authorization',required:true,schema:{type:'string'}}]}},{'echo.mjs':echo});
 const runtime=await createRuntime(root,{plugins:[plugin()]});t.after(()=>runtime.close());assert.deepEqual(body(await runtime.handle({target:'/default',headers:new Headers({cookie:'not-an-integer-synthetic-secret'})})),{cookie:null,authorization:null,other:null,header:{},args:{}});
 await assert.rejects(runtime.handle({target:'/required',headers:new Headers({authorization:'synthetic-secret'})}),{message:'Missing required parameter'});
});
test('cache policies retain original header values for explicitly configured vary keys',async t=>{
 const root=await project(t,{'/cached':{function:{source:'echo.mjs'},policies:{cache:{strategy:'public',maxAge:60,originTtl:60,vary:['authorization']}}}},{'echo.mjs':echo});
 const runtime=await createRuntime(root,{plugins:[plugin()]});t.after(()=>runtime.close());
 for(const token of ['synthetic-a','synthetic-b','synthetic-a'])await runtime.handle({target:'/cached',headers:new Headers({authorization:token})});assert.equal(runtime.metrics().policies.cache.store,2);assert.equal(runtime.metrics().policies.cache.hit,1);
});
test('the default remains backward compatible and credential declarations are snapshotted',async t=>{
 const root=await project(t,{'/':{function:{source:'echo.mjs',args},parameters}},{'echo.mjs':echo});const headers=new Headers({cookie:'synthetic-cookie',authorization:'synthetic-auth'});
 const plain=await createRuntime(root);t.after(()=>plain.close());assert.deepEqual(body(await plain.handle({target:'/',headers})),{cookie:'synthetic-cookie',authorization:'synthetic-auth',other:null,header:{cookie:'synthetic-cookie',authorization:'synthetic-auth'},args:{cookie:'synthetic-cookie',authorization:'synthetic-auth'}});
 const owner=plugin({onActivate(){owner.credentialHeaders!.length=0;}}),protectedRuntime=await createRuntime(root,{plugins:[owner]});t.after(()=>protectedRuntime.close());assert.deepEqual(body(await protectedRuntime.handle({target:'/',headers})),{cookie:null,authorization:null,other:null,header:{},args:{}});
});
test('plugin credential header names are bounded and validated',()=>{
 for(const credentialHeaders of ['cookie',Array.from({length:65},(_,i)=>`x-${i}`),['cookie','COOKIE'],['invalid header'],['x'.repeat(129)],[12]])assert.throws(()=>validatePlugins([{...plugin(),credentialHeaders}]));
 assert.equal(validatePlugins([plugin({credentialHeaders:[]})]).length,1);
});
