import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import type { RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { createUiExtension } from '@jimhoyd/urlcode-ui/host';
import { createFormsExtension } from '../src/index.ts';

const origin='https://forms.example.test';
async function boot(t: test.TestContext, protectedMount=false) {
  const root=await mkdtemp(join(tmpdir(),'forms-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const project=join(root,'app');await mkdir(project);
  const forms={version:'1' as const,config:{flows:{contact:{mount:'/contact',title:'Contact <team>',submitLabel:'Send message',confirmation:{title:'Thank you <friend>',message:'We received your message.'},fields:{email:{label:'Email',type:'email',required:true,maxLength:320},topic:{label:'Topic',control:'select',required:true,options:[{value:'support',label:'Support'},{value:'sales',label:'Sales'}]},message:{label:'Message',control:'textarea',required:true,minLength:10,maxLength:128,pattern:'^[A-Za-z ]+$'},terms:{label:'Agree',control:'checkbox',required:true},visit:{label:'Visit date',type:'date',required:false},callback:{label:'Callback time',type:'datetime-local',required:false}}}}}};
  await writeFile(join(project,'urlcode.yaml'),JSON.stringify({version:'1',extensions:{ui:{version:'1',config:{}},...(protectedMount?{auth:{version:'1',config:{}}}:{}),forms},routes:{'/assets/ui/*':{extension:'ui'},'/contact/*':{extension:'forms',methods:['GET','HEAD','POST'],...(protectedMount?{auth:true}:{})}}}));
  const projectSha256=await inspectExtensionRevision(project),ui=createUiExtension({projectRoot:project,projectSha256});
  const gate:RuntimeExtension={name:'auth',version:'1',projectSha256,targets:['node'],schema:{type:'object',additionalProperties:false},policySchema:{type:'object',additionalProperties:false},async activate(){return {handle(){return {status:404,headers:[]};},authorize(){return {status:401,headers:[['content-type','text/plain; charset=utf-8']],body:'Sign in required'};}};}};
  const app=await startServer({project,origin,port:0,log:()=>{},extensions:[ui.registration,...(protectedMount?[gate]:[]),createFormsExtension({ui,projectSha256,csrfSecret:'a'.repeat(32)})]});t.after(()=>app.close());
  // Node's fetch() has no automatic cookie jar (unlike a browser): forward Set-Cookie back as
  // Cookie on later requests, the same manual pattern the auth package's HTTP tests use, so the
  // forms extension's double-submit CSRF binding cookie round-trips within a test.
  const cookies=new Map<string,string>();
  const call=(path:string,init:RequestInit={})=>{
    const headers=new Headers(init.headers);
    if(cookies.size&&!headers.has('cookie'))headers.set('cookie',[...cookies].map(([key,value])=>`${key}=${value}`).join('; '));
    return fetch(`http://127.0.0.1:${app.address.port}${path}`,{...init,headers}).then(response=>{
      for(const header of response.headers.getSetCookie()){
        const first=header.split(';')[0]!,index=first.indexOf('=');
        if(header.includes('Max-Age=0'))cookies.delete(first.slice(0,index));
        else cookies.set(first.slice(0,index),first.slice(index+1));
      }
      return response;
    });
  };
  return {call,cookies};
}
async function csrf(call:(path:string,init?:RequestInit)=>Promise<Response>):Promise<string>{const html=await (await call('/contact')).text();const value=/name="csrf" value="([^"]+)"/.exec(html)?.[1];assert.ok(value);return value;}

test('renders escaped safe controls then validates a URL-encoded submission before redirecting to its confirmation',async t=>{
  const {call}=await boot(t);const form=await call('/contact');const html=await form.text();
  assert.equal(form.status,200);assert.match(html,/Contact &lt;team&gt;/);assert.match(html,/type="email"/);assert.match(html,/<textarea /);assert.match(html,/type="checkbox"/);assert.ok(!html.includes('<team>'));
  assert.ok(form.headers.getSetCookie().some(header=>header.startsWith('__Host-urlcode-forms-csrf=')),'a binding cookie is issued with the form');
  const token=/name="csrf" value="([^"]+)"/.exec(html)?.[1];assert.ok(token);
  const answer=await call('/contact',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin},body:new URLSearchParams({csrf:token,email:'person@example.test',topic:'support',message:'Need assistance now',terms:'true'}) ,redirect:'manual'});
  assert.equal(answer.status,303);assert.equal(answer.headers.get('location'),'/contact/confirmation');
  const confirmation=await call('/contact/confirmation');assert.equal(confirmation.status,200);assert.match(await confirmation.text(),/Thank you &lt;friend&gt;/);
});

