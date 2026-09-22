import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {AuthHttp} from '../src/auth-ui.ts';
import {createManualRecoveryFlows,validateRecoveryEvidence} from '../src/manual-recovery.ts';
import {activatedUi} from './support/render.ts';
import type {ManualRecoveryService} from '../src/manual-recovery.ts';
import type {ExtensionRequest} from '@jimhoyd/urlcode/extensions';

test('manual evidence accepts bounded plain text without fetching or retaining mutable input',()=>{
 const input={summary:' Independent human review ',reference:'https://internal.invalid/evidence'};
 const result=validateRecoveryEvidence(input);input.summary='changed';assert.equal(result.summary,'Independent human review');assert.equal(result.reference,'https://internal.invalid/evidence');
 for(const value of [{summary:''},{summary:'x'.repeat(2001)},{summary:'secret\nvalue'},{summary:'review',reference:'x'.repeat(257)},{summary:'review',upload:'document'}])assert.throws(()=>validateRecoveryEvidence(value));
});
test('manual restoration GET never redeems and POST requires same-origin CSRF',async t=>{
 let redeemed=0;const token='r'.repeat(43),origin='https://example.test',http=new AuthHttp({origin,csrfKey:randomBytes(32)});
 const service={getManualRecoveryEnabled:()=>true,redeemRecoveryCase:async()=>{redeemed++;throw new Error('Domain reached');}} as unknown as ManualRecoveryService;
 const helper=createManualRecoveryFlows(service,http,'/account',await activatedUi(t,import.meta.dirname,'a'.repeat(64),origin));
 const request:ExtensionRequest={method:'GET',target:'/account/restore-access?token='+token,path:'/account/restore-access',query:new URLSearchParams({token}),headers:new Headers({accept:'text/html'}),headerCounts:{},body:new Uint8Array(),origin,route:'/account/*',mount:'/account',client:null};
 assert.equal((await helper.handle(request))?.status,200);assert.equal(redeemed,0);
 const post={...request,method:'POST',headers:new Headers({origin:'https://attacker.test','content-type':'application/json'}),body:new TextEncoder().encode(JSON.stringify({token,password:'replacement long password',csrf:'forged'}))};
 await assert.rejects(helper.handle(post));assert.equal(redeemed,0);
 const duplicate={...request,query:new URLSearchParams('token='+token+'&token='+token)};await assert.rejects(helper.handle(duplicate));
});

