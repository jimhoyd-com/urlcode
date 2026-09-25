import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {adminSite,password,text} from './support/site.ts';

test('admin pages share one meaningful heading and skip target while retaining empty states, filters and sensitive action forms',async t=>{
 const site=await adminSite(t,{health:async()=>({checkedAt:new Date().toISOString(),runtime:{status:'healthy',readiness:'healthy',version:'test',routes:4},sender:'unknown',providers:[],alerts:[]})});
 const owner=await site.service.bootstrapAdmin({email:'owner@example.test',password});
 async function get(path:string){const result=await site.call('/admin'+path,owner.token,{html:true});assert.equal(result.status,200,path);const html=text(result);assert.equal((html.match(/<h1(?: |>|\n)/g)||[]).length,1,path);
  // The kit builds the console shell: skip target `#main`, one navigation, one sidebar, no hand-built mobile duplicate.
  assert.ok(html.includes('href="#main"'),path);assert.ok(html.includes('id="main" tabindex="-1"'),path);
  assert.doesNotMatch(html,/ui-mobile-navigation/);assert.doesNotMatch(html,/ui-header/);
  assert.equal((html.match(/<nav class="ui-nav" data-slot="sidebar-group" aria-label="Primary">/g)||[]).length,1,path);assert.equal((html.match(/<aside class="ui-sidebar" data-slot="sidebar">/g)||[]).length,1,path);
  assert.ok(result.headers.some(([name,value])=>name==='cache-control'&&value==='no-store'));return html;}
 for(const path of ['/','/users','/roles','/sessions','/audit','/health','/cases','/registrations','/users/detail?id='+owner.user.id])await get(path);
 const sessions=await get('/sessions');assert.match(sessions, /class="ui-button ui-button-destructive"/);assert.match(sessions, /name="csrf"/);assert.match(sessions, /name="reason"/);assert.match(sessions, /\/sessions\/revoke-one/);
 const subject=randomUUID(),audit=await get('/audit?subject='+subject+'&action=session.absent');assert.ok(audit.includes('name="subject" type="text" autocomplete="off" maxlength="1024" value="'+subject+'"'));assert.match(audit,/No audit events match these filters/);
 assert.match(await get('/sessions?accountId='+subject),/No active sessions match these filters/);
 assert.match(await get('/cases'),/No support cases to review/);
 assert.match(await get('/registrations'),/No registration requests are waiting for approval/);
 assert.match(await get('/health'),/No alerts reported/);
 assert.doesNotMatch(await get('/users/detail?id='+owner.user.id),/href="\/admin\/recovery-cases"/);
});
