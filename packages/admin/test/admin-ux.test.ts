import base from 'node:test';
import type {TestContext} from 'node:test';
import {activatedUi,eachRenderPath,renderOf} from './support/render.ts';
const test=(name:string,fn:(t:TestContext)=>Promise<void>)=>eachRenderPath(base,name,fn);
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
 const origin='https://example.test',projectSha256='a'.repeat(64),render=renderOf(t),ui=await activatedUi(t,render,directory,projectSha256);
 const instance=await adminExtension({service,csrfKey:randomBytes(32),projectSha256,...(ui?{ui}:{}),health:async()=>({checkedAt:new Date().toISOString(),runtime:{status:'healthy',readiness:'healthy',version:'test',routes:4},sender:'unknown',providers:[],alerts:[]})}).activate({},{origin,target:'node',projectSha256,mounts:['/admin'], root: import.meta.dirname});
 async function get(path:string){const url=new URL('/admin'+path,origin);const result=await instance.handle({method:'GET',target:url.pathname+url.search,path:url.pathname,query:url.searchParams,headers:new Headers({cookie:'__Host-urlcode-session='+owner.token,accept:'text/html'}),headerCounts:{cookie:1},body:new Uint8Array(),origin,route:'/admin/*',mount:'/admin',client:null});assert.equal(result.status,200,path);const html=Buffer.from(result.body!).toString();assert.equal((html.match(/<h1(?: |>|\n)/g)||[]).length,1,path);
  // The kit builds the console shell on its own path (skip target `#main`, one navigation, no mobile duplicate); the primitives keep their hand-built shell.
  const target=render==='kit'?'main':'admin-content';
  assert.ok(html.includes('href="#'+target+'"'),path);assert.ok(html.includes('id="'+target+'" tabindex="-1"'),path);
  assert.match(html,/<aside class="ui-sidebar"/);
  if(render==='kit'){assert.doesNotMatch(html,/ui-mobile-navigation/);assert.doesNotMatch(html,/ui-header/);assert.equal((html.match(/<nav class="ui-nav" aria-label="Primary">/g)||[]).length,1,path);assert.equal((html.match(/<aside class="ui-sidebar">/g)||[]).length,1,path);}
  else assert.match(html,/class="ui-mobile-navigation"/);
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

base('admin-owned UX copy supports custom locales without adding account copy to shared UI',()=>{
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
