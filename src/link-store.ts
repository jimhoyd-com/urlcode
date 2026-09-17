import {Worker} from 'node:worker_threads';
import {realpath,lstat,open} from 'node:fs/promises';
import {dirname,basename,join,relative,isAbsolute,sep} from 'node:path';
import {ConfigError,HttpError,assert} from './errors.ts';
import {supportsConcurrentWal} from './sqlite-version.ts';
import type {LinkRecord} from './link-records.ts';

export type Log=(event: object)=>void;
/** A stored link as the worker returns it. */
export interface LinkRow extends LinkRecord { collection: string; code: string; version: number }
export interface ListOptions { limit?: number|undefined; after?: string|undefined }
export interface AuditIdentity { actor?: string|undefined; requestId?: string|undefined }
export interface ExportHeader { format: string; schemaVersion: number; applicationId: number; collection: string|null; revision: number; records: number; generatedAt: string }
export interface ExportPageOptions { afterCollection?: string|undefined; afterCode?: string|undefined; limit?: number|undefined }
export interface ExportOptions { collection?: string|undefined; pageSize?: number|undefined; deadlineMs?: number|undefined }
export interface ExportHandlers { onHeader?: ((header: ExportHeader)=>unknown)|undefined; onRecords?: ((records: LinkRow[])=>unknown)|undefined }
export interface ExportSummary extends ExportHeader { exported: number }
export interface PoolStats { connections: number; healthyConnections: number; limit: number; inFlight: number; completed: number; failed: number; rejected: number; durationMs: number }
export interface LinkStoreStats { closed: boolean; exporting: boolean; read: PoolStats; write: PoolStats }

// The worker protocol: one command per operation, one reply per command. The
// worker validates every argument again; these types name the contract.
export interface LinkStoreWorkerData { file: string; readOnly: boolean }
export type LinkStoreOperation='get'|'list'|'create'|'update'|'delete'|'exportBegin'|'exportPage'|'exportEnd'|'close';
export interface LinkStoreArgs extends ListOptions, ExportPageOptions {
  collection?: string|undefined; code?: string|undefined; data?: unknown; expectedVersion?: unknown; audit?: AuditIdentity|undefined;
}
export interface LinkStoreCommand { id: number; operation: LinkStoreOperation; args: LinkStoreArgs }
export type LinkStoreReply=
  | {ready: true} | {failed: true}
  | {id: number; value: unknown}
  | {id: number; error: {status: number; message: string}};

/** One worker-backed SQLite connection. */
export interface LinkConnection {
  readonly healthy: boolean;
  get(collection: string,code: string): Promise<LinkRow|null>;
  list(collection: string,options?: ListOptions): Promise<LinkRow[]>;
  exportBegin(options?: {collection?: string|undefined}): Promise<ExportHeader>;
  exportPage(options?: ExportPageOptions): Promise<LinkRow[]>;
  exportEnd(): Promise<boolean>;
  create(collection: string,data: unknown,code?: string|undefined,audit?: AuditIdentity|undefined): Promise<LinkRow>;
  update(collection: string,code: string,data: unknown,expectedVersion: unknown,audit?: AuditIdentity|undefined): Promise<LinkRow>;
  delete(collection: string,code: string,expectedVersion: unknown,audit?: AuditIdentity|undefined): Promise<boolean>;
  close(): Promise<void>;
}
/** The pooled store openLinkStore returns. */
export interface LinkStore {
  readonly readHealthy: boolean; readonly writeHealthy: boolean; readonly healthy: boolean;
  readonly atomicAudit: true;
  stats(): LinkStoreStats;
  exportSnapshot(options?: ExportOptions,handlers?: ExportHandlers): Promise<ExportSummary>;
  get(collection: string,code: string): Promise<LinkRow|null>;
  list(collection: string,options?: ListOptions): Promise<LinkRow[]>;
  create(collection: string,data: unknown,code?: string|undefined,audit?: AuditIdentity|undefined): Promise<LinkRow>;
  update(collection: string,code: string,data: unknown,expectedVersion: unknown,audit?: AuditIdentity|undefined): Promise<LinkRow>;
  delete(collection: string,code: string,expectedVersion: unknown,audit?: AuditIdentity|undefined): Promise<boolean>;
  close(): Promise<void>;
}
export interface LinkStoreOptions { file?: string|undefined; project?: string|undefined; readOnly?: boolean|undefined; readers?: number|undefined; maxReads?: number|undefined; maxWrites?: number|undefined; log?: Log|undefined }

