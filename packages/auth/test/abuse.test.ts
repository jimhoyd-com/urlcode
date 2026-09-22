import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHmac} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createAuthService} from '../src/auth-core.ts';
import {normalizeAbusePolicy} from '../src/abuse.ts';
import {abuseOperation} from '../src/abuse-store.ts';
function totp(secret:string,now:number){const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits=0,value=0;const bytes:number[]=[];for(const char of secret){value=(value<<5)|alphabet.indexOf(char);bits+=5;if(bits>=8){bits-=8;bytes.push((value>>>bits)&255);}}const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(now/30000)));const digest=createHmac('sha1',Buffer.from(bytes)).update(counter).digest(),offset=digest.at(-1)!&15;return String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');}
const code=(name:string)=>(error:unknown)=>error instanceof Error&&'code'in error&&error.code===name;
test('abuse policy is bounded and challenge pressure requires a hard client budget',()=>{
 assert.equal(normalizeAbusePolicy(undefined),undefined);assert.throws(()=>normalizeAbusePolicy({challengeAfter:1}));assert.throws(()=>normalizeAbusePolicy({client:{limit:2,windowMs:1000},challengeAfter:2}));assert.throws(()=>normalizeAbusePolicy({passwordBackoff:{initialDelayMs:1000,maxDelayMs:500}}));assert.throws(()=>normalizeAbusePolicy({client:{limit:100001,windowMs:1000}}));
});
test('password backoff persists across restart, resets on success and verified reset never bypasses MFA',async t=>{
 const root=await mkdtemp(join(tmpdir(),'auth-abuse-'));cleanup(t, ()=>rm(root,{recursive:true,force:true}));let clock=1800000000000;const options={database:join(root,'auth.sqlite'),encryptionKey:randomBytes(32),roles:{member:['site.read']},defaultRole:'member',now:()=>clock,abuse:{passwordBackoff:{threshold:2,initialDelayMs:1000,maxDelayMs:8000,resetAfterMs:60000}}};
 let service=await createAuthService(options);cleanup(t, ()=>service.close());const user=await service.register({email:'reader@example.test',password:'correct horse battery staple'});
 await assert.rejects(service.login({email:user.user.email,password:'wrong'}),code('invalid_credentials'));await assert.rejects(service.login({email:user.user.email,password:'wrong'}),code('invalid_credentials'));await assert.rejects(service.login({email:user.user.email,password:'correct horse battery staple'}),code('auth_backoff'));
 await service.close();service=await createAuthService(options);await assert.rejects(service.login({email:user.user.email,password:'correct horse battery staple'}),code('auth_backoff'));
 clock+=1000;const signed=await service.login({email:user.user.email,password:'correct horse battery staple'});await assert.rejects(service.login({email:user.user.email,password:'wrong'}),code('invalid_credentials'));await service.login({email:user.user.email,password:'correct horse battery staple'});
 const verification=await service.issueToken({email:user.user.email,purpose:'verify-email'});await service.consumeVerification(verification.token!,signed.token);const factor=await service.beginTotp(signed.token);await service.confirmTotp({token:signed.token,code:totp(factor.secret,clock)});
 await assert.rejects(service.login({email:user.user.email,password:'wrong'}));await assert.rejects(service.login({email:user.user.email,password:'wrong'}));await assert.rejects(service.login({email:user.user.email,password:'correct horse battery staple'}),code('auth_backoff'));
 const reset=await service.issueToken({email:user.user.email,purpose:'reset-password'});await service.resetPassword({token:reset.token!,password:'new strong password after reset'});assert.equal(await service.authenticate(signed.token),null);
 await assert.rejects(service.login({email:user.user.email,password:'new strong password after reset'}),code('invalid_credentials'));clock+=30000;
 const restored=await service.login({email:user.user.email,password:'new strong password after reset',totp:totp(factor.secret,clock)});assert.equal(restored.user.totpEnabled,true);
 // Unknown identifiers have the same durable failure/backoff behavior.
 await assert.rejects(service.login({email:'unknown@example.test',password:'wrong'}),code('invalid_credentials'));await assert.rejects(service.login({email:'unknown@example.test',password:'wrong'}),code('invalid_credentials'));await assert.rejects(service.login({email:'unknown@example.test',password:'wrong'}),code('auth_backoff'));clock+=60001;await assert.rejects(service.login({email:'unknown@example.test',password:'wrong'}),code('invalid_credentials'));
});
test('velocity budgets are atomic per trusted client and signup domain, durable and expiring',async t=>{
 const root=await mkdtemp(join(tmpdir(),'auth-velocity-'));cleanup(t, ()=>rm(root,{recursive:true,force:true}));let clock=1800000000000;const options={database:join(root,'auth.sqlite'),encryptionKey:randomBytes(32),roles:{member:[]},defaultRole:'member',now:()=>clock,abuse:{client:{limit:4,windowMs:10000},signupClient:{limit:2,windowMs:10000},signupDomain:{limit:2,windowMs:10000},challengeAfter:1}};
 let service=await createAuthService(options);cleanup(t, ()=>service.close());assert.deepEqual(await service.admitAuthRequest({client:'192.0.2.1',signupEmail:'one@example.test'}),{challengeRequired:false});assert.deepEqual(await service.admitAuthRequest({client:'192.0.2.1',signupEmail:'two@example.test'}),{challengeRequired:true});await assert.rejects(service.admitAuthRequest({client:'192.0.2.2',signupEmail:'three@example.test'}),code('auth_rate_limited'));await assert.rejects(service.admitAuthRequest({client:null,signupEmail:'one@different.test'}),code('trusted_client_required'));
 await service.close();service=await createAuthService(options);await assert.rejects(service.admitAuthRequest({client:'192.0.2.1',signupEmail:'one@other.test'}),code('auth_rate_limited'));
 const results=await Promise.allSettled(Array.from({length:8},()=>service.admitAuthRequest({client:'192.0.2.3'})));assert.equal(results.filter(item=>item.status==='fulfilled').length,4);
 clock+=10001;assert.deepEqual(await service.admitAuthRequest({client:'192.0.2.1',signupEmail:'one@example.test'}),{challengeRequired:false});
});
test('abuse counters have a hard SQLite capacity bound and bounded expiry cleanup',()=>{
 const db=new DatabaseSync(':memory:');try{db.exec('CREATE TABLE auth_abuse(key TEXT PRIMARY KEY,count INTEGER,expires INTEGER,blocked_until INTEGER);CREATE INDEX expiry ON auth_abuse(expires);BEGIN');const insert=db.prepare('INSERT INTO auth_abuse VALUES(?,1,2000,0)');for(let i=0;i<100000;i++)insert.run(String(i));db.exec('COMMIT');const fail=(_status:number,name:string):never=>{throw new Error(name);};assert.throws(()=>abuseOperation('abuseAdmit',{limits:[{key:'new',limit:2,windowMs:1000}],now:1000},db,undefined,fail),/auth_capacity_reached/);
 const admitted=abuseOperation('abuseAdmit',{limits:[{key:'new',limit:2,windowMs:1000}],now:2001},db,undefined,fail);assert.ok(admitted);assert.equal(Number(db.prepare('SELECT count(*) AS n FROM auth_abuse').get()!.n),99001);
 }finally{db.close();}
});
