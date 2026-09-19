import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildCloudflare } from '../src/build-cloudflare.ts';
import { createFetchHandler } from '../src/cloudflare.ts';
import { startServer } from '../src/server.ts';
import { project, redirect, request, param } from './helpers.ts';
import type { ProjectFiles, ProjectSettings } from './helpers.ts';
import type { TestContext } from 'node:test';
import type { Artifact, Validators } from '../src/cloudflare.ts';
import type { RouteConfig } from '../src/types.ts';

// The Worker runtime consumes a build artifact, so a test that hand-writes one
// proves nothing. Every case here builds the same project the self-hosted
// server is running and compares the two responses.
// The build writes plain ES modules; importing them by URL yields untyped
// namespaces, so the artifact and validators are typed at this boundary.
const loadArtifact = async (out: string): Promise<Artifact> =>
  ((await import(pathToFileURL(join(out,'artifact.js')).href)) as { default: Artifact }).default;
async function build(t: TestContext, root: string) {
  const out = await mkdtemp(join(tmpdir(),'urlcode-cf-'));
  t.after(() => rm(out,{ recursive:true, force:true }));
  const report = await buildCloudflare(root,{ out });
  const artifact = await loadArtifact(out);
  const validators = (await import(pathToFileURL(join(out,'validators.js')).href)) as Validators;
  return { report, out, fetch: createFetchHandler(artifact, validators) };
}

const read = async (response: Response) => ({
  status: response.status,
  headers: Object.fromEntries([...response.headers]),
  body: await response.text(),
});

const routes = {
  '/go': redirect('https://example.com/target'),
  '/u/{id}': { parameters:[param('id')], redirect:{ url:'https://example.com/{id}' } },
  '/hello': { respond:{ json:{ ok:true } }, response:{ headers:{ 'x-demo':'yes' } } },
  '/text': { respond:{ text:'plain body' } },
  '/empty': { respond:{ status:204 } },
  '/q': { parameters:[param('n','integer','query')],
    redirect:{ url:'https://example.com/q', query:{ map:{ n:{ from:'query', name:'n' } } } } },
  '/only-post': { methods:['POST'], respond:{ text:'posted' } },
  // maxLength drags in an Ajv runtime helper; the build has to inline it.
  '/short': { parameters:[{ name:'s', in:'query', required:true, schema:{ type:'string', maxLength:3 } }],
    redirect:{ url:'https://example.com/s', query:{ map:{ s:{ from:'query', name:'s' } } } } },
};

test('the Worker runtime answers exactly as the self-hosted server does', async t => {
  const root = await project(t,routes);
  const hosted = await startServer({ project:root, port:0, log:()=>{} });
  t.after(() => hosted.close());
  const worker = await build(t,root);

  for (const [path,method] of [['/go','GET'],['/go','HEAD'],['/u/42','GET'],['/hello','GET'],
    ['/text','GET'],['/empty','GET'],['/q?n=7','GET'],['/missing','GET'],['/go','POST'],
    ['/q?n=nope','GET'],['/u//x','GET'],['/short?s=abc','GET'],['/short?s=abcd','GET'],
    // Surrogate pairs count as one character, on every host or not at all.
    ['/short?s=%F0%9F%99%82%F0%9F%99%82%F0%9F%99%82','GET'],['/short','GET']] as const) {
    const a = await request(hosted,path,{ method });
    const b = await read(await worker.fetch(new Request(`https://links.example${path}`,{ method })));
    const where = `${method} ${path}`;
    assert.equal(b.status,a.status,`status differs for ${where}`);
    assert.equal(b.body,a.body,`body differs for ${where}`);
    // Everything but the per-request identifier must match, or "portable" means
    // something different on each host.
    for (const header of ['location','content-type','cache-control','content-length',
      'allow','x-content-type-options','x-demo']) {
      assert.equal(b.headers[header],a.headers[header],`${header} differs for ${where}`);
    }
    assert.match(b.headers['x-request-id'] ?? '',/^[0-9a-f-]{36}$/);
  }
});

test('a declared request body is read and policed like everywhere else', async t => {
  const root = await project(t,{ '/in':{ methods:['POST'],
    request:{ body:{ required:true, format:'json', maxBytes:32 } }, respond:{ text:'ok' } } });
  const hosted = await startServer({ project:root, port:0, log:()=>{} });
  t.after(() => hosted.close());
  const worker = await build(t,root);
  const json = { 'content-type':'application/json' };

  const cases: [string, Record<string, string>][] = [['{"a":1}',json],['',json],['not json',json],
    [JSON.stringify({ a:'x'.repeat(64) }),json],['{"a":1}',{ 'content-type':'text/plain' }]];
  for (const [body,headers] of cases) {
    const a = await request(hosted,'/in',{ method:'POST', headers, body });
    const b = await read(await worker.fetch(new Request('https://links.example/in',
      { method:'POST', headers, body })));
    assert.equal(b.status,a.status,`status differs for ${JSON.stringify(body).slice(0,24)}`);
    assert.equal(b.body,a.body);
  }
});

