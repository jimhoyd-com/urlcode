import test from 'node:test';import assert from 'node:assert/strict';
import {SignalBroker} from '../packages/core/src/signals.ts';import type {EgressRequest,EgressResponse} from '../packages/core/src/egress.ts';
test('signals are bounded, asynchronous, fixed payload and never retried',async()=>{
 let captured:EgressRequest|undefined;let complete:((r:EgressResponse)=>void)|undefined;
 const broker=new SignalBroker({request:async input=>{captured=input;return new Promise(resolve=>{complete=resolve;});}},1);
 assert.equal(broker.emit({url:'https://example.com/hook'},{route:'/items/{id}',status:200,method:'GET'}),true);assert.equal(captured,undefined);
 assert.equal(broker.emit({url:'https://example.com/hook'},{route:'/second',status:200,method:'GET'}),false);
 await Promise.resolve();assert.deepEqual(JSON.parse(Buffer.from(captured!.body!).toString()),{version:1,route:'/items/{id}',status:200,method:'GET'});
 complete!({status:503,headers:{},body:Buffer.alloc(0)});await broker.close();assert.deepEqual(broker.stats,{accepted:1,delivered:0,failed:1,dropped:1});
 assert.equal(broker.emit({url:'https://example.com/hook'},{route:'/third',status:200,method:'GET'}),false);
});
test('signals redact errors and count failures',async()=>{
 const broker=new SignalBroker({request:async()=>{throw new Error('secret-url');}});
 broker.emit({url:'https://example.com'},{route:'/x',status:204,method:'POST'});await broker.close();assert.equal(broker.stats.failed,1);
});
test('signal counter observers receive redacted snapshots and cannot break delivery',async()=>{
 const observations:unknown[]=[];
 const broker=new SignalBroker({request:async()=>({status:204,headers:{},body:Buffer.alloc(0)})},1,stats=>{observations.push(stats);throw new Error('observer failure');});
 assert.equal(broker.emit({url:'https://example.com/secret'},{route:'/x',status:200,method:'GET'}),true);await broker.close();
 assert.deepEqual(observations,[{accepted:1,delivered:0,failed:0,dropped:0},{accepted:1,delivered:1,failed:0,dropped:0}]);
});
