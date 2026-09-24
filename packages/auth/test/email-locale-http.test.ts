import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHmac} from 'node:crypto';
import {createAuthService} from '../src/auth-core.ts';
import {authExtension} from '../src/auth.ts';
import {createPresentation} from '../src/presentation.ts';
import {createRegistrationPolicy} from '../src/registration.ts';
import type { CsrfBody, MessageBody, SessionBody, SignupStatusBody } from './support/json-api.ts';
import { activatedUi } from './support/render.ts';
function totp(secret:string){const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits=0,value=0;const bytes:number[]=[];for(const char of secret){value=(value<<5)|alphabet.indexOf(char);bits+=5;if(bits>=8){bits-=8;bytes.push((value>>>bits)&255);}}const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const digest=createHmac('sha1',Buffer.from(bytes)).update(counter).digest(),offset=digest.at(-1)!&15;return String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');}

test('HTTP email callbacks receive scoped locales and known-account notices prefer saved locale without public enumeration',async t=>{
 const root=await mkdtemp(join(tmpdir(),'mail-locale-'));cleanup(t, ()=>rm(root,{recursive:true,force:true}));
 const service=await createAuthService({database:join(root,'auth.sqlite'),encryptionKey:randomBytes(32),roles:{member:['site.read']},defaultRole:'member',requireEmailVerification:true,allowEmailFactorRecovery:true,registrationPolicy:createRegistrationPolicy({locales:['en','fr']})});cleanup(t, ()=>service.close());
 const user=await service.register({email:'reader@example.test',password:'correct horse battery staple',profile:{locale:'fr'}}),origin='https://site.example',projectSha256='a'.repeat(64);
 const messages:{kind:string;locale?:string;event?:string;purpose?:string}[]=[];
 const ui=await activatedUi(t,import.meta.dirname,projectSha256,origin);
 const instance=await authExtension({service,projectSha256,csrfKey:randomBytes(32),ui,presentation:createPresentation({catalogues:{fr:{'page.signIn':'Connexion'}}}),sendToken:async m=>{messages.push({kind:'token',...m});},sendEmailCode:async m=>{messages.push({kind:'code',...m});},sendSignupCode:async m=>{messages.push({kind:'signup',...m});},sendFactorRecovery:async m=>{messages.push({kind:'recovery',...m});},sendNotice:async m=>{messages.push({kind:'notice',...m});}}).activate({registration:'open'},{origin,target:'node',projectSha256,mounts:['/account'], root: import.meta.dirname});
 const cookies=new Map<string,string>([['__Host-urlcode-session',user.token]]);
 async function request(path:string,data?:Record<string,string>,csrf?:string){const url=new URL(origin+'/account'+path),headers=new Headers({accept:'application/json','accept-language':'en',cookie:[...cookies].map(([k,v])=>k+'='+v).join('; ')});if(data){headers.set('content-type','application/json');headers.set('origin',origin);}if(csrf)headers.set('x-csrf-token',csrf);const result=await instance.handle({method:data?'POST':'GET',path:url.pathname,target:url.pathname+url.search,query:url.searchParams,headers,headerCounts:Object.fromEntries([...headers].map(([key])=>[key,1])),body:Buffer.from(data?JSON.stringify(data):''),origin,route:'/account/*',mount:'/account',client:'127.0.0.1', requestId: 'test-request', env: {}});for(const [name,value] of result.headers)if(name==='set-cookie'){const [key,item]=value.split(';')[0]!.split('=');if(value.includes('Max-Age=0'))cookies.delete(key!);else cookies.set(key!,item!);}const body=Buffer.from(result.body!).toString();return {status:result.status,body,json:<T=unknown>()=>JSON.parse(body) as T};}
 let csrf=(await request('/csrf')).json<CsrfBody>().csrf;
 assert.equal((await request('/send-verification?lang=en',{},csrf)).status,200);assert.equal(messages.at(-1)?.locale,'fr');
 const verified=await service.issueToken({email:user.user.email,purpose:'verify-email'});await service.consumeVerification(verified.token!,user.token);cookies.clear();csrf=(await request('/csrf')).json<CsrfBody>().csrf;
 const login=await request('/login?lang=en',{email:user.user.email,password:'correct horse battery staple'},csrf);assert.equal(login.status,200);csrf=login.json<SessionBody>().csrf;assert.equal(messages.at(-1)?.event,'new-device');assert.equal(messages.at(-1)?.locale,'fr');
 assert.equal((await request('/change-password?lang=en',{currentPassword:'correct horse battery staple',password:'a different strong password now'},csrf)).status,200);assert.equal(messages.at(-1)?.event,'password-changed');assert.equal(messages.at(-1)?.locale,'fr');
 csrf=(await request('/csrf')).json<CsrfBody>().csrf;
 // Delivery is attempted for both an existing and an unknown address (no timing/enumeration
 // signal, #463): the unknown address gets a well-formed but inert decoy token.
 const existing=await request('/forgot-password?lang=fr',{email:user.user.email},csrf),count=messages.length,unknown=await request('/forgot-password?lang=fr',{email:'unknown@example.test'},csrf);assert.equal(existing.status,unknown.status);assert.deepEqual(existing.json<MessageBody>(),unknown.json<MessageBody>());assert.equal(messages.length,count+1);assert.equal(messages.at(-1)?.purpose,'reset-password');assert.equal(messages.at(-1)?.locale,'fr');assert.equal(messages.at(-1)?.kind,'token');
 assert.equal((await request('/send-email-code?lang=fr',{email:user.user.email},csrf)).status,200);assert.equal(messages.at(-1)?.kind,'code');assert.equal(messages.at(-1)?.locale,'fr');
 const signup=await request('/signup?lang=fr');csrf=signup.json<SignupStatusBody>().csrf;assert.equal((await request('/signup/begin?lang=fr',{email:'new@example.test'},csrf)).status,200);assert.equal(messages.at(-1)?.kind,'signup');assert.equal(messages.at(-1)?.locale,'fr');
 assert.equal((await request('/signup/begin?lang=fr',{email:user.user.email},csrf)).status,200);assert.equal(messages.at(-1)?.event,'registration-attempt');assert.equal(messages.at(-1)?.locale,'fr');
 const actor=await service.login({email:user.user.email,password:'a different strong password now'}),factor=await service.beginTotp(actor.token);await service.confirmTotp({token:actor.token,code:totp(factor.secret)});
 assert.equal((await request('/recover-factor?lang=fr',{email:user.user.email},csrf)).status,200);assert.equal(messages.at(-1)?.kind,'recovery');assert.equal(messages.at(-1)?.locale,'fr');
 const reset=await service.issueToken({email:user.user.email,purpose:'reset-password'});
 assert.equal((await request('/reset',{token:reset.token!,password:'another synthetic replacement passphrase'},csrf)).status,200);
 assert.equal(messages.at(-1)?.event,'password-changed');assert.equal(messages.at(-1)?.locale,'fr');
 const recoveryPage=await request('/recover-factor?lang=fr');assert.ok(recoveryPage.body.includes('/recover-factor?lang=fr'));
 // An independent English request cannot inherit the previous request's locale.
 assert.equal((await request('/send-email-code?lang=en',{email:user.user.email},csrf)).status,200);assert.equal(messages.at(-1)?.locale,'en');
});

test('confirmed email change sends a localized notice to the verified replacement address',async t=>{
 const root=await mkdtemp(join(tmpdir(),'email-change-notice-'));cleanup(t, ()=>rm(root,{recursive:true,force:true}));let now=Date.now();
 const service=await createAuthService({database:join(root,'auth.sqlite'),encryptionKey:randomBytes(32),roles:{member:[]},defaultRole:'member',now:()=>now});cleanup(t, ()=>service.close());
 const password='synthetic strong password phrase',user=await service.register({email:'old@example.test',password,profile:{locale:'fr'}}),change=await service.requestEmailChange({token:user.token,email:'new@example.test',password});now+=86400000;
 const messages:{email:string;event:string;locale?:string}[]=[],origin='https://site.example',projectSha256='a'.repeat(64),csrfKey=randomBytes(32),binding=randomBytes(32).toString('base64url');
 const ui=await activatedUi(t,import.meta.dirname,projectSha256,origin);
 const instance=await authExtension({service,projectSha256,csrfKey,ui,presentation:createPresentation({catalogues:{fr:{'page.signIn':'Connexion'}}}),sendNotice:async message=>{messages.push(message);throw new Error('synthetic sender failure');}}).activate({registration:'open'},{origin,target:'node',projectSha256,mounts:['/account'], root: import.meta.dirname});
 const csrf=createHmac('sha256',csrfKey).update('urlcode-csrf\0'+origin+'\0'+binding).digest('hex');
 const response=await instance.handle({method:'POST',path:'/account/verify-email-change',target:'/account/verify-email-change',query:new URLSearchParams(),headers:new Headers({origin,cookie:'__Host-urlcode-flow='+binding,'content-type':'application/json',accept:'application/json'}),headerCounts:{origin:1,cookie:1},body:Buffer.from(JSON.stringify({csrf,token:change.verificationToken})),origin,mount:'/account',route:'/account/*',client:null, requestId: 'test-request', env: {}});
 assert.equal(response.status,200);assert.equal(messages[0]?.event,'email-changed');assert.equal(messages[0]?.email,'new@example.test');assert.equal(messages[0]?.locale,'fr');assert.equal((await service.getUser(user.user.id))?.email,'new@example.test');
});