export async function outsideProject(file: unknown,project: string): Promise<string> {
  assert(typeof file==='string' && isAbsolute(file),'Operator file must use an absolute path');
  const parent=await realpath(dirname(file));const actual=join(parent,basename(file));
  const root=await realpath(project);const rel=relative(root,actual);
  assert(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep),'Operator file must be outside the application project');
  return actual;
}
// A backstop against a worker that will never answer, not a performance budget:
// a bad build or an unreadable file reports itself in milliseconds, while a cold,
// heavily loaded machine can legitimately take seconds to boot a worker thread
// and open SQLite. Set well clear of that, because refusing to start a store the
// machine would have opened is the worse failure.
const startupMs=15000;
interface PendingCall { resolve: (value: unknown)=>void; reject: (error: Error)=>void; timer: NodeJS.Timeout }
const isCode=(error: unknown,code: string): boolean=>error instanceof Error && 'code' in error && error.code===code;
async function openConnection({file,project='.',readOnly=false,log=()=>{}}: {file: unknown; project?: string|undefined; readOnly?: boolean|undefined; log?: Log|undefined}): Promise<LinkConnection> {
  assert(supportsConcurrentWal(process.versions.sqlite),`Live links require a Node build with patched SQLite (3.51.3+, 3.50.7 or 3.44.6); this build has ${process.versions.sqlite}. Upgrade Node`);
  const path=await outsideProject(file,project);
  if(!readOnly){try{const handle=await open(path,'wx',0o600);await handle.close();}catch(e){if(!isCode(e,'EEXIST'))throw e;}}
  const info=await lstat(path);
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink===1,'Link store must be a regular operator-owned file');
  const pending=new Map<number,PendingCall>();
  let worker: Worker|undefined,sequence=0,healthy=false,closed=false,closing: Promise<void>|undefined,attempts=0,respawnTimer: NodeJS.Timeout|undefined;
  const report=(status: string,extra: object={})=>{try{log({event:'link_store_worker',status,readOnly,...extra});}catch{/* Logging cannot fail the store. */}};
  const fail=()=>{healthy=false;for(const {reject,timer} of pending.values()){clearTimeout(timer);reject(new HttpError(503,'Link store unavailable'));}pending.clear();};
  // A dead connection must not latch the store off: one slow query or an abrupt
  // worker exit is recoverable, and the records themselves live on disk.
  function scheduleRespawn() {
    if(closed)return;
    attempts++;
    const delayMs=Math.min(30000,250*2**Math.min(attempts-1,7));
    report('restarting',{attempt:attempts,delayMs});
    respawnTimer=setTimeout(()=>{respawnTimer=undefined;if(closed)return;void launch().catch(()=>scheduleRespawn());},delayMs);
    respawnTimer.unref();
  }
  async function launch() {
    const workerData: LinkStoreWorkerData={file:path,readOnly};
    const instance=new Worker(new URL('./link-store-worker.ts',import.meta.url),{workerData,env:{},execArgv:[],stdout:true,stderr:true,resourceLimits:{maxOldGenerationSizeMb:64}});
    worker=instance;instance.stdout.resume();instance.stderr.resume();
    try {
      await new Promise<void>((resolve,reject)=>{
        let started=false,settled=false;
        const settle=(error?: Error)=>{if(settled)return;settled=true;if(error)reject(error);else resolve();};
        const timer=setTimeout(()=>settle(new ConfigError(`Link store initialization failed: no ready signal within ${startupMs}ms`)),startupMs);
        instance.on('message',(message: LinkStoreReply)=>{ // trust boundary: the worker's own protocol
          if('ready' in message){if(!started){started=true;healthy=true;clearTimeout(timer);report('started');settle();}return;}
          if('failed' in message){clearTimeout(timer);healthy=false;settle(new ConfigError('Link store initialization failed: the worker could not open the store'));return;}
          const request=pending.get(message.id);if(!request)return;
          // An answered operation, success or rejection, proves this connection is
          // serving again; a worker that starts cleanly but dies on every operation
          // must keep backing off rather than restarting in a tight loop.
          attempts=0;clearTimeout(request.timer);pending.delete(message.id);
          if('error' in message)request.reject(new HttpError(message.error.status,message.error.message));else request.resolve(message.value);
        });
        const down=()=>{
          clearTimeout(timer);
          const wasStarted=started;started=false;
          if(worker===instance)fail();
          settle(new ConfigError('Link store initialization failed: the worker exited or errored during start'));
          // Replace only a connection that had been serving; a failed activation
          // is reported to the caller instead of retried behind its back.
          if(wasStarted&&!closed&&worker===instance)scheduleRespawn();
        };
        instance.on('error',down);instance.on('exit',down);
      });
    } catch(error) {
      // An initialization error must not escape while its worker still owns the DB.
      await instance.terminate();
      throw error;
    }
  }
  await launch();
  function call<T>(operation: LinkStoreOperation,args: LinkStoreArgs={},internal=false): Promise<T> {
    const instance=worker;
    if(!healthy||!instance||(!internal&&(closed||pending.size>=32)))return Promise.reject(new HttpError(503,'Link store capacity unavailable'));
    const id=++sequence;
    return new Promise<T>((resolve,reject)=>{
      const timer=setTimeout(()=>{if(worker===instance){fail();void instance.terminate();}},5000);
      pending.set(id,{resolve:value=>resolve(value as T),reject,timer}); // trust boundary: the worker answers each operation with its own value type
      const command: LinkStoreCommand={id,operation,args};
      try{instance.postMessage(command);}
      catch{clearTimeout(timer);pending.delete(id);reject(new HttpError(400,'Invalid store arguments'));}
    });
  }
  return {
    get healthy(){return healthy&&!closed;},
    get:(collection,code)=>call('get',{collection,code}),
    list:(collection,options={})=>call('list',{collection,...options}),
    exportBegin:(options={})=>call('exportBegin',options),
    exportPage:(options={})=>call('exportPage',options),
    exportEnd:()=>call('exportEnd',{}),
    create:(collection,data,code,audit)=>call('create',{collection,data,code,audit}),
    update:(collection,code,data,expectedVersion,audit)=>call('update',{collection,code,data,expectedVersion,audit}),
    delete:(collection,code,expectedVersion,audit)=>call('delete',{collection,code,expectedVersion,audit}),
    close(){
      if(closing)return closing;
      closed=true;
      if(respawnTimer){clearTimeout(respawnTimer);respawnTimer=undefined;}
      // Reserve shutdown admission and enqueue it after all accepted operations.
      closing=(async()=>{const instance=worker;try{if(healthy)await call('close',{},true);}finally{fail();await instance?.terminate();}})();
      return closing;
    },
  };
}

