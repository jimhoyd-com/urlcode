import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openLinkStore} from '../src/link-store.js';
import {startLinkApi,loadLinkToken} from '../src/link-api.js';
import {startServer} from '../src/server.js';
import {createRuntime} from '../src/runtime.js';
import {auditProject} from '../src/readiness.js';
import {project,param,redirect,request} from './helpers.js';
const route=()=>({parameters:[param('code')],link:{collection:'links',code:{from:'path',name:'code'}}});
const data=(url='https://example.com/one')=>({url});
async function setup(t,routes={'/r/{code}':route(),'/plain':redirect()}) {
 const root=await project(t,routes,{}, {dynamicLinks:true}),directory=await mkdtemp(join(tmpdir(),'urlcode-links-')),file=join(directory,'links.sqlite');
 const close=[];t.after(async()=>{for(const value of close.reverse())await value.close();await rm(directory,{recursive:true,force:true});});
 const store=await openLinkStore({file,project:root});close.push(store);
 return {root,file,directory,store,keep:value=>{close.push(value);return value;}};
}
test('new links, updates, deletion and negative-cache misses become visible without reload',async t=>{
 const f=await setup(t);const app=f.keep(await startServer({project:f.root,port:0,linkStore:{collection:'links',file:f.file},log:()=>{}}));
 const config=await readFile(join(f.root,'urlcode.yaml'),'utf8');const before=JSON.parse((await request(app,'/_urlcode/health')).body);
 assert.equal((await request(app,'/r/new')).status,404);
 const first=await f.store.create('links',data(),'new');
 assert.equal((await request(app,'/r/new')).headers.location,'https://example.com/one');
 const updated=await f.store.update('links','new',{url:'https://example.com/two',status:307},first.version);
 const result=await request(app,'/r/new');assert.equal(result.status,307);assert.equal(result.headers.location,'https://example.com/two');assert.equal(result.headers['cache-control'],'no-store');
 assert.equal((await request(app,'/r/new',{method:'HEAD'})).body,'');assert.equal((await request(app,'/r/new',{method:'POST'})).status,405);
 await f.store.delete('links','new',updated.version);assert.equal((await request(app,'/r/new')).status,404);
 assert.equal(await readFile(join(f.root,'urlcode.yaml'),'utf8'),config);assert.deepEqual(JSON.parse((await request(app,'/_urlcode/health')).body),before);
});
test('records survive connection restart; independent readers see committed writes',async t=>{
 const f=await setup(t);const row=await f.store.create('links',data(),'persistent');await f.store.close();
 const reader=f.keep(await openLinkStore({file:f.file,project:f.root,readOnly:true}));assert.equal((await reader.get('links','persistent')).version,row.version);
 await assert.rejects(reader.create('links',data(),'blocked'),{status:403});
});
test('concurrent writers enforce unique codes, optimistic versions and delete/recreate safety',async t=>{
 const f=await setup(t);const other=f.keep(await openLinkStore({file:f.file,project:f.root}));
 const created=await Promise.allSettled([f.store.create('links',data(),'same'),other.create('links',data(),'same')]);
 assert.equal(created.filter(r=>r.status==='fulfilled').length,1);assert.equal(created.find(r=>r.status==='rejected').reason.status,409);
 const first=await f.store.get('links','same');
 const changes=await Promise.allSettled([f.store.update('links','same',data('https://example.com/a'),first.version),other.update('links','same',data('https://example.com/b'),first.version)]);
 assert.equal(changes.filter(r=>r.status==='fulfilled').length,1);
 const current=await other.get('links','same');await other.delete('links','same',current.version);
 const replacement=await f.store.create('links',data(),'same');assert.ok(replacement.version>current.version);
 await assert.rejects(other.delete('links','same',current.version),{status:409});
});
test('expiry, disabled state, collection scope, exact precedence and middleware are preserved',async t=>{
 const wrapped=route();wrapped.middleware=[{source:'headers.mjs'}];
 const f=await setup(t,{'/r/{code}':wrapped,'/r/fixed':redirect('https://example.com/fixed')});
 await writeFile(join(f.root,'headers.mjs'),'export default async (req,ctx,next)=>{const res=await next();res.headers.set("x-link","yes");return res;}');
 await f.store.create('links',{url:'https://example.com/',enabled:false},'disabled');
 await f.store.create('links',{url:'https://example.com/',expires:'2020-01-01T00:00:00Z'},'expired');
 await f.store.create('other',data(),'private');await f.store.create('links',data(),'fixed');await f.store.create('links',data(),'valid');
 const app=f.keep(await startServer({project:f.root,port:0,linkStore:{collection:'links',file:f.file},log:()=>{}}));
 assert.equal((await request(app,'/r/disabled')).status,404);assert.equal((await request(app,'/r/expired')).status,410);assert.equal((await request(app,'/r/private')).status,404);
 assert.equal((await request(app,'/r/fixed')).headers.location,'https://example.com/fixed');assert.equal((await request(app,'/r/valid')).headers['x-link'],'yes');
 assert.equal((await request(app,'/r/valid?url=https://evil.example')).headers.location,'https://example.com/one');
 const audit=await auditProject(app);assert.equal(audit.ready,false);assert.equal(audit.uncovered.length,2);
});
test('store input validation rejects unsafe destinations and ambiguous mutations',async t=>{
 const f=await setup(t);
 for(const record of [{url:'javascript:alert(1)'},{url:'https://user:password@example.com'},{url:'https://example.com/\r\nx:y'},{url:'https://example.com',extra:1},{url:'https://example.com',status:200},{url:'https://example.com',expires:'2025-02-30T00:00:00Z'}])await assert.rejects(f.store.create('links',record,'bad'),{status:400});
 for(const code of ['',null,'a/b','x'.repeat(129)])await assert.rejects(f.store.create('links',data(),code),{status:400});
 const row=await f.store.create('links',data());assert.match(row.code,/^[A-Za-z0-9_-]{16}$/);
 await assert.rejects(f.store.update('links',row.code,data()),{status:400});await assert.rejects(f.store.list('links',{limit:101}),{status:400});
});
test('bounded store admission fails fast and store failure does not stop native redirects',async t=>{
 const f=await setup(t);const results=await Promise.allSettled(Array.from({length:64},()=>f.store.get('links','missing')));
 assert.ok(results.some(r=>r.status==='rejected'&&r.reason.status===503));
 const app=f.keep(await startServer({project:f.root,port:0,linkStores:{links:f.store},log:()=>{}}));
 await f.store.close();assert.equal((await request(app,'/r/missing')).status,503);assert.equal((await request(app,'/plain')).status,302);assert.equal((await request(app,'/_urlcode/ready')).status,503);
});
test('missing bindings, invalid methods and in-project stores fail activation',async t=>{
 const f=await setup(t);await assert.rejects(createRuntime(f.root),/Missing operator link store/);
 await assert.rejects(openLinkStore({file:join(f.root,'links.sqlite'),project:f.root}),/outside/);
 const root=await project(t,{'/r/{code}':{...route(),methods:['POST']}},{},{dynamicLinks:true});await assert.rejects(createRuntime(root),/GET and HEAD/);
});
test('management API requires a token and conditional writes; public server has no management endpoint',async t=>{
 const f=await setup(t),token='a'.repeat(43),api=f.keep(await startLinkApi({store:f.store,collection:'links',token,port:0}));
 const call=(path,method='GET',record,extra={})=>request(api,path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json',...extra},body:record===undefined?undefined:JSON.stringify(record)});
 assert.equal((await request(api,'/v1/links')).status,401);
 assert.equal((await call('/v1/links','POST',data(),{origin:'https://evil.example'})).status,403);
 const created=await call('/v1/links','POST',{code:'api',url:'https://example.com/api'});assert.equal(created.status,201);const row=JSON.parse(created.body);
 assert.equal((await call('/v1/links','POST',{code:'api',url:'https://example.com/'})).status,409);
 assert.equal((await call('/v1/links/api')).headers.etag,`"${row.version}"`);
 assert.equal((await call('/v1/links/api','PUT',data())).status,428);
 assert.equal((await call('/v1/links/api','PUT',data(),{'if-match':'"9999"'})).status,409);
 const updated=await call('/v1/links/api','PUT',data(),{'if-match':created.headers.etag});assert.equal(updated.status,200);
 assert.equal(JSON.parse((await call('/v1/links?limit=1')).body).items.length,1);
 assert.equal((await call('/v1/links/api','DELETE',undefined,{'if-match':updated.headers.etag})).status,204);
 assert.equal((await call('/v1/links/api')).status,404);
 const app=f.keep(await startServer({project:f.root,port:0,linkStore:{collection:'links',file:f.file},log:()=>{}}));assert.equal((await request(app,'/v1/links')).status,404);
});
test('management JSON/body limits and token file boundaries are enforced',async t=>{
 const f=await setup(t),token='b'.repeat(43),api=f.keep(await startLinkApi({store:f.store,collection:'links',token,port:0}));
 const tokenFile=join(f.directory,'token');await writeFile(tokenFile,token,{mode:0o600});assert.equal(await loadLinkToken(tokenFile,f.root),token);
 await assert.rejects(loadLinkToken(join(f.root,'token'),f.root),/outside/);
 const headers={authorization:'Bearer '+token,'content-type':'application/json'};
 assert.equal((await request(api,'/v1/links',{method:'POST',headers,body:'{'})).status,400);
 const large=await request(api,'/v1/links',{method:'POST',headers,body:JSON.stringify({url:'https://example.com/'+'a'.repeat(17000)})});assert.equal(large.status,413);
});
test('CLI creates persistent links visible to an already running server',async t=>{
 const f=await setup(t);const app=f.keep(await startServer({project:f.root,port:0,linkStore:{collection:'links',file:f.file},log:()=>{}}));
 const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
 const created=spawnSync(process.execPath,[cli,'links','create','--store',f.file,'--project',f.root,'--code','cli','--destination','https://example.com/cli'],{encoding:'utf8',timeout:10000});
 assert.equal(created.status,0,created.stderr);assert.equal(JSON.parse(created.stdout).code,'cli');assert.equal((await request(app,'/r/cli')).headers.location,'https://example.com/cli');
});
test('acknowledged writes survive abrupt writer exit and pagination retains records',async t=>{
 const f=await setup(t);const module=new URL('../src/link-store.js',import.meta.url).href;
 const script=`import {openLinkStore} from ${JSON.stringify(module)};const store=await openLinkStore({file:${JSON.stringify(f.file)},project:${JSON.stringify(f.root)}});await store.create('links',{url:'https://example.com/crash'},'crash');process.exit(0);`;
 const writer=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000});assert.equal(writer.status,0,writer.stderr);
 assert.equal((await f.store.get('links','crash')).url,'https://example.com/crash');
 await f.store.create('links',data(),'next');const page=await f.store.list('links',{limit:1});assert.equal(page[0].code,'crash');assert.equal((await f.store.list('links',{limit:1,after:'crash'}))[0].code,'next');
});
test('record edits leave function approval digests unchanged and safe adapter validation fails closed',async t=>{
 const f=await setup(t);const {loadDocument}=await import('../src/config.js');const {prepareFunctionSnapshot}=await import('../src/policy.js');
 const before=(await prepareFunctionSnapshot(await loadDocument(f.root))).projectSha256;
 await f.store.create('links',data(),'approved');const after=(await prepareFunctionSnapshot(await loadDocument(f.root))).projectSha256;assert.equal(before,after);
 const app=f.keep(await startServer({project:f.root,port:0,linkStores:{links:{get:async()=>({url:'javascript:alert(1)'})}},log:()=>{}}));
 assert.equal((await request(app,'/r/unsafe')).status,503);
});
test('shutdown drains a full store queue, rejects new work and is idempotent',async t=>{
 const f=await setup(t);
 const writes=Array.from({length:32},(_,i)=>f.store.create('links',data(),`drain-${i}`));
 const closing=f.store.close();assert.equal(f.store.close(),closing);
 await assert.rejects(f.store.get('links','drain-0'),{status:503});
 await Promise.all(writes);await closing;
 const reader=f.keep(await openLinkStore({file:f.file,project:f.root,readOnly:true}));
 assert.equal((await reader.list('links')).length,32);
});
test('uncloneable store arguments do not consume admission or kill the worker',async t=>{
 const f=await setup(t);
 for(let i=0;i<40;i++)await assert.rejects(f.store.create('links',{url:()=>{}},'bad'),{status:400});
 assert.equal((await f.store.create('links',data(),'valid')).code,'valid');assert.equal(f.store.healthy,true);
});
test('management method errors advertise endpoint-specific allowed methods',async t=>{
 const f=await setup(t),token='c'.repeat(43),api=f.keep(await startLinkApi({store:f.store,collection:'links',token,port:0}));
 for(const [path,method,allow] of [['/v1/links','PUT','GET, POST'],['/v1/links/item','POST','GET, PUT, DELETE'],['/v1/links','OPTIONS','GET, POST']]){
  const result=await request(api,path,{method,headers:{authorization:'Bearer '+token}});
  assert.equal(result.status,405);assert.equal(result.headers.allow,allow);
 }
});
test('stores with missing revision metadata fail activation',async t=>{
 const f=await setup(t);await f.store.close();
 const script=`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify(f.file)});db.exec('DELETE FROM urlcode_link_meta');db.close();`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr);
 await assert.rejects(openLinkStore({file:f.file,project:f.root}),/initialization failed/);
});
test('live links require entry-level opt-in, including routes from included files',async t=>{
 const {stringify}=await import('yaml');
 for(const setting of [undefined,false]){
  const root=await project(t,{'/r/{code}':route()},{},setting===undefined?{}:{dynamicLinks:setting});
  await assert.rejects(createRuntime(root),/dynamicLinks: true/);
 }
 const root=await project(t,{'/go':redirect()});
 // Parameterized function/redirect routes are independent of this stored-link switch.
 const plain=await createRuntime(root);assert.equal(plain.testPlan().dynamicLinks,false);await plain.close();
 await assert.rejects(createRuntime(root,{linkStores:{links:{get:async()=>null}}}),/dynamicLinks: true/);
 await writeFile(join(root,'part.yaml'),stringify({version:'1',dynamicLinks:true,routes:{}}));
 await writeFile(join(root,'urlcode.yaml'),stringify({version:'1',dynamicLinks:true,includes:['part.yaml'],routes:{}}));
 await assert.rejects(createRuntime(root),/only be set in the entry/);
 await writeFile(join(root,'part.yaml'),stringify({version:'1',routes:{'/r/{code}':route()}}));
 await writeFile(join(root,'urlcode.yaml'),stringify({version:'1',includes:['part.yaml'],routes:{}}));
 await assert.rejects(createRuntime(root),/dynamicLinks: true/);
 await writeFile(join(root,'urlcode.yaml'),stringify({version:'1',dynamicLinks:true,includes:['part.yaml'],routes:{}}));
 const enabled=await createRuntime(root,{linkStores:{links:{get:async()=>null}}});assert.equal(enabled.testPlan().dynamicLinks,true);await enabled.close();
});
test('read and write pools have independent bounded admission and drain on close',async t=>{
 const f=await setup(t);const pooled=f.keep(await openLinkStore({file:f.file,project:f.root,readers:3,maxReads:2,maxWrites:1}));
 const row=await pooled.create('links',data(),'pool');
 const reads=[pooled.get('links','pool'),pooled.get('links','pool')];
 await assert.rejects(pooled.get('links','pool'),{status:503});
 const write=pooled.update('links','pool',data('https://example.com/new'),row.version);
 await assert.rejects(pooled.create('links',data(),'excess'),{status:503});
 const first=pooled.stats();assert.equal(first.read.connections,3);assert.equal(first.write.connections,1);assert.equal(first.read.rejected,1);assert.equal(first.write.rejected,1);
 await Promise.all([...reads,write]);assert.equal((await pooled.get('links','pool')).url,'https://example.com/new');
 const last=pooled.stats();assert.equal(last.read.inFlight,0);assert.equal(last.write.inFlight,0);assert.equal(last.write.completed,2);
 const closing=pooled.close();assert.equal(pooled.close(),closing);await closing;assert.equal(pooled.readHealthy,false);
});
test('a blocked writer does not occupy read connections and recovers after lock release',async t=>{
 const {DatabaseSync}=await import('node:sqlite');const f=await setup(t);
 const row=await f.store.create('links',data(),'locked');const db=new DatabaseSync(f.file);
 try{
  db.exec('BEGIN IMMEDIATE');
  const pending=f.store.update('links','locked',data('https://example.com/after'),row.version);
  assert.equal(f.store.stats().write.inFlight,1);
  assert.equal((await f.store.get('links','locked')).url,'https://example.com/one');
  assert.equal(f.store.stats().write.inFlight,1);
  db.exec('ROLLBACK');await pending;
  assert.equal((await f.store.get('links','locked')).url,'https://example.com/after');
 }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}
});
test('public reader pools have no writer and readiness uses read health independently',async t=>{
 const f=await setup(t);const read=f.keep(await openLinkStore({file:f.file,project:f.root,readOnly:true,readers:1}));
 assert.equal(read.stats().write.connections,0);assert.equal(read.readHealthy,true);assert.equal(read.writeHealthy,false);
 await assert.rejects(read.create('links',data(),'forbidden'),{status:403});
 const app=f.keep(await startServer({project:f.root,port:0,linkStores:{links:{readHealthy:true,healthy:false,get:async()=>({url:'https://example.com/'})}},log:()=>{}}));
 assert.equal((await request(app,'/_urlcode/ready')).status,200);assert.equal((await request(app,'/r/any')).status,302);
});
test('invalid pool sizing and unpatched SQLite versions are rejected',async t=>{
 const f=await setup(t);for(const options of [{readers:0},{readers:9},{maxReads:33},{maxWrites:0}])await assert.rejects(openLinkStore({file:f.file,project:f.root,...options}),/must be/);
 const {supportsConcurrentWal}=await import('../src/sqlite-version.js');
 for(const version of ['3.51.2','3.50.6','3.44.5','3.45.9','bad'])assert.equal(supportsConcurrentWal(version),false);
 for(const version of ['3.51.3','3.50.7','3.44.6','3.53.4'])assert.equal(supportsConcurrentWal(version),true);
});
