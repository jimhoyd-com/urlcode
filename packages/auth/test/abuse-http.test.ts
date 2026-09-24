import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ExtensionRequest} from '@jimhoyd/urlcode/extensions';
import {createAuthService} from '../src/auth-core.ts';
import {AuthHttp} from '../src/auth-ui.ts';
import {createAbuseGuard} from '../src/abuse-http.ts';
import {activatedUi} from './support/render.ts';
test('entry guard binds CSRF and trusted client, challenges under pressure and never bypasses hard budgets',async t=>{
 const root=await mkdtemp(join(tmpdir(),'abuse-http-'));cleanup(t, ()=>rm(root,{recursive:true,force:true}));
 const service=await createAuthService({database:join(root,'auth.sqlite'),encryptionKey:randomBytes(32),roles:{member:[]},defaultRole:'member',abuse:{client:{limit:3,windowMs:60000},challengeAfter:1}});cleanup(t, ()=>service.close());
 const origin='https://site.example',http=new AuthHttp({origin,csrfKey:randomBytes(32)}),binding=randomBytes(32).toString('base64url');let calls=0;
 const ui=await activatedUi(t,root,'a'.repeat(64),origin);
 const guard=createAbuseGuard(service,http,'/account',{async verify(input){calls++;assert.equal(input.client,'192.0.2.1');return input.token==='valid';}},ui);
 function request(path='/login',token=''):ExtensionRequest {const headers=new Headers({'content-type':'application/json',origin,cookie:'__Host-urlcode-flow='+binding,'x-forwarded-for':'198.51.100.1',accept:'application/json'});return {method:'POST',path:'/account'+path,target:'/account'+path,query:new URLSearchParams(),headers,headerCounts:Object.fromEntries([...headers].map(([key])=>[key,1])),body:Buffer.from(JSON.stringify({csrf:http.token(binding),challengeToken:token})),origin,mount:'/account',route:'/account/*',client:'192.0.2.1', requestId: 'test-request', env: {}};}
 const foreign=request();foreign.headers.set('origin','https://foreign.example');await assert.rejects(guard(foreign));assert.equal(calls,0);
 assert.equal(await guard(request()),undefined);
 assert.equal((await guard(request()))?.status,403);
 assert.equal(await guard(request('/login','valid')),undefined);assert.equal(calls,1);
 await assert.rejects(guard(request('/login','valid')),{code:'auth_rate_limited'});assert.equal(calls,1);
 assert.equal(await guard(request('/providers/example/callback','valid')),undefined);
 assert.equal(await guard(request('/reset','valid')),undefined);
 const missing=request();missing.client=null;await assert.rejects(guard(missing),{code:'trusted_client_required'});
});