// SQLite permits concurrent readers but serializes writes. Keep independent
// admission budgets so management work cannot consume redirect read capacity.
export async function openLinkStore({file,project='.',readOnly=false,readers=2,maxReads=32,maxWrites=32,log=()=>{}}: LinkStoreOptions={}): Promise<LinkStore> {
  assert(Number.isInteger(readers)&&readers>=1&&readers<=8,'Link readers must be 1–8');
  for(const value of [maxReads,maxWrites])assert(Number.isInteger(value)&&value>=1&&value<=32,'Link pool limits must be 1–32');
  const connections: LinkConnection[]=[];let writer: LinkConnection|undefined;
  try {
    // Initialize before opening read-only connections on a new database.
    if(!readOnly){writer=await openConnection({file,project,log});connections.push(writer);}
    const read: LinkConnection[]=[];
    for(let i=0;i<readers;i++){const connection=await openConnection({file,project,readOnly:true,log});connections.push(connection);read.push(connection);}
    return pooledStore(read,writer,maxReads,maxWrites);
  }catch(error){await Promise.allSettled(connections.map(connection=>connection.close()));throw error;}
}
interface PoolSlot { connection: LinkConnection; inFlight: number }
interface Pool { connections: PoolSlot[]; limit: number; inFlight: number; completed: number; failed: number; rejected: number; durationMs: number }
function pooledStore(read: LinkConnection[],writer: LinkConnection|undefined,maxReads: number,maxWrites: number): LinkStore {
  const group=(connections: LinkConnection[],limit: number): Pool=>({connections:connections.map(connection=>({connection,inFlight:0})),limit,inFlight:0,completed:0,failed:0,rejected:0,durationMs:0});
  const reads=group(read,maxReads),writes=group(writer?[writer]:[],maxWrites);
  let closed=false,closing: Promise<void>|undefined,exporting=false;
  const healthy=(pool: Pool)=>!closed&&pool.connections.length>0&&pool.connections.every(slot=>slot.connection.healthy);
  async function run<T>(pool: Pool,operation: (connection: LinkConnection)=>Promise<T>): Promise<T>{
    if(closed){pool.rejected++;throw new HttpError(503,'Link store unavailable');}
    if(!pool.connections.length){pool.rejected++;throw new HttpError(403,'Store is read-only');}
    const slot=pool.connections.filter(slot=>slot.connection.healthy).sort((a,b)=>a.inFlight-b.inFlight)[0];
    if(!slot || pool.inFlight>=pool.limit){pool.rejected++;throw new HttpError(503,'Link pool capacity unavailable');}
    pool.inFlight++;slot.inFlight++;const started=performance.now();
    try{const value=await operation(slot.connection);pool.completed++;return value;}
    catch(error){pool.failed++;throw error;}
    finally{pool.inFlight--;slot.inFlight--;pool.durationMs+=performance.now()-started;}
  }
  // One bounded, point-in-time export at a time, pinned to a single reader and
  // holding that reader's admission for its whole life so it cannot outgrow the
  // pool's budget. Writers keep committing; this view does not see them.
  async function exportSnapshot({collection,pageSize=100,deadlineMs=60000}: ExportOptions={},{onHeader=()=>{},onRecords=()=>{}}: ExportHandlers={}): Promise<ExportSummary> {
    assert(Number.isInteger(pageSize)&&pageSize>=1&&pageSize<=100,'Export page size must be 1–100');
    assert(Number.isInteger(deadlineMs)&&deadlineMs>=1000&&deadlineMs<=600000,'Export deadline must be 1000–600000 ms');
    assert(typeof onHeader==='function' && typeof onRecords==='function','Export handlers must be functions');
    if(closed){reads.rejected++;throw new HttpError(503,'Link store unavailable');}
    if(exporting){reads.rejected++;throw new HttpError(409,'An export is already in progress');}
    const slot=reads.connections.filter(slot=>slot.connection.healthy).sort((a,b)=>a.inFlight-b.inFlight)[0];
    if(!slot||reads.inFlight>=reads.limit){reads.rejected++;throw new HttpError(503,'Link pool capacity unavailable');}
    exporting=true;reads.inFlight++;slot.inFlight++;
    const started=performance.now(),expires=Date.now()+deadlineMs;
    try {
      const header=await slot.connection.exportBegin(collection===undefined?{}:{collection});
      let exported=0,afterCollection='',afterCode='';
      try {
        // Identity and the snapshot's revision are handed over before any record,
        // so a truncated stream is recognizable rather than silently short.
        await onHeader(header);
        for(;;){
          if(Date.now()>expires)throw new HttpError(503,'Export deadline exceeded');
          const records=await slot.connection.exportPage({afterCollection,afterCode,limit:pageSize});
          const last=records.at(-1);
          if(!last)break;
          await onRecords(records);
          exported+=records.length;
          afterCollection=last.collection;afterCode=last.code;
        }
      } finally { await slot.connection.exportEnd().catch(()=>{}); }
      reads.completed++;
      return {...header,exported};
    } catch(error){reads.failed++;throw error;}
    finally{exporting=false;reads.inFlight--;slot.inFlight--;reads.durationMs+=performance.now()-started;}
  }
  const stats=(pool: Pool): PoolStats=>({connections:pool.connections.length,healthyConnections:pool.connections.filter(s=>s.connection.healthy).length,limit:pool.limit,inFlight:pool.inFlight,completed:pool.completed,failed:pool.failed,rejected:pool.rejected,durationMs:pool.durationMs});
  return {
    get readHealthy(){return healthy(reads);},
    get writeHealthy(){return healthy(writes);},
    get healthy(){return healthy(reads)&&(!writer||healthy(writes));},
    atomicAudit:true,
    stats:()=>({closed,exporting,read:stats(reads),write:stats(writes)}),
    exportSnapshot,
    get:(collection,code)=>run(reads,c=>c.get(collection,code)),list:(collection,options)=>run(reads,c=>c.list(collection,options)),
    create:(collection,data,code,audit)=>run(writes,c=>c.create(collection,data,code,audit)),update:(collection,code,data,expectedVersion,audit)=>run(writes,c=>c.update(collection,code,data,expectedVersion,audit)),delete:(collection,code,expectedVersion,audit)=>run(writes,c=>c.delete(collection,code,expectedVersion,audit)),
    close(){
      if(closing)return closing;closed=true;
      closing=(async()=>{
        const results=await Promise.allSettled([...read,...(writer?[writer]:[])].map(connection=>connection.close()));
        const failed=results.find((result): result is PromiseRejectedResult=>result.status==='rejected');if(failed)throw failed.reason;
      })();return closing;
    },
  };
}
