import test from 'node:test';import assert from 'node:assert/strict';
import {executeProxy,validateProxy} from '../src/proxy.ts';
import type {EgressRequest} from '../src/egress.ts';
test('proxy encodes path arguments and forwards only explicit fields',async()=>{
 let captured:EgressRequest|undefined;
 const result=await executeProxy({request:async input=>{captured=input;return {status:302,headers:{location:'https://other.example/','set-cookie':'secret','content-type':'text/plain'},body:Buffer.from('ok')};}},
 {url:'https://example.com/items/{id}',query:['q'],requestHeaders:['accept'],responseHeaders:['content-type'],headers:{authorization:'Bearer synthetic'}},
 {method:'GET',url:'https://in.example/?q=a&q=b&secret=no',params:{id:'a/b?c'},headers:{accept:'text/plain',cookie:'no'}});
 assert.equal(captured?.url,'https://example.com/items/a%2Fb%3Fc?q=a&q=b');assert.deepEqual({...captured?.headers},{accept:'text/plain',authorization:'Bearer synthetic'});assert.deepEqual({...result.headers},{'content-type':'text/plain'});assert.equal(result.status,302);
});
test('proxy rejects ambient credentials and query templates',()=>{
 for(const definition of [{url:'https://example.com',requestHeaders:['cookie']},{url:'https://example.com',responseHeaders:['set-cookie']},{url:'https://example.com/?q={id}'}]) assert.throws(()=>validateProxy(definition));
});
test('proxy removes headers nominated by incoming and upstream Connection',async()=>{
 const result=await executeProxy({request:async input=>{assert.deepEqual({...input.headers},{});return {status:200,headers:{connection:'x-test','x-test':'private'},body:Buffer.alloc(0)};}},
 {url:'https://example.com',requestHeaders:['x-test'],responseHeaders:['x-test']},{method:'GET',url:'https://in.example',params:{},headers:{connection:'X-Test','x-test':'private'}});
 assert.deepEqual({...result.headers},{});
});
test('proxy forbids all forwarded identity headers',()=>{
 for(const name of ['x-forwarded-client-cert','X-Forwarded-Port','x-forwarded-user'])assert.throws(()=>validateProxy({url:'https://example.com',requestHeaders:[name]}),/denied/);
});
test('proxy preserves explicitly selected request body coding and rejects missing or overridden coding',async()=>{
 let calls=0;const client={request:async()=>{calls++;return {status:200,headers:{},body:Buffer.alloc(0)};}};
 const input={method:'POST',url:'https://incoming.example',params:{},headers:{'content-encoding':'gzip'},body:Buffer.from('compressed bytes')};
 await assert.rejects(executeProxy(client,{url:'https://example.com'},input),/denied/);
 await assert.rejects(executeProxy(client,{url:'https://example.com',requestHeaders:['content-encoding'],headers:{'Content-Encoding':'br'}},input),/denied/);
 await assert.rejects(executeProxy(client,{url:'https://example.com',headers:{'content-encoding':'gzip'}},input),/denied/);
 await assert.rejects(executeProxy(client,{url:'https://example.com',headers:{'content-encoding':'gzip'}},{...input,headers:{}}),/denied/);
 assert.equal(calls,0);await executeProxy(client,{url:'https://example.com',requestHeaders:['content-encoding']},input);assert.equal(calls,1);
});