import type {TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TOTP,Secret} from 'otpauth';
import {createAuthService, sessionReference} from '../src/auth-core.ts';
const password='synthetic original account password',replacement='synthetic replacement account password';
async function domain(t:TestContext,enabled=true){
 const root=await mkdtemp(join(tmpdir(),'manual-recovery-'));let now=1800000000000;
 const options={database:join(root,'auth.sqlite'),encryptionKey:randomBytes(32),allowManualRecovery:enabled,allowPasskeySecondFactor:true,trustedDeviceTtlMs:86400000,roles:{member:['content.read'],admin:['*']},defaultRole:'member',now:()=>now};
 const service=await createAuthService(options);cleanup(t, async()=>{await service.close();await rm(root,{recursive:true,force:true});});
 const maker=await service.bootstrapAdmin({email:'maker@example.test',password}),second=await service.register({email:'checker@example.test',password});await service.adminSetRoles({actorToken:maker.token,accountId:second.user.id,roles:['admin'],reason:'Independent recovery administrator'});const checker=await service.login({email:second.user.email,password}),target=await service.register({email:'old@example.test',password});
 const create=()=>service.createRecoveryCase({actorToken:maker.token,accountId:target.user.id,email:'replacement@example.test',reason:'Documented human verification',evidence:{summary:'Two approved internal identity checks',reference:'ticket-123'}});
 const approve=async()=>{const item=await create();return service.approveRecoveryCase({actorToken:checker.token,caseId:item.id,reason:'Independent evidence reviewed'});};
 return {service,maker,checker,target,options,create,approve,time:()=>now,advance:(ms:number)=>{now+=ms;}};
}
test('manual restoration requires distinct administrators, delivery activation and one-use transaction',async t=>{
 const {service,maker,checker,target,create,time}=await domain(t);
 await service.linkExternal({ sessionReference: sessionReference(target.token), provider:'synthetic',subject:'old-subject'});
 await service.addPasskey({actorToken:target.token,credential:{id:'c'.repeat(24),publicKey:Buffer.from('synthetic-cose-key').toString('base64url'),counter:0}});
 const enrollment=await service.beginTotp(target.token),totp=new TOTP({secret:Secret.fromBase32(enrollment.secret),digits:6,period:30});await service.confirmTotp({token:target.token,code:totp.generate({timestamp:time()})});const trusted=await service.rememberDevice({token:target.token,label:'Old trusted browser'});
 const item=await create();await assert.rejects(service.approveRecoveryCase({actorToken:maker.token,caseId:item.id,reason:'Self approval'}),{code:'distinct_approver_required'});await assert.rejects(service.approveCase({actorToken:checker.token,caseId:item.id,reason:'Wrong approval path'}),{code:'recovery_approval_required'});
 const issued=await service.approveRecoveryCase({actorToken:checker.token,caseId:item.id,reason:'Independent review'});
 await assert.rejects(service.redeemRecoveryCase({token:issued.token,password:replacement}),{code:'invalid_recovery'});
 await service.activateRecoveryCase({actorToken:checker.token,caseId:item.id,token:issued.token});
 const results=await Promise.allSettled([service.redeemRecoveryCase({token:issued.token,password:replacement}),service.redeemRecoveryCase({token:issued.token,password:replacement})]);assert.equal(results.filter(value=>value.status==='fulfilled').length,1);const recovered=results.find(value=>value.status==='fulfilled')!.value;
 assert.equal(recovered.user.email,'replacement@example.test');assert.deepEqual(recovered.user.roles,['member']);assert.deepEqual(recovered.principal.restrictions,['enroll-mfa']);assert.equal(await service.authenticate(target.token),null);assert.equal(await service.findExternal('synthetic','old-subject'),null);assert.deepEqual(await service.listPasskeys(target.user.id),[]);
 await assert.rejects(service.login({email:target.user.email,password}));await assert.rejects(service.login({email:recovered.user.email,password}));
 const ordinary=await service.login({email:recovered.user.email,password:replacement});await assert.rejects(service.beginTotp(ordinary.token),{code:'recovery_enrollment_proof_required'});
 const next=await service.beginTotp(recovered.token),newTotp=new TOTP({secret:Secret.fromBase32(next.secret),digits:6,period:30});await service.confirmTotp({token:recovered.token,code:newTotp.generate({timestamp:time()})});assert.equal((await service.authenticate(recovered.token))?.restrictions,undefined);assert.equal(await service.authenticate(ordinary.token),null);assert.deepEqual(await service.listTrustedDevices(recovered.token),[]);await assert.rejects(service.login({email:recovered.user.email,password:replacement,trustedDevice:trusted.token}));
 assert.equal((await service.listRecoveryCases()).cases[0]?.recovery.state,'redeemed');assert.equal((await service.listCases()).cases.length,0);
});
test('manual restoration rejects stale account changes, failed delivery, email collisions and expiry',async t=>{
 const fixture=await domain(t),{service,checker,target}=fixture;
 let issued=await fixture.approve();await service.cancelRecoveryCredential({actorToken:checker.token,caseId:issued.case.id,token:issued.token});await assert.rejects(service.redeemRecoveryCase({token:issued.token,password:replacement}),{code:'invalid_recovery'});
 issued=await fixture.approve();await service.updateProfile({token:target.token,profile:{displayName:'Changed after approval'}});await assert.rejects(service.activateRecoveryCase({actorToken:checker.token,caseId:issued.case.id,token:issued.token}),{code:'case_target_changed'});
 issued=await fixture.approve();await service.activateRecoveryCase({actorToken:checker.token,caseId:issued.case.id,token:issued.token});await service.register({email:'replacement@example.test',password});await assert.rejects(service.redeemRecoveryCase({token:issued.token,password:replacement}),{code:'email_unavailable'});
 fixture.advance(1800001);await assert.rejects(service.redeemRecoveryCase({token:issued.token,password:replacement}),{code:'invalid_recovery'});assert.equal((await service.getUser(target.user.id))?.email,target.user.email);
});
test('manual recovery is explicit and durable credentials are revoked by configuration migration',async t=>{
 const off=await domain(t,false);await assert.rejects(off.create(),{code:'manual_recovery_disabled'});
 const {service,checker,options,approve}=await domain(t);const issued=await approve();await service.activateRecoveryCase({actorToken:checker.token,caseId:issued.case.id,token:issued.token});const revision=await service.getConfigurationRevision();
 const migrated=await createAuthService({...options,configurationTag:'reviewed recovery policy v2',approveConfigurationChangeFrom:revision});cleanup(t, ()=>migrated.close());await assert.rejects(migrated.redeemRecoveryCase({token:issued.token,password:replacement}),{code:'invalid_recovery'});await assert.rejects(service.listRecoveryCases(),{code:'stale_auth_configuration'});const cases=await migrated.listRecoveryCases();assert.equal(cases.cases[0]?.recovery.state,'cancelled');assert.equal(cases.cases[0]?.status,'closed');
});

