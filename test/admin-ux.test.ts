import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {createAuthService} from '@jimhoyd/urlcode-auth';
import {adminExtension} from '../src/admin.ts';
import {createAdminPresentation} from '../src/admin-copy.ts';

test('admin pages share one meaningful heading and skip target while retaining empty states, filters and sensitive action forms',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'admin-ux-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const service=await createAuthService({database:join(directory,'auth.sqlite'),encryptionKey:randomBytes(32),roles:{member:[],admin:['*']},defaultRole:'member'});t.after(()=>service.close());
 const owner=await service.bootstrapAdmin({email:'owner@example.test',password:'synthetic UX review passphrase'});
 const origin='https://example.test',projectSha256='a'.repeat(64);
 const instance=await adminExtension({service,csrfKey:randomBytes(32),projectSha256,health:async()=>({checkedAt:new Date().toISOString(),runtime:{status:'healthy',readiness:'healthy',version:'test',routes:4},sender:'unknown',providers:[],alerts:[]})}).activate({},{origin,target:'node',projectSha256,mounts:['/admin']});
 async function get(path:string){const url=new URL('/admin'+path,origin);const result=await instance.handle({method:'GET',target:url.pathname+url.search,path:url.pathname,query:url.searchParams,headers:new Headers({cookie:'__Host-urlcode-session='+owner.token,accept:'text/html'}),headerCounts:{cookie:1},body:new Uint8Array(),origin,route:'/admin/*',mount:'/admin',client:null});assert.equal(result.status,200,path);const html=Buffer.from(result.body!).toString();assert.equal((html.match(/<h1>/g)||[]).length,1,path);assert.ok(html.includes('href="#admin-content"'));assert.ok(html.includes('id="admin-content" tabindex="-1"'));assert.ok(result.headers.some(([name,value])=>name==='cache-control'&&value==='no-store'));return html;}
 for(const path of ['/','/users','/roles','/sessions','/audit','/health','/cases','/registrations','/users/detail?id='+owner.user.id])await get(path);
 const sessions=await get('/sessions');assert.match(sessions, /class="ui-button-destructive"/);assert.match(sessions, /name="csrf"/);assert.match(sessions, /name="reason"/);assert.match(sessions, /\/sessions\/revoke-one/);
 const subject=randomUUID(),audit=await get('/audit?subject='+subject+'&action=session.absent');assert.ok(audit.includes('name="subject" type="text" autocomplete="off" maxlength="1024" value="'+subject+'"'));assert.match(audit,/No audit events match these filters/);
 assert.match(await get('/sessions?accountId='+subject),/No active sessions match these filters/);
 assert.match(await get('/cases'),/No support cases to review/);
 assert.match(await get('/registrations'),/No registration requests are waiting for approval/);
 assert.match(await get('/health'),/No alerts reported/);
 assert.doesNotMatch(await get('/users/detail?id='+owner.user.id),/href="\/admin\/recovery-cases"/);
});

test('admin-owned UX copy supports custom locales without adding account copy to shared UI',()=>{
 const factory=createAdminPresentation({catalogues:{fr:{'adminUi.noSessions':'Aucune session active.','adminUi.auditFilters':'Filtrer les événements'}}});
 const presentation=factory.resolve({queryLocale:'fr'});
 assert.equal(factory.defaultLocale,'en');
 assert.equal(factory.english['adminUi.noSessions'],'No active sessions match these filters.');
 assert.equal(presentation.has('adminUi.noSessions'),true);
 assert.equal(presentation.has('nav.users'),true);
 assert.equal(presentation.has('adminUi.nonexistent'),false);
 assert.equal(typeof presentation.formatNumber(1234),'string');
 assert.ok(factory.coverage('fr').missing.includes('adminUi.noAudit'));
 assert.ok(!factory.coverage('fr').missing.includes('adminUi.noSessions'));
 assert.equal(presentation.textSource('No active sessions match these filters.'),'Aucune session active.');
 assert.equal(presentation.textSource('Filter audit events'),'Filtrer les événements');
 assert.equal(presentation.text('nav.users'),'Users');
});
