import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Socket } from 'node:net';
import {startServer} from '../src/server.ts';
import type {ServerOptions} from '../src/server.ts';
import {project,redirect,request,param} from './helpers.ts';

test('HTTP admission bounds unfinished uploads, preserves health and recovers after disconnect',async t=>{
 const root=await project(t,{'/go':redirect()});
 const app=await startServer({project:root,port:0,maxInFlightRequests:1,log:()=>{}});
 t.after(()=>app.close());
 const entered=new Promise(resolve=>app.server.once('request',resolve));
 const upload=http.request({host:'127.0.0.1',port:app.address.port,path:'/go',method:'POST',headers:{'transfer-encoding':'chunked'}});
 upload.on('error',()=>{});t.after(()=>upload.destroy());upload.write('unfinished');await entered;
 const overloaded=await request(app,'/go');assert.equal(overloaded.status,503);assert.equal(overloaded.headers.connection,'close');
 assert.equal((await request(app,'/_urlcode/ready')).status,200);
 // Complete the original request to release its admission deterministically.
 const completed=new Promise(resolve=>upload.once('response',res=>{res.resume();res.once('end',resolve);}));
 upload.end();await completed;
 assert.equal((await request(app,'/go')).status,302);
 // A disconnected body must release admission too.
 let peer: Socket|undefined;
 const enteredAgain=new Promise<void>(resolve=>app.server.once('request',req=>{peer=req.socket;resolve();}));
 const aborted=http.request({host:'127.0.0.1',port:app.address.port,path:'/go',method:'POST',agent:false,headers:{'transfer-encoding':'chunked'}});
 aborted.on('error',()=>{});aborted.write('unfinished');await enteredAgain;
 assert.ok(peer);const socket=peer;const disconnected=new Promise(resolve=>socket.once('close',resolve));
 aborted.destroy();await disconnected;
 assert.equal((await request(app,'/go')).status,302);
 assert.equal(app.server.timeout,15000);
});
test('dev watcher uses metadata rather than reading unrelated project JSON',async t=>{
 const {chmod}=await import('node:fs/promises');const {join}=await import('node:path');
 const root=await project(t,{'/go':redirect()},{'private-data.json':'not a configuration dependency'});
 await chmod(join(root,'private-data.json'),0);
 t.after(async()=>{try{await chmod(join(root,'private-data.json'),0o600);}catch(e){if(!(e instanceof Error && 'code' in e && e.code==='ENOENT'))throw e;}});
 const app=await startServer({project:root,port:0,watch:true,log:()=>{}});t.after(()=>app.close());
 assert.equal((await request(app,'/go')).status,302);
});

test('health probes keep their own bounded budget, separate from application admission',async t=>{
 const root=await project(t,{'/go':redirect()});
 const app=await startServer({project:root,port:0,maxInFlightRequests:1,maxInFlightHealthRequests:2,log:()=>{}});
 t.after(()=>app.close());
 // An application request saturating admission must not take health down with it.
 const entered=new Promise(resolve=>app.server.once('request',resolve));
 const upload=http.request({host:'127.0.0.1',port:app.address.port,path:'/go',method:'POST',headers:{'transfer-encoding':'chunked'}});
 upload.on('error',()=>{});t.after(()=>upload.destroy());upload.write('unfinished');await entered;
 assert.equal((await request(app,'/go')).status,503);
 assert.equal((await request(app,'/_urlcode/ready')).status,200);
 assert.equal((await request(app,'/_urlcode/health')).status,200);
 // Probes are metered rather than unmetered: a burst releases its budget on
 // completion, so the endpoint keeps answering instead of latching off. The
 // overload branch is not forced here because a probe response completes too
 // quickly to hold admission deterministically.
 const burst=await Promise.all(Array.from({length:32},()=>request(app,'/_urlcode/health')));
 assert.ok(burst.every(response=>[200,503].includes(response.status)));
 upload.destroy();
 await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal((await request(app,'/_urlcode/health')).status,200);
 assert.equal((await request(app,'/go')).status,302);
});

test('capacity and logging options are validated before the listener starts',async t=>{
 const root=await project(t,{'/go':redirect()});
 // trustRequestId:'yes' is the wrong type on purpose: the server must refuse it at run time.
 const options: Record<string, unknown>[]=[{maxInFlightHealthRequests:0},{maxInFlightHealthRequests:2048},{maxInFlightHealthRequests:1.5},
   {requestLog:'verbose'},{trustRequestId:'yes'},{maxInFlightRequests:0},{maxBodyBytes:0}];
 for(const invalid of options) {
  await assert.rejects(startServer({project:root,port:0,log:()=>{},...invalid as ServerOptions}));
 }
 const app=await startServer({project:root,port:0,log:()=>{},maxInFlightHealthRequests:1,requestLog:'detailed',trustRequestId:false});
 t.after(()=>app.close());
 assert.equal((await request(app,'/_urlcode/health')).status,200);
});

test('request IDs are server-owned unless an operator trusts the upstream proxy',async t=>{
 const root=await project(t,{'/go':redirect()});
 const events: Record<string, unknown>[]=[];
 const standard=await startServer({project:root,port:0,log:event=>events.push(event)});
 t.after(()=>standard.close());
 const spoofed=await request(standard,'/go',{headers:{'x-request-id':'client-chosen-id'}});
 assert.notEqual(spoofed.headers['x-request-id'],'client-chosen-id');
 const trusting=await startServer({project:root,port:0,trustRequestId:true,requestLog:'detailed',log:event=>events.push(event)});
 t.after(()=>trusting.close());
 assert.equal((await request(trusting,'/go',{headers:{'x-request-id':'upstream-id-1'}})).headers['x-request-id'],'upstream-id-1');
 // Unsafe, duplicated or oversized values still fall back to a generated ID.
 assert.notEqual((await request(trusting,'/go',{headers:{'x-request-id':'bad value	'}})).headers['x-request-id'],'bad value	');
 assert.notEqual((await request(trusting,'/go',{headers:{'x-request-id':['a','b']}})).headers['x-request-id'],'a');
 // Detailed logs add the configured route pattern and method, never request text.
 const detailed=events.find(event=>event.event==='request' && event.route==='/go');
 assert.ok(detailed,'no detailed request record for /go');assert.equal(detailed.method,'GET');
 assert.ok(!JSON.stringify(events).includes('client-chosen-id'));
});

test('detailed request logs record the matched pattern, not the request path or query',async t=>{
 const root=await project(t,{'/u/{id}':{parameters:[param('id')],...redirect()}});
 const events: Record<string, unknown>[]=[];
 const app=await startServer({project:root,port:0,requestLog:'detailed',log:event=>events.push(event)});
 t.after(()=>app.close());
 assert.equal((await request(app,'/u/secret-customer?token=secret-token')).status,302);
 const logged=events.find(event=>event.event==='request');
 assert.ok(logged,'no request record was emitted');assert.equal(logged.route,'/u/{id}');
 assert.equal(logged.method,'GET');
 assert.ok(!JSON.stringify(events).includes('secret-customer'));
 assert.ok(!JSON.stringify(events).includes('secret-token'));
 // An unmatched target reports no route rather than echoing the requested path.
 assert.equal((await request(app,'/missing-secret')).status,404);
 assert.equal(events.filter(event=>event.event==='request').at(-1)?.route,null);
 assert.ok(!JSON.stringify(events).includes('missing-secret'));
});
