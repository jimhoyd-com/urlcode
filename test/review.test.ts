import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm,writeFile as writeHostFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {reviewProject} from '../packages/core/src/review.ts';
import {inspectExtensionRevision} from '../packages/core/src/extensions.ts';
import {project} from './helpers.ts';
const cookbook=fileURLToPath(new URL('../examples/cookbook/',import.meta.url));
const cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));

const validatorSource = 'export default function(request){\n'
  + '  const body = JSON.parse(request.body);\n'
  + '  if (typeof body.email !== "string") throw new Error("email is required");\n'
  + '  if (!body.name) throw new Error("name is missing");\n'
  + '  return {status:200,body:"ok"};\n'
  + '}\n';

const cookieSource = 'import {randomUUID} from "node:crypto";\n'
  + 'export default function(request){\n'
  + '  const token = randomUUID();\n'
  + '  return {status:200,headers:{"Set-Cookie":`session=${token}; HttpOnly; Path=/`}};\n'
  + '}\n';

const counterSource = 'let hits = 0;\n'
  + 'export default function(request){\n'
  + '  hits++;\n'
  + '  return {status:200,body:String(hits)};\n'
  + '}\n';

const egressSource = 'export default async function(request){\n'
  + '  const response = await fetch("https://example.com/webhook", {method:"POST"});\n'
  + '  return {status:response.status};\n'
  + '}\n';

const plainSource = 'export default function(request){\n'
  + '  const name = request.parameters.name || "world";\n'
  + '  return {status:200,body:`hello ${name}`};\n'
  + '}\n';

const methodDispatchSource = 'export default function(request){\n'
  + '  if (request.method === "GET") return {status:200,body:"list"};\n'
  + '  if (request.method === "POST") return {status:201,body:"created"};\n'
  + '  return {status:405,body:"nope"};\n'
  + '}\n';

const singleMethodCheckSource = 'export default function(request){\n'
  + '  if (request.method === "POST") { /* guard, not a dispatch table */ }\n'
  + '  return {status:200,body:"ok"};\n'
  + '}\n';

const rateLimitSource = 'const hits = new Map();\n'
  + 'export default function(request){\n'
  + '  const key = request.headers.get("x-client-id");\n'
  + '  const now = Date.now();\n'
  + '  let count = (hits.get(key) || 0) + 1;\n'
  + '  count += 1;\n'
  + '  hits.set(key, count);\n'
  + '  if (count > 100) return {status:429, headers:{"Retry-After":"60"}, body:"rate limited"};\n'
  + '  return {status:200,body:"ok"};\n'
  + '}\n';

const preconditionFailedSource = 'export default function(request){\n'
  + '  if (!request.headers.get("x-api-key")) return {status:429,body:"try later"};\n'
  + '  return {status:200,body:"ok"};\n'
  + '}\n';

const securityHeadersSource = 'export default function(request){\n'
  + '  return {status:200,headers:{"X-Frame-Options":"DENY","Content-Security-Policy":"default-src \'none\'"},body:"ok"};\n'
  + '}\n';

const oneSecurityHeaderSource = 'export default function(request){\n'
  + '  return {status:200,headers:{"X-Frame-Options":"DENY"},body:"ok"};\n'
  + '}\n';

test('review flags hand-written JSON body validation as a native-alternative when request.body.schema is absent',async t=>{
  const root=await project(t,{'/submit':{methods:['POST'],function:{source:'f.mjs'}}},{'f.mjs':validatorSource});
  const review=await reviewProject(root);
  const found=review.observations.find(item=>item.signal==='manual-body-validation');
  assert.ok(found);
  assert.equal(found!.category,'native-alternative');
  assert.equal(found!.capability,'request.body');
  assert.deepEqual(found!.routes,['/submit']);
  assert.ok(Buffer.byteLength(found!.excerpt)<=240);
});

test('review does not flag body validation when the route already declares request.body.schema',async t=>{
  const root=await project(t,{'/submit':{methods:['POST'],function:{source:'f.mjs'},request:{body:{format:'json',schema:{type:'object',properties:{email:{type:'string'}},required:['email']}}}}},{'f.mjs':validatorSource});
  const review=await reviewProject(root);
  assert.ok(!review.observations.some(item=>item.signal==='manual-body-validation'));
});