test('returns 422 field errors without echoing hostile values, validates email/select/checkbox, and does not leak one submission into another',async t=>{
  const {call}=await boot(t);const first=await csrf(call),second=await csrf(call);const hostile='<img src=x onerror=alert(1)>';
  const bad=await call('/contact',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin},body:new URLSearchParams({csrf:first,email:'not-an-email',topic:'other',message:hostile,terms:'false'})});const html=await bad.text();
  assert.equal(bad.status,422);assert.match(html,/must be a valid email address/);assert.match(html,/is not an allowed option/);assert.match(html,/does not match the declared pattern/);assert.match(html,/must be true or absent/);assert.ok(!html.includes(hostile));assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
  const clean=await call('/contact',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin},body:new URLSearchParams({csrf:second,email:'person@example.test',topic:'sales',message:'A valid message',terms:'true'}),redirect:'manual'});assert.equal(clean.status,303);
  const newForm=await (await call('/contact')).text();assert.ok(!newForm.includes(hostile),'a later request cannot see an earlier caller\'s values');
});

test('validates date and datetime-local submissions in the formats browsers send, rejecting impossible calendar values (#682)',async t=>{
  const {call}=await boot(t);const token=await csrf(call);
  const submit=async(extra:Record<string,string>)=>{const response=await call('/contact',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin},body:new URLSearchParams({csrf:token,email:'person@example.test',topic:'sales',message:'A valid message',terms:'true',...extra}),redirect:'manual'});return {status:response.status,html:await response.text()};};
  assert.equal((await submit({})).status,303,'empty optional date fields are still admitted');
  assert.equal((await submit({visit:'',callback:''})).status,303,'explicitly empty optional date fields are still admitted');
  for(const visit of ['2026-09-24','2028-02-29','2000-02-29','0001-01-01'])assert.equal((await submit({visit})).status,303,`${visit} is a valid date`);
  for(const visit of ['not-a-date','2026-9-24','26-09-24','2026/09/24','2026-09-24T10:00',' 2026-09-24','+2026-09-24','2026-09-24\n','２０２６-09-24','2026-02-30','2027-02-29','1900-02-29','2026-13-01','2026-00-10','2026-04-31','2026-01-00','0000-01-01']){const answer=await submit({visit});assert.equal(answer.status,422,`${JSON.stringify(visit)} is refused`);assert.match(answer.html,/must be a valid date/);}
  for(const callback of ['2026-09-24T09:30','2026-09-24T23:59:59','2026-09-24T00:00:05.5','2026-09-24T00:00:05.123','2028-02-29T12:00'])assert.equal((await submit({callback})).status,303,`${callback} is a valid local date and time`);
  for(const callback of ['2026-09-24','2026-09-24 09:30','2026-09-24T9:30','2026-09-24T24:00','2026-09-24T12:60','2026-09-24T12:00:60','2026-09-24T12:00:00.1234','2026-09-24T12:00.5','2026-09-24T12:00Z','2026-09-24T12:00+02:00','2026-02-30T12:00','2026-13-01T12:00','not-a-time']){const answer=await submit({callback});assert.equal(answer.status,422,`${JSON.stringify(callback)} is refused`);assert.match(answer.html,/must be a valid local date and time/);}
});

test('refuses missing CSRF, cross-origin, malformed media, wrong paths and methods before an action can run',async t=>{
  const {call}=await boot(t);const token=await csrf(call);const body=new URLSearchParams({csrf:token,email:'person@example.test',topic:'sales',message:'A valid message',terms:'true'});
  assert.equal((await call('/contact',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',referer:origin+'/contact'},body:body.toString(),redirect:'manual'})).status,303,'an absent Origin still admits when Referer proves same-origin');
  assert.equal((await call('/contact',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin},body:'email=x'})).status,403);
  assert.equal((await call('/contact',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:'https://evil.example'},body:body.toString()})).status,403);
  assert.equal((await call('/contact',{method:'POST',headers:{'content-type':'application/json',origin},body:'{}'})).status,415);
  assert.equal((await call('/contact/confirmation',{method:'POST'})).status,405);
  assert.equal((await call('/contact/unknown')).status,404);
  assert.equal((await call('/contact',{method:'DELETE'})).status,405);
});

