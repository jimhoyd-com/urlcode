import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openLinkStore} from '../src/link-store.ts';
import {startLinkApi,loadLinkToken} from '../src/link-api.ts';
import {startServer} from '../src/server.ts';
import {createRuntime} from '../src/runtime.ts';
import {auditProject} from '../src/readiness.ts';
import {project,param,redirect,request,liveLinksSkip} from './helpers.ts';
import type {ProjectRoutes,Response} from './helpers.ts';
import type {TestContext} from 'node:test';
import type {ExportHeader,LinkRow} from '../src/link-store.ts';
import type {LinkEvent} from '../src/link-events.ts';
import type {RouteConfig} from '../src/types.ts';
/** The HTTP status a store or API error carries, read without assuming the error's shape. */
const errorStatus=(error: unknown): unknown=>typeof error==='object'&&error!==null&&'status' in error?error.status:undefined;
const route=(): RouteConfig=>({parameters:[param('code')],link:{collection:'links',code:{from:'path',name:'code'}}});
const data=(url='https://example.com/one')=>({url});
async function setup(t: TestContext,routes: ProjectRoutes={'/r/{code}':route(),'/plain':redirect()}) {
 const root=await project(t,routes,{}, {dynamicLinks:true}),directory=await mkdtemp(join(tmpdir(),'urlcode-links-')),file=join(directory,'links.sqlite');
 const close: {close(): Promise<unknown>}[]=[];t.after(async()=>{for(const value of close.reverse())await value.close();await rm(directory,{recursive:true,force:true});});
 const store=await openLinkStore({file,project:root});close.push(store);
 return {root,file,directory,store,keep:<T extends {close(): Promise<unknown>}>(value: T): T=>{close.push(value);return value;}};
}
test('new links, updates, deletion and negative-cache misses become visible without reload',{skip:liveLinksSkip},async t=>{
 const f=await setup(t);const app=f.keep(await startServer({project:f.root,port:0,linkStore:{collection:'links',file:f.file},log:()=>{}}));
 const config=await readFile(join(f.root,'urlcode.yaml'),'utf8');const before: unknown=JSON.parse((await request(app,'/_urlcode/health')).body);
 assert.equal((await request(app,'/r/new')).status,404);
 const first=await f.store.create('links',data(),'new');
 assert.equal((await request(app,'/r/new')).headers.location,'https://example.com/one');
 const updated=await f.store.update('links','new',{url:'https://example.com/two',status:307},first.version);
 const result=await request(app,'/r/new');assert.equal(result.status,307);assert.equal(result.headers.location,'https://example.com/two');assert.equal(result.headers['cache-control'],'no-store');
 assert.equal((await request(app,'/r/new',{method:'HEAD'})).body,'');assert.equal((await request(app,'/r/new',{method:'POST'})).status,405);
 await f.store.delete('links','new',updated.version);assert.equal((await request(app,'/r/new')).status,404);
 assert.equal(await readFile(join(f.root,'urlcode.yaml'),'utf8'),config);assert.deepEqual(JSON.parse((await request(app,'/_urlcode/health')).body),before);
});
test('records survive connection restart; independent readers see committed writes',{skip:liveLinksSkip},async t=>{
 const f=await setup(t);const row=await f.store.create('links',data(),'persistent');await f.store.close();
 const reader=f.keep(await openLinkStore({file:f.file,project:f.root,readOnly:true}));assert.equal((await reader.get('links','persistent'))?.version,row.version);
 await assert.rejects(reader.create('links',data(),'blocked'),{status:403});
});
test('concurrent writers enforce unique codes, optimistic versions and delete/recreate safety',{skip:liveLinksSkip},async t=>{
 const f=await setup(t);const other=f.keep(await openLinkStore({file:f.file,project:f.root}));
 const writers=[f.store,other];
 const created=await Promise.allSettled(writers.map(store=>store.create('links',data(),'same')));
 assert.equal(created.filter(r=>r.status==='fulfilled').length,1);
 const losingCreate=created.findIndex(r=>r.status==='rejected'),rejected=created[losingCreate];
 assert.ok(rejected&&rejected.status==='rejected');
 // BEGIN IMMEDIATE has a bounded lock wait: on a loaded host the loser
 // may receive 503 before it can inspect the winner's committed record.
 assert.ok([409,503].includes(Number(errorStatus(rejected.reason))));
 const first=await f.store.get('links','same');assert.ok(first);
 assert.deepEqual(created.find(r=>r.status==='fulfilled')?.value,first);
 await assert.rejects(writers[losingCreate]!.create('links',data(),'same'),{status:409});
 assert.deepEqual(await f.store.list('links'),[first]);
 const updates=[data('https://example.com/a'),data('https://example.com/b')];
 const changes=await Promise.allSettled(writers.map((store,index)=>store.update('links','same',updates[index]!,first.version)));
 assert.equal(changes.filter(r=>r.status==='fulfilled').length,1);
 const losingUpdate=changes.findIndex(r=>r.status==='rejected'),conflict=changes[losingUpdate];
 assert.ok(conflict&&conflict.status==='rejected');
 assert.ok([409,503].includes(Number(errorStatus(conflict.reason))));
 const current=await other.get('links','same');assert.ok(current);
 assert.deepEqual(changes.find(r=>r.status==='fulfilled')?.value,current);
 assert.equal(current.version,first.version+1);
 await assert.rejects(writers[losingUpdate]!.update('links','same',updates[losingUpdate]!,first.version),{status:409});
 assert.deepEqual(await f.store.get('links','same'),current);
 await other.delete('links','same',current.version);
 const replacement=await f.store.create('links',data(),'same');assert.ok(replacement.version>current.version);
 await assert.rejects(other.delete('links','same',current.version),{status:409});
});
test('writer lock exhaustion returns 503 without mutation and recovers after release',{skip:liveLinksSkip},async t=>{
 const {DatabaseSync}=await import('node:sqlite');const f=await setup(t);
 const first=await f.store.create('links',data(),'same');
 const db=new DatabaseSync(f.file);
 try{
  db.exec('BEGIN IMMEDIATE');
  try{
   // Hold the write lock until the worker answers: exercise the bounded
   // contention path deterministically without relying on scheduler timing.
   await assert.rejects(f.store.create('links',data('https://example.com/blocked'),'same'),{status:503});
  }finally{db.exec('ROLLBACK');}
  await assert.rejects(f.store.create('links',data('https://example.com/blocked'),'same'),{status:409});
  assert.deepEqual(await f.store.get('links','same'),first);
  assert.equal(db.prepare('SELECT revision FROM urlcode_link_meta').get()?.revision,first.version);
  assert.equal(db.prepare('SELECT count(*) AS count FROM urlcode_link_audit').get()?.count,1);
  const updated=await f.store.update('links','same',data('https://example.com/recovered'),first.version);
  assert.equal(updated.version,first.version+1);
 }finally{db.close();}
});
test('expiry, disabled state, collection scope, exact precedence and middleware are preserved',{skip:liveLinksSkip},async t=>{
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
test('store input validation rejects unsafe destinations and ambiguous mutations',{skip:liveLinksSkip},async t=>{
 const f=await setup(t);
 for(const record of [{url:'javascript:alert(1)'},{url:'https://user:password@example.com'},{url:'https://example.com/\r\nx:y'},{url:'https://example.com',extra:1},{url:'https://example.com',status:200},{url:'https://example.com',expires:'2025-02-30T00:00:00Z'}])await assert.rejects(f.store.create('links',record,'bad'),{status:400});
 for(const code of ['',null,'a/b','x'.repeat(129)])await assert.rejects(f.store.create('links',data(),code),{status:400});
 const row=await f.store.create('links',data());assert.match(row.code,/^[A-Za-z0-9_-]{16}$/);
 await assert.rejects(f.store.update('links',row.code,data(),undefined),{status:400});await assert.rejects(f.store.list('links',{limit:101}),{status:400});
});
test('bounded store admission fails fast and store failure does not stop native redirects',{skip:liveLinksSkip},async t=>{
 const f=await setup(t);const results=await Promise.allSettled(Array.from({length:64},()=>f.store.get('links','missing')));
 assert.ok(results.some(r=>r.status==='rejected'&&errorStatus(r.reason)===503));
 const app=f.keep(await startServer({project:f.root,port:0,linkStores:{links:f.store},log:()=>{}}));
 await f.store.close();assert.equal((await request(app,'/r/missing')).status,503);assert.equal((await request(app,'/plain')).status,302);assert.equal((await request(app,'/_urlcode/ready')).status,503);
});
test('missing bindings, invalid methods and in-project stores fail activation',{skip:liveLinksSkip},async t=>{
 const f=await setup(t);await assert.rejects(createRuntime(f.root),/Missing operator link store/);
 await assert.rejects(openLinkStore({file:join(f.root,'links.sqlite'),project:f.root}),/outside/);
 const root=await project(t,{'/r/{code}':{...route(),methods:['POST']}},{},{dynamicLinks:true});await assert.rejects(createRuntime(root),/GET and HEAD/);
});
test('management API requires a token and conditional writes; public server has no management endpoint',{skip:liveLinksSkip},async t=>{
 const f=await setup(t),token='a'.repeat(43),api=f.keep(await startLinkApi({store:f.store,collection:'links',token,port:0}));
 const call=(path: string,method='GET',record?: unknown,extra: Record<string,string|undefined>={})=>request(api,path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json',...extra},body:record===undefined?undefined:JSON.stringify(record)});
 assert.equal((await request(api,'/v1/links')).status,401);
 assert.equal((await call('/v1/links','POST',data(),{origin:'https://evil.example'})).status,403);
 const created=await call('/v1/links','POST',{code:'api',url:'https://example.com/api'});assert.equal(created.status,201);const row=JSON.parse(created.body) as LinkRow; // the API answers with the stored row
 assert.equal((await call('/v1/links','POST',{code:'api',url:'https://example.com/'})).status,409);
 assert.equal((await call('/v1/links/api')).headers.etag,`"${row.version}"`);
 assert.equal((await call('/v1/links/api','PUT',data())).status,428);
 assert.equal((await call('/v1/links/api','PUT',data(),{'if-match':'"9999"'})).status,409);
 const updated=await call('/v1/links/api','PUT',data(),{'if-match':created.headers.etag});assert.equal(updated.status,200);
 assert.equal((JSON.parse((await call('/v1/links?limit=1')).body) as {items: unknown[]}).items.length,1);
 assert.equal((await call('/v1/links/api','DELETE',undefined,{'if-match':updated.headers.etag})).status,204);
 assert.equal((await call('/v1/links/api')).status,404);
 const app=f.keep(await startServer({project:f.root,port:0,linkStore:{collection:'links',file:f.file},log:()=>{}}));assert.equal((await request(app,'/v1/links')).status,404);
});
test('management JSON/body limits and token file boundaries are enforced',{skip:liveLinksSkip},async t=>{
 const f=await setup(t),token='b'.repeat(43),api=f.keep(await startLinkApi({store:f.store,collection:'links',token,port:0}));
 const tokenFile=join(f.directory,'token');await writeFile(tokenFile,token,{mode:0o600});assert.equal(await loadLinkToken(tokenFile,f.root),token);
 await assert.rejects(loadLinkToken(join(f.root,'token'),f.root),/outside/);
 const headers={authorization:'Bearer '+token,'content-type':'application/json'};
 assert.equal((await request(api,'/v1/links',{method:'POST',headers,body:'{'})).status,400);
 const large=await request(api,'/v1/links',{method:'POST',headers,body:JSON.stringify({url:'https://example.com/'+'a'.repeat(17000)})});assert.equal(large.status,413);
});
test('CLI creates persistent links visible to an already running server',{skip:liveLinksSkip},async t=>{
 const f=await setup(t);const app=f.keep(await startServer({project:f.root,port:0,linkStore:{collection:'links',file:f.file},log:()=>{}}));
 const cli=fileURLToPath(new URL('../src/cli.ts',import.meta.url));
 const created=spawnSync(process.execPath,[cli,'links','create','--store',f.file,'--project',f.root,'--code','cli','--destination','https://example.com/cli'],{encoding:'utf8',timeout:10000});
 assert.equal(created.status,0,created.stderr);assert.equal((JSON.parse(created.stdout) as {code?: unknown}).code,'cli');assert.equal((await request(app,'/r/cli')).headers.location,'https://example.com/cli');
});
test('acknowledged writes survive abrupt writer exit and pagination retains records',{skip:liveLinksSkip},async t=>{
 const f=await setup(t);const module=new URL('../src/link-store.ts',import.meta.url).href;
 const script=`import {openLinkStore} from ${JSON.stringify(module)};const store=await openLinkStore({file:${JSON.stringify(f.file)},project:${JSON.stringify(f.root)}});await store.create('links',{url:'https://example.com/crash'},'crash');process.exit(0);`;
 const writer=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000});assert.equal(writer.status,0,writer.stderr);
 assert.equal((await f.store.get('links','crash'))?.url,'https://example.com/crash');
 await f.store.create('links',data(),'next');const page=await f.store.list('links',{limit:1});assert.equal(page[0]?.code,'crash');assert.equal((await f.store.list('links',{limit:1,after:'crash'}))[0]?.code,'next');
});
test('record edits leave function approval digests unchanged and safe adapter validation fails closed',{skip:liveLinksSkip},async t=>{
 const f=await setup(t);const {loadDocument}=await import('../src/config.ts');const {prepareFunctionSnapshot}=await import('../src/policy.ts');
 const before=(await prepareFunctionSnapshot(await loadDocument(f.root))).projectSha256;
 await f.store.create('links',data(),'approved');const after=(await prepareFunctionSnapshot(await loadDocument(f.root))).projectSha256;assert.equal(before,after);
 const app=f.keep(await startServer({project:f.root,port:0,linkStores:{links:{get:async()=>({url:'javascript:alert(1)'})}},log:()=>{}}));
 assert.equal((await request(app,'/r/unsafe')).status,503);
});
test('shutdown drains a full store queue, rejects new work and is idempotent',{skip:liveLinksSkip},async t=>{
 const f=await setup(t);
 const writes=Array.from({length:32},(_,i)=>f.store.create('links',data(),`drain-${i}`));
 const closing=f.store.close();assert.equal(f.store.close(),closing);
 await assert.rejects(f.store.get('links','drain-0'),{status:503});
 await Promise.all(writes);await closing;
 const reader=f.keep(await openLinkStore({file:f.file,project:f.root,readOnly:true}));
 assert.equal((await reader.list('links')).length,32);
});
test('uncloneable store arguments do not consume admission or kill the worker',{skip:liveLinksSkip},async t=>{
 const f=await setup(t);
 for(let i=0;i<40;i++)await assert.rejects(f.store.create('links',{url:()=>{}},'bad'),{status:400});
 assert.equal((await f.store.create('links',data(),'valid')).code,'valid');assert.equal(f.store.healthy,true);
});
test('management method errors advertise endpoint-specific allowed methods',{skip:liveLinksSkip},async t=>{
 const f=await setup(t),token='c'.repeat(43),api=f.keep(await startLinkApi({store:f.store,collection:'links',token,port:0}));
 for(const [path,method,allow] of [['/v1/links','PUT','GET, POST'],['/v1/links/item','POST','GET, PUT, DELETE'],['/v1/links','OPTIONS','GET, POST']] as const){
  const result=await request(api,path,{method,headers:{authorization:'Bearer '+token}});
  assert.equal(result.status,405);assert.equal(result.headers.allow,allow);
 }
});
test('stores with missing revision metadata fail activation',{skip:liveLinksSkip},async t=>{
 const f=await setup(t);await f.store.close();
 const script=`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify(f.file)});db.exec('DELETE FROM urlcode_link_meta');db.close();`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr);
 await assert.rejects(openLinkStore({file:f.file,project:f.root}),/initialization failed/);
});
test('live links require entry-level opt-in, including routes from included files',{skip:liveLinksSkip},async t=>{
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
test('read and write pools have independent bounded admission and drain on close',{skip:liveLinksSkip},async t=>{
 const f=await setup(t);const pooled=f.keep(await openLinkStore({file:f.file,project:f.root,readers:3,maxReads:2,maxWrites:1}));
 const row=await pooled.create('links',data(),'pool');
 const reads=[pooled.get('links','pool'),pooled.get('links','pool')];
 await assert.rejects(pooled.get('links','pool'),{status:503});
 const write=pooled.update('links','pool',data('https://example.com/new'),row.version);
 await assert.rejects(pooled.create('links',data(),'excess'),{status:503});
 const first=pooled.stats();assert.equal(first.read.connections,3);assert.equal(first.write.connections,1);assert.equal(first.read.rejected,1);assert.equal(first.write.rejected,1);
 await Promise.all([...reads,write]);assert.equal((await pooled.get('links','pool'))?.url,'https://example.com/new');
 const last=pooled.stats();assert.equal(last.read.inFlight,0);assert.equal(last.write.inFlight,0);assert.equal(last.write.completed,2);
 const closing=pooled.close();assert.equal(pooled.close(),closing);await closing;assert.equal(pooled.readHealthy,false);
});
test('a blocked writer does not occupy read connections and recovers after lock release',{skip:liveLinksSkip},async t=>{
 const {DatabaseSync}=await import('node:sqlite');const f=await setup(t);
 const row=await f.store.create('links',data(),'locked');const db=new DatabaseSync(f.file);
 try{
  db.exec('BEGIN IMMEDIATE');
  const pending=f.store.update('links','locked',data('https://example.com/after'),row.version);
  assert.equal(f.store.stats().write.inFlight,1);
  assert.equal((await f.store.get('links','locked'))?.url,'https://example.com/one');
  assert.equal(f.store.stats().write.inFlight,1);
  db.exec('ROLLBACK');await pending;
  assert.equal((await f.store.get('links','locked'))?.url,'https://example.com/after');
 }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}
});
test('public reader pools have no writer and readiness uses read health independently',{skip:liveLinksSkip},async t=>{
 const f=await setup(t);const read=f.keep(await openLinkStore({file:f.file,project:f.root,readOnly:true,readers:1}));
 assert.equal(read.stats().write.connections,0);assert.equal(read.readHealthy,true);assert.equal(read.writeHealthy,false);
 await assert.rejects(read.create('links',data(),'forbidden'),{status:403});
 const app=f.keep(await startServer({project:f.root,port:0,linkStores:{links:{readHealthy:true,healthy:false,get:async()=>({url:'https://example.com/'})}},log:()=>{}}));
 assert.equal((await request(app,'/_urlcode/ready')).status,200);assert.equal((await request(app,'/r/any')).status,302);
});
test('invalid pool sizing and unpatched SQLite versions are rejected',{skip:liveLinksSkip},async t=>{
 const f=await setup(t);for(const options of [{readers:0},{readers:9},{maxReads:33},{maxWrites:0}])await assert.rejects(openLinkStore({file:f.file,project:f.root,...options}),/must be/);
 const {supportsConcurrentWal}=await import('../src/sqlite-version.ts');
 for(const version of ['3.51.2','3.50.6','3.44.5','3.45.9','bad'])assert.equal(supportsConcurrentWal(version),false);
 for(const version of ['3.51.3','3.50.7','3.44.6','3.53.4'])assert.equal(supportsConcurrentWal(version),true);
});
test('management admission, idle timeout, canonical paths and redacted audit events',{skip:liveLinksSkip},async t=>{
 const http=await import('node:http');const f=await setup(t),token='d'.repeat(43),events: object[]=[];
 const api=f.keep(await startLinkApi({store:f.store,collection:'links',token,port:0,maxInFlightRequests:1,socketTimeoutMs:1000,log:event=>events.push(event)}));
 const upload=http.request({host:'127.0.0.1',port:api.address.port,path:'/v1/links',method:'POST',agent:false,headers:{authorization:'Bearer '+token,'content-type':'application/json','transfer-encoding':'chunked'}});
 upload.on('error',()=>{});t.after(()=>upload.destroy());
 const connected=new Promise(resolve=>upload.once('socket',socket=>socket.once('connect',resolve)));upload.write('{');await connected;
 // Same connection has already sent its headers; poll until admission is observable.
 let overloaded: Response|undefined;for(let i=0;i<10;i++){overloaded=await request(api,'/v1/links',{headers:{authorization:'Bearer '+token}});if(overloaded.status===503)break;}
 assert.equal(overloaded?.status,503);
 await new Promise<void>(resolve=>{if(upload.destroyed)resolve();else upload.once('close',resolve);});
 const headers={authorization:'Bearer '+token,'content-type':'application/json'};
 assert.equal((await request(api,'/v1/a/../links',{headers})).status,400);
 const created=await request(api,'/v1/links',{method:'POST',headers,body:JSON.stringify({code:'SECRET_CODE',url:'https://example.com/SECRET_DEST'})});assert.equal(created.status,201);
 assert.ok(events.some(e=>'action' in e&&e.action==='create'&&'status' in e&&e.status===201&&'authenticated' in e&&e.authenticated&&'requestId' in e&&e.requestId===created.headers['x-request-id']));
 assert.ok(events.some(e=>'outcome' in e&&e.outcome==='aborted'));
 const logs=JSON.stringify(events);for(const secret of [token,'SECRET_CODE','SECRET_DEST'])assert.ok(!logs.includes(secret));
 const closing=api.close();assert.equal(api.close(),closing);await closing;
});

test('scoped credentials enforce permissions, expiry, hot revocation and fail closed',{skip:liveLinksSkip},async t=>{
 const {managementPolicy}=await import('../src/management-policy.ts');
 const {createHash}=await import('node:crypto');
 const f=await setup(t),file=join(f.directory,'management.json'),token='r'.repeat(43);
 const credential: {id: string; sha256: string; expires: string; collections: string[]; actions: string[]; revoked?: boolean}={id:'alice',sha256:createHash('sha256').update(token).digest('hex'),expires:'2099-01-01T00:00:00Z',collections:['links'],actions:['get','list']};
 const save=()=>writeFile(file,JSON.stringify({version:1,credentials:[credential]}),{mode:0o600});await save();
 const authorize=await managementPolicy(file,f.root);
 const app=f.keep(await startLinkApi({store:f.store,collection:'links',authorize,port:0,log:()=>{}}));
 const options={headers:{authorization:'Bearer '+token}};
 assert.equal((await request(app,'/v1/links',options)).status,200);
 assert.equal((await request(app,'/v1/links',{...options,method:'POST'})).status,403);
 credential.actions.push('create');await save();
 const created=await request(app,'/v1/links',{method:'POST',headers:{...options.headers,'content-type':'application/json'},body:JSON.stringify({code:'scoped',url:'https://example.com/'})});assert.equal(created.status,201);
 const {DatabaseSync}=await import('node:sqlite');const auditDb=new DatabaseSync(f.file,{readOnly:true});
 try{assert.equal(auditDb.prepare('SELECT actor FROM urlcode_link_audit').get()?.actor,'alice');}finally{auditDb.close();}
 credential.collections=['other'];await save();assert.equal((await request(app,'/v1/links',options)).status,403);
 credential.collections=['links'];credential.revoked=true;await save();assert.equal((await request(app,'/v1/links',options)).status,401);
 credential.revoked=false;credential.expires='2000-01-01T00:00:00Z';await save();assert.equal((await request(app,'/v1/links',options)).status,401);
 await writeFile(file,'broken');assert.equal((await request(app,'/v1/links',options)).status,503);
 await assert.rejects(startLinkApi({store:f.store,collection:'links',token,host:'0.0.0.0',port:0}),/loopback/);
});
test('mutation audit is durable, redacted, attributable and atomic on audit failure',{skip:liveLinksSkip},async t=>{
 const {DatabaseSync}=await import('node:sqlite');const f=await setup(t);
 const row=await f.store.create('links',data('https://example.com/private'),'secret-code',{actor:'alice',requestId:'test-request'});
 const db=new DatabaseSync(f.file);t.after(()=>{try{db.close();}catch{/* already closed */}});
 const audit=db.prepare('SELECT * FROM urlcode_link_audit').all();assert.equal(audit.length,1);assert.equal(audit[0]?.actor,'alice');assert.equal(audit[0]?.revision,row.version);
 assert.ok(!JSON.stringify(audit).includes('secret-code'));assert.ok(!JSON.stringify(audit).includes('https://'));
 db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON urlcode_link_audit BEGIN SELECT RAISE(ABORT,'audit full'); END;");
 await assert.rejects(f.store.update('links','secret-code',data('https://example.com/changed'),row.version),{status:503});
 assert.equal((await f.store.get('links','secret-code'))?.url,'https://example.com/private');
 assert.equal(db.prepare('SELECT revision FROM urlcode_link_meta').get()?.revision,row.version);
 db.exec('DROP TRIGGER fail_audit');db.close();
 await f.store.close();const reader=f.keep(await openLinkStore({file:f.file,project:f.root,readOnly:true}));assert.equal((await reader.get('links','secret-code'))?.version,row.version);
});
test('export is a point-in-time snapshot across collections and states, bounded and single-flight',{skip:liveLinksSkip},async t=>{
 const f=await setup(t);
 await f.store.create('links',data('https://example.com/a'),'a');
 const b=await f.store.create('links',{url:'https://example.com/b',enabled:false},'b');
 await f.store.create('links',{url:'https://example.com/c',expires:'2020-01-01T00:00:00Z'},'c');
 await f.store.create('other',data('https://example.com/d'),'d');
 let header: ExportHeader|undefined,concurrent=false;const exported: LinkRow[]=[];
 // Mutations committed after the snapshot is pinned must not reach this export.
 const summary=await f.store.exportSnapshot({pageSize:1},{onHeader:value=>{header=value;},onRecords:async records=>{
   exported.push(...records);
   if(concurrent)return;
   concurrent=true;
   await f.store.create('links',data('https://example.com/late'),'late');
   await f.store.delete('links','b',b.version);
 }});
 assert.ok(header,'no export header was delivered');assert.equal(header.format,'urlcode.links.v1');assert.equal(header.schemaVersion,1);assert.equal(header.applicationId,1431456835);
 assert.equal(header.collection,null);assert.equal(header.records,4);assert.ok(header.revision>0);assert.ok(Date.parse(header.generatedAt));
 assert.equal(summary.exported,4);
 assert.deepEqual(exported.map(record=>`${record.collection}/${record.code}`),['links/a','links/b','links/c','other/d']);
 assert.equal(exported.find(record=>record.code==='b')?.enabled,false);
 assert.equal(exported.find(record=>record.code==='c')?.expires,'2020-01-01T00:00:00Z');
 assert.ok(exported.every(record=>Number.isSafeInteger(record.version)&&record.version>0));
 // The committed mutations are visible to a later export, and one collection scopes.
 const scoped: LinkRow[]=[];await f.store.exportSnapshot({collection:'other'},{onRecords:records=>scoped.push(...records)});
 assert.deepEqual(scoped.map(record=>record.code),['d']);
 const after: LinkRow[]=[];await f.store.exportSnapshot({},{onRecords:records=>after.push(...records)});
 assert.deepEqual(after.map(record=>record.code),['a','c','late','d']);
 for(const options of [{pageSize:0},{pageSize:101},{deadlineMs:1}])await assert.rejects(f.store.exportSnapshot(options,{}),/must be/);
 // Many records over many pages keep a single ordered pass with no gap or repeat.
 for(let i=0;i<250;i++)await f.store.create(i%2?'bulk':'links',data(`https://example.com/${i}`),`bulk-${String(i).padStart(4,'0')}`);
 const bulk: LinkRow[]=[];const large=await f.store.exportSnapshot({pageSize:100},{onRecords:records=>bulk.push(...records)});
 assert.equal(large.exported,254);assert.equal(bulk.length,254);
 assert.equal(new Set(bulk.map(record=>`${record.collection}/${record.code}`)).size,254);
 assert.deepEqual(bulk.map(record=>`${record.collection}/${record.code}`),[...bulk.map(record=>`${record.collection}/${record.code}`)].sort());
});
test('a running export excludes a second export and releases its reader when interrupted',{skip:liveLinksSkip},async t=>{
 const f=await setup(t);for(const code of ['one','two'])await f.store.create('links',data(),code);
 let blocked: unknown;
 const running=f.store.exportSnapshot({pageSize:1},{onRecords:async()=>{
   blocked??=await f.store.exportSnapshot({},{}).then(()=>null,error=>error);
 }});
 await running;assert.equal(errorStatus(blocked),409);assert.equal(f.store.stats().exporting,false);
 // A consumer that fails must end the read transaction and leave the pool usable.
 await assert.rejects(f.store.exportSnapshot({pageSize:1},{onRecords:()=>{throw new Error('sink failed');}}),/sink failed/);
 assert.equal(f.store.stats().exporting,false);assert.equal(f.store.readHealthy,true);
 assert.equal((await f.store.get('links','one'))?.code,'one');
 const recovered: LinkRow[]=[];await f.store.exportSnapshot({},{onRecords:records=>recovered.push(...records)});
 assert.equal(recovered.length,2);
 // Writers keep working while and after an export holds a reader.
 assert.ok((await f.store.create('links',data(),'three')).version>0);
 await f.store.close();await assert.rejects(f.store.exportSnapshot({},{}),{status:503});
});
test('CLI export and import round-trip a store and refuse tampered, truncated or occupied targets',{skip:liveLinksSkip},async t=>{
 const f=await setup(t);const cli=fileURLToPath(new URL('../src/cli.ts',import.meta.url));
 const first=await f.store.create('links',{url:'https://example.com/keep',status:307,expires:'2030-01-01T00:00:00Z'},'keep');
 await f.store.create('links',{url:'https://example.com/off',enabled:false},'off');
 await f.store.create('archive',data('https://example.com/arch'),'arch');
 const run=(...args: string[])=>spawnSync(process.execPath,[cli,'links',...args,'--project',f.root],{encoding:'utf8',timeout:20000});
 const exported=run('export','--store',f.file,'--page-size','1');
 assert.equal(exported.status,0,exported.stderr);
 // The export stream: a begin line, one line per record and a completion line; read back as the CLI documents it.
 interface ExportLine { event?: string; records?: number; exported?: number; sha256?: string; record?: LinkRow }
 interface ImportReport { imported: number; collections: Record<string,number>; versionsReassigned: boolean; source: { sha256: string } }
 const lines=exported.stdout.trim().split('\n').map(line=>JSON.parse(line) as ExportLine);
 assert.equal(lines[0]?.event,'link-export-begin');assert.equal(lines[0]?.records,3);
 assert.deepEqual(lines.slice(1,-1).map(line=>line.record?.code),['arch','keep','off']);
 assert.equal(lines.at(-1)?.event,'link-export-complete');assert.equal(lines.at(-1)?.exported,3);
 assert.match(lines.at(-1)?.sha256 ?? '',/^[0-9a-f]{64}$/);
 const file=join(f.directory,'export.ndjson');await writeFile(file,exported.stdout);
 const target=join(f.directory,'restored.sqlite');
 const imported=run('import','--store',target,'--input',file);
 assert.equal(imported.status,0,imported.stderr);
 const report=JSON.parse(imported.stdout) as ImportReport;
 assert.equal(report.imported,3);assert.deepEqual(report.collections,{archive:1,links:2});
 assert.equal(report.versionsReassigned,true);assert.equal(report.source.sha256,lines.at(-1)?.sha256);
 const restored=f.keep(await openLinkStore({file:target,project:f.root,readOnly:true}));
 const record=await restored.get('links','keep');assert.ok(record,'the restored store has no keep link');
 assert.equal(record.url,'https://example.com/keep');assert.equal(record.status,307);assert.equal(record.expires,'2030-01-01T00:00:00Z');
 assert.equal((await restored.get('links','off'))?.enabled,false);assert.equal((await restored.get('archive','arch'))?.code,'arch');
 // Restoring rewrites versions, so management ETags from the exported store are stale.
 assert.notEqual(record.version,first.version);
 assert.equal(run('import','--store',target,'--input',file).status,1);
 assert.match(run('import','--store',target,'--input',file).stderr,/already contains records/);
 const tampered=join(f.directory,'tampered.ndjson');
 await writeFile(tampered,lines.map((line,index)=>JSON.stringify(index===1?{record:{...line.record,url:'https://evil.example/'}}:line)).join('\n')+'\n');
 assert.match(run('import','--store',join(f.directory,'tampered.sqlite'),'--input',tampered).stderr,/digest does not match/);
 const truncated=join(f.directory,'truncated.ndjson');
 await writeFile(truncated,lines.slice(0,-1).map(line=>JSON.stringify(line)).join('\n')+'\n');
 assert.match(run('import','--store',join(f.directory,'truncated.sqlite'),'--input',truncated).stderr,/truncated/);
 assert.match(run('import','--store',join(f.directory,'relative.sqlite'),'--input','export.ndjson').stderr,/absolute export file path/);
});
test('opt-in link events report method, outcome and completion without disclosing codes by default',{skip:liveLinksSkip},async t=>{
 const f=await setup(t);
 await f.store.create('links',data('https://example.com/live'),'live');
 await f.store.create('links',{url:'https://example.com/',enabled:false},'off');
 await f.store.create('links',{url:'https://example.com/',expires:'2020-01-01T00:00:00Z'},'old');
 const seen: LinkEvent[]=[],settled: (()=>void)[]=[];
 const observe=(event: LinkEvent)=>{seen.push(event);settled.shift()?.();};
 const drain=(count: number)=>Promise.all(Array.from({length:count},()=>new Promise<void>(resolve=>settled.push(resolve))));
 const app=f.keep(await startServer({project:f.root,port:0,linkStore:{collection:'links',file:f.file},log:()=>{},
   linkEvents:{observe}}));
 const wait=drain(5);
 assert.equal((await request(app,'/r/live')).status,302);
 assert.equal((await request(app,'/r/live',{method:'HEAD'})).status,302);
 assert.equal((await request(app,'/r/off')).status,404);
 assert.equal((await request(app,'/r/old')).status,410);
 assert.equal((await request(app,'/r/missing')).status,404);
 assert.equal((await request(app,'/plain')).status,302);
 await wait;
 assert.deepEqual(seen.map(event=>[event.method,event.outcome,event.status]),
   [['GET','completed',302],['HEAD','completed',302],['GET','disabled',404],['GET','expired',410],['GET','missing',404]]);
 // A plain YAML redirect is not a stored link and is never reported.
 assert.equal(seen.length,5);
 for(const event of seen){
  assert.equal(event.event,'link_request');assert.equal(event.collection,'links');assert.equal(event.route,'/r/{code}');
  assert.ok(!Object.hasOwn(event,'code'),'codes are not disclosed by default');
  assert.ok(typeof event.requestId==='string' && typeof event.durationMs==='number' && event.durationMs>=0);
 }
 assert.deepEqual(app.linkEventStats()?.dropped,0);
});
test('link observers are opt-in, bounded and cannot delay, break or outlive a redirect',{skip:liveLinksSkip},async t=>{
 const f=await setup(t);await f.store.create('links',data('https://example.com/live'),'live');
 const {createLinkObserver}=await import('../src/link-events.ts');
 for(const options of [{},{observe:'no'},{observe:()=>{},includeCode:'yes'},{observe:()=>{},maxQueue:0},{observe:()=>{},timeoutMs:0},{observe:()=>{},unknown:1}])
  assert.throws(()=>createLinkObserver(options),/Link event|Unsupported link event|observe/);
 assert.equal(createLinkObserver(undefined),undefined);
 // A collector that fails or hangs is counted, never surfaced to the client.
 const logged: Record<string,unknown>[]=[];
 const observer=createLinkObserver({observe:()=>{throw new Error('collector down');},maxQueue:2,timeoutMs:20},event=>logged.push(event));
 assert.ok(observer,'a valid observer configuration was refused');
 for(let i=0;i<6;i++)observer.emit({outcome:'completed'});
 observer.emit({outcome:'not-an-outcome'});
 const failing=await observer.close();
 // Seven emits, a two-event queue: every one is either delivered to the failing
 // collector or counted as dropped, and none is silently lost.
 assert.equal(failing.delivered,0);assert.equal(failing.failed+failing.dropped,7);
 assert.ok(failing.failed>=1 && failing.dropped>=4);assert.equal(failing.queued,0);
 assert.ok(logged.some(event=>event.event==='link_observer'&&event.status==='dropped'));
 const slow=createLinkObserver({observe:()=>new Promise(()=>{}),timeoutMs:20});assert.ok(slow);
 slow.emit({outcome:'completed'});assert.equal((await slow.close()).timedOut,1);
 // End to end: an opted-in code is disclosed and a failing observer still redirects.
 const codes: unknown[]=[];
 const app=f.keep(await startServer({project:f.root,port:0,linkStore:{collection:'links',file:f.file},log:()=>{},
   linkEvents:{observe:(event: LinkEvent)=>{codes.push(event.code);if(codes.length===1)throw new Error('collector down');},includeCode:true}}));
 assert.equal((await request(app,'/r/live')).headers.location,'https://example.com/live');
 assert.equal((await request(app,'/r/live')).headers.location,'https://example.com/live');
 while(codes.length<2)await new Promise(resolve=>setTimeout(resolve,10));
 assert.deepEqual(codes,['live','live']);
 await assert.rejects(startServer({project:f.root,port:0,linkStore:{collection:'links',file:f.file},log:()=>{},linkEvents:{}}),/observe/);
});
