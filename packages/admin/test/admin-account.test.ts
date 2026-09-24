import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {AuthHttp,createPresentation} from '@jimhoyd/urlcode-auth';
import type {AuthPrincipal,AdminAccountService,AdminAccountDelivery} from '@jimhoyd/urlcode-auth';
import type {ExtensionRequest} from '@jimhoyd/urlcode/extensions';
import {createAdminAccount} from '../src/admin-account.ts';
import {activatedUi,testUiHost} from './support/render.ts';
const ui=testUiHost();
const actorToken='a'.repeat(43),origin='https://example.test',principal:AuthPrincipal={id:'admin',email:'admin@example.test',emailVerified:true,roles:['admin'],permissions:['*'],sessionId:'session',authenticatedAt:Date.now()};
function setup(deliver:(message:AdminAccountDelivery)=>Promise<void>=async()=>{}){
 const calls:string[]=[],http=new AuthHttp({origin,csrfKey:randomBytes(32)});
 const service:AdminAccountService&{getUser(accountId:string):Promise<null>}={getUser:async()=>null,inspectAccountAuthentication:async()=>({accountId:'target',password:true,totp:true,passkeys:[{id:'<unsafe>',secondFactor:true}],external:[{id:'b'.repeat(64),provider:'<provider>'}]}),stageAccountAdministration:async()=>{calls.push('stage');return {operationId:'operator-only-operation',deliveries:[{kind:'token',accountId:'target',email:'private@example.test',purpose:'reset-password',token:'private-token'}]};},completeAccountAdministration:async()=>{calls.push('complete');return {affected:1};},cancelAccountAdministration:async()=>{calls.push('cancel');}};
 const helper=createAdminAccount({service,sendAccountAdministration:async message=>{calls.push('deliver');await deliver(message);}},http,'/admin');
 function request(method='POST',fields:Record<string,string>={}):ExtensionRequest{return {method,path:'/admin/account-operations',target:'/admin/account-operations',query:new URLSearchParams({accountId:'target'}),headers:new Headers({cookie:'__Host-urlcode-session='+actorToken,origin,...(method==='POST'?{'content-type':'application/json',accept:'application/json'}:{accept:'text/html'})}),headerCounts:{cookie:1,origin:1},body:method==='POST'?new TextEncoder().encode(JSON.stringify({action:'force-password-reset',accountIds:'target',confirmation:'FORCE-PASSWORD-RESET 1',reason:'Reviewed account request',csrf:http.token(actorToken),...fields})):new Uint8Array(),origin,route:'/admin/*',mount:'/admin',client:null, requestId: 'test-request', env: {}};}
 return {calls,helper,request,service};
}
test('account operations deliver privately before commit and never expose staged authority',async()=>{
 const {calls,helper,request}=setup();const response=await helper.handle(request(),principal,actorToken,{presentation:createPresentation().resolve(),ui});assert.equal(response?.status,200);assert.deepEqual(calls,['stage','deliver','complete']);assert.doesNotMatch(Buffer.from(response?.body??'').toString(),/private|operator-only/);
});
test('failed notices cancel staged changes without commit',async()=>{
 const {calls,helper,request}=setup(async()=>{throw new Error('Sender unavailable');});await assert.rejects(helper.handle(request(),principal,actorToken,{presentation:createPresentation().resolve(),ui}),/Sender unavailable/);assert.deepEqual(calls,['stage','deliver','cancel']);
});
test('typed confirmation, same-origin CSRF and management permission precede staging',async()=>{
 const {calls,helper,request}=setup(),context=createPresentation().resolve();await assert.rejects(helper.handle(request('POST',{confirmation:'FORCE-PASSWORD-RESET 2'}),principal,actorToken,{presentation:context,ui}));const forged=request();forged.headers.set('origin','https://attacker.test');await assert.rejects(helper.handle(forged,principal,actorToken,{presentation:context,ui}));await assert.rejects(helper.handle(request(),{...principal,permissions:['auth.users.read']},actorToken,{presentation:context,ui}));assert.deepEqual(calls,[]);
});
test('method page escapes identifiers and routes enrolled factor removal through two-admin cases',async()=>{
 const {helper,request}=setup(),response=await helper.handle(request('GET'),principal,actorToken,{presentation:createPresentation().resolve(),ui});const body=Buffer.from(response?.body??'').toString();assert.match(body,/&lt;unsafe&gt;/);assert.match(body,/&lt;provider&gt;/);assert.match(body,/two-administrator case/);assert.doesNotMatch(body,/name="credentialId" value="&lt;unsafe&gt;"/);
});

import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAuthService} from '@jimhoyd/urlcode-auth';
import {adminExtension} from '../src/admin.ts';
test('real admin handler stages account mutation until notice succeeds and records per-user audit',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'admin-account-handler-'));cleanup(t, ()=>rm(directory,{recursive:true,force:true}));const service=await createAuthService({database:join(directory,'auth.sqlite'),encryptionKey:randomBytes(32),roles:{member:['site.read'],admin:['*']},defaultRole:'member'});cleanup(t, ()=>service.close());
 const admin=await service.bootstrapAdmin({email:'owner@example.test',password:'synthetic administrator password'}),target=await service.register({email:'subject@example.test',password:'synthetic subject password'}),csrfKey=randomBytes(32),http=new AuthHttp({origin,csrfKey}),projectSha256='a'.repeat(64);let fail=true,delivered=0;
 const instance=await adminExtension({service,csrfKey,projectSha256,ui:await activatedUi(t,directory,projectSha256),sendAccountAdministration:async message=>{assert.equal((await service.getUser(target.user.id))?.emailVerified,false);assert.equal(message.email,target.user.email);if(fail)throw new Error('Notice rejected');delivered++;}}).activate({}, {origin,target:'node',projectSha256,mounts:['/admin'], root: import.meta.dirname});
 const invoke=()=>instance.handle({method:'POST',path:'/admin/account-operations',target:'/admin/account-operations',query:new URLSearchParams(),headers:new Headers({cookie:'__Host-urlcode-session='+admin.token,origin,'content-type':'application/json',accept:'application/json'}),headerCounts:{cookie:1,origin:1},body:new TextEncoder().encode(JSON.stringify({csrf:http.token(admin.token),action:'verify-email',accountIds:target.user.id,reason:'Documented manual verification',confirmation:'VERIFY-EMAIL 1'})),origin,route:'/admin/*',mount:'/admin',client:null, requestId: 'test-request', env: {}});
 assert.notEqual((await invoke()).status,200);assert.equal((await service.getUser(target.user.id))?.emailVerified,false);fail=false;const response=await invoke();assert.equal(response.status,200);assert.equal(delivered,1);assert.equal((await service.getUser(target.user.id))?.emailVerified,true);assert.equal(await service.authenticate(target.token),null);assert.doesNotMatch(Buffer.from(response.body??'').toString(),/subject@example|operationId|token/);assert.ok((await service.listAudit({subject:target.user.id})).events.some(event=>event.action==='admin.verify-email'));
});
