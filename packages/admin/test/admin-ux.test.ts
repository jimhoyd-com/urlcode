import { cleanup } from './cleanup.ts';
import test from 'node:test';
import {activatedUi} from './support/render.ts';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {createAuthService,createPresentation} from '@jimhoyd/urlcode-auth';
import {adminExtension} from '../src/admin.ts';
import {createAdminPresentation} from '../src/admin-copy.ts';

test('admin pages share one meaningful heading and skip target while retaining empty states, filters and sensitive action forms',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'admin-ux-'));cleanup(t, ()=>rm(directory,{recursive:true,force:true}));
 const service=await createAuthService({database:join(directory,'auth.sqlite'),encryptionKey:randomBytes(32),roles:{member:[],admin:['*']},defaultRole:'member'});cleanup(t, ()=>service.close());
 const owner=await service.bootstrapAdmin({email:'owner@example.test',password:'synthetic UX review passphrase'});
 const origin='https://example.test',projectSha256='a'.repeat(64),ui=await activatedUi(t,directory,projectSha256);
 const instance=await adminExtension({service,csrfKey:randomBytes(32),projectSha256,ui,health:async()=>({checkedAt:new Date().toISOString(),runtime:{status:'healthy',readiness:'healthy',version:'test',routes:4},sender:'unknown',providers:[],alerts:[]})}).activate({},{origin,target:'node',projectSha256,mounts:['/admin'], root: import.meta.dirname});
 async function get(path:string){const url=new URL('/admin'+path,origin);const result=await instance.handle({method:'GET',target:url.pathname+url.search,path:url.pathname,query:url.searchParams,headers:new Headers({cookie:'__Host-urlcode-session='+owner.token,accept:'text/html'}),headerCounts:{cookie:1},body:new Uint8Array(),origin,route:'/admin/*',mount:'/admin',client:null});assert.equal(result.status,200,path);const html=Buffer.from(result.body!).toString();assert.equal((html.match(/<h1(?: |>|\n)/g)||[]).length,1,path);
  // The kit builds the console shell: skip target `#main`, one navigation, one sidebar, no hand-built mobile duplicate.
  assert.ok(html.includes('href="#main"'),path);assert.ok(html.includes('id="main" tabindex="-1"'),path);
  assert.doesNotMatch(html,/ui-mobile-navigation/);assert.doesNotMatch(html,/ui-header/);
  assert.equal((html.match(/<nav class="ui-nav" aria-label="Primary">/g)||[]).length,1,path);assert.equal((html.match(/<aside class="ui-sidebar">/g)||[]).length,1,path);
  assert.ok(result.headers.some(([name,value])=>name==='cache-control'&&value==='no-store'));return html;}
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

test('a base presentation carrying project adminUi.* translations reaches the admin copy; unsupplied ids keep the bundled English',()=>{
 const base=createPresentation({catalogues:{fr:{'adminUi.noSessions':'Aucune session (projet).'}}});
 const factory=createAdminPresentation({base});
 const fr=factory.resolve({queryLocale:'fr'});
 assert.equal(fr.text('adminUi.noSessions'),'Aucune session (projet).');
 assert.equal(fr.textSource('No active sessions match these filters.'),'Aucune session (projet).');
 assert.equal(fr.text('adminUi.noAudit'),factory.english['adminUi.noAudit']);
 assert.equal(factory.resolve({queryLocale:'en'}).text('adminUi.noSessions'),factory.english['adminUi.noSessions']);
});
