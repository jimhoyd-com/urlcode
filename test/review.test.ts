import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {reviewProject} from '../src/review.ts';
import {project} from './helpers.ts';
const cookbook=fileURLToPath(new URL('../examples/cookbook/',import.meta.url));
const cli=fileURLToPath(new URL('../src/cli.ts',import.meta.url));

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

test('review is deterministic and bounded: same project yields the same observations, sorted by module path',async t=>{
  const root=await project(t,{'/a':{methods:['GET'],function:{source:'a.mjs'}},'/b':{methods:['GET'],function:{source:'b.mjs'}}},{'a.mjs':egressSource,'b.mjs':counterSource});
  const first=await reviewProject(root), second=await reviewProject(root);
  assert.deepEqual(first,second);
  assert.deepEqual(first.observations.map(item=>item.source),['/a.mjs','/b.mjs']);
});