test('an expired or disabled route is refused by the artifact, not by the platform', async t => {
  const root = await project(t,{
    '/off':{ ...redirect(), enabled:false },
    '/old':{ ...redirect(), expires:'2020-01-01T00:00:00Z' },
  });
  const worker = await build(t,root);
  assert.equal((await worker.fetch(new Request('https://links.example/off'))).status,404);
  assert.equal((await worker.fetch(new Request('https://links.example/old'))).status,410);
});

test('handlers this target cannot serve are refused at build time, not at runtime', async t => {
  const cases: [RouteConfig, ProjectFiles, RegExp, ProjectSettings?][] = [
    [{ function:{ source:'f.mjs' } },{ 'f.mjs':'export default () => new Response("x");' },/self-hosted Node lifecycle/],
    [{ ...redirect(), middleware:[{ source:'m.mjs' }] },{ 'm.mjs':'export default async (q,c,next) => next();' },/middleware/],
    [{ page:{ file:'p.html' } },{ 'p.html':'<p>x</p>' },/static-asset binding/],
    [{ ...redirect(), env:{ TOKEN:{ value:'literal' } } },{},/baked into the artifact/],
  ];
  for (const [config,files,expected,settings] of cases) {
    const pattern = config.page ? '/p' : '/x';
    const root = await project(t,{ [pattern]:config },files,settings);
    await assert.rejects(() => buildCloudflare(root,{ out:join(tmpdir(),'urlcode-cf-never') }),expected);
  }
});

test('a project with nothing to serve fails the build rather than deploying an empty Worker', async t => {
  const root = await project(t,{});
  await assert.rejects(() => buildCloudflare(root,{ out:join(tmpdir(),'urlcode-cf-never') }),/No routes/);
});

test('the runtime refuses an artifact it does not understand', async t => {
  const root = await project(t,{ '/u/{id}':{ parameters:[param('id')], redirect:{ url:'https://example.com/{id}' } } });
  const worker = await build(t,root);
  const artifact = await loadArtifact(worker.out);
  assert.throws(() => createFetchHandler({ ...artifact, format:99 },{}),/rebuild with this runtime version/);
  assert.throws(() => createFetchHandler(artifact,{}),/missing the validator/);
});

test('the generated Worker entry and validators carry no imports the platform cannot resolve', async t => {
  const root = await project(t,{ '/u/{id}':{ parameters:[param('id')], redirect:{ url:'https://example.com/{id}' } } });
  const worker = await build(t,root);
  const { readFile } = await import('node:fs/promises');
  const validators = await readFile(join(worker.out,'validators.js'),'utf8');
  // The platform forbids runtime code generation, so the validators must be
  // precompiled, self-contained ES modules.
  assert.doesNotMatch(validators,/\brequire\s*\(/);
  assert.doesNotMatch(validators,/^\s*import\s/m);
  assert.match(await readFile(join(worker.out,'index.js'),'utf8'),/urlcode\/cloudflare/);
  assert.equal(worker.report.format,1);
});

test('the shipped example satisfies its own assertions on the Worker runtime', async t => {
  // examples/cloudflare is tested against the local runtime in CI. Replaying the
  // same cases through the compiled Worker is what makes it a portability claim.
  const { readFile } = await import('node:fs/promises');
  // fileURLToPath, not URL.pathname: on Windows that yields "/C:/…".
  const root = fileURLToPath(new URL('../examples/cloudflare',import.meta.url));
  const worker = await build(t,root);
  interface RequestCase { path: string; method?: string; status: number; expectHeaders?: Record<string, string>; expectBody?: string }
  // The example's fixture file is checked by the example's own test run; here it is read as data.
  const cases = JSON.parse(await readFile(join(root,'tests/requests.json'),'utf8')) as RequestCase[];
  assert.ok(cases.length);
  for (const item of cases) {
    const response = await read(await worker.fetch(
      new Request(`https://links.example${item.path}`,{ method:item.method || 'GET' })));
    assert.equal(response.status,item.status,`status differs for ${item.path}`);
    for (const [key,value] of Object.entries(item.expectHeaders || {})) {
      assert.equal(response.headers[key],value,`${key} differs for ${item.path}`);
    }
    if (item.expectBody !== undefined) assert.equal(response.body,item.expectBody,`body differs for ${item.path}`);
  }
});
