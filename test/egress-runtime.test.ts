import {fileURLToPath} from 'node:url';
import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {writeFile} from 'node:fs/promises';import {join} from 'node:path';import {stringify} from 'yaml';
import {createRuntime} from '../src/runtime.ts';import {validatePolicy} from '../src/policy.ts';import {loadDocument} from '../src/config.ts';import {compileRoutes} from '../src/router.ts';
import type {EgressDependencies} from '../src/egress.ts';import {project,param,approveBindings} from './helpers.ts';
interface Captured { url:string;method:string;headers:Record<string,string>;body:string }
function transport(captured:Captured[],responseHeaders:Record<string,string>={}):EgressDependencies {
 return {resolve:async()=>[{address:'8.8.8.8',family:4}],request:((url:URL,options:{method:string;headers:Record<string,string>},callback:(response:unknown)=>void)=>{
  const req=Object.assign(new EventEmitter(),{end(body?:Uint8Array){captured.push({url:url.href,method:options.method,headers:{...options.headers},body:body?Buffer.from(body).toString():''});queueMicrotask(()=>{const response=Object.assign(new EventEmitter(),{statusCode:200,headers:{'content-type':'text/plain',...responseHeaders}});callback(response);response.emit('data',Buffer.from('ok'));response.emit('end');});},destroy(){}});return req;
 }) as unknown as typeof import('node:https').request};
}
test('runtime proxy requires exact revision grant and preserves bounded selected behavior',async t=>{
 const root=await project(t,{'/item/{id}':{proxy:{url:'https://example.com/items/{id}',query:['q'],requestHeaders:['accept'],responseHeaders:['content-type'],headers:{authorization:{secret:'TOKEN'}}},parameters:[param('id')],secrets:{TOKEN:{secret:'synthetic_token'}}}});
 await assert.rejects(createRuntime(root,{environment:{synthetic_token:'synthetic'}}),/Egress denied/);
 const permissions=await approveBindings(root),calls:Captured[]=[];
 const runtime=await createRuntime(root,{permissions,environment:{synthetic_token:'synthetic'},egressDependencies:transport(calls)});t.after(()=>runtime.close());
 const result=await runtime.handle({target:'/item/a?q=one&private=no',headers:new Headers({accept:'text/plain',cookie:'private'})});assert.equal(result.status,200);assert.deepEqual(calls[0],{url:'https://example.com/items/a?q=one',method:'GET',headers:{accept:'text/plain',authorization:'synthetic'},body:''});
 assert.deepEqual(result.headers,[['content-type','text/plain'],['cache-control','no-store']]);
 const wrong=structuredClone(permissions);wrong.routes['/item/{id}']!.egress!.proxy=['https://other.example'];await assert.rejects(createRuntime(root,{permissions:wrong}),/Egress denied/);
 await writeFile(join(root,'urlcode.yaml'),stringify({version:'1',routes:{'/changed':{respond:{text:'changed'},signals:[{url:'https://example.com/hook'}]}}}));await assert.rejects(createRuntime(root,{permissions}),/Egress denied/);
});
test('signals run after primary result with fixed payload, skip HEAD/probes and expose counters',async t=>{
 const root=await project(t,{'/event':{respond:{text:'primary'},signals:[{url:'https://example.com/hook'}]}}),permissions=await approveBindings(root),calls:Captured[]=[];
 const runtime=await createRuntime(root,{permissions,egressDependencies:transport(calls)});
 const result=await runtime.handle({target:'/event?private=value',headers:new Headers({authorization:'incoming-secret'})});assert.equal(Buffer.from(result.body as Uint8Array).toString(),'primary');
 await runtime.handle({target:'/event',method:'HEAD'});await runtime.handle({target:'/event',trace:{probe:true}});await runtime.close();
 assert.equal(calls.length,1);assert.deepEqual(JSON.parse(calls[0]!.body),{version:1,route:'/event',status:200,method:'GET'});assert.equal(runtime.metrics().signals.accepted,1);
});
test('egress grants are separate by purpose and reject malformed operator policy',async t=>{
 const root=await project(t,{'/':{proxy:{url:'https://example.com'},signals:[{url:'https://example.com/hook'}]}}),permissions=await approveBindings(root);
 delete permissions.routes['/']!.egress!.signals;await assert.rejects(createRuntime(root,{permissions}),/Egress denied/);
 for(const origins of [['http://example.com'],['https://example.com/'],['https://example.com/path']])assert.throws(()=>validatePolicy({...permissions,routes:{'/':{egress:{proxy:origins}}}}));
});
test('providers refuse proxy and signal declarations',async t=>{
 const root=await project(t,{'/':{proxy:{url:'https://example.com'},signals:[{url:'https://example.com/hook'}]}});
 for(const target of ['aws','vercel','cloudflare'] as const)await assert.rejects(createRuntime(root,{target}),/bounded egress/);
});
test('compressed upstream responses cannot silently lose their encoding metadata',async t=>{
 const root=await project(t,{'/':{proxy:{url:'https://example.com',responseHeaders:['content-type']}}}),permissions=await approveBindings(root);
 const runtime=await createRuntime(root,{permissions,egressDependencies:transport([],{'content-encoding':'gzip'})});t.after(()=>runtime.close());await assert.rejects(runtime.handle({target:'/'}),/Proxy upstream unavailable/);
});
test('proxy placeholders and secret alias references are validated during compilation',async t=>{
 for(const proxy of [{url:'https://example.com/{undeclared}'},{url:'https://example.com',headers:{authorization:{secret:'MISSING'}}}]){const root=await project(t,{'/':{proxy}});await assert.rejects(loadDocument(root).then(loaded=>compileRoutes(loaded,{})));}
});
test('checked-in egress example compiles and executes through the bounded fake transport',async t=>{
 const root=fileURLToPath(new URL('../examples/egress/',import.meta.url)),permissions=await approveBindings(root),calls:Captured[]=[];
 const runtime=await createRuntime(root,{permissions,egressDependencies:transport(calls)});t.after(()=>runtime.close());
 assert.equal((await runtime.handle({target:'/proxy/hello?page=2'})).status,200);assert.equal(calls[0]?.url,'https://api.example.com/items/hello?page=2');assert.equal(runtime.requestLimit('/proxy/hello'),1048576);
});
test('proxy refuses early-return middleware and unsafe shared caching before egress',async t=>{
 for(const extra of [{middleware:[{source:'auth.mjs'}]},{policies:{cache:{strategy:'public' as const}}},{response:{headers:{'CDN-Cache-Control':'public, max-age=3600'}}}]) {
  const root=await project(t,{'/':{proxy:{url:'https://example.com'},...extra}},{'auth.mjs':'export default()=>new Response("denied",{status:403})'});await assert.rejects(loadDocument(root).then(loaded=>compileRoutes(loaded,{})),/Proxy/);
 }
});
test('changing inherited project policies or profiles invalidates old egress grants',async t=>{
 const routes={'/':{respond:{text:'ok'},signals:[{url:'https://example.com/hook'}]}};
 for(const kind of ['policies','profiles'] as const){
  const root=await project(t,routes);
  const before=kind==='policies'?{policies:{cache:{strategy:'no-store'}}}:{profiles:{safe:{cache:{strategy:'no-store'}}}};
  const after=kind==='policies'?{policies:{cache:{strategy:'private'}}}:{profiles:{safe:{cache:{strategy:'private'}}}};
  await writeFile(join(root,'urlcode.yaml'),stringify({version:'1',routes,...before}));const permissions=await approveBindings(root);
  await writeFile(join(root,'urlcode.yaml'),stringify({version:'1',routes,...after}));const changed=await approveBindings(root);assert.notEqual(changed.projectSha256,permissions.projectSha256);
  await assert.rejects(createRuntime(root,{permissions}),/Egress denied/);
 }
});