test('an absent Origin with no Referer or Sec-Fetch-Site evidence is refused, not admitted by default',async t=>{
  const {call}=await boot(t);const token=await csrf(call);
  const body=new URLSearchParams({csrf:token,email:'person@example.test',topic:'sales',message:'A valid message',terms:'true'});
  assert.equal((await call('/contact',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:body.toString()})).status,403);
  assert.equal((await call('/contact',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','sec-fetch-site':'cross-site'},body:body.toString()})).status,403);
  assert.equal((await call('/contact',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','sec-fetch-site':'same-origin'},body:body.toString(),redirect:'manual'})).status,303,'Sec-Fetch-Site: same-origin is accepted in place of Origin');
});

test('answers 403, not a server error, for a forged, cross-flow or unbound CSRF token — including on an unprotected mount',async t=>{
  const {call,cookies}=await boot(t);const token=await csrf(call);const [data,signature]=token.split('.') as [string,string];
  const post=(value:string,init:{headers?:Record<string,string>}={})=>call('/contact',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin,...init.headers},body:new URLSearchParams({csrf:value,email:'person@example.test',topic:'sales',message:'A valid message',terms:'true'}),redirect:'manual'});
  const forgedData=Buffer.from(JSON.stringify({flow:'contact',purpose:'urlcode-forms-csrf',binding:cookies.get('__Host-urlcode-forms-csrf'),expires:Date.now()+60_000,nonce:'forged'})).toString('base64url');
  for(const value of [`${forgedData}.${signature}`,`${data}.${'A'.repeat(signature.length)}`,`${data}.${'!'.repeat(signature.length)}`,`${data}.${signature.slice(0,-1)}`,`${data}.${signature}.extra`,'forged'])
    assert.equal((await post(value)).status,403,value);
  // A well-formed, correctly signed token minted for a DIFFERENT flow (or with no matching
  // purpose/binding) must not admit this one — this is the path the previous single "missing or
  // forged" test never actually reached, since it only ever sent a missing token.
  const otherFlowSecret='a'.repeat(32);
  const crossFlowToken=(await (async()=>{const {createSignedToken}=await import('@jimhoyd/urlcode-ui/host');return createSignedToken(otherFlowSecret,{flow:'not-contact',purpose:'urlcode-forms-csrf',binding:cookies.get('__Host-urlcode-forms-csrf')},10*60*1000);})());
  assert.equal((await post(crossFlowToken)).status,403,'a validly signed token for a different flow is refused');
  // A genuine token for THIS flow, replayed with no cookie at all (or a different browser's
  // cookie), must not be accepted: the token is bound to the caller, not just the flow name.
  assert.equal((await post(token,{headers:{cookie:''}})).status,403,'a genuine token without its binding cookie is refused');
  assert.equal((await post(token,{headers:{cookie:'__Host-urlcode-forms-csrf=attacker-controlled-value'}})).status,403,'a genuine token with a different browser\'s binding cookie is refused');
  assert.equal((await post(token)).status,303,'the genuine token with its own binding cookie still admits the submission');
});

test('onSubmit runs only after CSRF and field validation pass, and receives just the declared values',async t=>{
  const root=await mkdtemp(join(tmpdir(),'forms-onsubmit-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const project=join(root,'app');await mkdir(project);
  const hookFile=join(project,'on-submit.mjs');
  await writeFile(hookFile,'export default async function onSubmit(input) { globalThis.__formsOnSubmitCalls ??= []; globalThis.__formsOnSubmitCalls.push(input); }\n');
  const forms={version:'1' as const,config:{hooks:{onSubmit:'./on-submit.mjs'},flows:{contact:{mount:'/contact',title:'Contact',submitLabel:'Send',confirmation:{title:'Thanks',message:'Received.'},fields:{email:{label:'Email',type:'email',required:true,maxLength:320}}}}}};
  await writeFile(join(project,'urlcode.yaml'),JSON.stringify({version:'1',extensions:{ui:{version:'1',config:{}},forms},routes:{'/assets/ui/*':{extension:'ui'},'/contact/*':{extension:'forms',methods:['GET','HEAD','POST']}}}));
  const projectSha256=await inspectExtensionRevision(project),ui=createUiExtension({projectRoot:project,projectSha256});
  const app=await startServer({project,origin,port:0,log:()=>{},extensions:[ui.registration,createFormsExtension({ui,projectSha256,csrfSecret:'a'.repeat(32)})]});t.after(()=>app.close());
  const cookies=new Map<string,string>();
  const call=(path:string,init:RequestInit={})=>{const headers=new Headers(init.headers);if(cookies.size&&!headers.has('cookie'))headers.set('cookie',[...cookies].map(([key,value])=>`${key}=${value}`).join('; '));return fetch(`http://127.0.0.1:${app.address.port}${path}`,{...init,headers}).then(response=>{for(const header of response.headers.getSetCookie()){const first=header.split(';')[0]!,index=first.indexOf('=');if(header.includes('Max-Age=0'))cookies.delete(first.slice(0,index));else cookies.set(first.slice(0,index),first.slice(index+1));}return response;});};
  (globalThis as unknown as { __formsOnSubmitCalls?: unknown[] }).__formsOnSubmitCalls=[];
  const token=await csrf(call);
  // A rejected (forged-binding) submission must not invoke onSubmit.
  await call('/contact',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin,cookie:'__Host-urlcode-forms-csrf=wrong-binding'},body:new URLSearchParams({csrf:token,email:'person@example.test'})});
  assert.equal((globalThis as unknown as { __formsOnSubmitCalls: unknown[] }).__formsOnSubmitCalls.length,0);
  const ok=await call('/contact',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin},body:new URLSearchParams({csrf:token,email:'person@example.test'}),redirect:'manual'});
  assert.equal(ok.status,303);
  const calls=(globalThis as unknown as { __formsOnSubmitCalls: { flow:string; values:Record<string,string> }[] }).__formsOnSubmitCalls;
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0], { flow:'contact', values:{ email:'person@example.test' } });
});

