import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntime } from '../src/runtime.js';
import { startServer } from '../src/server.js';
import { loadOperatorPolicy, prepareFunctionSnapshot, requestedPermissions } from '../src/policy.js';
import { loadDocument } from '../src/config.js';
import { project,request,approveBindings,redirect } from './helpers.js';

async function app(t,root,options={}) {
  const server = await startServer({project:root,port:0,log:()=>{},...options});
  t.after(()=>server.close()); return server;
}
test('guest has no Node, filesystem, shell, network or worker capabilities', async t => {
  const root = await project(t,{'/':{function:{source:'f.mjs'}}},{'f.mjs':`export default () => Response.json({process:typeof process,require:typeof require,fetch:typeof fetch,WebSocket:typeof WebSocket,Worker:typeof Worker,Buffer:typeof Buffer,Deno:typeof Deno,Bun:typeof Bun,WebAssembly:typeof WebAssembly});`});
  const response = await request(await app(t,root),'/');
  assert.equal(response.status,200);
  assert.ok(Object.values(JSON.parse(response.body)).every(value=>value==='undefined'));
});
test('constructor and eval escapes stay inside the guest realm', async t => {
  const root = await project(t,{'/':{function:{source:'f.mjs'}}},{'f.mjs':`export default (request,context) => {
    const checks = [()=>({}).constructor.constructor('return process')(),()=>request.constructor.constructor('return process')(),()=>context.constructor.constructor('return process')(),()=>eval('process.env'),()=>Function('return require')()];
    return Response.json(checks.map(fn=>{try { fn(); return 'escaped'; } catch { return 'blocked'; }}));
  }`});
  assert.deepEqual(JSON.parse((await request(await app(t,root),'/')).body),Array(5).fill('blocked'));
});
test('static privileged imports fail before host side effects can run', async t => {
  const root = await project(t,{'/':{function:{source:'f.mjs'}}});
  const marker = join(root,'owned');
  for (const module of ['node:fs','node:child_process','node:net','node:worker_threads','https://example.com/evil.mjs']) {
    await writeFile(join(root,'f.mjs'),`import * as privileged from ${JSON.stringify(module)}; privileged.writeFileSync?.(${JSON.stringify(marker)},'bad'); export default () => new Response('bad');`);
    await assert.rejects(createRuntime(root),/relative project/);
    await assert.rejects(access(marker));
  }
});
test('dynamic import cannot recover host modules, including code constructed at runtime', async t => {
  const root = await project(t,{'/':{function:{source:'f.mjs'}}},{'f.mjs':`export default async () => { const load = Function("return import('node:fs')"); await load(); return new Response('escaped'); }`});
  assert.equal((await request(await app(t,root),'/')).status,502);
});
test('new invocation heap prevents state and prototype pollution crossing requests', async t => {
  const root = await project(t,{'/':{function:{source:'f.mjs'}}},{'f.mjs':`export default () => { const previous = Object.prototype.infected || null; Object.prototype.infected = 'secret'; globalThis.count = (globalThis.count || 0) + 1; return Response.json({previous,count:globalThis.count}); }`});
  const server = await app(t,root,{workers:1});
  for (let i=0;i<3;i++) assert.deepEqual(JSON.parse((await request(server,'/')).body),{previous:null,count:1});
  assert.equal(Object.prototype.infected,undefined);
});
test('malicious allocations fail within guest limit and redirects survive', async t => {
  const root = await project(t,{'/oom':{function:{source:'f.mjs'}},'/go':redirect()},{'f.mjs':`export default () => { const values=[]; for(let i=0;i<10000000;i++) values.push({i,data:'x'.repeat(1000)}); return new Response('bad'); }`});
  const server = await app(t,root,{timeoutMs:1000});
  assert.ok([502,504].includes((await request(server,'/oom')).status));
  assert.equal((await request(server,'/go')).status,302);
});
test('YAML cannot self-grant secrets; grants are route-scoped and revision-pinned', async t => {
  const root = await project(t,{'/allowed':{function:{source:'f.mjs'},secrets:{KEY:{secret:'token'}}},'/other':{function:{source:'f.mjs'}}},{'f.mjs':`import {value} from './helper.mjs'; export default (_request,context) => Response.json({keys:Object.keys(context.secrets),value});`,'helper.mjs':`export const value = 'ok';`});
  const environment = {token:'TEST_PRIVATE',ambient:'MUST_NOT_LEAK'};
  await assert.rejects(createRuntime(root,{environment}),/denied by operator policy/);
  const permissions = await approveBindings(root);
  const server = await app(t,root,{permissions,environment,workers:1});
  assert.deepEqual(JSON.parse((await request(server,'/allowed')).body).keys,['KEY']);
  assert.deepEqual(JSON.parse((await request(server,'/other')).body).keys,[]);
  await writeFile(join(root,'helper.mjs'),`export const value = 'changed';`);
  await assert.rejects(createRuntime(root,{permissions,environment}),/denied by operator policy/);
});
test('operator policy cannot be loaded from the application or broaden to network', async t => {
  const root = await project(t,{});
  const loaded = await loadDocument(root);
  const policy = requestedPermissions(loaded,await prepareFunctionSnapshot(loaded));
  const file = join(root,'policy.json'); await writeFile(file,JSON.stringify(policy));
  await assert.rejects(loadOperatorPolicy(file,root),/outside/);
  await assert.rejects(createRuntime(root,{permissions:{...policy,network:true}}),/Policy/);
});
test('capability inspection never executes module top-level code', async t => {
  const root = await project(t,{'/':{function:{source:'f.mjs'}}},{'f.mjs':`while (true) {} export default () => new Response('no');`});
  const loaded = await loadDocument(root);
  const snapshot = await prepareFunctionSnapshot(loaded);
  assert.match(snapshot.projectSha256,/^[0-9a-f]{64}$/);
});
test('large ArrayBuffer is rejected inside the guest rather than allocated on the host', async t => {
  const root = await project(t,{'/':{function:{source:'f.mjs'}}},{'f.mjs':`export default () => { try { new ArrayBuffer(256 * 1024 * 1024); return new Response('allocated'); } catch { return new Response('blocked'); } }`});
  assert.equal((await request(await app(t,root),'/')).body,'blocked');
});
test('runtime-constructed imports cannot read another route module outside the declared graph', async t => {
  const root = await project(t,{'/a':{function:{source:'a.mjs'}},'/b':{function:{source:'b.mjs'}}},{'a.mjs':`export default async () => { const load = Function("return import('/b.mjs')"); await load(); return new Response('escaped'); }`,'b.mjs':`export default () => new Response('b');`});
  const server = await app(t,root);
  assert.equal((await request(server,'/a')).status,502);
  assert.equal((await request(server,'/b')).body,'b');
});
