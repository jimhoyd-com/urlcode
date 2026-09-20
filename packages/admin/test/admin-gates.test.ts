import { cleanup } from './cleanup.ts';
import base from 'node:test';
import type {TestContext} from 'node:test';
import {activatedUi,eachRenderPath,renderOf} from './support/render.ts';
const test=(name:string,fn:(t:TestContext)=>Promise<void>)=>eachRenderPath(base,name,fn);
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {AuthHttp,createAuthService} from '@jimhoyd/urlcode-auth';
import type {AuthService} from '@jimhoyd/urlcode-auth';
import {adminExtension} from '../src/admin.ts';
import type {AdminExtensionOptions} from '../src/admin.ts';
const origin='https://example.test',projectSha256='a'.repeat(64),csrfKey=randomBytes(32),http=new AuthHttp({origin,csrfKey}),password='synthetic gate review passphrase';
function client(service:AuthService,extra:Partial<AdminExtensionOptions>={}){
 const instance=adminExtension({service,csrfKey,projectSha256,...extra}).activate({},{origin,target:'node',projectSha256,mounts:['/admin'], root: import.meta.dirname});
 return async(method:string,path:string,token:string,fields?:Record<string,string>,html=false)=>{const url=new URL('/admin'+path,origin);return (await instance).handle({method,target:url.pathname+url.search,path:url.pathname,query:url.searchParams,headers:new Headers({cookie:'__Host-urlcode-session='+token,origin,'content-type':html?'application/x-www-form-urlencoded':'application/json',accept:html?'text/html':'application/json'}),headerCounts:{cookie:1,origin:1},body:fields?new TextEncoder().encode(html?new URLSearchParams({...fields,csrf:http.token(token)}).toString():JSON.stringify({...fields,csrf:http.token(token)})):new Uint8Array(),origin,route:'/admin/*',mount:'/admin',client:null});};
}
const header=(response:{headers:[string,string][]},name:string)=>response.headers.find(([key])=>key===name)?.[1];

test('admin gates: role assignment, invitations, audit export, methods and CSV export headers',async t=>{
 const root=await mkdtemp(join(tmpdir(),'admin-gates-'));cleanup(t, ()=>rm(root,{recursive:true,force:true}));
 const service=await createAuthService({database:join(root,'auth.sqlite'),encryptionKey:randomBytes(32),roles:{member:[],reader:['auth.users.read'],auditor:['auth.audit.read'],exporter:['auth.audit.read','auth.audit.export'],admin:['*']},defaultRole:'member'});cleanup(t, ()=>service.close());
 const owner=await service.bootstrapAdmin({email:'owner@example.test',password}),target=await service.register({email:'target@example.test',password});
 const as=async(role:string)=>{await service.adminSetRoles({actorToken:owner.token,accountId:target.user.id,roles:[role],reason:'gate fixture'});return (await service.login({email:target.user.email,password})).token;};
 const ui=await activatedUi(t,renderOf(t),root,projectSha256),withUi=ui?{ui}:{};
 const call=client(service,withUi);
 assert.equal((await call('POST','/users/roles',await as('reader'),{accountId:target.user.id,roles:'admin',reason:'self escalation attempt'})).status,403);
 assert.deepEqual((await service.getUser(target.user.id))!.roles,['reader']);
 assert.equal((await call('POST','/users/roles',owner.token,{accountId:target.user.id,roles:'reader, auditor',reason:'grant audit access'})).status,200);
 assert.deepEqual((await service.getUser(target.user.id))!.roles,['reader','auditor']);
 const inviteService=await createAuthService({database:join(root,'invite.sqlite'),encryptionKey:randomBytes(32),roles:{member:[],admin:['*']},defaultRole:'member',registrationMode:'invite-only'});cleanup(t, ()=>inviteService.close());
 const inviter=await inviteService.bootstrapAdmin({email:'inviter@example.test',password}),invitation={email:'invited@example.test',reason:'delivery configured'};
 assert.equal((await client(inviteService,withUi)('POST','/invitations',inviter.token,invitation)).status,503);
 const invitations:{email:string;token:string}[]=[],inviting=client(inviteService,{...withUi,sendInvitation:async message=>{invitations.push(message);}});
 const invited=await inviting('POST','/invitations',inviter.token,invitation);
 assert.equal(invited.status,200);assert.equal(invitations.length,1);assert.equal(invitations[0]!.email,'invited@example.test');assert.ok(invitations[0]!.token);
 assert.doesNotMatch(Buffer.from(invited.body!).toString(),new RegExp(invitations[0]!.token));
 const range='?from=2024-01-01T00:00Z&to=2024-01-02T00:00Z';
 assert.equal((await call('GET','/audit/export'+range,await as('auditor'))).status,403);
 const exported=await call('GET','/audit/export'+range,await as('exporter'));
 assert.equal(exported.status,200);assert.equal(header(exported,'content-disposition'),'attachment; filename="audit-range.json"');
 for(const method of ['PUT','DELETE','PATCH']){const denied=await call(method,'/users',owner.token);assert.equal(denied.status,405);assert.equal(header(denied,'allow'),'GET, HEAD, POST');}
 const rangeCsv=await call('POST','/users/export-range',owner.token,{reason:'complete filtered export'});
 assert.equal(rangeCsv.status,200);assert.equal(header(rangeCsv,'content-type'),'text/csv; charset=utf-8');assert.equal(header(rangeCsv,'content-disposition'),'attachment; filename="accounts-filtered.csv"');
 const pageCsv=await call('POST','/users/export-page',owner.token,{reason:'one page export'});
 assert.equal(pageCsv.status,200);assert.equal(header(pageCsv,'content-type'),'text/csv; charset=utf-8');assert.equal(header(pageCsv,'content-disposition'),'attachment; filename="accounts-page.csv"');
 assert.match(Buffer.from(pageCsv.body!).toString(),/^"id","email_masked"/);
});

