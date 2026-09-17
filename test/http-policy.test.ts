import test from 'node:test';
import assert from 'node:assert/strict';
import { project, request, redirect } from './helpers.ts';
import { startServer } from '../src/server.ts';
import { createRuntime } from '../src/runtime.ts';
async function appFor(t,routes,files={}) {
 const root=await project(t,routes,files); const app=await startServer({project:root,port:0,log:()=>{}}); t.after(()=>app.close()); return app;
}
test('YAML response headers apply to functions and redirects; cookies remain separate',async t=>{
 const app=await appFor(t,{
  '/go':{...redirect(),response:{headers:{'Cache-Control':'public, max-age=60','X-Example':'redirect'}}},
  '/fn':{function:{source:'fn.mjs'},response:{headers:{'x-example':'yaml','set-cookie':['a=1; HttpOnly; SameSite=Lax','b=2; Secure']}}}
 },{'fn.mjs':'export default () => new Response("ok",{headers:{"x-example":"code","set-cookie":"old=1"}})'});
 const go=await request(app,'/go');assert.equal(go.status,302);assert.equal(go.headers.location,'https://example.com/');assert.equal(go.headers['cache-control'],'public, max-age=60');
 const fn=await request(app,'/fn');assert.equal(fn.body,'ok');assert.equal(fn.headers['x-example'],'yaml');assert.deepEqual(fn.headers['set-cookie'],['a=1; HttpOnly; SameSite=Lax','b=2; Secure']);
 assert.equal((await request(app,'/fn',{method:'HEAD'})).body,'');
});
test('declarative text, JSON and empty responses use correct bodies and statuses',async t=>{
 const app=await appFor(t,{'/json':{respond:{status:201,json:{ok:true}}},'/text':{respond:{text:'Hello'}},'/empty':{respond:{status:204}},'/reset':{respond:{status:205}}});
 const json=await request(app,'/json');assert.equal(json.status,201);assert.deepEqual(JSON.parse(json.body),{ok:true});assert.match(json.headers['content-type'],/^application\/json/);
 assert.equal((await request(app,'/text')).body,'Hello');
 for(const path of ['/empty','/reset'])assert.equal((await request(app,path)).body,'');
 assert.equal((await request(app,'/json',{method:'HEAD'})).body,'');
});
test('request body policies reject size, media, encoding and malformed JSON before handler',async t=>{
 const app=await appFor(t,{'/echo':{methods:['POST'],request:{body:{required:true,maxBytes:32,contentTypes:['application/json'],format:'json'}},function:{source:'echo.mjs'}}},{'echo.mjs':'export default async request => Response.json(await request.json())'});
 const send=(body,headers={'content-type':'application/json'})=>request(app,'/echo',{method:'POST',body,headers});
 assert.equal((await send('{"a":1}')).status,200);
 assert.equal((await send('')).status,400);assert.equal((await send('{')).status,400);
 assert.equal((await send('"'+ 'a'.repeat(32)+'"')).status,413);
 assert.equal((await send('{}',{'content-type':'text/plain'})).status,415);
 assert.equal((await send('{}',{'content-type':'application/json','content-encoding':'gzip'})).status,415);
 assert.equal((await send(Buffer.from([255]),{'content-type':'application/json'})).status,400);
 assert.equal((await send('{}',{'content-type':'application/json; charset=utf-8','transfer-encoding':'chunked'})).status,200);
 assert.equal((await send('x'.repeat(33),{'content-type':'application/json','transfer-encoding':'chunked'})).status,413);
 assert.equal((await request(app,'/echo')).status,405);
});
test('invalid response policy and contradictory declarations fail activation',async t=>{
 for(const route of [
  {respond:{text:'x',json:{}}}, {respond:{status:204,text:'x'}}, {respond:{status:304}},
  {respond:{json:{}},response:{headers:{'content-type':'text/html'}}},
  ...['Content-Length','Location','Connection','X-Content-Type-Options','ETag'].map(name=>({respond:{},response:{headers:{[name]:'bad'}}})),
  {respond:{},response:{headers:{'x-a':'ok','X-A':'bad'}}},
  {respond:{},response:{headers:{'x-a':'bad\r\ninjected:true'}}},
  {respond:{},response:{headers:{'x-a':['a','b']}}},
  {respond:{},redirect:{url:'https://example.com'}},
 ]) { const root=await project(t,{'/a':route});await assert.rejects(createRuntime(root)); }
});
