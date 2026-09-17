import test from 'node:test';
import assert from 'node:assert/strict';
import {createTurnstileChallenge} from '../src/challenge.ts';
const config={secret:'secret_value_12345',siteKey:'site_key_12345',hostname:'login.example'};
const input={token:'opaque-token',client:'192.0.2.1',signal:new AbortController().signal};
const verdict=(extra:Record<string,unknown>={})=>({success:true,hostname:config.hostname,action:'auth',challenge_ts:new Date().toISOString(),...extra});
test('Turnstile uses a fixed POST upstream and validates hostname, action, freshness and provider replay verdict',async()=>{
 let calls=0;let response=verdict();
 const challenge=createTurnstileChallenge({...config,fetch:async(url,init)=>{calls++;assert.equal(url,'https://challenges.cloudflare.com/turnstile/v0/siteverify');assert.equal(init?.method,'POST');assert.equal(init?.redirect,'error');const body=new URLSearchParams(String(init?.body));assert.equal(body.get('remoteip'),input.client);assert.equal(body.get('secret'),config.secret);assert.equal(body.get('response'),input.token);return Response.json(response);}});
 assert.equal(await challenge.verify(input),true);
 for(const bad of [{hostname:'evil.example'},{action:'signup'},{success:false},{challenge_ts:new Date(Date.now()-301000).toISOString()},{challenge_ts:'invalid'}]){response=verdict(bad);assert.equal(await challenge.verify(input),false);}
 assert.equal(calls,6);assert.equal(await challenge.verify({...input,client:'forwarded=spoofed'}),false);assert.equal(await challenge.verify({...input,token:'x'.repeat(2049)}),false);assert.equal(calls,6);
 assert.throws(()=>createTurnstileChallenge({...config,hostname:'login.example/path'}));
});
test('Turnstile bounds responses, exceptions, deadlines and outstanding cancellation-ignoring requests',async()=>{
 for(const fetcher of [async()=>new Response('x'.repeat(8193)),async()=>new Response('{}',{status:302}),async()=>{throw new Error('secret upstream details');}])assert.equal(await createTurnstileChallenge({...config,fetch:fetcher}).verify(input),false);
 let calls=0;const never=()=>new Promise<Response>(()=>{});const challenge=createTurnstileChallenge({...config,timeoutMs:10,fetch:()=>{calls++;return never();}});
 const results=await Promise.all(Array.from({length:40},()=>challenge.verify(input)));assert.equal(results.every(value=>value===false),true);assert.equal(calls,32);assert.equal(await challenge.verify(input),false);assert.equal(calls,32);
 const aborted=new AbortController();aborted.abort();assert.equal(await challenge.verify({...input,signal:aborted.signal}),false);
});
