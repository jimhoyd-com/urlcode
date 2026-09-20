import { test as base } from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHmac} from 'node:crypto';
import {startServer} from '@jimhoyd/urlcode';
import {inspectExtensionRevision} from '@jimhoyd/urlcode/extensions';
import {createAuthService} from '../src/auth-core.ts';
import {authExtension} from '../src/auth.ts';
import {createPresentation} from '../src/presentation.ts';
import type { TestContext } from 'node:test';
import { eachRenderPath, kitSetup, renderOf } from './support/render.ts';
import { body } from './support/json-api.ts';
import type { EnrollmentRequiredBody, TotpBeginBody } from './support/json-api.ts';
import {removeAtExit} from './support/temp.ts';
const test = (name: string, fn: (t: TestContext) => Promise<void>) => eachRenderPath(base, name, fn);
function totp(secret:string){const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits=0,value=0;const bytes:number[]=[];for(const char of secret){value=(value<<5)|alphabet.indexOf(char);bits+=5;if(bits>=8){bits-=8;bytes.push((value>>>bits)&255);}}const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const digest=createHmac('sha1',Buffer.from(bytes)).update(counter).digest(),offset=digest.at(-1)!&15;return String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');}

test('approved manual recovery is localized, CSRF protected, one-use and restricted until new MFA enrollment',async t=>{
 const root=await mkdtemp(join(tmpdir(),'manual-http-'));removeAtExit(root);const project=join(root,'project');await mkdir(project);
 const render=renderOf(t),kit=kitSetup(render,project,'');
 await writeFile(join(project,'urlcode.yaml'),JSON.stringify({version:'1',extensions:{auth:{version:'1',config:{registration:'open'}},...kit.extensions},routes:{'/account/*':{extension:'auth',methods:['GET','HEAD','POST']},'/private':{respond:{json:{private:true}},policies:{extensions:{auth:{}}}},...kit.routes}}));
 const projectSha256=await inspectExtensionRevision(project),{ui,registrations}=kitSetup(render,project,projectSha256);
 const service=await createAuthService({database:join(root,'auth.sqlite'),encryptionKey:randomBytes(32),roles:{admin:['*'],member:['site.read']},defaultRole:'member',allowManualRecovery:true});
 const maker=await service.bootstrapAdmin({email:'maker@example.test',password:'correct horse battery staple'}),checkerInitial=await service.register({email:'checker@example.test',password:'correct horse battery staple'});
 await service.adminSetRoles({actorToken:maker.token,accountId:checkerInitial.user.id,roles:['admin']});const checker=await service.login({email:'checker@example.test',password:'correct horse battery staple'});
 const original=await service.register({email:'old@example.test',password:'original password before recovery'});await service.linkExternal({actorToken:original.token,provider:'oidc-fixture',subject:'old-subject'});
 const reset=await service.issueToken({email:original.user.email,purpose:'reset-password'});
 const recovery=await service.createRecoveryCase({actorToken:maker.token,accountId:original.user.id,email:'restored@example.test',evidence:{summary:'Offline identity evidence independently assessed',reference:'internal-case-123'},reason:'Lost access to all sign-in methods'});
 await assert.rejects(service.approveRecoveryCase({actorToken:maker.token,caseId:recovery.id,reason:'Self approval is forbidden'}));
 const approved=await service.approveRecoveryCase({actorToken:checker.token,caseId:recovery.id,reason:'Independently verified evidence and replacement address'});
 const origin='https://site.example',presentation=createPresentation({catalogues:{fr:{'manualRecovery.restoreTitle':'Rétablir accès','manualRecovery.restoreIntro':'<img src=x onerror=alert(1)> Vérification humaine','manualRecovery.newPassword':'Nouveau secret','manualRecovery.replace':'Continuer avec MFA'}}});
 const server=await startServer({project,origin,port:0,extensions:[...registrations,authExtension({service,csrfKey:randomBytes(32),projectSha256,presentation,...(ui?{ui}:{})})],log:()=>{}});t.after(async()=>{await server.close();await service.close();});
 const cookies=new Map<string,string>();
 async function request(path:string,data?:Record<string,string>,csrf?:string,html=false){const response=await fetch(`http://127.0.0.1:${server.address.port}${path}`,{method:data?'POST':'GET',redirect:'manual',headers:{accept:html?'text/html':'application/json',cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),...(data?{'content-type':'application/json',origin}:{}),...(csrf?{'x-csrf-token':csrf}:{})},...(data?{body:JSON.stringify(data)}:{})});for(const header of response.headers.getSetCookie()){const [key,value]=header.split(';')[0]!.split('=');if(header.includes('Max-Age=0'))cookies.delete(key!);else cookies.set(key!,value!);}return response;}
 assert.equal((await request('/account/restore-access?token='+approved.token+'&token='+approved.token)).status,400);
 const page=await request('/account/restore-access?token='+approved.token+'&lang=fr',undefined,undefined,true),html=await page.text();assert.equal(page.status,200);assert.ok(html.includes('Nouveau secret'));assert.ok(html.includes('Continuer avec MFA'));assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img src=x'));assert.ok(html.includes('/account/restore-access?lang=fr'));assert.ok(page.headers.get('cache-control')?.includes('no-store'));assert.equal(page.headers.get('referrer-policy'),'strict-origin');
 let csrf=html.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
 const data={token:approved.token,password:'new password after human recovery'};
 assert.equal((await request('/account/restore-access',data)).status,403);
 assert.equal((await request('/account/restore-access',data,csrf)).status>=400,true); // Delivery has not been activated.
 await service.activateRecoveryCase({actorToken:checker.token,caseId:recovery.id,token:approved.token});
 const restored=await request('/account/restore-access?lang=fr',data,csrf);assert.equal(restored.status,200);const result=await body<EnrollmentRequiredBody>(restored);assert.equal(result.enrollmentRequired,true);assert.equal(result.token,undefined);assert.equal(result.user.email,'restored@example.test');csrf=result.csrf;
 assert.equal(await service.authenticate(original.token),null);assert.equal(await service.findExternal('oidc-fixture','old-subject'),null);await assert.rejects(service.resetPassword({token:reset.token!,password:'old reset must not work anymore'}));
 const principal=await service.authenticate(cookies.get('__Host-urlcode-session')!);assert.deepEqual(principal?.roles,[]);assert.deepEqual(principal?.restrictions,['enroll-mfa']);assert.equal((await request('/private')).status,403);
 assert.equal((await request('/account/restore-access',data,csrf)).status>=400,true);assert.equal((await request('/account/change-password',{currentPassword:data.password,password:'another password without fresh factor'},csrf)).status,403);
 const begun=await request('/account/totp/begin',{},csrf);assert.equal(begun.status,200);const secret=(await body<TotpBeginBody>(begun)).secret;
 assert.equal((await request('/account/totp/confirm',{code:totp(secret)},csrf)).status,200);assert.equal((await request('/private')).status,200);
});
