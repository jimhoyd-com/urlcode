import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createKit,createPresentation as createUiPresentation,kitCatalogue,mergeCatalogues,isMarkup} from '@jimhoyd/urlcode-ui';
import type {ViewModel,ViewValue} from '@jimhoyd/urlcode-ui';
import {startServer} from '@jimhoyd/urlcode';
import {inspectExtensionRevision} from '@jimhoyd/urlcode/extensions';
import {authExtension,createAuthService} from '@jimhoyd/urlcode-auth';
import {adminExtension} from '../src/admin.ts';
import {adminCatalogue} from '../src/admin-copy.ts';
import {screenObserver} from '../src/admin-ui.ts';
import type {RenderPath,Screen} from '../src/admin-ui.ts';
import {adminTemplates,adminTemplateNames,adminUiTemplates} from '../src/admin-templates.ts';
import {kitSetup,renderPaths} from './support/render.ts';
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
test('the views the extension computes match the sample view models key for key, on both render paths',async t=>{
 const observed=new Map<string,{view:ViewModel;paths:Set<RenderPath>}>();
 screenObserver.current=(screen:Screen,path)=>{const entry=observed.get(screen.name)??{view:screen.view,paths:new Set<RenderPath>()};entry.paths.add(path);observed.set(screen.name,entry);};
 t.after(()=>{screenObserver.current=undefined;});
 for(const path of renderPaths){
  const {request,service,owner,member}=await app(t,path);
  const {csrf}=await (await request('/admin',owner.token)).json() as {csrf:string};
  for(const page of ['/admin','/admin/users','/admin/users/detail?id='+member.user.id,'/admin/sessions','/admin/roles','/admin/audit','/admin/registrations','/admin/cases','/admin/health','/admin/recovery-cases','/admin/account-operations','/admin/account-operations?accountId='+member.user.id])
   assert.equal((await request(page,owner.token,{html:true})).status,200,`${page} [${path}]`);
  assert.equal((await request('/admin/users/note',owner.token,{html:true,data:{accountId:member.user.id,reason:'walkthrough note',csrf}})).status,200);
  assert.equal((await request('/admin/users/reveal',owner.token,{html:true,data:{accountId:member.user.id,reason:'walkthrough reveal',csrf}})).status,200);
  assert.equal((await request('/admin/users/status',owner.token,{html:true,data:{accountId:member.user.id,status:'locked',reason:'walkthrough lock',csrf}})).status,200);
  assert.equal((await request('/admin/nowhere',owner.token,{html:true})).status,404,'the failure screen renders on this path');
  await service.close();
 }
 assert.deepEqual(adminTemplateNames.filter(name=>!observed.has(name)),[],'the walkthrough reaches every template');
 for(const [name,entry] of observed){
  assert.deepEqual([...entry.paths].sort(),['kit','primitives'],`${name} rendered on both paths`);
  assert.equal(mismatch(entry.view,adminTemplates[name]!.sample,name),undefined,`${name}: real view matches its sample shape`);
 }
});
test('kit-rendered admin pages escape user-controlled values and keep the strict CSP, no-store and the hashed stylesheet',async t=>{
 const {request,service,owner,member}=await app(t,'kit');
 const displayName='x<script>alert(1)</script>"onload="x';
 await service.updateProfile({token:member.token,profile:{displayName}});
 const page=await request('/admin/users/detail?id='+member.user.id,owner.token,{html:true});
 const html=await page.text();
 assert.equal(page.status,200);
 assert.equal((html.match(/<h1(?: |>|\n)/g)??[]).length,1,'kit console keeps one page heading');
 assert.match(html,/href="#main"/);
 assert.match(html,/<aside class="ui-sidebar"/);
 // The kit renders the console shell: exactly one navigation, exactly one shell, and no CSS-hidden duplicate header.
 assert.equal((html.match(/<nav class="ui-nav" aria-label="Primary">/g)??[]).length,1,'one console navigation element on a kit console page');
 assert.equal((html.match(/<aside class="ui-sidebar">/g)??[]).length,1);
 assert.equal((html.match(/ui-shell/g)??[]).length,1);
 assert.doesNotMatch(html,/ui-header/);
 assert.doesNotMatch(html,/ui-mobile-navigation/);
 assert.match(html,/<div class="ui-content" id="main" tabindex="-1"><header class="ui-page-header"><h1>Account details<\/h1><\/header>/);
 const sidebar=html.slice(html.indexOf('<aside class="ui-sidebar">'),html.indexOf('</aside>'));
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
async function app(t:TestContext,path:RenderPath) {
 const root=await mkdtemp(join(tmpdir(),'urlcode-admin-templates-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const project=join(root,'project');
 await mkdir(project);
 const kit=kitSetup(path,project,'');
 await writeFile(join(project,'urlcode.yaml'),JSON.stringify({version:'1',extensions:{...kit.extensions,auth:{version:'1',config:{registration:'open'}},admin:{version:'1',config:{}}},routes:{...kit.routes,'/account/*':{extension:'auth',methods:['GET','HEAD','POST']},'/admin/*':{extension:'admin',methods:['GET','HEAD','POST']}}}));
 const projectSha256=await inspectExtensionRevision(project),{ui,registrations}=kitSetup(path,project,projectSha256);
 const service=await createAuthService({database:join(root,'accounts.sqlite'),encryptionKey:randomBytes(32),roles:{member:['site.read'],admin:['*']},defaultRole:'member',allowImpersonation:true,allowManualRecovery:true});
 const owner=await service.bootstrapAdmin({email:'owner@example.test',password:'correct horse battery staple'});
 const member=await service.register({email:'member@example.test',password:'correct horse battery staple'});
 const csrfKey=randomBytes(32),withUi=ui?{ui}:{};
 const health=async()=>({checkedAt:new Date().toISOString(),runtime:{status:'healthy' as const,readiness:'healthy' as const,version:'test',routes:4},sender:'unknown' as const,providers:[],alerts:['sender-failed' as const]});
 const server=await startServer({project,origin:'https://example.test',port:0,extensions:[...registrations,authExtension({service,csrfKey,projectSha256,...withUi}),adminExtension({service,csrfKey,projectSha256,...withUi,health,notifyImpersonation:async()=>{},sendSetup:async()=>{},sendInvitation:async()=>{},sendAccountAdministration:async()=>{},sendRecovery:async()=>{}})],log:()=>{}}).catch(async error=>{await service.close();throw error;});
 t.after(async()=>{await server.close();await service.close().catch(()=>{});});
 async function request(path:string,token:string,{data,html=false}:{data?:Record<string,string>;html?:boolean}={}) {
  return fetch(`http://127.0.0.1:${server.address.port}${path}`,{method:data?'POST':'GET',redirect:'manual',headers:{accept:html?'text/html':'application/json',cookie:`__Host-urlcode-session=${token}`,...(data?{'content-type':html?'application/x-www-form-urlencoded':'application/json',origin:'https://example.test'}:{})},...(data?{body:html?new URLSearchParams(data).toString():JSON.stringify(data)}:{})});
 }
 return {request,service,owner,member};
}
