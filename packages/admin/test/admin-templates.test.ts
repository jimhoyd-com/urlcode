import { cleanup } from './cleanup.ts';
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createKit,createPresentation as createUiPresentation,kitCatalogue,mergeCatalogues,isMarkup} from '@jimhoyd/urlcode-ui';
import type {ViewModel,ViewValue} from '@jimhoyd/urlcode-ui';
import {adminCatalogue,copyObserver} from '../src/admin-copy.ts';
import {screenObserver} from '../src/admin-ui.ts';
import type {Screen} from '../src/admin-ui.ts';
import {adminTemplates,adminTemplateNames,adminUiTemplates} from '../src/admin-templates.ts';
import {adminSite,password,text as bodyText} from './support/site.ts';
/** Compares a real view with a sample the way `urlcode-ui doctor` would: same keys at every level, list items against the sample item, Markup and scalars as leaves. A null where the sample has an object is an optional section the flow left out. */
function mismatch(real:ViewValue,sample:ViewValue,path=''):string|undefined {
 if(Array.isArray(sample)){
  if(!Array.isArray(real))return `${path}: expected a list`;
  for(const [index,item] of real.entries()){const found=mismatch(item,sample[0]!,`${path}[${index}]`);if(found)return found;}
  return undefined;
 }
 if(sample&&typeof sample==='object'&&!isMarkup(sample)){
  if(real===null)return undefined;
  if(!real||typeof real!=='object'||Array.isArray(real)||isMarkup(real))return `${path}: expected an object`;
  const wanted=Object.keys(sample).sort(),got=Object.keys(real).sort();
  if(JSON.stringify(wanted)!==JSON.stringify(got))return `${path}: keys ${JSON.stringify(got)} differ from sample ${JSON.stringify(wanted)}`;
  for(const key of wanted){const found=mismatch((real as ViewModel)[key],(sample as ViewModel)[key],`${path}.${key}`);if(found)return found;}
  return undefined;
 }
 return undefined;
}
test('every admin template declares its view model, renders its sample through the kit and places copy only through its view',()=>{
 const presentation=createUiPresentation({defaults:mergeCatalogues([kitCatalogue,adminCatalogue])});
 const kit=createKit({presentation,extensions:[adminUiTemplates]});
 const context=kit.resolveContext();
 assert.equal(adminTemplateNames.length,13);
 for(const name of adminTemplateNames){
  const info=kit.info(name)!;
  assert.equal(info.origin,'extension:admin');
  assert.equal(info.viewModel,`${name}@1`,`${name} declares its view model`);
  assert.equal(info.behind,false);
  const html=kit.render(name,adminTemplates[name]!.sample,context).html;
  assert.ok(html.length>0&&!html.includes('{{'),`${name} renders its sample`);
  assert.match(new TextDecoder().decode(kit.page(name,adminTemplates[name]!.sample,{title:'Sample',context}).body),/<main id="main"/);
  // Copy reaches a template through the view the extension computed, so a project translation cannot desynchronise a template from its flow or its permission gates.
  assert.deepEqual(kit.template(name)!.copyKeys,[],`${name} places copy through its view`);
 }
 assert.deepEqual(kit.report().behind,[]);
 assert.equal(Object.keys(adminUiTemplates.templates).length,13);
});
test('the views the extension computes match the sample view models key for key, and every string they show is admin copy',async t=>{
 const observed=new Map<string,ViewModel>(),missing=new Set<string>();
 screenObserver.current=(screen:Screen)=>{if(!observed.has(screen.name))observed.set(screen.name,screen.view);};
 copyObserver.missing=source=>{missing.add(source);};
 cleanup(t, ()=>{screenObserver.current=undefined;copyObserver.missing=undefined;});
 const {request,owner,member}=await app(t);
 const {csrf}=await (await request('/admin',owner.token)).json() as {csrf:string};
 for(const page of ['/admin','/admin/users','/admin/users/detail?id='+member.user.id,'/admin/sessions','/admin/roles','/admin/audit','/admin/registrations','/admin/cases','/admin/health','/admin/recovery-cases','/admin/account-operations','/admin/account-operations?accountId='+member.user.id])
  assert.equal((await request(page,owner.token,{html:true})).status,200,page);
 assert.equal((await request('/admin/users/note',owner.token,{html:true,data:{accountId:member.user.id,reason:'walkthrough note',csrf}})).status,200);
 assert.equal((await request('/admin/users/reveal',owner.token,{html:true,data:{accountId:member.user.id,reason:'walkthrough reveal',csrf}})).status,200);
 assert.equal((await request('/admin/users/status',owner.token,{html:true,data:{accountId:member.user.id,status:'locked',reason:'walkthrough lock',csrf}})).status,200);
 assert.equal((await request('/admin/nowhere',owner.token,{html:true})).status,404,'the failure screen renders through the kit');
 assert.equal((await request('/admin/users/status',owner.token,{html:true,data:{accountId:member.user.id,status:'locked',reason:'x'.repeat(300),csrf}})).status,400,'a refusal renders admin copy too');
 assert.deepEqual([...missing],[],'every English source the console resolved is in the admin catalogue');
 assert.deepEqual(adminTemplateNames.filter(name=>!observed.has(name)),[],'the walkthrough reaches every template');
 for(const [name,view] of observed)
  assert.equal(mismatch(view,adminTemplates[name]!.sample,name),undefined,`${name}: real view matches its sample shape`);
});
test('kit-rendered admin pages escape user-controlled values and keep the strict CSP, no-store and the hashed stylesheet',async t=>{
 const {request,service,owner,member}=await app(t);
 const displayName='x<script>alert(1)</script>"onload="x';
 await service.updateProfile({token:member.token,profile:{displayName}});
 const page=await request('/admin/users/detail?id='+member.user.id,owner.token,{html:true});
 const html=await page.text();
 assert.equal(page.status,200);
 assert.equal((html.match(/<h1(?: |>|\n)/g)??[]).length,1,'kit console keeps one page heading');
 assert.match(html,/href="#main"/);
 assert.match(html,/<aside class="ui-sidebar"/);
 // The kit renders the console shell: exactly one navigation, exactly one shell, and no CSS-hidden duplicate header.
 assert.equal((html.match(/<nav class="ui-nav" data-slot="sidebar-group" aria-label="Primary">/g)??[]).length,1,'one console navigation element on a kit console page');
 assert.equal((html.match(/<aside class="ui-sidebar" data-slot="sidebar">/g)??[]).length,1);
 assert.equal((html.match(/ui-shell/g)??[]).length,1);
 assert.doesNotMatch(html,/ui-header/);
 assert.doesNotMatch(html,/ui-mobile-navigation/);
 assert.match(html,/<div class="ui-content" data-slot="sidebar-inset" id="main" tabindex="-1"><header class="ui-page-header" data-slot="page-header"><h1>Account details<\/h1><\/header>/);
 const sidebar=html.slice(html.indexOf('<aside class="ui-sidebar"'),html.indexOf('</aside>'));
 for(const label of ['Overview','Users','Sessions','Audit','Roles'])assert.equal((sidebar.match(new RegExp('>'+label+'</a>','g'))??[]).length,1,label+' appears once in the console navigation');
 assert.doesNotMatch(html,/<script>alert/);
 assert.match(html,/<dd>x&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;onload=&quot;x<\/dd>/);
 const subject='"><img src=x onerror=alert(1)>';
 const audit=await request('/admin/audit?subject='+encodeURIComponent(subject),owner.token,{html:true});
 const auditHtml=await audit.text();
 assert.equal(audit.status,200);
 assert.doesNotMatch(auditHtml,/<img src=x/);
 assert.match(auditHtml,/value="&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;"/);
 const nonce=/<style nonce="([A-Za-z0-9+/=]+)">/.exec(html)![1]!;
 const csp=page.headers.get('content-security-policy')!;
 assert.ok(csp.includes(`script-src 'nonce-${nonce}'`)&&csp.includes("default-src 'none'")&&csp.includes("form-action 'self'")&&csp.includes("frame-ancestors 'none'"));
 assert.doesNotMatch(csp,/unsafe-inline/);
 assert.doesNotMatch(html,/<script(?! nonce=")/);
 assert.equal(page.headers.get('cache-control'),'no-store');
 assert.equal(page.headers.get('x-content-type-options'),'nosniff');
 assert.match(html,/<link rel="stylesheet" href="\/assets\/ui\/static\/kit\.[0-9a-f]{12}\.css">/);
 const stylesheet=await request(/href="(\/assets\/ui\/static\/kit\.[0-9a-f]{12}\.css)"/.exec(html)![1]!,owner.token);
 assert.equal(stylesheet.status,200);
 assert.match(stylesheet.headers.get('etag')??'',/^"[0-9a-f]+"$/);
 assert.match(stylesheet.headers.get('cache-control')??'',/immutable/);
 // The failure screen is the admin status template on the kit path: the same headers, an alert and no console navigation leak.
 const failure=await request('/admin/users/detail?id=missing',owner.token,{html:true});
 assert.equal(failure.status,404);
 assert.match(await failure.text(),/<p role="alert" class="error">Account not found<\/p>/);
 assert.equal(failure.headers.get('cache-control'),'no-store');
 // A member without any console permission still gets nothing but a 404, whichever path renders it.
 assert.equal((await request('/admin',member.token,{html:true})).status,404);
});
async function app(t:TestContext) {
 const health=async()=>({checkedAt:new Date().toISOString(),runtime:{status:'healthy' as const,readiness:'healthy' as const,version:'test',routes:4},sender:'unknown' as const,providers:[],alerts:['sender-failed' as const]});
 const site=await adminSite(t,{health,auth:{allowImpersonation:true,allowManualRecovery:true}});
 const service=site.service;
 const owner=await service.bootstrapAdmin({email:'owner@example.test',password});
 const member=await service.register({email:'member@example.test',password});
 async function request(path:string,token:string,{data,html=false}:{data?:Record<string,string>;html?:boolean}={}) {
  const {csrf,...fields}=data??{};
  const response=await site.call(path,token,{html,...(data?{fields,csrf:csrf??false,form:html}:{})});
  return {status:response.status,headers:new Headers(response.headers),text:async()=>bodyText(response),json:async()=>JSON.parse(bodyText(response)) as unknown};
 }
 return {request,service,owner,member};
}