test('review flags manual cookie/session construction for human review, never claiming trusted code is insecure',async t=>{
  const root=await project(t,{'/login':{methods:['POST'],function:{source:'f.mjs'}}},{'f.mjs':cookieSource});
  const review=await reviewProject(root);
  const found=review.observations.find(item=>item.signal==='manual-cookie-session');
  assert.ok(found);
  assert.equal(found!.category,'manual-review');
  assert.doesNotMatch(found!.reason.toLowerCase(),/insecure|unsafe|vulnerable/);
  assert.doesNotMatch(found!.note.toLowerCase(),/insecure|unsafe|vulnerable/);
});

test('review reports manual cookie/session construction as extension-alternative once auth is declared, but still asks for a human decision',async t=>{
  const root=await project(t,{'/login':{methods:['POST'],function:{source:'f.mjs'}}},{'f.mjs':cookieSource},{extensions:{auth:{version:'1',config:{}}}});
  const review=await reviewProject(root);
  const found=review.observations.find(item=>item.signal==='manual-cookie-session');
  assert.ok(found);
  assert.equal(found!.category,'extension-alternative');
  assert.equal(found!.extension,'auth');
  assert.match(found!.note,/human decision/);
});

test('review reports in-process global mutable state as a gap and names the restart/multi-instance limitation, never claiming core support for durable counters',async t=>{
  const root=await project(t,{'/hit':{methods:['GET'],function:{source:'f.mjs'}}},{'f.mjs':counterSource});
  const review=await reviewProject(root);
  const found=review.observations.find(item=>item.signal==='global-mutable-state');
  assert.ok(found);
  assert.equal(found!.category,'gap');
  assert.match(found!.note,/restart/);
  assert.match(found!.note,/multiple instances/);
  assert.doesNotMatch(found!.note.toLowerCase(),/core (currently )?supports? durable counters/);
});

test('review reports global mutable state as extension-alternative once store is declared, but does not claim it is registered',async t=>{
  const root=await project(t,{'/hit':{methods:['GET'],function:{source:'f.mjs'}}},{'f.mjs':counterSource},{extensions:{store:{version:'1',config:{}}}});
  const review=await reviewProject(root);
  const found=review.observations.find(item=>item.signal==='global-mutable-state');
  assert.ok(found);
  assert.equal(found!.category,'extension-alternative');
  assert.equal(found!.extension,'store');
  assert.match(found!.note,/registered/);
});

test('review flags a direct outbound network call for manual review, not as core support for webhook idempotency',async t=>{
  const root=await project(t,{'/hook':{methods:['POST'],function:{source:'f.mjs'}}},{'f.mjs':egressSource});
  const review=await reviewProject(root);
  const found=review.observations.find(item=>item.signal==='outbound-network-call');
  assert.ok(found);
  assert.equal(found!.category,'manual-review');
  assert.doesNotMatch(found!.note.toLowerCase(),/idempoten/);
});

test('review flags hand-written request.method branching as a native-alternative to per-method routes',async t=>{
  const root=await project(t,{'/items':{methods:['GET','POST'],function:{source:'f.mjs'}}},{'f.mjs':methodDispatchSource});
  const review=await reviewProject(root);
  const found=review.observations.find(item=>item.signal==='method-dispatch');
  assert.ok(found);
  assert.equal(found!.category,'native-alternative');
  assert.equal(found!.capability,'methods');
  assert.deepEqual(found!.routes,['/items']);
});

test('review does not flag a single request.method guard as method-dispatch',async t=>{
  const root=await project(t,{'/items':{methods:['POST'],function:{source:'f.mjs'}}},{'f.mjs':singleMethodCheckSource});
  const review=await reviewProject(root);
  assert.ok(!review.observations.some(item=>item.signal==='method-dispatch'));
});

test('review flags hand-rolled rate limiting as a native-alternative when policies.throttle is not declared for the route',async t=>{
  const root=await project(t,{'/hit':{methods:['POST'],function:{source:'f.mjs'}}},{'f.mjs':rateLimitSource});
  const review=await reviewProject(root);
  const found=review.observations.find(item=>item.signal==='manual-rate-limit');
  assert.ok(found);
  assert.equal(found!.category,'native-alternative');
  assert.equal(found!.capability,'policies.throttle');
  assert.deepEqual(found!.routes,['/hit']);
});

test('review reports hand-rolled rate limiting as manual-review, not a false claim of duplication, once policies.throttle is actually declared for the route',async t=>{
  const root=await project(t,{'/hit':{methods:['POST'],function:{source:'f.mjs'},policies:{throttle:{quota:10,window:60}}}},{'f.mjs':rateLimitSource});
  const review=await reviewProject(root);
  const found=review.observations.find(item=>item.signal==='manual-rate-limit');
  assert.ok(found);
  assert.equal(found!.category,'manual-review');
  assert.deepEqual(found!.routes,['/hit']);
  assert.match(found!.note,/already declared/);
});

