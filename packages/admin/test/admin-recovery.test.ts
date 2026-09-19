import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {AuthHttp,createPresentation} from '@jimhoyd/urlcode-auth';
import type {AuthPrincipal,ManualRecoveryCase} from '@jimhoyd/urlcode-auth';
import type {ExtensionRequest} from '@jimhoyd/urlcode/extensions';
import {createAdminRecovery} from '../src/admin-recovery.ts';
import type {AdminRecoveryOptions} from '../src/admin-recovery.ts';
const actorToken='a'.repeat(43),origin='https://example.test';
const principal:AuthPrincipal={id:'checker',email:'checker@example.test',emailVerified:true,roles:['admin'],permissions:['*'],sessionId:'session',authenticatedAt:Date.now()};
function setup(deliver:(message:unknown)=>Promise<void>=async()=>{}){
 const calls:string[]=[],http=new AuthHttp({origin,csrfKey:randomBytes(32)});
 const item:ManualRecoveryCase={id:'case',accountId:'target',action:'restore-access',reason:'Human review',makerId:'maker',status:'pending',created:Date.now(),expires:Date.now()+3600000,targetVersion:1,recovery:{email:'replacement@example.test',evidence:{summary:'<img src=x onerror=alert(1)>',reference:'https://internal.invalid/evidence'},state:'review'}};
 const service:AdminRecoveryOptions['service']={getManualRecoveryEnabled:()=>true,createRecoveryCase:async()=>{calls.push('create');return item;},listRecoveryCases:async()=>({cases:[item]}),approveRecoveryCase:async()=>{calls.push('approve');return {case:item,token:'s'.repeat(43),email:item.recovery.email,oldEmail:'old@example.test'};},activateRecoveryCase:async()=>{calls.push('activate');},cancelRecoveryCredential:async()=>{calls.push('cancel');},redeemRecoveryCase:async()=>{throw new Error('Not an admin operation');},closeCase:async()=>{calls.push('close');},addCaseNote:async()=>{calls.push('note');}};
 const helper=createAdminRecovery({service,sendRecovery:async message=>{calls.push('deliver');await deliver(message);}},http,'/admin');
 function request(path:string,method='GET',data:Record<string,string>={},json=false):ExtensionRequest{return {method,path:'/admin'+path,target:'/admin'+path,query:new URLSearchParams(),headers:new Headers({cookie:'__Host-urlcode-session='+actorToken,origin,...(method==='POST'?{'content-type':'application/json'}:{}),...(json?{accept:'application/json'}:{accept:'text/html'})}),headerCounts:{cookie:1,origin:1},body:method==='POST'?new TextEncoder().encode(JSON.stringify({...data,csrf:http.token(actorToken)})):new Uint8Array(),origin,route:'/admin/*',mount:'/admin',client:null};}
 return {calls,helper,request,service};
}
test('manual recovery admin escapes evidence and requires explicit confirmation before private delivery',async()=>{
 const {calls,helper,request}=setup();const context=createPresentation().resolve();
 const page=await helper.handle(request('/recovery-cases'),principal,actorToken,{presentation:context});assert.equal(page?.status,200);assert.match(Buffer.from(page?.body??'').toString(),/&lt;img/);assert.doesNotMatch(Buffer.from(page?.body??'').toString(),/<img src=x|replacement@example.test/);
 const listing=await helper.handle(request('/recovery-cases','GET',{},true),principal,actorToken,{presentation:context});assert.doesNotMatch(Buffer.from(listing?.body??'').toString(),/replacement@example.test/);assert.doesNotMatch(Buffer.from(page?.body??'').toString(),/href="https:\/\/internal/);
 await assert.rejects(helper.handle(request('/recovery-cases/approve','POST',{caseId:'case',reason:'Independent assessment'}),principal,actorToken,{presentation:context}));assert.deepEqual(calls,[]);
 const response=await helper.handle(request('/recovery-cases/approve','POST',{caseId:'case',reason:'Independent assessment',confirmation:'RESTORE'},true),principal,actorToken,{presentation:context});assert.equal(response?.status,200);assert.deepEqual(calls,['approve','deliver','activate']);assert.doesNotMatch(Buffer.from(response?.body??'').toString(),/s{43}|replacement@example/);
});
test('delivery failure cancels inactive credential and cannot activate it',async()=>{
 const {calls,helper,request}=setup(async()=>{throw new Error('Transport failed');});
 await assert.rejects(helper.handle(request('/recovery-cases/approve','POST',{caseId:'case',reason:'Independent assessment',confirmation:'RESTORE'}),principal,actorToken,{presentation:createPresentation().resolve()}),/Transport failed/);assert.deepEqual(calls,['approve','deliver','cancel']);
});
test('manual recovery admin refuses cross-origin, insufficient permissions and GET mutations',async()=>{
 const {calls,helper,request}=setup(),context=createPresentation().resolve();
 const forged=request('/recovery-cases/create','POST',{reason:'Review'});forged.headers.set('origin','https://attacker.test');await assert.rejects(helper.handle(forged,principal,actorToken,{presentation:context}));
 await assert.rejects(helper.handle(request('/recovery-cases/create','POST',{reason:'Review'}),{...principal,permissions:['auth.cases.read']},actorToken,{presentation:context}));
 await assert.rejects(helper.handle(request('/recovery-cases/approve'),principal,actorToken,{presentation:context}));assert.deepEqual(calls,[]);
});

test('timed-out uncooperative callbacks retain bounded delivery slots until they settle',async()=>{
 const finish:(()=>void)[]=[];const {helper,request}=setup(()=>new Promise<void>(resolve=>finish.push(resolve))),context=createPresentation().resolve();
 const invoke=()=>helper.handle(request('/recovery-cases/approve','POST',{caseId:'case',reason:'Independent assessment',confirmation:'RESTORE'}),principal,actorToken,{presentation:context});
 const attempts=await Promise.allSettled(Array.from({length:4},invoke));assert.equal(attempts.filter(value=>value.status==='rejected').length,4);assert.equal(finish.length,4);await assert.rejects(invoke(),/busy/);
 for(const resolve of finish)resolve();await new Promise<void>(resolve=>setImmediate(resolve));
});