test('a field pattern without a maxLength of at most 128 fails activation',async t=>{
 for(const [field,accepted] of [[{label:'Code',pattern:'^[a-z]+$'},false],[{label:'Code',pattern:'^[a-z]+$',maxLength:129},false],[{label:'Code',pattern:'^[a-z]+$',maxLength:128},true]] as const){
  const root=await mkdtemp(join(tmpdir(),'forms-pattern-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const project=join(root,'app');await mkdir(project);
  const forms={version:'1',config:{flows:{contact:{mount:'/contact',title:'Contact',submitLabel:'Send',confirmation:{title:'Thanks',message:'Received.'},fields:{code:field}}}}};
  await writeFile(join(project,'urlcode.yaml'),JSON.stringify({version:'1',extensions:{ui:{version:'1',config:{}},forms},routes:{'/assets/ui/*':{extension:'ui'},'/contact/*':{extension:'forms',methods:['GET','HEAD','POST']}}}));
  const projectSha256=await inspectExtensionRevision(project),ui=createUiExtension({projectRoot:project,projectSha256});
  const start=startServer({project,origin,port:0,log:()=>{},extensions:[ui.registration,createFormsExtension({ui,projectSha256,csrfSecret:'a'.repeat(32)})]});
  if(accepted){const app=await start;await app.close();}
  else await assert.rejects(start,/pattern code requires maxLength at most 128/,JSON.stringify(field));
 }
});

// Deliberately unsafe patterns, joined at runtime like core's own pattern-guard
// tests do, so they are test inputs the guard must reject rather than being
// compiled by any tool scanning this file for regex literals.
const unsafe=(head:string,tail:string):string=>head+tail;

test('field patterns run through core\'s real pattern guard, not a narrower local copy (#595)',async t=>{
 for(const pattern of [
   // #460: a bounded repeat of a group whose body has its own quantifier or
   // alternation is still super-linear even though the outer repeat is bounded.
   unsafe('^(','a+){2,3}$'), unsafe('^(','a|aa){2,5}$'),
   // #544: core charges every variable-width quantifier and alternation
   // against one backtracking-path budget, so a flat run without any group
   // is refused exactly like its grouped form, not just `*`/`+`/`{n,}` runs.
   '^'+'a?'.repeat(21)+'!$', '^'+'[a-z]{0,16}'.repeat(6)+'!$', '^'+unsafe('(a|a)','').repeat(21)+'!$',
 ]){
  const root=await mkdtemp(join(tmpdir(),'forms-pattern-guard-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const project=join(root,'app');await mkdir(project);
  const forms={version:'1',config:{flows:{contact:{mount:'/contact',title:'Contact',submitLabel:'Send',confirmation:{title:'Thanks',message:'Received.'},fields:{code:{label:'Code',pattern,maxLength:128}}}}}};
  await writeFile(join(project,'urlcode.yaml'),JSON.stringify({version:'1',extensions:{ui:{version:'1',config:{}},forms},routes:{'/assets/ui/*':{extension:'ui'},'/contact/*':{extension:'forms',methods:['GET','HEAD','POST']}}}));
  const projectSha256=await inspectExtensionRevision(project),ui=createUiExtension({projectRoot:project,projectSha256});
  const start=startServer({project,origin,port:0,log:()=>{},extensions:[ui.registration,createFormsExtension({ui,projectSha256,csrfSecret:'a'.repeat(32)})]});
  await assert.rejects(start,/bound-repeat a group|matching cost/,pattern);
 }
});

test('auth authorization gates a forms mount before rendering or submission',async t=>{
 const {call}=await boot(t,true);const page=await call('/contact');assert.equal(page.status,401);assert.doesNotMatch(await page.text(),/<form/);
 const post=await call('/contact',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'csrf=forged'});assert.equal(post.status,401);assert.equal(await post.text(),'Sign in required');
});

test('re-issues the binding cookie on every render, so a form rendered at t=9min still submits at t=12min (#551)',async t=>{
  const {call}=await boot(t);
  // A browser-like jar that honours Max-Age against a mocked clock (Date only, so the server's
  // sockets and timers still run normally): an expired binding cookie is simply not sent.
  const start=Date.now();t.mock.timers.enable({apis:['Date'],now:start});
  const minute=60_000,jar=new Map<string,{value:string;expires:number}>();
  const browser=async(path:string,init:RequestInit={})=>{
    const live=[...jar].filter(([,cookie])=>cookie.expires>Date.now()).map(([key,cookie])=>`${key}=${cookie.value}`).join('; ');
    const response=await call(path,{...init,headers:{...(init.headers as Record<string,string>|undefined),cookie:live}});
    for(const header of response.headers.getSetCookie()){const first=header.split(';')[0]!,index=first.indexOf('='),maxAge=Number(/Max-Age=(\d+)/.exec(header)?.[1]??0);jar.set(first.slice(0,index),{value:first.slice(index+1),expires:Date.now()+maxAge*1000});}
    return response;
  };
  const first=await browser('/contact');assert.equal(first.status,200);const binding=jar.get('__Host-urlcode-forms-csrf')?.value;assert.ok(binding);
  t.mock.timers.setTime(start+9*minute);
  const late=await browser('/contact');const token=/name="csrf" value="([^"]+)"/.exec(await late.text())?.[1];assert.ok(token);
  const reissued=late.headers.getSetCookie().find(header=>header.startsWith('__Host-urlcode-forms-csrf='));
  assert.ok(reissued,'a returning render re-issues the binding cookie');assert.ok(reissued.startsWith(`__Host-urlcode-forms-csrf=${binding};`),'with the same value');assert.match(reissued,/Max-Age=600/);
  t.mock.timers.setTime(start+12*minute);
  const answer=await browser('/contact',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin},body:new URLSearchParams({csrf:token,email:'person@example.test',topic:'support',message:'Need assistance now',terms:'true'}),redirect:'manual'});
  assert.equal(answer.status,303,'the token rendered at t=9min is admitted at t=12min because its binding cookie was refreshed');
});

