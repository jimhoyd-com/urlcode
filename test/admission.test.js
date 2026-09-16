import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {startServer} from '../src/server.js';
import {project,redirect,request} from './helpers.js';

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
 let peer;
 const enteredAgain=new Promise(resolve=>app.server.once('request',req=>{peer=req.socket;resolve();}));
 const aborted=http.request({host:'127.0.0.1',port:app.address.port,path:'/go',method:'POST',agent:false,headers:{'transfer-encoding':'chunked'}});
 aborted.on('error',()=>{});aborted.write('unfinished');await enteredAgain;
 const disconnected=new Promise(resolve=>peer.once('close',resolve));
 aborted.destroy();await disconnected;
 assert.equal((await request(app,'/go')).status,302);
 assert.equal(app.server.timeout,15000);
});
test('dev watcher uses metadata rather than reading unrelated project JSON',async t=>{
 const {chmod}=await import('node:fs/promises');const {join}=await import('node:path');
 const root=await project(t,{'/go':redirect()},{'private-data.json':'not a configuration dependency'});
 await chmod(join(root,'private-data.json'),0);
 t.after(async()=>{try{await chmod(join(root,'private-data.json'),0o600);}catch(e){if(e.code!=='ENOENT')throw e;}});
 const app=await startServer({project:root,port:0,watch:true,log:()=>{}});t.after(()=>app.close());
 assert.equal((await request(app,'/go')).status,302);
});