test('review does not flag a plain 429 with no counting/window pattern as manual-rate-limit',async t=>{
  const root=await project(t,{'/gate':{methods:['GET'],function:{source:'f.mjs'}}},{'f.mjs':preconditionFailedSource});
  const review=await reviewProject(root);
  assert.ok(!review.observations.some(item=>item.signal==='manual-rate-limit'));
});

test('review flags hand-set security response headers as a native-alternative when policies.security is not declared for the route',async t=>{
  const root=await project(t,{'/page':{methods:['GET'],function:{source:'f.mjs'}}},{'f.mjs':securityHeadersSource});
  const review=await reviewProject(root);
  const found=review.observations.find(item=>item.signal==='manual-security-headers');
  assert.ok(found);
  assert.equal(found!.category,'native-alternative');
  assert.equal(found!.capability,'policies.security');
  assert.deepEqual(found!.routes,['/page']);
});

test('review reports hand-set security headers as manual-review once policies.security is actually declared for the route',async t=>{
  const root=await project(t,{'/page':{methods:['GET'],function:{source:'f.mjs'},policies:{security:{headers:'oshp'}}}},{'f.mjs':securityHeadersSource});
  const review=await reviewProject(root);
  const found=review.observations.find(item=>item.signal==='manual-security-headers');
  assert.ok(found);
  assert.equal(found!.category,'manual-review');
  assert.match(found!.note,/already declared/);
});

test('review does not flag a single hand-set security header as manual-security-headers',async t=>{
  const root=await project(t,{'/page':{methods:['GET'],function:{source:'f.mjs'}}},{'f.mjs':oneSecurityHeaderSource});
  const review=await reviewProject(root);
  assert.ok(!review.observations.some(item=>item.signal==='manual-security-headers'));
});

test('review upgrades a declared extension to "registered and revision-pinned" only when the caller supplies a matching, revision-pinned registration',async t=>{
  const root=await project(t,{'/login':{methods:['POST'],function:{source:'f.mjs'}}},{'f.mjs':cookieSource},{extensions:{auth:{version:'1',config:{}}}});
  const projectSha256=await inspectExtensionRevision(root);
  const registration={name:'auth',version:'1' as const,projectSha256,targets:['node' as const],schema:{},activate(){throw new Error('review must not activate an extension');}};
  const review=await reviewProject(root,{extensions:[registration]});
  const found=review.observations.find(item=>item.signal==='manual-cookie-session');
  assert.ok(found);
  assert.equal(found!.category,'extension-alternative');
  assert.equal(found!.registered,true);
  assert.equal(found!.revisionPinned,true);
  assert.match(found!.note,/registered and revision-pinned/);
});

test('review reports "registered but not revision-pinned" rather than claiming a stale registration is current',async t=>{
  const root=await project(t,{'/login':{methods:['POST'],function:{source:'f.mjs'}}},{'f.mjs':cookieSource},{extensions:{auth:{version:'1',config:{}}}});
  const registration={name:'auth',version:'1' as const,projectSha256:'0'.repeat(64),targets:['node' as const],schema:{},activate(){throw new Error('review must not activate an extension');}};
  const review=await reviewProject(root,{extensions:[registration]});
  const found=review.observations.find(item=>item.signal==='manual-cookie-session');
  assert.ok(found);
  assert.equal(found!.category,'extension-alternative');
  assert.equal(found!.registered,true);
  assert.equal(found!.revisionPinned,false);
  assert.match(found!.note,/registered but not revision-pinned/);
});

test('review keeps the conservative "declared, setup unconfirmed" wording and no registered field when no registrations are supplied at all',async t=>{
  const root=await project(t,{'/login':{methods:['POST'],function:{source:'f.mjs'}}},{'f.mjs':cookieSource},{extensions:{auth:{version:'1',config:{}}}});
  const review=await reviewProject(root);
  const found=review.observations.find(item=>item.signal==='manual-cookie-session');
  assert.ok(found);
  assert.equal(found!.registered,undefined);
  assert.equal(found!.revisionPinned,undefined);
  assert.match(found!.note,/once registered/);
});

