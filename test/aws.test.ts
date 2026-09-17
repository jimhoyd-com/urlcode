import test from 'node:test';
import assert from 'node:assert/strict';
import { createLambdaHandler } from '../src/aws.ts';
import type { LambdaEvent, LambdaResponse } from '../src/aws.ts';
import { startServer } from '../src/server.ts';
import { project, redirect, request, param, approveBindings } from './helpers.ts';

// A Lambda Function URL / HTTP API invocation, payload format 2.0.
interface InvokeOptions { method?: string; headers?: Record<string, string>; cookies?: string[]; body?: string; isBase64Encoded?: boolean }
const invoke = (path: string, { method = 'GET', headers = {}, cookies, body, isBase64Encoded }: InvokeOptions = {}): LambdaEvent => {
  const [rawPath = '', rawQueryString = ''] = path.split(/\?(.*)/s);
  return { version:'2.0', rawPath, rawQueryString, headers, ...(cookies ? {cookies} : {}),
    ...(body === undefined ? {} : {body, isBase64Encoded: isBase64Encoded ?? false}),
    requestContext:{ http:{ method } } };
};
const decode = (response: LambdaResponse) => Buffer.from(response.body,'base64').toString();

const assets = { 'public/page.html':'<!doctype html><title>page</title>', 'public/data.txt':'hello from a file\n' };
const routes = {
  '/go': redirect('https://example.com/target'),
  '/u/{id}': {parameters:[param('id')],redirect:{url:'https://example.com/{id}'}},
  '/hello': {respond:{json:{ok:true}}},
  '/page': {page:{file:'public/page.html'}},
  '/files/*': {static:{directory:'public'}},
};

test('a Lambda response carries exactly what the self-hosted server sends', async t => {
  const root = await project(t,routes,assets);
  const hosted = await startServer({project:root,port:0,log:()=>{}});
  t.after(() => hosted.close());
  const handler = createLambdaHandler({project:root});

  for (const path of ['/go','/u/42','/hello','/page','/files/data.txt','/missing']) {
    const served = await request(hosted,path);
    const returned = await handler(invoke(path));
    assert.equal(returned.statusCode,served.status,`status differs for ${path}`);
    assert.equal(decode(returned),served.body,`body differs for ${path}`);
    for (const header of ['location','content-type','etag','cache-control','x-content-type-options','content-length']) {
      assert.equal(returned.headers[header],served.headers[header],`${header} differs for ${path}`);
    }
    assert.equal(returned.isBase64Encoded,true);
  }
  // Query strings reach the runtime with their original bytes.
  assert.equal((await handler(invoke('/hello?a=1&b=%20'))).statusCode,200);
  assert.equal((await handler(invoke('/go',{method:'POST'}))).statusCode,405);
  assert.equal(decode(await handler(invoke('/page',{method:'HEAD'}))),'');
});

test('payload format 1.0 is refused with the reason, not silently mishandled', async t => {
  const root = await project(t,{'/go':redirect()});
  const handler = createLambdaHandler({project:root});
  const legacy = await handler({ path:'/go', httpMethod:'GET', headers:{}, queryStringParameters:null });
  assert.equal(legacy.statusCode,500);
  for (const event of [null,{},{version:'1.0'},{version:'2.0',rawPath:'/go'}]) {
    assert.equal((await handler(event)).statusCode,500,`accepted ${JSON.stringify(event)}`);
  }
});

test('base64 request bodies are decoded and route body policy still applies', async t => {
  const root = await project(t,{'/go':{...redirect(),methods:['GET','POST'],request:{body:{maxBytes:16}}}});
  const handler = createLambdaHandler({project:root,maxBodyBytes:64});
  assert.equal((await handler(invoke('/go',{method:'POST',body:Buffer.from('small').toString('base64'),isBase64Encoded:true}))).statusCode,302);
  assert.equal((await handler(invoke('/go',{method:'POST',body:'small'}))).statusCode,302);
  assert.equal((await handler(invoke('/go',{method:'POST',body:'x'.repeat(200)}))).statusCode,413);
});

test('cookies arrive through the format 2.0 array and leave through it', async t => {
  const root = await project(t,{'/go':{...redirect(),response:{headers:{'set-cookie':['a=1','b=2']}}},
    '/echo':{parameters:[{name:'cookie',in:'header',schema:{type:'string'}}],respond:{text:'ok'}}});
  const handler = createLambdaHandler({project:root});
  const response = await handler(invoke('/go'));
  assert.deepEqual(response.cookies,['a=1','b=2']);
  assert.equal(response.headers['set-cookie'],undefined,'cookies must not also be a joined header');
  assert.equal((await handler(invoke('/echo',{cookies:['session=abc']}))).statusCode,200);
});

test('unsupported handlers and the policy pin behave as on any adapter', async t => {
  const functions = await project(t,{'/f':{function:{source:'f.mjs'}}},{'f.mjs':'export default () => new Response("x");'});
  assert.equal((await createLambdaHandler({project:functions})(invoke('/f'))).statusCode,500);

  const root = await project(t,{'/go':{...redirect(),env:{token:{env:'TOKEN'}}}});
  const granted = await approveBindings(root);
  assert.equal((await createLambdaHandler({project:root,environment:{TOKEN:'v'}})(invoke('/go'))).statusCode,500);
  assert.equal((await createLambdaHandler({project:root,environment:{TOKEN:'v',URLCODE_POLICY:JSON.stringify(granted)}})(invoke('/go'))).statusCode,302);
  assert.equal((await createLambdaHandler({project:root,environment:{TOKEN:'v',
    URLCODE_POLICY:JSON.stringify({...granted,projectSha256:'0'.repeat(64)})}})(invoke('/go'))).statusCode,500);
});