async function startWithFields(t:test.TestContext,fields:Record<string,unknown>){
  const root=await mkdtemp(join(tmpdir(),'forms-bounds-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const project=join(root,'app');await mkdir(project);
  const forms={version:'1',config:{flows:{contact:{mount:'/contact',title:'Contact',submitLabel:'Send',confirmation:{title:'Thanks',message:'Received.'},fields}}}};
  await writeFile(join(project,'urlcode.yaml'),JSON.stringify({version:'1',extensions:{ui:{version:'1',config:{}},forms},routes:{'/assets/ui/*':{extension:'ui'},'/contact/*':{extension:'forms',methods:['GET','HEAD','POST']}}}));
  const projectSha256=await inspectExtensionRevision(project),ui=createUiExtension({projectRoot:project,projectSha256});
  return startServer({project,origin,port:0,log:()=>{},extensions:[ui.registration,createFormsExtension({ui,projectSha256,csrfSecret:'a'.repeat(32)})]});
}

test('date and datetime-local bounds are enforced on submission and rendered as HTML min/max (#528)',async t=>{
  const app=await startWithFields(t,{start:{label:'Start date',type:'date',minimum:'2026-01-01',maximum:'2027-12-31'},slot:{label:'Slot',type:'datetime-local',required:false,minimum:'2026-01-01T09:00',maximum:'2026-01-01T17:30'},from:{label:'From',type:'date',required:false,minimum:'2026-06-01'}});
  t.after(()=>app.close());
  const cookies=new Map<string,string>();
  const call=async(path:string,init:RequestInit={})=>{const headers=new Headers(init.headers);if(cookies.size)headers.set('cookie',[...cookies].map(([key,value])=>`${key}=${value}`).join('; '));const response=await fetch(`http://127.0.0.1:${app.address.port}${path}`,{...init,headers,redirect:'manual'});for(const header of response.headers.getSetCookie()){const first=header.split(';')[0]!,index=first.indexOf('=');cookies.set(first.slice(0,index),first.slice(index+1));}return response;};
  const page=await (await call('/contact')).text();
  assert.match(page,/name="start" type="date"[^>]* min="2026-01-01" max="2027-12-31"/);
  assert.match(page,/name="slot" type="datetime-local"[^>]* min="2026-01-01T09:00" max="2026-01-01T17:30"/);
  const from=/<input[^>]*name="from"[^>]*>/.exec(page)![0];assert.match(from,/ min="2026-06-01"/);assert.doesNotMatch(from,/ max=/);
  const token=/name="csrf" value="([^"]+)"/.exec(page)![1]!;
  const submit=async(extra:Record<string,string>)=>{const response=await call('/contact',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin},body:new URLSearchParams({csrf:token,start:'2026-06-15',...extra})});return {status:response.status,html:await response.text()};};
  for(const start of ['2026-01-01','2026-06-15','2027-12-31'])assert.equal((await submit({start})).status,303,`${start} is inside the bounds`);
  for(const [start,message] of [['2025-12-31','must be on or after 2026-01-01'],['2028-01-01','must be on or before 2027-12-31'],['0001-01-01','must be on or after 2026-01-01']] as const){const answer=await submit({start});assert.equal(answer.status,422,start);assert.match(answer.html,new RegExp(message));}
  const invalid=await submit({start:'2026-02-30'});assert.equal(invalid.status,422);assert.match(invalid.html,/must be a valid date/,'format is checked before bounds');
  for(const slot of ['2026-01-01T09:00','2026-01-01T09:00:00','2026-01-01T09:00:00.000','2026-01-01T12:15:30.5','2026-01-01T17:30','2026-01-01T17:30:00.000'])assert.equal((await submit({slot})).status,303,`${slot} is inside the bounds`);
  for(const [slot,message] of [['2026-01-01T08:59:59.999','must be on or after 2026-01-01T09:00'],['2025-12-31T23:59','must be on or after 2026-01-01T09:00'],['2026-01-01T17:30:00.001','must be on or before 2026-01-01T17:30'],['2026-01-01T17:31','must be on or before 2026-01-01T17:30'],['2026-01-02T00:00','must be on or before 2026-01-01T17:30']] as const){const answer=await submit({slot});assert.equal(answer.status,422,slot);assert.match(answer.html,new RegExp(message));}
  assert.equal((await submit({slot:'',from:''})).status,303,'empty optional bounded fields are still admitted');
  assert.equal((await submit({from:'2099-01-01'})).status,303,'a one-sided bound leaves the other side open');
  assert.equal((await submit({from:'2026-05-31'})).status,422);
});