test('review never claims a declared-but-unregistered extension is registered',async t=>{
  const root=await project(t,{'/login':{methods:['POST'],function:{source:'f.mjs'}}},{'f.mjs':cookieSource},{extensions:{auth:{version:'1',config:{}}}});
  const review=await reviewProject(root,{extensions:[]});
  const found=review.observations.find(item=>item.signal==='manual-cookie-session');
  assert.ok(found);
  assert.equal(found!.registered,undefined);
  assert.match(found!.note,/once registered/);
});

test('the review CLI accepts --host-file to sharpen extension-alternative registration state without activating anything',async t=>{
  const root=await project(t,{'/login':{methods:['POST'],function:{source:'f.mjs'}}},{'f.mjs':cookieSource},{extensions:{auth:{version:'1',config:{}}}});
  const projectSha256=await inspectExtensionRevision(root);
  const dir=await mkdtemp(join(tmpdir(),'urlcode-review-host-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'host.mjs');
  await writeHostFile(file,`export default {extensions:[{name:'auth',version:'1',projectSha256:${JSON.stringify(projectSha256)},targets:['node'],schema:{},activate(){throw new Error('review must not activate an extension');}}]};`);
  const run=(...args:string[])=>spawnSync(process.execPath,[cli,'review','--project',root,'--json',...args],{encoding:'utf8',timeout:20000});
  const withoutHost=run();assert.equal(withoutHost.status,0);
  const bare=JSON.parse(withoutHost.stdout) as {observations:{signal:string;note:string}[]};
  assert.match(bare.observations.find(item=>item.signal==='manual-cookie-session')!.note,/once registered/);
  const withHost=run('--host-file',file);assert.equal(withHost.status,0);
  const sharpened=JSON.parse(withHost.stdout) as {observations:{signal:string;note:string;registered?:boolean;revisionPinned?:boolean}[]};
  const found=sharpened.observations.find(item=>item.signal==='manual-cookie-session');
  assert.ok(found);
  assert.equal(found!.registered,true);
  assert.equal(found!.revisionPinned,true);
  assert.match(found!.note,/registered and revision-pinned/);
});

test('review reports no findings for a legitimate application-specific function matching no signal',async t=>{
  const root=await project(t,{'/hello':{methods:['GET'],function:{source:'f.mjs'}}},{'f.mjs':plainSource});
  const review=await reviewProject(root);
  assert.deepEqual(review.observations,[]);
  assert.deepEqual(review.summary,{'native-alternative':0,'extension-alternative':0,gap:0,'manual-review':0});
});

test('review never executes project source: a module that throws at import time is still reported on',async t=>{
  const root=await project(t,{'/boom':{methods:['POST'],function:{source:'f.mjs'}}},{'f.mjs':'throw new Error("must never run");\n'+validatorSource});
  const review=await reviewProject(root);
  assert.ok(review.observations.some(item=>item.signal==='manual-body-validation'));
});

test('review scans middleware source the same way as a function handler',async t=>{
  const root=await project(t,{'/mw':{methods:['GET'],middleware:[{source:'m.mjs'}],respond:{status:204}}},{'m.mjs':egressSource});
  const review=await reviewProject(root);
  assert.ok(review.observations.some(item=>item.signal==='outbound-network-call'&&item.routes.includes('/mw')));
});

test('review is unaffected by a route\'s sandbox: true execution mode, and never activates or imports the sandbox',async t=>{
  const trusted=await project(t,{'/hit':{methods:['GET'],function:{source:'f.mjs'}}},{'f.mjs':counterSource});
  const sandboxed=await project(t,{'/hit':{methods:['GET'],function:{source:'f.mjs'},sandbox:true}},{'f.mjs':counterSource});
  const trustedReview=await reviewProject(trusted), sandboxedReview=await reviewProject(sandboxed);
  assert.equal(trustedReview.observations.length,sandboxedReview.observations.length);
  assert.equal(trustedReview.observations[0]!.signal,sandboxedReview.observations[0]!.signal);
  assert.equal(trustedReview.observations[0]!.category,sandboxedReview.observations[0]!.category);
});

test('the review CLI runs read-only against a real example project and supports --json',()=>{
  const run=(...args:string[])=>spawnSync(process.execPath,[cli,...args,'--project',cookbook],{encoding:'utf8',timeout:60000});
  const text=run('review');assert.equal(text.status,0);assert.match(text.stdout,/format: 1/);
  const json=run('review','--json');assert.equal(json.status,0);
  const review=JSON.parse(json.stdout) as {format:number;summary:Record<string,number>};
  assert.equal(review.format,1);
  assert.ok(Object.keys(review.summary).sort().join(',')==='extension-alternative,gap,manual-review,native-alternative');
  assert.equal(run('review','extra','--project',cookbook).status,1);
});

// test/fixtures/review-recipes holds the recipe modules as they were before
// #555 converted them to declarative YAML (comments stripped). They are frozen
// review inputs: each had a native replacement that review used to miss (#556).
const frozen=(name:string)=>fileURLToPath(new URL('./fixtures/review-recipes/'+name+'/',import.meta.url));
const signals=async(name:string)=>(await reviewProject(frozen(name))).observations.map(item=>`${item.signal} ${item.source} ${item.routes.join(',')}`).sort();

test('review flags request.json() followed by field checks in the frozen pre-#555 recipes',async()=>{
  assert.deepEqual(await signals('contact-form'),['manual-body-validation /functions/contact.mjs /contact']);
  assert.deepEqual(await signals('webhook-receiver'),['manual-body-validation /functions/receive.mjs /webhook']);
  assert.deepEqual(await signals('middleware'),['manual-body-validation /middleware/body.mjs /profile']);
  const found=(await reviewProject(frozen('contact-form'))).observations[0]!;
  assert.equal(found.category,'native-alternative');assert.equal(found.capability,'request.body');assert.match(found.excerpt,/request\.json\(\)/);
});

test('review flags a function that answers a constant response as a native-alternative to respond',async()=>{
  assert.deepEqual(await signals('cors-api'),['constant-response /functions/items.mjs /api/items']);
  assert.deepEqual(await signals('static-plus-api'),['constant-response /functions/info.mjs /api/info']);
  const found=(await reviewProject(frozen('cors-api'))).observations[0]!;
  assert.equal(found.category,'native-alternative');assert.equal(found.capability,'respond');
});

test('review keeps request-dependent handlers and middleware out of the constant-response signal',async t=>{
  const constant='export default function items() {\n  return Response.json({ok: true});\n}\n';
  const cases:Record<string,string>={
    'args bound from the query':'export default function f(request, {args}) {\n  return Response.json({fail: args.fail});\n}\n',
    'reads the request':'export default function f(request) {\n  return Response.json({url: request.url});\n}\n',
    'branches':'export default function f() {\n  if (Date.now() % 2) return Response.json({a: 1});\n  return Response.json({b: 2});\n}\n',
    'awaits':'export default async function f(request) {\n  const body = await request.text();\n  return new Response(body);\n}\n',
  };
  for(const [name,source] of Object.entries(cases)){
    const root=await project(t,{'/x':{function:{source:'f.mjs',args:{fail:{from:'query',name:'fail'}}},parameters:[{name:'fail',in:'query',schema:{type:'boolean',default:false}}]}},{'f.mjs':source});
    assert.ok(!(await reviewProject(root)).observations.some(item=>item.signal==='constant-response'),name);
  }
  const asMiddleware=await project(t,{'/mw':{middleware:[{source:'m.mjs'}],respond:{status:204}}},{'m.mjs':constant});
  assert.ok(!(await reviewProject(asMiddleware)).observations.some(item=>item.signal==='constant-response'));
  const asHandler=await project(t,{'/x':{function:{source:'f.mjs'}}},{'f.mjs':constant});
  assert.ok((await reviewProject(asHandler)).observations.some(item=>item.signal==='constant-response'));
});

test('review does not treat an upstream response.json() as request body parsing',async t=>{
  const source='export default async function f(request) {\n  const upstream = await fetch("https://api.example.com");\n  const data = await upstream.json();\n'
    +'  if (typeof data.id !== "string" || data.id.length > 10) return new Response("invalid", {status: 502});\n  return Response.json(data);\n}\n';
  const root=await project(t,{'/x':{function:{source:'f.mjs'}}},{'f.mjs':source});
  assert.ok(!(await reviewProject(root)).observations.some(item=>item.signal==='manual-body-validation'));
});

test('review is deterministic and bounded: same project yields the same observations, sorted by module path',async t=>{
  const root=await project(t,{'/a':{methods:['GET'],function:{source:'a.mjs'}},'/b':{methods:['GET'],function:{source:'b.mjs'}}},{'a.mjs':egressSource,'b.mjs':counterSource});
  const first=await reviewProject(root), second=await reviewProject(root);
  assert.deepEqual(first,second);
  assert.deepEqual(first.observations.map(item=>item.source),['/a.mjs','/b.mjs']);
});
