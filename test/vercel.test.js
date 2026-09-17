import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createVercelHandler } from '../src/vercel.js';
import { startServer } from '../src/server.js';
import { project, redirect, request, param, approveBindings } from './helpers.js';

// Vercel invokes a Node function with the same req/res pair an http server sees,
// so hosting the handler on a plain server exercises the real code path.
async function deploy(t, options) {
  const handler = createVercelHandler(options);
  const server = http.createServer((req,res) => { void handler(req,res).catch(() => { if (!res.headersSent) res.destroy(); }); });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { address: server.address() };
}

const assets = {
  'public/page.html':'<!doctype html><title>page</title>',
  'public/data.txt':'hello from a file\n',
};
const nativeRoutes = {
  '/go': redirect('https://example.com/target'),
  '/u/{id}': {parameters:[param('id')],redirect:{url:'https://example.com/{id}'}},
  '/hello': {respond:{json:{ok:true}}},
  '/page': {page:{file:'public/page.html'}},
  '/files/*': {static:{directory:'public'}},
};

test('the adapter serves native handlers exactly as the self-hosted server does', async t => {
  const root = await project(t,nativeRoutes,assets);
  const hosted = await startServer({project:root,port:0,log:()=>{}});
  t.after(() => hosted.close());
  const adapted = await deploy(t,{project:root});

  for (const path of ['/go','/u/42','/hello','/page','/files/data.txt','/missing']) {
    const a = await request(hosted,path);
    const b = await request(adapted,path);
    assert.equal(b.status,a.status,`status differs for ${path}`);
    assert.equal(b.body,a.body,`body differs for ${path}`);
    // Everything except the per-request identifier must match, or "portable"
    // means something different on each host.
    for (const header of ['location','content-type','etag','cache-control','x-content-type-options','content-length','allow']) {
      assert.equal(b.headers[header],a.headers[header],`${header} differs for ${path}`);
    }
    assert.match(b.headers['x-request-id'],/^[0-9a-f-]{36}$/);
  }
  assert.equal((await request(adapted,'/go',{method:'POST'})).status,405);
  assert.equal((await request(adapted,'/page',{method:'HEAD'})).body,'');
});

test('handlers a serverless invocation cannot support are refused at activation', async t => {
  for (const [routes, files, expected] of [
    [{'/f':{function:{source:'f.mjs'}}},{'f.mjs':'export default () => new Response("x");'},/isolated functions/],
    [{'/go':{...redirect(),middleware:[{source:'m.mjs'}]}},{'m.mjs':'export default async (q,c,next) => next();'},/declares middleware/],
  ]) {
    const root = await project(t,routes,files);
    const adapted = await deploy(t,{project:root});
    const response = await request(adapted,'/go');
    assert.equal(response.status,500,'an unsupported project must not serve');
    assert.doesNotMatch(response.body,expected,'the reason belongs in operator logs, not a response');
  }
});

test('a stored-link route is refused rather than half-working without a store', async t => {
  const root = await project(t,{'/r/{code}':{parameters:[param('code')],link:{collection:'links',code:{from:'path',name:'code'}}}},{},{dynamicLinks:true});
  const adapted = await deploy(t,{project:root});
  assert.equal((await request(adapted,'/r/demo')).status,500);
});

test('bindings come from a revision-pinned policy in the environment', async t => {
  const root = await project(t,{'/go':{...redirect(),env:{token:{env:'TOKEN'}}}});
  const granted = await approveBindings(root);

  // No policy: the route's declared binding is not granted, so activation fails.
  const denied = await deploy(t,{project:root,environment:{TOKEN:'value'}});
  assert.equal((await request(denied,'/go')).status,500);

  // The same grant document the self-hosted runtime reads from a file.
  const allowed = await deploy(t,{project:root,environment:{TOKEN:'value',URLCODE_POLICY:JSON.stringify(granted)}});
  assert.equal((await request(allowed,'/go')).status,302);

  // A policy pinned to a different revision must not activate this one.
  const stale = await deploy(t,{project:root,environment:{TOKEN:'value',
    URLCODE_POLICY:JSON.stringify({...granted,projectSha256:'0'.repeat(64)})}});
  assert.equal((await request(stale,'/go')).status,500);

  const malformed = await deploy(t,{project:root,environment:{TOKEN:'value',URLCODE_POLICY:'{not json'}});
  assert.equal((await request(malformed,'/go')).status,500);
});

test('request bodies stay bounded and route policy still applies', async t => {
  const root = await project(t,{'/go':{...redirect(),methods:['GET','POST'],request:{body:{maxBytes:16}}}});
  const adapted = await deploy(t,{project:root,maxBodyBytes:64});
  assert.equal((await request(adapted,'/go',{method:'POST',body:'small'})).status,302);
  assert.equal((await request(adapted,'/go',{method:'POST',body:'x'.repeat(200)})).status,413);
  assert.throws(() => createVercelHandler({project:root,maxBodyBytes:0}),/Request limit/);
});