test('date and datetime-local bounds are checked at activation (#528)',async t=>{
  for(const [field,error] of [
    [{label:'D',type:'date',minimum:'2026-02-30'},/minimum of d must be a YYYY-MM-DD date/],
    [{label:'D',type:'date',maximum:'2026-01-01T09:00'},/maximum of d must be a YYYY-MM-DD date/],
    [{label:'D',type:'date',minimum:5},/minimum of d must be a YYYY-MM-DD date/],
    [{label:'D',type:'date',minimum:'2026-02-01',maximum:'2026-01-31'},/d minimum exceeds maximum/],
    [{label:'D',type:'datetime-local',minimum:'2026-01-01'},/minimum of d must be a YYYY-MM-DDTHH:MM local date and time/],
    [{label:'D',type:'datetime-local',minimum:'2026-01-01T24:00'},/minimum of d must be a YYYY-MM-DDTHH:MM local date and time/],
    [{label:'D',type:'datetime-local',minimum:'2026-01-01T10:00',maximum:'2026-01-01T09:59'},/d minimum exceeds maximum/],
    [{label:'D',type:'number',minimum:'2026-01-01'},/minimum of d requires type number, date or datetime-local/],
    [{label:'D',type:'text',maximum:'2026-01-01'},/maximum of d requires type number, date or datetime-local/],
    [{label:'D',maximum:3},/maximum of d requires type number, date or datetime-local/],
  ] as const)await assert.rejects(startWithFields(t,{d:field}),error,JSON.stringify(field));
  // The config schema refuses seconds before validateFlow sees them: date-time bounds are whole minutes.
  await assert.rejects(startWithFields(t,{d:{label:'D',type:'datetime-local',minimum:'2026-01-01T09:00:30'}}));
  for(const field of [{label:'D',type:'date',minimum:'2026-01-01',maximum:'2026-01-01'},{label:'D',type:'datetime-local',minimum:'2026-01-01T09:00',maximum:'2026-01-01T09:00'},{label:'D',type:'number',minimum:1,maximum:2}]){const app=await startWithFields(t,{d:field});await app.close();}
});

