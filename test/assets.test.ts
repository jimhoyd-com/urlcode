import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink, link, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { startServer } from '../src/server.ts';
import { createRuntime } from '../src/runtime.ts';
import { project, request, redirect } from './helpers.ts';
async function serve(t, routes, files, options = {}) {
  const root = await project(t,routes,files);
  const app = await startServer({project:root,port:0,log:()=>{},...options});
  t.after(()=>app.close()); return {root,app};
}
test('native page, download and static handlers detect MIME and preserve binary bytes',async t => {
  const binary = Buffer.from([0,255,128,1]);
  const {app} = await serve(t,{
    '/about':{page:{file:'public/about.html'}},
    '/get':{download:{file:'public/data.bin',filename:'résumé.bin'}},
    '/custom':{page:{file:'public/data.bin',contentType:'text/plain',cacheControl:'no-store'}},
    '/assets/*':{static:{directory:'public',index:'about.html'}},
    '/assets/override':redirect(),
  },{'public/about.html':'<h1>Hello</h1>','public/data.bin':binary,'public/.env':'SECRET'});
  const page = await request(app,'/about');
  assert.equal(page.status,200); assert.equal(page.headers['content-type'],'text/html; charset=utf-8');
  assert.equal(page.headers['cache-control'],'no-cache'); assert.equal(page.headers['x-content-type-options'],'nosniff');
  const file = await request(app,'/get'); assert.deepEqual(file.bytes,binary);
  assert.equal(file.headers['content-type'],'application/octet-stream');
  assert.match(file.headers['content-disposition'],/^attachment;/); assert.match(file.headers['content-disposition'],/filename\*=UTF-8''r%C3%A9sum%C3%A9.bin/);
  const head = await request(app,'/get',{method:'HEAD'}); assert.equal(head.body,''); assert.equal(head.headers['content-length'],'4');
  assert.equal((await request(app,'/custom')).headers['content-type'],'text/plain; charset=utf-8');
  assert.equal((await request(app,'/assets/')).body,page.body);
  assert.deepEqual((await request(app,'/assets/data.bin')).bytes,binary);
  assert.equal((await request(app,'/assets/override')).status,302);
  for (const path of ['/assets/.env','/assets/missing','/assets']) assert.equal((await request(app,path)).status,404);
  for (const path of ['/assets/../urlcode.yaml','/assets/%2e%2e/urlcode.yaml','/assets/%2fetc']) assert.equal((await request(app,path)).status,400);
  assert.equal((await request(app,'/get',{method:'POST'})).status,405);
});
test('asset conditions, byte ranges, empty files and HEAD obey HTTP ordering',async t => {
  const {app} = await serve(t,{'/file':{download:{file:'public/a.txt'}},'/empty':{page:{file:'public/empty.txt'}}},{'public/a.txt':'0123456789','public/empty.txt':''});
  const full = await request(app,'/file'), etag = full.headers.etag;
  for (const headers of [{'if-none-match':etag},{'if-none-match':'W/'+etag},{'if-modified-since':full.headers['last-modified']}]) {
    const result = await request(app,'/file',{headers}); assert.equal(result.status,304); assert.equal(result.body,'');
  }
  assert.equal((await request(app,'/file',{headers:{'if-none-match':'"other"','if-modified-since':full.headers['last-modified']}})).status,200);
  assert.equal((await request(app,'/file',{headers:{'if-match':'W/'+etag}})).status,412);
  assert.equal((await request(app,'/file',{headers:{'if-unmodified-since':'Thu, 01 Jan 1970 00:00:00 GMT'}})).status,412);
  for (const [range,body] of [['bytes=2-4','234'],['bytes=7-','789'],['bytes=-3','789'],['bytes=-999999999999999999999','0123456789']]) {
    const result = await request(app,'/file',{headers:{range}}); assert.equal(result.status,206); assert.equal(result.body,body); assert.equal(Number(result.headers['content-length']),body.length);
  }
  assert.equal((await request(app,'/file',{headers:{range:'bytes=2-4'}})).headers['content-range'],'bytes 2-4/10');
  for (const range of ['bytes=10-','bytes=-0','bytes=5-2']) assert.equal((await request(app,'/file',{headers:{range}})).status,416);
  assert.equal((await request(app,'/empty',{headers:{range:'bytes=0-'}})).headers['content-range'],'bytes */0');
  for (const range of ['other=1-2','bytes=0-1,3-4','bytes=bad']) assert.equal((await request(app,'/file',{headers:{range}})).status,200);
  assert.equal((await request(app,'/file',{headers:{range:'bytes=0-1','if-range':'"old"'}})).status,200);
  assert.equal((await request(app,'/file',{headers:{range:'bytes=0-1','if-range':etag}})).status,206);
  assert.equal((await request(app,'/file',{headers:{range:'bytes=0-1','if-none-match':etag}})).status,304);
  const head = await request(app,'/file',{method:'HEAD',headers:{range:'bytes=0-1'}}); assert.equal(head.status,200); assert.equal(head.headers['content-length'],'10');
});
test('assets reject unsafe paths, symlinks, hardlinks, invalid methods and oversized files',async t => {
  const root = await project(t,{}, {'public/a.txt':'ok','.env.local':'SECRET'});
  async function rejects(route) {
    await writeFile(join(root,'urlcode.yaml'),stringify({version:'1',routes:{'/file':route}}));
    await assert.rejects(createRuntime(root));
  }
  for (const file of ['../a.txt','/etc/passwd','.env.local','public/../.env.local','public/a.key','public\\a.txt']) await rejects({page:{file}});
  await rejects({page:{file:'public/a.txt'},methods:['POST']});
  await rejects({download:{file:'public/a.txt',filename:'bad\r\nname'}});
  await rejects({page:{file:'public/a.txt'},redirect:{url:'https://example.com'}});
  await link(join(root,'public/a.txt'),join(root,'public/hard.txt'));
  await rejects({page:{file:'public/hard.txt'}});
  // Windows symlink creation may require privileges; junctions work for directories.
  await symlink(join(root,'public'),join(root,'linked'),process.platform === 'win32' ? 'junction' : 'dir');
  await rejects({page:{file:'linked/a.txt'}});
  await writeFile(join(root,'public/big.bin'),''); await truncate(join(root,'public/big.bin'),16*1024*1024+1);
  await rejects({download:{file:'public/big.bin'}});
});
test('asset snapshots survive mutation and invalid reload; valid reload replaces bytes and ETag',async t => {
  const {root,app} = await serve(t,{'/a':{page:{file:'public/a.txt'}}},{'public/a.txt':'old'});
  const old = await request(app,'/a');
  await writeFile(join(root,'public/a.txt'),'new');
  assert.equal((await request(app,'/a')).body,'old');
  await writeFile(join(root,'urlcode.yaml'),'invalid: true'); assert.equal(await app.reload(),false);
  assert.equal((await request(app,'/a')).body,'old');
  await writeFile(join(root,'urlcode.yaml'),stringify({version:'1',routes:{'/a':{page:{file:'public/a.txt'}}}}));
  assert.equal(await app.reload(),true); const next = await request(app,'/a'); assert.equal(next.body,'new'); assert.notEqual(next.headers.etag,old.headers.etag);
});
test('dev watches binary asset edits and additions in explicitly mounted build directories',async t => {
  const {root,app} = await serve(t,{'/assets/*':{static:{directory:'dist'}}},{'dist/a.bin':'old'},{watch:true});
  await writeFile(join(root,'dist/a.bin'),'new'); await writeFile(join(root,'dist/b.bin'),'added');
  const deadline = Date.now()+5000;
  while (Date.now()<deadline) { if ((await request(app,'/assets/b.bin')).status===200) break; await new Promise(resolve=>setTimeout(resolve,100)); }
  assert.equal((await request(app,'/assets/a.bin')).body,'new'); assert.equal((await request(app,'/assets/b.bin')).body,'added');
});
