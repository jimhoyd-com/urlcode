import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import { startServer } from '../packages/core/src/server.ts';
import { project, redirect, param, request, approveBindings } from './helpers.ts';
import type { TestContext } from 'node:test';
import type { ServerOptions } from '../packages/core/src/server.ts';

async function serve(t: TestContext, root: string, options: ServerOptions={}) {
  const app = await startServer({ project:root,port:0,log:()=>{},...options }); t.after(() => app.close()); return app;
}
test('literal precedence, methods, HEAD, query isolation, disabled/expired and health', async t => {
  const root = await project(t,{
    '/go':redirect(), '/go/':redirect('https://example.org/'),
    '/p/{id}':{ ...redirect('https://example.com/{id}'),parameters:[param('id')] },
    '/p/exact':redirect('https://exact.example/'),
    '/disabled':{ ...redirect(),enabled:false },
    '/expired':{ ...redirect(),expires:'2020-01-01T00:00:00Z' },
  });
  const app = await serve(t,root);
  assert.equal((await request(app,'/go?token=private')).headers.location,'https://example.com/');
  assert.equal((await request(app,'/go/')).headers.location,'https://example.org/');
  assert.equal((await request(app,'/p/exact')).headers.location,'https://exact.example/');
  assert.equal((await request(app,'/p/hello%20world')).headers.location,'https://example.com/hello%20world');
  assert.equal((await request(app,'/go',{ method:'HEAD' })).body,'');
  const method = await request(app,'/go',{ method:'POST' }); assert.equal(method.status,405); assert.equal(method.headers.allow,'GET, HEAD');
  assert.equal((await request(app,'/missing')).status,404);
  assert.equal((await request(app,'/disabled')).status,404);
  assert.equal((await request(app,'/expired')).status,410);
  assert.equal((await request(app,'/_urlcode/ready')).status,200);
  assert.equal((await request(app,'/GO')).status,404);
});
test('malformed and ambiguous URL encodings fail before routing', async t => {
  const root = await project(t,{ '/{id}':{ ...redirect('https://example.com/{id}'),parameters:[param('id')] } });
  const app = await serve(t,root);
  for (const path of ['/%ZZ','/%ff','/%2f','/%5c','/%00','/..','/%2e','//evil.example','/ok?q=%ff','/ok?q=%']) assert.equal((await request(app,path)).status,400,path);
  assert.equal((await request(app,'/a%252Fb')).headers.location,'https://example.com/a%252Fb');
});
test('typed inputs, defaults, arrays, mapping and passthrough', async t => {
  const root = await project(t,{ '/search':{
    parameters:[ { ...param('n','integer','query'),schema:{ type:'integer',minimum:1,maximum:10,default:2 } },
      { ...param('tags','array','query'),schema:{ type:'array',items:{ type:'string' },maxItems:3 } },param('ok','boolean','query') ],
    redirect:{ url:'https://example.com/search',query:{ map:{ count:{ from:'query',name:'n' },flag:{ from:'query',name:'ok' } },pass:['tags'] } },
  } });
  const app = await serve(t,root);
  assert.equal((await request(app,'/search')).headers.location,'https://example.com/search?count=2');
  assert.equal((await request(app,'/search?n=3&ok=false&tags=a&tags=b')).headers.location,'https://example.com/search?count=3&flag=false&tags=a&tags=b');
  for (const query of ['n=','n=2x','n=01','n=1e0','n=11','n=1&n=2','ok=1','ok=False','tags=a&tags=b&tags=c&tags=d']) assert.equal((await request(app,'/search?'+query)).status,400,query);
});
test('function Request/Response ABI, scoped bindings, cookies, bodies and redacted errors', async t => {
  const events: Record<string, unknown>[] = [];
  const root = await project(t,{
    '/hello/{id}':{ parameters:[param('id')],methods:['GET','HEAD','POST'],function:{ source:'hello.mjs',args:{ id:{ from:'path',name:'id' },key:{ secret:'KEY' } } },env:{ MODE:{ value:'test' } },secrets:{ KEY:{ secret:'token' } } },
    '/fail':{ function:{ source:'fail.mjs' } },
  },{
    'hello.mjs':`export default async (request, context) => { const headers = new Headers(); headers.append('set-cookie','a=1'); headers.append('set-cookie','b=2'); return new Response(JSON.stringify({id:context.args.id, mode:context.env.MODE, scoped:Object.keys(context.secrets), method:request.method, body:await request.text()}),{headers}); }`,
    'fail.mjs':`export default () => { throw new Error('SUPER_SECRET'); }`,
  });
  const app = await serve(t,root,{ permissions:await approveBindings(root),environment:{ token:'SUPER_SECRET', unrelated:'hidden' },log:e => events.push(e) });
  const result = await request(app,'/hello/42',{ method:'POST',body:'hello' });
  assert.equal(result.status,200); assert.deepEqual(result.headers['set-cookie'],['a=1','b=2']);
  assert.deepEqual(JSON.parse(result.body),{ id:'42',mode:'test',scoped:['KEY'],method:'POST',body:'hello' });
  assert.equal((await request(app,'/hello/42',{ method:'HEAD' })).body,'');
  const fail = await request(app,'/fail?secret=SUPER_SECRET');
  assert.equal(fail.status,502); assert.ok(!fail.body.includes('SUPER_SECRET')); assert.ok(!JSON.stringify(events).includes('SUPER_SECRET'));
});
test('sync function hangs time out without blocking redirects; capacity is bounded', async t => {
  const root = await project(t,{ '/hang':{ sandbox:true,function:{ source:'hang.mjs' } },'/go':redirect() },{ 'hang.mjs':'export default () => { while(true) {} }' });
  const app = await serve(t,root,{ workers:1,timeoutMs:1000 });
  const hanging = request(app,'/hang');
  await new Promise(r => setTimeout(r,30));
  assert.equal((await request(app,'/go')).status,302);
  assert.equal((await request(app,'/hang')).status,503);
  assert.equal((await hanging).status,504);
});
test('limits reject oversized requests and responses', async t => {
  const root = await project(t,{ '/':{ methods:['POST'],function:{ source:'large.mjs' } } },{ 'large.mjs':'export default () => new Response("x".repeat(200))' });
  const app = await serve(t,root,{ maxBodyBytes:100,maxBytes:100 });
  assert.equal((await request(app,'/',{ method:'POST',body:'x'.repeat(101),headers:{ 'content-length':'101' } })).status,413);
  assert.equal((await request(app,'/',{ method:'POST',body:'ok' })).status,502);
});
test('invalid reload preserves last good snapshot; valid reload replaces function dependencies', async t => {
  // sandbox:true: a trusted route only cache-busts its own entry file on
  // reload, not modules it imports (docs/FUNCTION-SECURITY.md) — ordinary
  // Node module resolution for a dependency two files deep is out of scope
  // for per-request cache-busting. This test specifically exercises reload
  // replacing a function's *dependency*, which needs the sandboxed pool's
  // from-scratch snapshot rebuild.
  const root = await project(t,{ '/':{ sandbox:true,function:{ source:'f.mjs' } },'/go':redirect() },{ 'f.mjs':'import {value} from "./value.mjs"; export default () => new Response(value);','value.mjs':'export const value = "old";' });
  const events: Record<string, unknown>[] = []; const app = await serve(t,root,{ log:e=>events.push(e) });
  assert.equal((await request(app,'/')).body,'old');
  await writeFile(join(root,'urlcode.yaml'),'bad: config');
  assert.equal(await app.reload(),false); assert.equal((await request(app,'/')).body,'old');
  await writeFile(join(root,'urlcode.yaml'),stringify({ version:'1',routes:{ '/':{ function:{ source:'f.mjs' } } } }));
  await writeFile(join(root,'value.mjs'),'export const value = "new";');
  assert.equal(await app.reload(),true); assert.equal((await request(app,'/')).body,'new');
  assert.equal((await request(app,'/go')).status,404);
  assert.ok(events.some(e => e.event === 'reload' && e.status === 'rejected'));
});
test('missing function export refuses startup and releases workers', async t => {
  const root = await project(t,{ '/':{ function:{ source:'f.mjs' } } },{ 'f.mjs':'export const wrong = 1;' });
  await assert.rejects(startServer({ project:root,port:0 }),/initialization/);
});
test('a client that writes its whole oversized body before reading still reads the 413, not a reset (#1046)', async t => {
  const root = await project(t,{ '/':{ methods:['POST'],function:{ source:'f.mjs' } } },{ 'f.mjs':'export default () => new Response("ok")' });
  const app = await startServer({ project:root,port:0,log:()=>{},maxBodyBytes:1024 });
  const port = app.address.port, size = 4 * 1024 * 1024, head = `POST / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: ${size}\r\n\r\n`;
  let open = true;
  try {
    for (let i = 0; i < 20; i++) {
      const answer = await new Promise<string>(resolve => {
        const socket = connect(port,'127.0.0.1'); let data = '';
        socket.on('data', chunk => { data += chunk; });
        socket.on('error', error => resolve(`${(error as NodeJS.ErrnoException).code}: ${data}`));
        socket.on('close', () => resolve(data));
        socket.write(head);
        socket.end('x'.repeat(size));
      });
      assert.match(answer, /^HTTP\/1\.1 413 [^]*connection: close/i, `attempt ${i}`);
    }
    // A client that neither finishes its body nor closes does not hold shutdown open for the linger period.
    const idle = connect(port,'127.0.0.1'); idle.on('error', () => {});
    const closed = new Promise(resolve => idle.once('close', resolve));
    await new Promise<void>(resolve => { idle.once('data', () => resolve()); idle.write(head + 'x'); });
    const started = performance.now(); open = false; await app.close(); await closed;
    assert.ok(performance.now() - started < 2000, 'close waited for a lingering connection');
  } finally { if (open) await app.close(); }
});
test('a chunked client that writes its whole oversized body before reading reads the 413, not a reset (#1081)', async t => {
  const root = await project(t,{ '/':{ methods:['POST'],function:{ source:'f.mjs' } } },{ 'f.mjs':'export default () => new Response("ok")' });
  const app = await serve(t,root,{ maxBodyBytes:1024 });
  const port = app.address.port, size = 4 * 1024 * 1024;
  for (let i = 0; i < 5; i++) {
    const answer = await new Promise<string>(resolve => {
      const socket = connect(port,'127.0.0.1'); let data = '';
      socket.on('data', chunk => { data += chunk; });
      socket.on('error', error => resolve(`${(error as NodeJS.ErrnoException).code}: ${data}`));
      socket.on('close', () => resolve(data));
      socket.write(`POST / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nTransfer-Encoding: chunked\r\n\r\n${size.toString(16)}\r\n`);
      socket.write('x'.repeat(size));
      socket.end('\r\n0\r\n\r\n');
    });
    assert.match(answer, /^HTTP\/1\.1 413 [^]*connection: close/i, `attempt ${i}`);
  }
});
test('shutdown does not wait for a connection lingering after a streamed body was refused (#1081)', async t => {
  const root = await project(t,{ '/':{ methods:['POST'],function:{ source:'f.mjs' } } },{ 'f.mjs':'export default () => new Response("ok")' });
  const app = await startServer({ project:root,port:0,log:()=>{},maxBodyBytes:1024 });
  let open = true;
  t.after(() => open ? app.close() : undefined);
  const port = app.address.port;
  // The body streams past the limit, more of it than the paused request buffers, then the client neither finishes
  // it nor closes.
  const socket = connect(port,'127.0.0.1'); socket.on('error', () => {});
  const closed = new Promise(resolve => socket.once('close', resolve));
  await new Promise<void>(resolve => {
    socket.once('data', chunk => { assert.match(String(chunk), /^HTTP\/1\.1 413 /); resolve(); });
    socket.write(`POST / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nTransfer-Encoding: chunked\r\n\r\n${(1 << 20).toString(16)}\r\n`);
    socket.write('x'.repeat(1 << 20));
  });
  const started = performance.now(); open = false; await app.close(); await closed;
  assert.ok(performance.now() - started < 2000, 'close waited for a lingering connection');
});
test('a request pipelined behind a refused one is not dispatched while the connection lingers (#1082)', async t => {
  const hits = join(await mkdtemp(join(tmpdir(),'urlcode-hits-')),'hits.log');
  await writeFile(hits,'');
  t.after(() => rm(dirname(hits),{ recursive:true,force:true }));
  const root = await project(t,{ '/':{ methods:['GET','POST'],function:{ source:'f.mjs' } } },
    { 'f.mjs':`import { appendFileSync } from 'node:fs'; export default request => { appendFileSync(${JSON.stringify(hits)}, request.method + '\\n'); return new Response('ok'); };` });
  const app = await serve(t,root,{ maxBodyBytes:1024 });
  const port = app.address.port, size = 2048;
  const socket = connect({ port,host:'127.0.0.1',allowHalfOpen:true }); socket.on('error', () => {});
  let data = '';
  socket.on('data', chunk => { data += chunk; });
  const ended = new Promise(resolve => socket.once('end', resolve));
  // The head and part of the body: the 413 arrives before the rest is sent.
  await new Promise<void>(resolve => { socket.once('data', () => resolve()); socket.write(`POST / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: ${size}\r\n\r\n` + 'x'.repeat(100)); });
  socket.write('x'.repeat(size - 100) + `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
  await new Promise(resolve => setTimeout(resolve, 500));
  socket.end(); await ended;
  assert.match(data, /^HTTP\/1\.1 413 /);
  assert.equal(data.match(/HTTP\/1\.1/g)?.length, 1);
  assert.equal(await readFile(hits,'utf8'), '', 'the pipelined GET reached its handler');
  socket.destroy();
});
test('chunked oversized body returns 413 and server remains usable', async t => {
  const root = await project(t,{ '/':redirect() });
  const app = await serve(t,root,{ maxBodyBytes:10 });
  assert.equal((await request(app,'/',{ method:'POST',headers:{ 'transfer-encoding':'chunked' },body:'01234567890' })).status,413);
  assert.equal((await request(app,'/')).status,302);
});
test('header inputs are case insensitive and duplicate scalars fail', async t => {
  const root = await project(t,{ '/':{ parameters:[{name:'X-Mode',in:'header',required:true,schema:{type:'string',enum:['ok']}}],redirect:{url:'https://example.com',query:{map:{mode:{from:'header',name:'X-Mode'}}}} } });
  const app = await serve(t,root);
  assert.equal((await request(app,'/',{headers:{'x-mode':'ok'}})).headers.location,'https://example.com/?mode=ok');
  assert.equal((await request(app,'/',{headers:{'x-mode':['ok','ok']}})).status,400);
  assert.equal((await request(app,'/')).status,400);
});
test('reload drains in-flight function on old version while new requests use new version', async t => {
  const root = await project(t,{ '/':{function:{source:'f.mjs'}} },{'f.mjs':'export default async () => { await new Promise(r=>setTimeout(r,200)); return new Response("old"); }'});
  const app = await serve(t,root);
  const pending = request(app,'/'); await new Promise(r=>setTimeout(r,50));
  await writeFile(join(root,'f.mjs'),'export default () => new Response("new")');
  assert.equal(await app.reload(),true);
  assert.equal((await request(app,'/')).body,'new');
  assert.equal((await pending).body,'old');
});
test('development watcher applies edits and keeps invalid edits out', async t => {
  const root = await project(t,{ '/':redirect('https://old.example') });
  const app = await serve(t,root,{ watch:true,local:true });
  await writeFile(join(root,'urlcode.yaml'),stringify({version:'1',routes:{'/':redirect('https://new.example')}}));
  const until = Date.now()+5000;
  while ((await request(app,'/')).headers.location !== 'https://new.example/' && Date.now()<until) await new Promise(r=>setTimeout(r,100));
  assert.equal((await request(app,'/')).headers.location,'https://new.example/');
  await writeFile(join(root,'urlcode.yaml'),'version: bad');
  await new Promise(r=>setTimeout(r,650));
  assert.equal((await request(app,'/')).headers.location,'https://new.example/');
});
test('invalid public origin fails before starting function workers', async t => {
  const root = await project(t,{ '/':{function:{source:'f.mjs'}} },{'f.mjs':'export default () => new Response("ok")'});
  await assert.rejects(startServer({project:root,port:0,origin:'not-a-url'}),/origin/i);
});