// Confirmation fields (#527): opted-in values travel in a sealed, browser-bound, short-lived cookie.
const CONFIRMATION='__Host-urlcode-forms-confirmation',BINDING='__Host-urlcode-forms-csrf';
const confirmFields={email:{label:'Email <address>',type:'email',required:true,maxLength:320},topic:{label:'Topic',control:'select',required:true,options:[{value:'support',label:'Support & help'},{value:'sales',label:'Sales'}]},terms:{label:'Agree',control:'checkbox',required:true},nickname:{label:'Nickname',required:false,maxLength:4000},secret:{label:'Private note',required:false,maxLength:128}};
async function bootFlows(t:test.TestContext,flows:Record<string,unknown>){
  const root=await mkdtemp(join(tmpdir(),'forms-confirmation-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const project=join(root,'app');await mkdir(project);
  const routes=Object.fromEntries(Object.values(flows).map(flow=>[`${(flow as {mount:string}).mount}/*`,{extension:'forms',methods:['GET','HEAD','POST']}]));
  await writeFile(join(project,'urlcode.yaml'),JSON.stringify({version:'1',extensions:{ui:{version:'1',config:{}},forms:{version:'1',config:{flows}}},routes:{'/assets/ui/*':{extension:'ui'},...routes}}));
  const projectSha256=await inspectExtensionRevision(project),ui=createUiExtension({projectRoot:project,projectSha256});
  const started=startServer({project,origin,port:0,log:()=>{},extensions:[ui.registration,createFormsExtension({ui,projectSha256,csrfSecret:'a'.repeat(32)})]});
  return {started,async ready(){const app=await started;t.after(()=>app.close());
    const cookies=new Map<string,string>();
    const call=(path:string,init:RequestInit={})=>{const headers=new Headers(init.headers);if(cookies.size&&!headers.has('cookie'))headers.set('cookie',[...cookies].map(([key,value])=>`${key}=${value}`).join('; '));return fetch(`http://127.0.0.1:${app.address.port}${path}`,{...init,headers}).then(response=>{for(const header of response.headers.getSetCookie()){const first=header.split(';')[0]!,index=first.indexOf('=');if(header.includes('Max-Age=0'))cookies.delete(first.slice(0,index));else cookies.set(first.slice(0,index),first.slice(index+1));}return response;});};
    const submit=async(mount:string,values:Record<string,string>)=>{const html=await (await call(mount)).text();const csrf=/name="csrf" value="([^"]+)"/.exec(html)?.[1];assert.ok(csrf);return call(mount,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin},body:new URLSearchParams({csrf,...values}),redirect:'manual'});};
    return {call,cookies,submit};
  }};
}
const contactFlow=(confirmation:Record<string,unknown>,mount='/contact')=>({mount,title:'Contact',submitLabel:'Send',confirmation:{title:'Thank you',...confirmation},fields:confirmFields});
const hostileEmail='<img/src=x/onerror=alert(1)>@example.test';

test('confirmation shows only opted-in fields, escaped, with placeholders substituted after escaping, and no-store (#527)',async t=>{
  const {call,cookies,submit}=await (await bootFlows(t,{contact:contactFlow({message:'We will reply to {email} about {topic}.',show:['email','topic','terms','nickname']})})).ready();
  const sent=await submit('/contact',{email:hostileEmail,topic:'support',terms:'true',nickname:'{email} <b>bold</b>',secret:'unlisted-private-note'});
  assert.equal(sent.status,303);assert.equal(sent.headers.get('location'),'/contact/confirmation','no field value is placed in the redirect URL');
  const handoff=sent.headers.getSetCookie().find(header=>header.startsWith(`${CONFIRMATION}=`));assert.ok(handoff);
  assert.match(handoff,/; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=300$/);
  const sealed=cookies.get(CONFIRMATION)!;for(const plain of ['example.test','support','unlisted','bold'])assert.ok(!Buffer.from(sealed,'base64url').toString('latin1').includes(plain),`the cookie does not carry ${plain} as plaintext`);
  const page=await call('/contact/confirmation');const html=await page.text();
  assert.equal(page.headers.get('cache-control'),'no-store');
  assert.match(html,/We will reply to &lt;img\/src=x\/onerror=alert\(1\)&gt;@example\.test about Support &amp; help\./);
  assert.ok(!html.includes('<img/src'),'a shown value cannot inject markup');
  assert.match(html,/<dt>Agree<\/dt><dd>Yes<\/dd>/);
  assert.match(html,/<dt>Nickname<\/dt><dd>\{email\} &lt;b&gt;bold&lt;\/b&gt;<\/dd>/,'a value is not re-expanded as a placeholder');
  assert.ok(!html.includes('<dt>Email'),'a field used as a placeholder is not listed again');
  assert.ok(!html.includes('unlisted-private-note')&&!html.includes('Private note'),'an unlisted field never appears');
  assert.ok(page.headers.getSetCookie().some(header=>header.startsWith(`${CONFIRMATION}=;`)&&header.includes('Max-Age=0')),'the handoff is cleared on read');
  const refresh=await (await call('/contact/confirmation')).text();
  assert.match(refresh,/We will reply to {2}about \./,'a refresh shows the fixed page, placeholders rendering as nothing');
  assert.ok(!refresh.includes('example.test')&&!refresh.includes('<dl>'));
});

test('confirmation falls back to the fixed page for another browser, a tampered, expired or other-flow handoff, or an oversized one (#527)',async t=>{
  const {call,cookies,submit}=await (await bootFlows(t,{contact:contactFlow({message:'Reply to {email}.',show:['email','nickname']}),other:contactFlow({message:'Other {email}.',show:['email']},'/other')})).ready();
  const fixed=(html:string)=>!html.includes('example.test')&&!html.includes('<dl>');
  const visit=async(cookie?:string)=>{const response=await call('/contact/confirmation',cookie===undefined?{}:{headers:{cookie}});return {html:await response.text(),cleared:response.headers.getSetCookie().some(header=>header.startsWith(`${CONFIRMATION}=;`)),status:response.status};};
  assert.ok(fixed((await visit()).html),'no handoff renders the fixed page');
  await submit('/contact',{email:'person@example.test',topic:'sales',terms:'true'});
  const sealed=cookies.get(CONFIRMATION)!,binding=cookies.get(BINDING)!;
  const otherBrowser=await visit(`${BINDING}=${'b'.repeat(36)}; ${CONFIRMATION}=${sealed}`);
  assert.equal(otherBrowser.status,200);assert.ok(fixed(otherBrowser.html),'a different binding cookie cannot open the handoff');assert.ok(otherBrowser.cleared);
  assert.ok(fixed((await visit(`${CONFIRMATION}=${sealed}`)).html),'a missing binding cookie cannot open the handoff');
  const middle=Math.floor(sealed.length/2),tampered=sealed.slice(0,middle)+(sealed[middle]==='A'?'B':'A')+sealed.slice(middle+1);
  const tamperedVisit=await visit(`${BINDING}=${binding}; ${CONFIRMATION}=${tampered}`);assert.ok(fixed(tamperedVisit.html),'a tampered handoff is refused');assert.ok(tamperedVisit.cleared);
  for(const junk of ['x','!!!',sealed.slice(0,20)])assert.ok(fixed((await visit(`${BINDING}=${binding}; ${CONFIRMATION}=${junk}`)).html),junk);
  const otherFlow=await call('/other/confirmation',{headers:{cookie:`${BINDING}=${binding}; ${CONFIRMATION}=${sealed}`}});assert.ok(fixed(await otherFlow.text()),'a handoff sealed for one flow does not open for another');
  assert.match((await visit(`${BINDING}=${binding}; ${CONFIRMATION}=${sealed}`)).html,/Reply to person@example\.test\./,'the genuine handoff still opens in its own browser');
  // Expiry: mock only Date so the server's sockets and timers run normally.
  await submit('/contact',{email:'late@example.test',topic:'sales',terms:'true'});
  t.mock.timers.enable({apis:['Date'],now:Date.now()});t.mock.timers.tick(5*60_000+1_000);
  const expired=await visit();assert.ok(!expired.html.includes('late@example.test'),'an expired handoff renders the fixed page');assert.ok(expired.cleared);
  t.mock.timers.reset();
  // Size cap: a handoff above 2 KiB of plaintext is not issued.
  const big=await submit('/contact',{email:'big@example.test',topic:'sales',terms:'true',nickname:'n'.repeat(3000)});
  assert.equal(big.status,303);assert.ok(!big.headers.getSetCookie().some(header=>header.startsWith(`${CONFIRMATION}=`)&&!header.includes('Max-Age=0')));
  assert.ok(!(await visit()).html.includes('big@example.test'));
});

test('HEAD on the confirmation answers the fixed page without consuming the handoff (#527)',async t=>{
  const {call,submit}=await (await bootFlows(t,{contact:contactFlow({message:'Reply to {email}.',show:['email']})})).ready();
  await submit('/contact',{email:'person@example.test',topic:'sales',terms:'true'});
  const head=await call('/contact/confirmation',{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('cache-control'),'no-store');assert.equal(head.headers.getSetCookie().length,0);
  assert.match(await (await call('/contact/confirmation')).text(),/Reply to person@example\.test\./);
});

test('startup refuses a show entry that is not a declared field, or a placeholder not listed in show (#527)',async t=>{
  for(const [confirmation,error] of [
    [{message:'Thanks.',show:['missing']},/confirmation show lists undeclared field missing/],
    [{message:'Reply to {email}.',show:['topic']},/confirmation placeholder \{email\} is not listed in show/],
    [{message:'Reply to {email}.'},/confirmation placeholder \{email\} is not listed in show/],
  ] as const){
    const {started}=await bootFlows(t,{contact:contactFlow(confirmation)});
    await assert.rejects(started,error,JSON.stringify(confirmation));
  }
  const {started}=await bootFlows(t,{contact:contactFlow({message:'Literal { braces } and {Upper} stay text.'})});await (await started).close();
});