test('manual restoration rechecks approval privileges and supports unchanged email after restart',async t=>{
 const fixture=await domain(t),{service,maker,checker,target,options}=fixture;
 const issued=await fixture.approve();await service.activateRecoveryCase({actorToken:checker.token,caseId:issued.case.id,token:issued.token});await service.adminSetRoles({actorToken:maker.token,accountId:checker.user.id,roles:['member'],reason:'Recovery authority removed'});
 await assert.rejects(service.redeemRecoveryCase({token:issued.token,password:replacement}),{code:'permission_denied'});
 await service.adminSetRoles({actorToken:maker.token,accountId:checker.user.id,roles:['admin'],reason:'New reviewed administrator assignment'});const renewed=await service.login({email:checker.user.email,password});
 const item=await service.createRecoveryCase({actorToken:maker.token,accountId:target.user.id,email:target.user.email,evidence:{summary:'Retained email proof reviewed'},reason:'Same email restoration'});const same=await service.approveRecoveryCase({actorToken:renewed.token,caseId:item.id,reason:'Independent evidence reviewed'});await service.activateRecoveryCase({actorToken:renewed.token,caseId:item.id,token:same.token});
 await service.close();const reopened=await createAuthService(options);cleanup(t, ()=>reopened.close());const recovered=await reopened.redeemRecoveryCase({token:same.token,password:replacement});assert.equal(recovered.user.email,target.user.email);assert.deepEqual(recovered.principal.restrictions,['enroll-mfa']);
});
test('approved restoration can be withdrawn and cancellation races redemption atomically',async t=>{
 const {service,maker,checker,approve}=await domain(t);
 const issued=await approve();await service.activateRecoveryCase({actorToken:checker.token,caseId:issued.case.id,token:issued.token});await service.addCaseNote({actorToken:maker.token,caseId:issued.case.id,note:'Additional review after delivery'});
 const results=await Promise.allSettled([service.closeCase({actorToken:maker.token,caseId:issued.case.id,reason:'Withdraw restoration'}),service.redeemRecoveryCase({token:issued.token,password:replacement})]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
 const item=(await service.listRecoveryCases()).cases.find(value=>value.id===issued.case.id)!;assert.ok(['cancelled','redeemed'].includes(item.recovery.state));
});
test('revoked and restored administrator roles cannot revive previously approved recovery authority',async t=>{
 const {service,maker,checker,approve}=await domain(t),issued=await approve();await service.activateRecoveryCase({actorToken:checker.token,caseId:issued.case.id,token:issued.token});
 await service.adminSetRoles({actorToken:maker.token,accountId:checker.user.id,roles:['member'],reason:'Authority withdrawn'});await service.adminSetRoles({actorToken:maker.token,accountId:checker.user.id,roles:['admin'],reason:'New authority assignment'});
 await assert.rejects(service.redeemRecoveryCase({token:issued.token,password:replacement}),{code:'recovery_approval_changed'});
});
