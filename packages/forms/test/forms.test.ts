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
  const call=(path:string,init:RequestInit={})=>fetch(`http://127.0.0.1:${app.address.port}${path}`,init);
  return {call};
}
async function csrf(call:(path:string,init?:RequestInit)=>Promise<Response>):Promise<string>{const html=await (await call('/contact')).text();const value=/name="csrf" value="([^"]+)"/.exec(html)?.[1];assert.ok(value);return value;}

test('renders escaped safe controls then validates a URL-encoded submission before redirecting to its confirmation',async t=>{
  const {call}=await boot(t);const form=await call('/contact');const html=await form.text();
  assert.equal(form.status,200);assert.match(html,/Contact &lt;team&gt;/);assert.match(html,/type="email"/);assert.match(html,/<textarea /);assert.match(html,/type="checkbox"/);assert.ok(!html.includes('<team>'));
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

test('refuses missing or forged CSRF, cross-origin, malformed media, wrong paths and methods before an action can run',async t=>{
  const {call}=await boot(t);const token=await csrf(call);const body=new URLSearchParams({csrf:token,email:'person@example.test',topic:'sales',message:'A valid message',terms:'true'});
  assert.equal((await call('/contact',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:body.toString(),redirect:'manual'})).status,303);
  assert.equal((await call('/contact',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin},body:'email=x'})).status,403);
  assert.equal((await call('/contact',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:'https://evil.example'},body:body.toString()})).status,403);
  assert.equal((await call('/contact',{method:'POST',headers:{'content-type':'application/json',origin},body:'{}'})).status,415);
  assert.equal((await call('/contact/confirmation',{method:'POST'})).status,405);
  assert.equal((await call('/contact/unknown')).status,404);
  assert.equal((await call('/contact',{method:'DELETE'})).status,405);
});

test('answers 403, not a server error, for a forged or malformed CSRF token on an unprotected mount',async t=>{
  const {call}=await boot(t);const token=await csrf(call);const [data,signature]=token.split('.') as [string,string];
  const post=(value:string)=>call('/contact',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin},body:new URLSearchParams({csrf:value,email:'person@example.test',topic:'sales',message:'A valid message',terms:'true'}),redirect:'manual'});
  const forgedData=Buffer.from(JSON.stringify({flow:'contact',expires:Date.now()+60_000,nonce:'forged'})).toString('base64url');
  for(const value of [`${forgedData}.${signature}`,`${data}.${'A'.repeat(signature.length)}`,`${data}.${'!'.repeat(signature.length)}`,`${data}.${signature.slice(0,-1)}`,`${data}.${signature}.extra`,'forged'])
    assert.equal((await post(value)).status,403,value);
  assert.equal((await post(token)).status,303,'the genuine token still admits the submission');
});

test('auth authorization gates a forms mount before rendering or submission',async t=>{
 const {call}=await boot(t,true);const page=await call('/contact');assert.equal(page.status,401);assert.doesNotMatch(await page.text(),/<form/);
 const post=await call('/contact',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'csrf=forged'});assert.equal(post.status,401);assert.equal(await post.text(),'Sign in required');
});
