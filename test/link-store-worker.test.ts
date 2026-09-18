import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {liveLinksSkip} from './helpers.ts';
import type {TestContext} from 'node:test';
import type {ExportHeader,LinkRow,LinkStoreArgs,LinkStoreCommand,LinkStoreOperation,LinkStoreReply,LinkStoreWorkerData} from '../src/link-store.ts';

// Drives src/link-store-worker.ts over its own protocol, below openConnection:
// what the worker answers, what it refuses, and when it closes its port. The
// gate matches test/links.test.ts: an unpatched SQLite skips rather than fails.
const workerUrl=new URL('../src/link-store-worker.ts',import.meta.url);
interface Connection { call<T=unknown>(operation: LinkStoreOperation,args?: LinkStoreArgs): Promise<T>; failure(operation: LinkStoreOperation,args?: LinkStoreArgs): Promise<{status: number; message: string}>; exited: Promise<number>; worker: Worker }
async function directory(t: TestContext): Promise<string> {
 const dir=await mkdtemp(join(tmpdir(),'urlcode-worker-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;
}
/** Starts a worker and resolves once it reports ready, or rejects with the failure reply. */
function connect(t: TestContext,file: string,readOnly=false): Promise<Connection> {
 const workerData: LinkStoreWorkerData={file,readOnly};
 const worker=new Worker(workerUrl,{workerData,env:{},execArgv:[],stdout:true,stderr:true});
 worker.stdout.resume();worker.stderr.resume();
 t.after(()=>worker.terminate());
 const pending=new Map<number,{resolve: (value: unknown)=>void; reject: (error: Error)=>void}>();
 let sequence=0;
 const exited=new Promise<number>(resolve=>worker.on('exit',resolve));
 return new Promise<Connection>((resolve,reject)=>{
  worker.on('error',reject);
  worker.on('message',(message: LinkStoreReply)=>{
   if('ready' in message){
    const call=<T,>(operation: LinkStoreOperation,args: LinkStoreArgs={}): Promise<T>=>new Promise<T>((ok,fail)=>{
     const id=++sequence;pending.set(id,{resolve:value=>ok(value as T),reject:fail});
     const command: LinkStoreCommand={id,operation,args};worker.postMessage(command);
    });
    const failure=async(operation: LinkStoreOperation,args: LinkStoreArgs={})=>{
     try{await call(operation,args);}catch(error){return error as {status: number; message: string};}
     throw new Error(`${operation} unexpectedly succeeded`);
    };
    resolve({call,failure,exited,worker});return;
   }
   if('failed' in message){reject(new Error('worker failed'));return;}
   const request=pending.get(message.id);if(!request)return;pending.delete(message.id);
   if('error' in message)request.reject(Object.assign(new Error(message.error.message),message.error));else request.resolve(message.value);
  });
 });
}
const data=(url='https://example.com/one',extra: Record<string,unknown>={})=>({url,...extra});

test('a fresh file initializes the schema; records round-trip through create, get, list, update and delete',{skip:liveLinksSkip},async t=>{
 const file=join(await directory(t),'links.sqlite');
 const c=await connect(t,file);
 const created=await c.call<LinkRow>('create',{collection:'links',data:data('https://example.com/a',{status:301,expires:'2030-01-01T00:00:00Z'}),code:'alpha'});
 assert.deepEqual(created,{collection:'links',code:'alpha',url:'https://example.com/a',status:301,enabled:true,expires:'2030-01-01T00:00:00Z',version:1});
 assert.deepEqual(await c.call('get',{collection:'links',code:'alpha'}),created);
 assert.equal(await c.call('get',{collection:'links',code:'missing'}),null);
 const generated=await c.call<LinkRow>('create',{collection:'links',data:data('https://example.com/b',{enabled:false})});
 assert.match(generated.code,/^[A-Za-z0-9_-]+$/);assert.equal(generated.enabled,false);assert.equal(generated.status,302);assert.equal(generated.version,2);
 const updated=await c.call<LinkRow>('update',{collection:'links',code:'alpha',data:data('https://example.com/c'),expectedVersion:1});
 assert.equal(updated.url,'https://example.com/c');assert.equal(updated.version,3);assert.equal(updated.expires,null);
 assert.equal((await c.failure('update',{collection:'links',code:'alpha',data:data(),expectedVersion:1})).status,409);
 assert.equal((await c.failure('create',{collection:'links',data:data(),code:'alpha'})).status,409);
 assert.equal((await c.failure('update',{collection:'links',code:'nope',data:data(),expectedVersion:1})).status,404);
 assert.equal((await c.failure('create',{collection:'links',data:{url:'ftp://x'}})).status,400);
 assert.equal((await c.failure('create',{collection:'bad collection',data:data()})).status,400);
 assert.equal((await c.failure('list',{collection:'links',limit:0})).status,400);
 assert.equal((await c.failure('get',{collection:'links',code:'no spaces'})).status,400);
 assert.equal((await c.failure('create',{collection:'links',data:data(),audit:{actor:'bad actor'}})).status,400);
 const all=await c.call<LinkRow[]>('list',{collection:'links'});
 assert.deepEqual(all.map(r=>r.code),['alpha',generated.code].sort());
 assert.deepEqual((await c.call<LinkRow[]>('list',{collection:'links',limit:1,after:all[0]!.code})).map(r=>r.code),[all[1]!.code]);
 assert.equal(await c.call('delete',{collection:'links',code:'alpha',expectedVersion:3}),true);
 assert.equal(await c.call('get',{collection:'links',code:'alpha'}),null);
 assert.equal((await c.failure('delete',{collection:'links',code:'alpha',expectedVersion:3})).status,404);
 assert.deepEqual(await c.call('list',{collection:'other'}),[]);
 assert.equal((await c.failure('exportPage',{})).status,409);
 assert.equal(await c.call('exportEnd'),false);
 assert.equal(await c.call('close'),true);
 assert.equal(await c.exited,0);
});

test('read-only workers see committed writes, refuse mutations and cannot open an empty file',{skip:liveLinksSkip},async t=>{
 const dir=await directory(t);const file=join(dir,'links.sqlite');
 const writer=await connect(t,file);
 await writer.call('create',{collection:'links',data:data(),code:'shared',audit:{actor:'tester',requestId:'req-1'}});
 const reader=await connect(t,file,true);
 assert.equal((await reader.call<LinkRow>('get',{collection:'links',code:'shared'})).url,'https://example.com/one');
 for(const operation of ['create','update','delete'] as const)assert.equal((await reader.failure(operation,{collection:'links',code:'shared',data:data(),expectedVersion:1})).status,403);
 await writer.call('update',{collection:'links',code:'shared',data:data('https://example.com/two'),expectedVersion:1});
 assert.equal((await reader.call<LinkRow>('get',{collection:'links',code:'shared'})).url,'https://example.com/two');
 const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(file,{readOnly:true});
 try{
  const audit=db.prepare('SELECT actor,request_id,action FROM urlcode_link_audit ORDER BY revision').all().map(r=>[r.actor,r.action,typeof r.request_id]);
  assert.deepEqual(audit,[['tester','create','string'],['local-operator','update','string']]);
  assert.equal(db.prepare('SELECT request_id FROM urlcode_link_audit WHERE revision=1').get()?.request_id,'req-1');
 }
 finally{db.close();}
 // A read-only worker cannot create the schema, so an empty file is a failed open.
 const empty=join(dir,'empty.sqlite');await writeFile(empty,'');
 await assert.rejects(connect(t,empty,true),/worker failed/);
});

test('a file with a foreign schema answers failed, closes its port and exits without serving',{skip:liveLinksSkip},async t=>{
 const file=join(await directory(t),'foreign.sqlite');
 const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(file);db.exec('CREATE TABLE other (id INTEGER)');db.close();
 const workerData: LinkStoreWorkerData={file,readOnly:false};
 const worker=new Worker(workerUrl,{workerData,env:{},execArgv:[],stdout:true,stderr:true});worker.stdout.resume();worker.stderr.resume();
 t.after(()=>worker.terminate());
 const replies: LinkStoreReply[]=[];worker.on('message',(message: LinkStoreReply)=>{replies.push(message);});
 const exitCode=await new Promise<number>(resolve=>worker.on('exit',resolve));
 assert.deepEqual(replies,[{failed:true}]);assert.equal(exitCode,0);
 const again=new DatabaseSync(file,{readOnly:true});
 try{assert.deepEqual(again.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r=>r.name),['other']);}finally{again.close();}
});

test('export is single-flight per connection, pinned to a snapshot, and a failed page ends it',{skip:liveLinksSkip},async t=>{
 const file=join(await directory(t),'links.sqlite');
 const writer=await connect(t,file),reader=await connect(t,file,true);
 for(const code of ['a','b','c'])await writer.call('create',{collection:'links',data:data('https://example.com/'+code),code});
 await writer.call('create',{collection:'zeta',data:data(),code:'z'});
 const header=await reader.call<ExportHeader>('exportBegin',{});
 assert.equal(header.format,'urlcode.links.v1');assert.equal(header.records,4);assert.equal(header.revision,4);assert.equal(header.collection,null);
 assert.equal((await reader.failure('exportBegin',{})).status,409);
 await writer.call('create',{collection:'links',data:data(),code:'d'});
 const first=await reader.call<LinkRow[]>('exportPage',{limit:2});
 assert.deepEqual(first.map(r=>[r.collection,r.code]),[['links','a'],['links','b']]);
 const rest=await reader.call<LinkRow[]>('exportPage',{afterCollection:'links',afterCode:'b',limit:100});
 assert.deepEqual(rest.map(r=>[r.collection,r.code]),[['links','c'],['zeta','z']]);
 assert.equal((await reader.failure('exportPage',{limit:101})).status,400);
 // The bad page ended the export, so the next begin is admitted and sees the new record.
 const scoped=await reader.call<ExportHeader>('exportBegin',{collection:'links'});
 assert.equal(scoped.records,4);assert.equal(scoped.collection,'links');
 assert.deepEqual((await reader.call<LinkRow[]>('exportPage',{limit:100})).map(r=>r.code),['a','b','c','d']);
 assert.equal(await reader.call('exportEnd'),true);assert.equal(await reader.call('exportEnd'),false);
 // A writer with an open export refuses mutations until the export ends.
 await writer.call('exportBegin',{collection:'links'});
 assert.equal((await writer.failure('create',{collection:'links',data:data(),code:'blocked'})).status,409);
 await writer.call('exportEnd');
 assert.equal((await writer.call<LinkRow>('create',{collection:'links',data:data(),code:'blocked'})).code,'blocked');
});

test('close answers once, then the worker exits and later commands are never answered',{skip:liveLinksSkip},async t=>{
 const file=join(await directory(t),'links.sqlite');
 const c=await connect(t,file);
 assert.equal(await c.call('close'),true);
 assert.equal(await c.exited,0);
 const late=Promise.race([c.call('get',{collection:'links',code:'x'}),new Promise(resolve=>setTimeout(()=>resolve('unanswered'),200))]);
 assert.equal(await late,'unanswered');
});

// openConnection replaces a started worker after its 5-second call deadline or
// an abrupt exit (the down() branch after activation). Neither has a
// deterministic trigger from outside: SQLite contention answers within the
// worker's 1-second busy_timeout, every protocol operation replies, and the
// Worker instance is private to the connection. Backoff arithmetic is shared
// with FunctionPool and is covered in test/sandbox-pool.test.ts.
test('connection replacement after a call deadline',{skip:liveLinksSkip||'no deterministic trigger: the 5 s deadline cannot be reached through the store protocol'},()=>{});
