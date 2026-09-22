import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project,request,redirect,approveBindings } from './helpers.ts';
import type { ProjectRoutes, ProjectFiles } from './helpers.ts';
import type { TestContext } from 'node:test';
import type { ServerOptions } from '../packages/core/src/server.ts';
import { startServer } from '../packages/core/src/server.ts';
import { createRuntime } from '../packages/core/src/runtime.ts';
import { auditProject } from '../packages/core/src/readiness.ts';
async function serve(t: TestContext,routes: ProjectRoutes,files: ProjectFiles,options: ServerOptions={}) {
 const root=await project(t,routes,files);const app=await startServer({project:root,port:0,log:()=>{},...options});t.after(()=>app.close());return {root,app};
}
test('middleware wraps function in declared/reverse order and shares only request-local state',async t=>{
 const {app}=await serve(t,{'/f':{sandbox:true,middleware:[{source:'a.mjs'},{source:'b.mjs',export:'wrap'}],function:{source:'f.mjs'}}},{
  'a.mjs':'let count=0; export default async (request,ctx,next) => {ctx.state.trace=["a-in"];ctx.state.count=++count; const res=await next();ctx.state.trace.push("a-out");res.headers.set("x-trace",ctx.state.trace.join(","));return res;}',
  'b.mjs':'export async function wrap(request,ctx,next) {ctx.state.trace.push("b-in");request.headers.set("x-injected","yes");const res=await next();ctx.state.trace.push("b-out");return res;}',
  'f.mjs':'export default (request,ctx) => {ctx.state.trace.push("handler");return Response.json({count:ctx.state.count,injected:request.headers.get("x-injected")});}'
 });
 for(let i=0;i<2;i++){const res=await request(app,'/f');assert.equal(res.status,200);assert.equal(res.headers['x-trace'],'a-in,b-in,handler,b-out,a-out');assert.deepEqual(JSON.parse(res.body),{count:1,injected:'yes'});}
 assert.equal((await request(app,'/f',{method:'HEAD'})).body,'');
});
test('middleware can short-circuit without invoking downstream code and can recover downstream errors',async t=>{
 const {app}=await serve(t,{'/deny':{sandbox:true,middleware:[{source:'deny.mjs'}],function:{source:'loop.mjs'}},'/recover':{sandbox:true,middleware:[{source:'catch.mjs'}],function:{source:'throw.mjs'}}},{
  'deny.mjs':'export default () => new Response("blocked",{status:403})',
  'loop.mjs':'export default () => {while(true){}}',
  'catch.mjs':'export default async (req,ctx,next) => {try{return await next();}catch{return new Response("fallback",{status:503});}}',
  'throw.mjs':'export default () => {throw new Error("private");}'
 });
 assert.equal((await request(app,'/deny')).status,403);const res=await request(app,'/recover');assert.equal(res.status,503);assert.equal(res.body,'fallback');
});
test('native redirects and binary assets retain their bytes and metadata through middleware',async t=>{
 const wrap=()=>[{source:'wrap.mjs'}];const bytes=Buffer.from([0,255,128,1]);
 const {app}=await serve(t,{'/go':{...redirect(),sandbox:true,middleware:wrap()},'/file':{download:{file:'public/a.bin'},sandbox:true,middleware:wrap()},'/assets/*':{static:{directory:'public'},sandbox:true,middleware:wrap()}},
 {'wrap.mjs':'export default async (req,ctx,next) => {const res=await next();res.headers.set("x-middleware","yes");return res;}', 'public/a.bin':bytes});
 const go=await request(app,'/go');assert.equal(go.status,302);assert.equal(go.headers.location,'https://example.com/');assert.equal(go.headers['x-middleware'],'yes');
 const full=await request(app,'/file');assert.deepEqual(full.bytes,bytes);assert.equal(full.headers['content-length'],'4');
 const range=await request(app,'/file',{headers:{range:'bytes=1-2'}});assert.equal(range.status,206);assert.deepEqual(range.bytes,bytes.subarray(1,3));assert.equal(range.headers['content-range'],'bytes 1-2/4');
 assert.equal((await request(app,'/file',{headers:{'if-none-match':full.headers.etag}})).status,304);
 assert.equal((await request(app,'/file',{method:'HEAD'})).headers['content-length'],'4');
 const missing=await request(app,'/assets/missing');assert.equal(missing.status,404);assert.equal(missing.headers['x-middleware'],'yes');
});
test('native metadata changes, double next and missing Response fail closed',async t=>{
 const {app}=await serve(t,{
  '/metadata':{...redirect(),sandbox:true,middleware:[{source:'metadata.mjs'}]},
  '/twice':{...redirect(),sandbox:true,middleware:[{source:'twice.mjs'}]},
  '/empty':{...redirect(),sandbox:true,middleware:[{source:'empty.mjs'}]}
 },{'metadata.mjs':'export default async (req,ctx,next) => {const res=await next();res.headers.set("location","https://bad.example");return res;}',
 'twice.mjs':'export default async (req,ctx,next) => {const res=await next();try{await next();}catch{}return res;}',
 'empty.mjs':'export default async (req,ctx,next) => {await next();}' });
 for(const path of ['/metadata','/twice','/empty'])assert.equal((await request(app,path)).status,502);
});
test('one deadline bounds the entire middleware chain; plain redirects remain native',async t=>{
 const {app}=await serve(t,{'/slow':{...redirect(),sandbox:true,middleware:[{source:'slow.mjs'},{source:'slow.mjs'}]},'/fast':redirect()},
 {'slow.mjs':'export default async (req,ctx,next) => {await new Promise(r=>setTimeout(r,200));return next();}'},{timeoutMs:300});
 assert.equal((await request(app,'/slow')).status,504);assert.equal((await request(app,'/fast')).status,302);
});
test('middleware shares sandbox restrictions and cannot import unrelated route modules',async t=>{
 const {app}=await serve(t,{'/f':{sandbox:true,middleware:[{source:'mw.mjs'}],respond:{text:'native'}},'/other':{sandbox:true,function:{source:'secret.mjs'}}},{
 'mw.mjs':'export default async (req,ctx,next) => {if(typeof process!=="undefined" || typeof fetch!=="undefined" || typeof require!=="undefined")throw new Error("escape");try{await Function("return import(\\"/secret.mjs\\")")();return new Response("leaked");}catch{}return next();}',
 'secret.mjs':'export default () => new Response("private-other-route")'});
 assert.equal((await request(app,'/f')).body,'native');
 const root=await project(t,{'/x':{...redirect(),sandbox:true,middleware:[{source:'unsafe.mjs'}]}},{'unsafe.mjs':'import fs from "node:fs";export default()=>new Response(fs.readFileSync("/etc/passwd"))'});await assert.rejects(createRuntime(root));
});
test('middleware edits invalidate binding grants and failed reload preserves the old snapshot',async t=>{
 const root=await project(t,{'/go':{...redirect(),sandbox:true,middleware:[{source:'mw.mjs'}],secrets:{KEY:{secret:'key'}}}},{'mw.mjs':'export default async (req,ctx,next) => {const res=await next();res.headers.set("x-value",ctx.secrets.KEY);return res;}'});
 const permissions=await approveBindings(root);const app=await startServer({project:root,port:0,log:()=>{},permissions,environment:{key:'approved'}});t.after(()=>app.close());
 assert.equal((await request(app,'/go')).headers['x-value'],'approved');
 await writeFile(join(root,'mw.mjs'),'export default () => new Response("changed")');assert.equal(await app.reload(),false);assert.equal((await request(app,'/go')).headers['x-value'],'approved');
 await assert.rejects(createRuntime(root,{permissions,environment:{key:'approved'}}));
});
test('readiness does not assume middleware-wrapped native routes behave like plain redirects',async t=>{
 const {app}=await serve(t,{'/go':{...redirect(),sandbox:true,middleware:[{source:'mw.mjs'}]}},{'mw.mjs':'export default (req,ctx,next)=>next()'});
 const report=await auditProject(app);assert.equal(report.ready,false);assert.equal(report.checks,0);assert.equal(report.uncovered.length,2);
});
test('middleware respects validation, final YAML headers and explicit native response replacement',async t=>{
 const {app}=await serve(t,{'/go':{...redirect(),sandbox:true,middleware:[{source:'replace.mjs'}],response:{headers:{'x-final':'yaml'}},parameters:[{name:'key',in:'query',required:true,schema:{type:'string'}}]}},
 {'replace.mjs':'export default async (req,ctx,next)=>{await next();return new Response("replacement",{status:201,headers:{"x-final":"guest"}})}'});
 assert.equal((await request(app,'/go')).status,400);
 assert.equal((await request(app,'/go?key=yes',{method:'POST'})).status,405);
 const res=await request(app,'/go?key=yes');assert.equal(res.status,201);assert.equal(res.body,'replacement');assert.equal(res.headers['x-final'],'yaml');assert.equal(res.headers.location,undefined);
});
test('missing middleware exports reject startup and next arguments fail closed',async t=>{
 const root=await project(t,{'/go':{...redirect(),sandbox:true,middleware:[{source:'mw.mjs',export:'missing'}]}},{'mw.mjs':'export default (req,ctx,next)=>next()'});
 await assert.rejects(createRuntime(root));
 const {app}=await serve(t,{'/go':{...redirect(),sandbox:true,middleware:[{source:'mw.mjs'}]}},{'mw.mjs':'export default (req,ctx,next)=>next("unsupported")'});
 assert.equal((await request(app,'/go')).status,502);
});
