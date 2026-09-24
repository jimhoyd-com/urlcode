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
  const forms={version:'1' as const,config:{flows:{contact:{mount:'/contact',title:'Contact <team>',submitLabel:'Send message',confirmation:{title:'Thank you <friend>',message:'We received your message.'},fields:{email:{label:'Email',type:'email',required:true,maxLength:320},topic:{label:'Topic',control:'select',required:true,options:[{value:'support',label:'Support'},{value:'sales',label:'Sales'}]},message:{label:'Message',control:'textarea',required:true,minLength:10,maxLength:128,pattern:'^[A-Za-z ]+$'},terms:{label:'Agree',control:'checkbox',required:true}}}}}};
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
