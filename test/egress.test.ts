import test from 'node:test';
import assert from 'node:assert/strict';
import {EGRESS_DNS_LIMIT,EgressClient,egressUrl,isPublicAddress,safeEgressHeaders} from '../packages/core/src/egress.ts';
test('egress rejects nonpublic IPv4, mapped IPv6 and special IPv6 addresses',()=>{
 for(const address of ['0.0.0.0','10.0.0.1','127.0.0.1','100.64.0.1','169.254.169.254','172.16.0.1','192.168.1.1','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','::1','::ffff:8.8.8.8','fc00::1','fe80::1','2001:db8::1','2002:0808:0808::1']) assert.equal(isPublicAddress(address),false,address);
 for(const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) assert.equal(isPublicAddress(address),true,address);
});
test('egress URLs and headers reject authority tricks and hop-by-hop fields',()=>{
 for(const url of ['http://example.com','https://secret@example.com','https://example.com/#secret','https://example.com./']) assert.throws(()=>egressUrl(url));
 for(const name of ['host','Content-Length','transfer-encoding','connection','proxy-authorization']) assert.throws(()=>safeEgressHeaders({[name]:'x'}));
 assert.throws(()=>safeEgressHeaders({'x-test':'hello\r\nsecret: value'}));assert.throws(()=>safeEgressHeaders({'x-test':'12345'},3));
});
test('egress denies ungranted destinations, private literals, oversized bodies and closed requests without networking',async()=>{
 const client=new EgressClient({grantOrigins:['https://127.0.0.1'],maxRequestBytes:2});
 await assert.rejects(client.request({url:'https://example.com',method:'GET'}),/denied/);
 await assert.rejects(client.request({url:'https://127.0.0.1',method:'GET'}),/denied/);
 await assert.rejects(client.request({url:'https://127.0.0.1',method:'POST',body:Buffer.from('abc')}),/limit/);
 await client.close();await assert.rejects(client.request({url:'https://127.0.0.1',method:'GET'}),/closed/);
});
test('egress checks all DNS answers, denies mixed public/private results before opening a connection',async()=>{
 let opened=false;
 const client=new EgressClient({grantOrigins:['https://example.com']},{resolve:async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}],request:(()=>{opened=true;throw new Error('must not connect');}) as typeof import('node:https').request});
 await assert.rejects(client.request({url:'https://example.com',method:'GET'}),/denied/);assert.equal(opened,false);await client.close();
});
test('DNS stalls have a deadline and cannot connect after close; concurrency has no queue',async()=>{
 let release:((answers:{address:string;family:number}[])=>void)|undefined;let opened=false;
 const client=new EgressClient({grantOrigins:['https://example.com'],timeoutMs:10,concurrency:1},{resolve:()=>new Promise(resolve=>{release=resolve;}),request:(()=>{opened=true;throw new Error('must not connect');}) as typeof import('node:https').request});
 const pending=client.request({url:'https://example.com',method:'GET'});
 await assert.rejects(client.request({url:'https://example.com',method:'GET'}),/busy/);await assert.rejects(pending,/timeout/);await client.close();release!([{address:'8.8.8.8',family:4}]);await Promise.resolve();assert.equal(opened,false);
});
test('transport pins a validated answer, preserves TLS hostname and returns redirects without following',async()=>{
 const {EventEmitter}=await import('node:events');let calls=0;
 const fake=((url:URL,options:import('node:https').RequestOptions,callback:(response:unknown)=>void)=>{
  calls++;assert.equal(url.hostname,'example.com');assert.equal(options.agent,false);assert.equal(options.rejectUnauthorized,undefined);
  options.lookup!('example.com',{all:true},(error,address)=>{assert.equal(error,null);assert.deepEqual(address,[{address:'8.8.8.8',family:4}]);});
  const req=new EventEmitter() as InstanceType<typeof EventEmitter>&{end:()=>void;destroy:()=>void};
  req.destroy=()=>{};req.end=()=>{const res=Object.assign(new EventEmitter(),{statusCode:302,headers:{location:'https://127.0.0.1/private'}});callback(res);res.emit('data',Buffer.from('redirect'));res.emit('end');};return req;
 }) as unknown as typeof import('node:https').request;
 const client=new EgressClient({grantOrigins:['https://example.com']},{resolve:async()=>[{address:'8.8.8.8',family:4}],request:fake});
 const result=await client.request({url:'https://example.com',method:'GET'});assert.equal(result.status,302);assert.equal(calls,1);await client.close();
});
test('transport destroys oversized response and emits only a fixed error category',async()=>{
 const {EventEmitter}=await import('node:events');let destroyed=false;
 const fake=((_url:URL,_options:unknown,callback:(response:unknown)=>void)=>{
  const req=new EventEmitter() as InstanceType<typeof EventEmitter>&{end:()=>void;destroy:()=>void};req.destroy=()=>{destroyed=true;};
  req.end=()=>{const res=Object.assign(new EventEmitter(),{statusCode:200,headers:{}});callback(res);res.emit('data',Buffer.alloc(3));};return req;
 }) as unknown as typeof import('node:https').request;
 const client=new EgressClient({grantOrigins:['https://example.com'],maxResponseBytes:2},{resolve:async()=>[{address:'8.8.8.8',family:4}],request:fake});
 await assert.rejects(client.request({url:'https://example.com/private?secret=synthetic',method:'GET'}),{message:'Egress limit'});assert.equal(destroyed,true);await client.close();
});
test('timed out underlying DNS operations retain their own concurrency slots',async()=>{
 let lookups=0;const releases:((answers:{address:string;family:number}[])=>void)[]=[];
 const client=new EgressClient({grantOrigins:['https://example.com'],timeoutMs:5,concurrency:2},{resolve:()=>{lookups++;return new Promise(resolve=>{releases.push(resolve);});}});
 for(let index=0;index<2;index++) await assert.rejects(client.request({url:'https://example.com',method:'GET'}),/timeout/);
 for(let index=0;index<8;index++) await assert.rejects(client.request({url:'https://example.com',method:'GET'}),/busy/);
 assert.equal(lookups,2);await client.close();for(const release of releases)release([{address:'8.8.8.8',family:4}]);await Promise.resolve();
});
test('process DNS cap survives closed client lifetimes and releases only when underlying lookups settle',async()=>{
 const releases:((answers:{address:string;family:number}[])=>void)[]=[];let opened=0;
 const dependencies={resolve:()=>new Promise<{address:string;family:number}[]>(resolve=>{releases.push(resolve);}),request:(()=>{opened++;throw new Error('late socket');}) as typeof import('node:https').request};
 try {
  for(let index=0;index<EGRESS_DNS_LIMIT;index++) {const client=new EgressClient({grantOrigins:['https://example.com'],timeoutMs:1,concurrency:1},dependencies);await assert.rejects(client.request({url:'https://example.com',method:'GET'}),/timeout/);await client.close();}
  const excess=new EgressClient({grantOrigins:['https://example.com']},dependencies);await assert.rejects(excess.request({url:'https://example.com',method:'GET'}),/busy/);await excess.close();assert.equal(releases.length,EGRESS_DNS_LIMIT);
 }finally{for(const release of releases)release([{address:'8.8.8.8',family:4}]);await Promise.resolve();await Promise.resolve();}
 assert.equal(opened,0);
 const recovered=new EgressClient({grantOrigins:['https://example.com']},{resolve:async()=>[{address:'127.0.0.1',family:4}]});await assert.rejects(recovered.request({url:'https://example.com',method:'GET'}),/denied/);await recovered.close();
});
