import test from 'node:test';
import assert from 'node:assert/strict';
import { project, redirect, request } from './helpers.ts';
import { startServer } from '../packages/core/src/server.ts';
import { createRuntime } from '../packages/core/src/runtime.ts';
import { buildCloudflare } from '../packages/core/src/build-cloudflare.ts';
import { normalizeMatch, assertDisjointMatches, matchesRoute } from '../packages/core/src/conditions.ts';

test('condition normalization rejects ambiguous inputs and overlapping cases', () => {
  assert.throws(() => normalizeMatch({ headers: { 'X-A': 'a', 'x-a': 'b' } }), /duplicate/);
  assert.throws(() => normalizeMatch({ headers: { authorization: 'secret' } }), /credential/);
  assert.throws(() => normalizeMatch({}), /empty/);
  assert.throws(() => assertDisjointMatches([{ query: { a: '1' } }, { headers: { b: '2' } }]), /overlap/);
  assert.doesNotThrow(() => assertDisjointMatches([{ query: { a: '1' } }, { query: { a: '2' } }]));
});
test('exact conditions reject duplicates and use trusted origin, not Host', () => {
  const input = { query: new URLSearchParams('a=1&a=1'), headers: new Headers({ host: 'evil.example', cookie: 'bucket=a; bucket=b' }), method: 'GET', origin: 'https://app.example' };
  assert.throws(() => matchesRoute({ query: { a: '1' } },input), /Duplicate/);
  assert.throws(() => matchesRoute({ cookies: { bucket: 'a' } },input), /Duplicate/);
  assert.equal(matchesRoute({ host: 'app.example' },input),true);
  assert.equal(matchesRoute({ host: 'evil.example' },input),false);
  assert.equal(matchesRoute({ query: { absent: '' } },input),false);
});
test('conditional cases, fallback and guards execute over HTTP without cache leakage', async t => {
  const root = await project(t, {
    '/campaign': { conditional: { cases: [
      { match: { query: { source: 'mail' } }, ...redirect('https://example.com/mail') },
      { match: { query: { source: 'partner' } }, respond: { json: { partner: true } } },
    ], fallback: { respond: { text: 'default' } } } },
    '/beta': { match: { headers: { 'x-beta': 'yes' }, cookies: { bucket: 'b' } }, respond: { text: 'beta' } },
  });
  const app = await startServer({ project: root, port: 0, log: () => {} }); t.after(() => app.close());
  assert.equal((await request(app,'/campaign?source=mail')).headers.location,'https://example.com/mail');
  assert.equal((await request(app,'/campaign?source=partner')).body,'{"partner":true}');
  const fallback = await request(app,'/campaign'); assert.equal(fallback.body,'default'); assert.equal(fallback.headers['cache-control'],'no-store');
  assert.equal((await request(app,'/campaign?source=mail&source=mail')).status,400);
  assert.equal((await request(app,'/beta')).status,404);
  assert.equal((await request(app,'/beta',{ headers: { 'x-beta': 'yes', cookie: 'bucket=b' } })).body,'beta');
  assert.equal((await request(app,'/campaign',{method:'HEAD'})).body,'');
  assert.equal(app.testPlan().cases.length,0);
  for (const target of ['aws','vercel'] as const) {
    const runtime = await createRuntime(root,{target});
    try { assert.equal((await runtime.handle({target:'/campaign?source=mail'})).status,302); } finally { await runtime.close(); }
  }
  await assert.rejects(buildCloudflare(root,{out:root+'/out'}), /capability: conditional/);
});
test('ambiguous cases and unsafe cache policies fail activation', async t => {
  const ambiguous = await project(t, { '/x': { conditional: { cases: [
    { match: { query: { a: '1' } }, respond: { text: 'a' } },
    { match: { cookies: { b: '1' } }, respond: { text: 'b' } },
  ] } } });
  await assert.rejects(createRuntime(ambiguous), /overlap/);
  const cached = await project(t,{ '/x': { match: { headers: { 'x-a': 'a' } }, respond: { text: 'a' }, policies: { cache: { strategy: 'micro' } } } });
  await assert.rejects(createRuntime(cached), { message: '/x: conditional routing requires cache disabled or no-store' });
});
test('normalizer defends its public boundary and disjointness uses normalized header names',()=>{
  for(const query of [null,false,'value',[],17])assert.throws(()=>normalizeMatch({query} as never),/object/);
  assert.throws(()=>normalizeMatch({query:Object.fromEntries(Array.from({length:17},(_,i)=>[`k${i}`,'v']))}),/1–16/);
  assert.throws(()=>normalizeMatch({query:{x:'a'.repeat(1025)}}),/value/);
  assert.throws(()=>normalizeMatch({host:'a'.repeat(256)}),/host/);
  for(const name of ['content-length','keep-alive','te','trailer','upgrade'])assert.throws(()=>normalizeMatch({headers:{[name]:'x'}}),/transport/);
  assert.throws(()=>assertDisjointMatches([{headers:{'X-Bucket':'a'}},{headers:{'x-bucket':'a'}}]),/overlap/);
  assert.doesNotThrow(()=>assertDisjointMatches([{headers:{'X-Bucket':'a'}},{headers:{'x-bucket':'b'}}]));
  assert.throws(()=>assertDisjointMatches([]),/1–16/);
});
test('cookies use bounded unquoted wire values and examined duplicate headers fail',()=>{
  const base={query:new URLSearchParams(),method:'GET',origin:'https://example.test'};
  assert.equal(matchesRoute(normalizeMatch({cookies:{bucket:'%61'}}),{...base,headers:new Headers({cookie:'other=a; bucket=%61'})}),true);
  assert.equal(matchesRoute(normalizeMatch({cookies:{bucket:'a'}}),{...base,headers:new Headers({cookie:'bucket=%61'})}),false);
  assert.throws(()=>matchesRoute(normalizeMatch({cookies:{bucket:'a'}}),{...base,headers:new Headers({cookie:'x'.repeat(8193)})}),/limit/);
  assert.throws(()=>matchesRoute(normalizeMatch({headers:{'x-bucket':'a'}}),{...base,headers:new Headers({'x-bucket':'a'}),headerCounts:{'x-bucket':2}}),/Duplicate/);
  assert.equal(matchesRoute(normalizeMatch({query:{q:''}}),{...base,headers:new Headers(),query:new URLSearchParams('q=')}),true);
  assert.equal(matchesRoute(normalizeMatch({host:'EXAMPLE.TEST'}),{...base,headers:new Headers({'x-forwarded-host':'attacker.test'})}),true);
});
test('guards preserve literal precedence and conditions do not substitute parameter defaults',async t=>{
  const root=await project(t,{
    '/p/special':{match:{query:{key:'yes'}},respond:{text:'literal'}},
    '/p/{id}':{parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}],respond:{text:'parameter'}},
    '/defaults':{parameters:[{name:'q',in:'query',schema:{type:'string',default:'default'}}],conditional:{cases:[{match:{query:{q:'default'}},respond:{text:'matched'}}],fallback:{respond:{text:'absent'}}}},
    '/no-fallback':{conditional:{cases:[{match:{method:'POST'},respond:{text:'post'}}]}},
  });
  const app=await startServer({project:root,port:0,log:()=>{}});t.after(()=>app.close());
  assert.equal((await request(app,'/p/special')).status,404);
  assert.equal((await request(app,'/p/other')).body,'parameter');
  assert.equal((await request(app,'/defaults')).body,'absent');
  assert.equal((await request(app,'/defaults?q=default')).body,'matched');
  assert.equal((await request(app,'/no-fallback')).status,404);
  assert.equal((await request(app,'/no-fallback',{method:'POST'})).status,405);
});
test('branches share declared typed inputs, headers and path escaping',async t=>{
  const root=await project(t,{
    '/item/{id}':{parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}},{name:'n',in:'query',schema:{type:'integer',default:7}}],
      response:{headers:{'x-shared':'yes'}},conditional:{cases:[{match:{cookies:{bucket:'a'}},redirect:{url:'https://example.test/{id}',query:{map:{n:{from:'query',name:'n'}}}}}],fallback:{respond:{text:'other'}}}},
  });
  const app=await startServer({project:root,port:0,log:()=>{}});t.after(()=>app.close());
  const response=await request(app,'/item/A%20B',{headers:{cookie:'bucket=a'}});
  assert.equal(response.headers.location,'https://example.test/A%20B?n=7');assert.equal(response.headers['x-shared'],'yes');assert.equal(response.headers['cache-control'],'no-store');
  assert.equal((await request(app,'/item/id?n=bad',{headers:{cookie:'bucket=b'}})).status,400);
});
test('the published conditions example has executable branch and guard coverage',async()=>{
  const {runProjectTests}=await import('../packages/core/src/project-tests.ts');
  const {fileURLToPath}=await import('node:url');
  const result=await runProjectTests(fileURLToPath(new URL('../examples/conditions',import.meta.url)),{origin:'https://conditions.example.test'});
  assert.deepEqual(result,{total:11,failed:0});
});
test('conditional route responses cannot opt into provider-specific downstream caches',async t=>{
  for(const name of ['CDN-Cache-Control','Vercel-CDN-Cache-Control','Surrogate-Control']){
    const root=await project(t,{'/x':{match:{query:{q:'yes'}},respond:{text:'private branch'},response:{headers:{[name]:'public, max-age=3600'}}}});
    await assert.rejects(createRuntime(root),{message:'/x: conditional responses require no-store'});
  }
});
