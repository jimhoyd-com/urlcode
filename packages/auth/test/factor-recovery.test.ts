import { cleanup } from './cleanup.ts';
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {TOTP,Secret} from 'otpauth';
import {createAuthService} from '../src/auth-core.ts';
import { activatedUi } from './support/render.ts';
const password='synthetic recovery password',browserToken='b'.repeat(43),day=86400000;
async function setup(t:TestContext,enabled=true){const root=await mkdtemp(join(tmpdir(),'factor-recovery-'));let now=1800000000000;const options={database:join(root,'auth.sqlite'),encryptionKey:randomBytes(32),roles:{member:['content.read'],admin:['*']},defaultRole:'member',allowEmailFactorRecovery:enabled,sessionTtlMs:3*day,sessionIdleMs:3*day,now:()=>now};const service=await createAuthService(options);cleanup(t, async()=>{await service.close();await rm(root,{recursive:true,force:true});});const user=await service.register({email:'recover@example.test',password});const verification=await service.issueToken({email:user.user.email,purpose:'verify-email'});await service.consumeVerification(verification.token!,user.token);const enrolled=await service.beginTotp(user.token);const totp=new TOTP({secret:Secret.fromBase32(enrolled.secret),digits:6,period:30});await service.confirmTotp({token:user.token,code:totp.generate({timestamp:now})});return {service,user,options,totp,time:()=>now,advance:(ms:number)=>{now+=ms;}};}
test('email MFA fallback is opt-in, generic for unknown/unverified accounts and browser-bound',async t=>{
 const off=await setup(t,false);await assert.rejects(off.service.beginFactorRecovery({email:off.user.user.email,browserToken}),{code:'factor_recovery_disabled'});
 const {service,user}=await setup(t);assert.deepEqual(await service.beginFactorRecovery({email:'unknown@example.test',browserToken}),{verificationToken:null,cancelToken:null});
 const issued=await service.beginFactorRecovery({email:user.user.email,browserToken});assert.ok(issued.verificationToken&&issued.cancelToken);
 await assert.rejects(service.confirmFactorRecovery({token:issued.verificationToken,browserToken:'c'.repeat(43)}),{code:'invalid_recovery_token'});
 await assert.rejects(service.completeFactorRecovery({token:issued.verificationToken,browserToken}),{code:'factor_recovery_cooldown'});
 await service.cancelFactorRecovery(issued.cancelToken);await assert.rejects(service.confirmFactorRecovery({token:issued.verificationToken,browserToken}),{code:'invalid_recovery_token'});
});
test('mail proof starts durable cooldown; completion revokes sessions and only proof holder may reenroll',async t=>{
 const {service,user,advance,time}=await setup(t);const issued=await service.beginFactorRecovery({email:user.user.email,browserToken});const input={token:issued.verificationToken!,browserToken};
 const confirmed=await service.confirmFactorRecovery(input);assert.equal(confirmed.completeAfter,time()+day);advance(1000);assert.deepEqual(await service.confirmFactorRecovery(input),confirmed);
 await assert.rejects(service.completeFactorRecovery(input),{code:'factor_recovery_cooldown'});advance(day);
 const results=await Promise.allSettled([service.completeFactorRecovery(input),service.completeFactorRecovery(input)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const recovered=results.find(r=>r.status==='fulfilled')!.value;
 assert.equal(await service.authenticate(user.token),null);assert.deepEqual(recovered.principal.restrictions,['enroll-mfa']);assert.deepEqual(recovered.principal.permissions,[]);
 const ordinary=await service.login({email:user.user.email,password});assert.deepEqual(ordinary.principal.restrictions,['enroll-mfa']);await assert.rejects(service.beginTotp(ordinary.token),{code:'recovery_enrollment_proof_required'});
 advance(6*60000);await assert.rejects(service.beginTotp(recovered.token),{code:'fresh_authentication_required'});const renewed=await service.stepUp({token:recovered.token,password});
 const enrollment=await service.beginTotp(renewed.token);const totp=new TOTP({secret:Secret.fromBase32(enrollment.secret),digits:6,period:30});await service.confirmTotp({token:renewed.token,code:totp.generate({timestamp:time()})});assert.equal((await service.authenticate(renewed.token))?.restrictions,undefined);assert.equal(await service.authenticate(ordinary.token),null);
});
test('cancellation and account changes prevent recovery; expired tokens and restart cannot bypass bounds',async t=>{
 const {service,user,advance,options,totp,time}=await setup(t);let issued=await service.beginFactorRecovery({email:user.user.email,browserToken});await service.confirmFactorRecovery({token:issued.verificationToken!,browserToken});await service.cancelFactorRecovery(issued.cancelToken!);advance(day);await assert.rejects(service.completeFactorRecovery({token:issued.verificationToken!,browserToken}),{code:'invalid_recovery_token'});
 issued=await service.beginFactorRecovery({email:user.user.email,browserToken});const input={token:issued.verificationToken!,browserToken};await service.confirmFactorRecovery(input);await service.close();const reopened=await createAuthService(options);cleanup(t, ()=>reopened.close());await assert.rejects(reopened.completeFactorRecovery(input),{code:'factor_recovery_cooldown'});
 advance(30000);const signed=await reopened.login({email:user.user.email,password,totp:totp.generate({timestamp:time()})});await reopened.updateProfile({token:signed.token,profile:{displayName:'Changed'}});advance(day);await assert.rejects(reopened.completeFactorRecovery(input),{code:'recovery_account_changed'});advance(2*day);await assert.rejects(reopened.completeFactorRecovery(input),{code:'invalid_recovery_token'});
});
test('recovery requests consume a persistent per-account attempt budget',async t=>{
 const {service,user}=await setup(t);for(let i=0;i<10;i++)await service.beginFactorRecovery({email:user.user.email,browserToken});await assert.rejects(service.beginFactorRecovery({email:user.user.email,browserToken}),{code:'authentication_rate_limited'});
});
test('recovery handlers require same-origin CSRF, never mutate on GET and issue enrollment-only cookies',async t=>{
 const {service,user,advance}=await setup(t);const {authExtension}=await import('../src/auth.ts'),{AuthHttp}=await import('../src/auth-ui.ts');
 const origin='https://recovery.example.test',csrfKey=randomBytes(32),http=new AuthHttp({origin,csrfKey}),cookies=new Map<string,string>(),delivered:{verificationToken:string;cancelToken:string}[]=[];
 const ui=await activatedUi(t,import.meta.dirname,'a'.repeat(64),origin);
 const instance=await authExtension({service,csrfKey,projectSha256:'a'.repeat(64),ui,sendFactorRecovery:async message=>{delivered.push(message);}}).activate({registration:'open'},{origin,target:'node',projectSha256:'a'.repeat(64),mounts:['/account'], root: import.meta.dirname});
 async function call(path:string,data?:Record<string,string>,requestOrigin=origin){const url=new URL(origin+'/account'+path);const result=await instance.handle({method:data?'POST':'GET',target:url.pathname+url.search,path:url.pathname,query:url.searchParams,headers:new Headers({accept:'application/json',origin:requestOrigin,cookie:[...cookies].map(([key,value])=>key+'='+value).join('; '),...(data?{'content-type':'application/json'}:{})}),headerCounts:{cookie:1,origin:1},body:Buffer.from(data?JSON.stringify({...data,csrf:http.token(cookies.get(http.sessionCookie)||cookies.get(http.flowCookie)||'')}):''),origin,route:'/account/*',mount:'/account',client:null, requestId: 'test-request', env: {}});for(const [name,value]of result.headers)if(name==='set-cookie'){const first=value.split(';')[0]!,split=first.indexOf('=');if(value.includes('Max-Age=0'))cookies.delete(first.slice(0,split));else cookies.set(first.slice(0,split),first.slice(split+1));}return result;}
 await call('/csrf');assert.equal((await call('/recover-factor',{email:user.user.email},'https://attacker.example')).status,403);assert.equal(delivered.length,0);
 assert.equal((await call('/recover-factor',{email:user.user.email})).status,200);assert.equal(delivered.length,1);const token=delivered[0]!.verificationToken;
 assert.equal((await call('/recover-factor/confirm?token='+token)).status,200);advance(day);assert.equal((await call('/recover-factor/complete',{token})).status,409);
 assert.equal((await call('/recover-factor/confirm',{token})).status,200);advance(day);const completed=await call('/recover-factor/complete',{token});assert.equal(completed.status,200);const session=cookies.get(http.sessionCookie)!;assert.deepEqual((await service.authenticate(session))?.restrictions,['enroll-mfa']);
 assert.equal((await call('/export',{})).status,403);assert.equal(cookies.has('__Host-urlcode-factor-recovery'),false);
});
test('cooldown cancellation racing completion has exactly one winner',async t=>{
 const {service,user,advance}=await setup(t);const issued=await service.beginFactorRecovery({email:user.user.email,browserToken}),input={token:issued.verificationToken!,browserToken};await service.confirmFactorRecovery(input);advance(day);
 const results=await Promise.allSettled([service.cancelFactorRecovery(issued.cancelToken!),service.completeFactorRecovery(input)]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
});
