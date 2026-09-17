import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, generateKeyPairSync, createHash, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { createAuthService } from '../src/auth-core.ts';
import { authExtension } from '../src/auth.ts';
import { createPasskeyProvider } from '../src/passkeys.ts';
import { createRegistrationPolicy } from '../src/registration.ts';
import type { TestContext } from 'node:test';
async function app(t:TestContext,mode:'open'|'waitlist'='open') {
 const root=await mkdtemp(join(tmpdir(),'signup-http-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const project=join(root,'project');await mkdir(project);await writeFile(join(project,'urlcode.yaml'),JSON.stringify({version:'1',extensions:{auth:{version:'1',config:{registration:mode}}},routes:{'/account/*':{extension:'auth',methods:['GET','HEAD','POST']}}}));
 const service=await createAuthService({database:join(root,'auth.sqlite'),encryptionKey:randomBytes(32),roles:{member:['site.read'],admin:['*']},defaultRole:'member',registrationMode:mode,requireEmailVerification:true,registrationPolicy:createRegistrationPolicy({termsVersion:'v1'})});
 const origin='https://site.example',codes=new Map<string,string>();
 const extension=authExtension({service,csrfKey:randomBytes(32),projectSha256:await inspectExtensionRevision(project),passkeys:createPasskeyProvider({origin,rpId:'site.example',rpName:'Site'}),sendSignupCode:async m=>{codes.set(m.email,m.code);}});
 const server=await startServer({project,origin,port:0,extensions:[extension],log:()=>{}});t.after(async()=>{await server.close();await service.close();});
 const cookies=new Map<string,string>();
 async function request(path:string,data?:Record<string,unknown>,csrf?:string,html=false){
  const response=await fetch(`http://127.0.0.1:${server.address.port}/account${path}`,{method:data?'POST':'GET',redirect:'manual',headers:{accept:html?'text/html':'application/json',cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),...(data?{'content-type':'application/json',origin}:{}),...(csrf?{'x-csrf-token':csrf}:{})},...(data?{body:JSON.stringify(data)}:{})});
  for(const item of response.headers.getSetCookie()){const [name,value]=item.split(';')[0]!.split('=');if(item.includes('Max-Age=0'))cookies.delete(name!);else cookies.set(name!,value!);}
  return response;
 }
 return {service,codes,cookies,request};
}
test('real HTTP signup verifies before credentials, resumes safely and commits profile with the account',async t=>{
 const {service,codes,cookies,request}=await app(t);
 let state=await (await request('/signup')).json() as any;const csrf=state.csrf;
 assert.equal(state.step,'identifier');
 assert.equal((await request('/register',{email:'reader@example.test',password:'correct horse battery staple'},csrf)).status,403);
 const begun=await request('/signup/begin',{email:'reader@example.test'},csrf);assert.equal(begun.status,200);assert.equal((await begun.json() as any).step,'verify-email');
 assert.equal((await service.listUsers()).users.length,0);
 assert.equal((await request('/signup/password',{password:'correct horse battery staple'},csrf)).status>=400,true);
 assert.equal((await request('/signup/passkeys/options',{},csrf)).status>=400,true);
 const original=cookies.get('__Host-urlcode-signup-browser')!;cookies.set('__Host-urlcode-signup-browser',randomBytes(32).toString('base64url'));
 assert.equal((await request('/signup/verify',{code:codes.get('reader@example.test')},csrf)).status>=400,true);cookies.set('__Host-urlcode-signup-browser',original);
 assert.equal((await request('/signup/verify',{code:codes.get('reader@example.test')},csrf)).status,200);
 state=await (await request('/signup')).json();assert.equal(state.step,'credential');
 assert.equal((await request('/signup/password',{password:'correct horse battery staple'},csrf)).status,200);
 const html=await (await request('/signup',undefined,undefined,true)).text();assert.ok(!html.includes('correct horse battery staple'));assert.ok(html.includes('termsAccepted'));
 assert.equal((await service.listUsers()).users.length,0);
 assert.equal((await request('/signup/complete',{},csrf)).status>=400,true);
 assert.equal((await request('/signup/complete',{termsAccepted:'true',displayName:'Reader'},csrf)).status,200);
 const user=(await service.listUsers()).users[0]!;assert.equal(user.emailVerified,true);assert.equal(user.profile?.displayName,'Reader');assert.ok(cookies.has('__Host-urlcode-session'));assert.ok(!cookies.has('__Host-urlcode-signup'));
 assert.equal((await request('/signup/complete',{termsAccepted:'true'},csrf)).status>=400,true);
});
test('verified signup registers a real WebAuthn attestation before atomic account creation',async t=>{
 const {service,codes,cookies,request}=await app(t);const csrf=(await (await request('/signup')).json() as any).csrf;
 await request('/signup/begin',{email:'passkey@example.test'},csrf);await request('/signup/verify',{code:codes.get('passkey@example.test')},csrf);
 const started=await (await request('/signup/passkeys/options',{},csrf)).json() as any;
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=publicKey.export({format:'jwk'});
 const cose=Buffer.concat([Buffer.from('a5010203262001215820','hex'),Buffer.from(jwk.x!,'base64url'),Buffer.from('225820','hex'),Buffer.from(jwk.y!,'base64url')]);
 const credential=randomBytes(32),id=credential.toString('base64url'),length=Buffer.alloc(2);length.writeUInt16BE(32);
 const client=Buffer.from(JSON.stringify({type:'webauthn.create',challenge:started.options.challenge,origin:'https://site.example',crossOrigin:false}));
 const auth=Buffer.concat([createHash('sha256').update('site.example').digest(),Buffer.from([0x45]),Buffer.alloc(20),length,credential,cose]);
 const attestation=isoCBOR.encode(new Map<string,string|Map<string,never>|Uint8Array<ArrayBuffer>>([['fmt','none'],['attStmt',new Map<string,never>()],['authData',new Uint8Array(auth)]]));
 const response={id,rawId:id,type:'public-key',clientExtensionResults:{},response:{clientDataJSON:client.toString('base64url'),attestationObject:Buffer.from(attestation).toString('base64url'),transports:['internal']}};
 assert.equal((await request('/signup/passkeys/verify',{response},csrf)).status,200);
 assert.equal((await request('/signup/passkeys/verify',{response},csrf)).status>=400,true);
 assert.equal((await service.listUsers()).users.length,0);
 assert.equal((await request('/signup/complete',{termsAccepted:'true'},csrf)).status,200);
 const user=(await service.listUsers()).users[0]!;assert.equal(user.id,Buffer.from(started.options.user.id,'base64url').toString());assert.equal((await service.getPasskey(id))?.accountId,user.id);assert.ok(cookies.has('__Host-urlcode-session'));
 cookies.delete('__Host-urlcode-session');
 const loginCsrf=(await (await request('/csrf')).json() as any).csrf;
 const loginStart=await (await request('/passkeys/login/options',{},loginCsrf)).json() as any;
 const loginClient=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:loginStart.options.challenge,origin:'https://site.example',crossOrigin:false}));
 const counter=Buffer.alloc(4);counter.writeUInt32BE(1);
 const loginAuth=Buffer.concat([createHash('sha256').update('site.example').digest(),Buffer.from([5]),counter]);
 const signature=sign('sha256',Buffer.concat([loginAuth,createHash('sha256').update(loginClient).digest()]),privateKey);
 const login=await request('/passkeys/login/verify',{flowId:loginStart.flowId,response:{id,rawId:id,type:'public-key',clientExtensionResults:{},response:{clientDataJSON:loginClient.toString('base64url'),authenticatorData:loginAuth.toString('base64url'),signature:signature.toString('base64url')}}},loginCsrf);
 assert.equal(login.status,200);assert.equal((await login.json() as any).user.id,user.id);assert.equal((await service.getPasskey(id))?.credential.counter,1);

});
test('signup identifier replies do not disclose account existence and mutations require CSRF',async t=>{
 const {service,codes,request}=await app(t);await service.register({email:'existing@example.test',password:'correct horse battery staple',profile:{termsAccepted:true}});
 const csrf=(await (await request('/signup')).json() as any).csrf;
 assert.equal((await request('/signup/begin',{email:'other@example.test'})).status,403);
 const existing=await (await request('/signup/begin',{email:'existing@example.test'},csrf)).json() as any;
 assert.equal(existing.step,'verify-email');assert.deepEqual(Object.keys(existing).sort(),['expires','step']);assert.equal(codes.has('existing@example.test'),false);
 const fresh=await (await request('/signup/begin',{email:'fresh@example.test'},csrf)).json() as any;
 assert.equal(fresh.step,existing.step);assert.deepEqual(Object.keys(fresh).sort(),Object.keys(existing).sort());
 const resumed=await (await request('/signup')).json() as any;assert.equal(resumed.step,'verify-email');assert.equal(resumed.flowId,undefined);assert.equal(resumed.email,undefined);
 await request('/signup/restart',{},csrf);assert.equal((await (await request('/signup')).json() as any).step,'identifier');
});

test('waitlist signup verifies email before accepting credentials and queues an account without issuing a session',async t=>{
 const {service,codes,cookies,request}=await app(t,'waitlist');const csrf=(await (await request('/signup')).json() as any).csrf;
 assert.equal((await request('/signup/begin',{email:'waiting@example.test'},csrf)).status,200);
 assert.equal((await request('/signup/password',{password:'correct horse battery staple'},csrf)).status>=400,true);
 assert.equal((await request('/signup/verify',{code:codes.get('waiting@example.test')},csrf)).status,200);
 assert.equal((await request('/signup/password',{password:'correct horse battery staple'},csrf)).status,200);
 const completed=await request('/signup/complete',{termsAccepted:'true'},csrf);assert.equal(completed.status,200);assert.equal((await completed.json() as any).redirect,'/account/signup/pending');
 assert.equal((await service.listUsers()).users.length,0);assert.equal((await service.listRegistrationRequests()).requests.length,1);assert.equal(cookies.has('__Host-urlcode-session'),false);
 const pending=await request('/signup/pending',undefined,undefined,true);assert.ok((await pending.text()).includes('administrator will review'));
});