test('admin mutations require a recent sign-in and a bounded reason; auth mounts are validated',async t=>{
 const root=await mkdtemp(join(tmpdir(),'admin-fresh-'));cleanup(t, ()=>rm(root,{recursive:true,force:true}));
 const now=Date.now()-6*60*1000;
 const service=await createAuthService({database:join(root,'auth.sqlite'),encryptionKey:randomBytes(32),roles:{member:[],admin:['*']},defaultRole:'member',now:()=>now});cleanup(t, ()=>service.close());
 const ui=await activatedUi(t,renderOf(t),root,projectSha256),owner=await service.bootstrapAdmin({email:'owner@example.test',password}),call=client(service,ui?{ui}:{});
 assert.equal((await service.authenticate(owner.token))!.authenticatedAt,now);
 const stale=await call('POST','/users/note',owner.token,{accountId:owner.user.id,reason:'signed in six minutes ago'});
 assert.equal(stale.status,403);assert.match(Buffer.from(stale.body!).toString(),/Confirm your identity/);
 const stalePage=await call('POST','/users/note',owner.token,{accountId:owner.user.id,reason:'signed in six minutes ago'},true);
 assert.equal(stalePage.status,403);assert.match(Buffer.from(stalePage.body!).toString(),/<p role="alert" class="error">Confirm your identity before this action<\/p>/);
 assert.equal((await call('POST','/users/note',owner.token,{accountId:owner.user.id,reason:'x'.repeat(257)})).status,400);
 assert.equal((await call('POST','/users/note',owner.token,{accountId:owner.user.id,reason:'   '})).status,400);
 assert.equal((await service.listAudit({action:'admin.note'})).events.length,0);
 for(const authMount of ['account','/account//x','/acc ount','/account?x'])assert.throws(()=>adminExtension({service,csrfKey,projectSha256,authMount}),/Invalid auth mount/);
 assert.doesNotThrow(()=>adminExtension({service,csrfKey,projectSha256,authMount:'/my-account_v2'}));
});
