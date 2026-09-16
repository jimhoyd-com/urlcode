import {Worker} from 'node:worker_threads';
import {realpath,lstat,open} from 'node:fs/promises';
import {dirname,basename,join,relative,isAbsolute,sep} from 'node:path';
import {ConfigError,HttpError,assert} from './errors.js';
import {supportsConcurrentWal} from './sqlite-version.js';
export async function outsideProject(file,project) {
  assert(typeof file==='string' && isAbsolute(file),'Operator file must use an absolute path');
  const parent=await realpath(dirname(file));const actual=join(parent,basename(file));
  const root=await realpath(project);const rel=relative(root,actual);
  assert(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep),'Operator file must be outside the application project');
  return actual;
}
async function openConnection({file,project='.',readOnly=false}) {
  assert(supportsConcurrentWal(process.versions.sqlite),'Live links require a Node build with patched SQLite (3.51.3+, 3.50.7 or 3.44.6); upgrade Node');
  file=await outsideProject(file,project);
  if(!readOnly){try{const handle=await open(file,'wx',0o600);await handle.close();}catch(e){if(e.code!=='EEXIST')throw e;}}
  const info=await lstat(file);
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink===1,'Link store must be a regular operator-owned file');
  const worker=new Worker(new URL('./link-store-worker.js',import.meta.url),{workerData:{file,readOnly},env:{},execArgv:[],stdout:true,stderr:true,resourceLimits:{maxOldGenerationSizeMb:64}});
  worker.stdout.resume();worker.stderr.resume();
  const pending=new Map();let sequence=0,healthy=false,closed=false,closing;
  const fail=()=>{healthy=false;for(const {reject,timer} of pending.values()){clearTimeout(timer);reject(new HttpError(503,'Link store unavailable'));}pending.clear();};
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{reject(new ConfigError('Link store initialization failed'));void worker.terminate();},5000);
    worker.on('message',message=>{
      if(message.ready){clearTimeout(timer);healthy=true;resolve();return;}
      if(message.failed){clearTimeout(timer);reject(new ConfigError('Link store initialization failed'));void worker.terminate();return;}
      const request=pending.get(message.id);if(!request)return;
      clearTimeout(request.timer);pending.delete(message.id);
      if(message.error)request.reject(new HttpError(message.error.status,message.error.message));else request.resolve(message.value);
    });
    worker.on('error',()=>{clearTimeout(timer);reject(new ConfigError('Link store initialization failed'));fail();});
    worker.on('exit',()=>{clearTimeout(timer);reject(new ConfigError('Link store initialization failed'));fail();});
  });
  function call(operation,args={},internal=false) {
    if(!healthy||(!internal&&(closed||pending.size>=32)))return Promise.reject(new HttpError(503,'Link store capacity unavailable'));
    const id=++sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{fail();void worker.terminate();},5000);
      pending.set(id,{resolve,reject,timer});
      try{worker.postMessage({id,operation,args});}
      catch{clearTimeout(timer);pending.delete(id);reject(new HttpError(400,'Invalid store arguments'));}
    });
  }
  return {
    get healthy(){return healthy&&!closed;},
    get:(collection,code)=>call('get',{collection,code}),
    list:(collection,options={})=>call('list',{collection,...options}),
    create:(collection,data,code,audit)=>call('create',{collection,data,code,audit}),
    update:(collection,code,data,expectedVersion,audit)=>call('update',{collection,code,data,expectedVersion,audit}),
    delete:(collection,code,expectedVersion,audit)=>call('delete',{collection,code,expectedVersion,audit}),
    close(){
      if(closing)return closing;
      closed=true;
      // Reserve shutdown admission and enqueue it after all accepted operations.
      closing=(async()=>{try{if(healthy)await call('close',{},true);}finally{fail();await worker.terminate();}})();
      return closing;
    },
  };
}

// SQLite permits concurrent readers but serializes writes. Keep independent
// admission budgets so management work cannot consume redirect read capacity.
export async function openLinkStore({file,project='.',readOnly=false,readers=2,maxReads=32,maxWrites=32}={}) {
  assert(Number.isInteger(readers)&&readers>=1&&readers<=8,'Link readers must be 1–8');
  for(const value of [maxReads,maxWrites])assert(Number.isInteger(value)&&value>=1&&value<=32,'Link pool limits must be 1–32');
  const connections=[];let writer;
  try {
    // Initialize before opening read-only connections on a new database.
    if(!readOnly){writer=await openConnection({file,project});connections.push(writer);}
    const read=[];
    for(let i=0;i<readers;i++){const connection=await openConnection({file,project,readOnly:true});connections.push(connection);read.push(connection);}
    return pooledStore(read,writer,maxReads,maxWrites);
  }catch(error){await Promise.allSettled(connections.map(connection=>connection.close()));throw error;}
}
function pooledStore(read,writer,maxReads,maxWrites){
  const group=(connections,limit)=>({connections:connections.map(connection=>({connection,inFlight:0})),limit,inFlight:0,completed:0,failed:0,rejected:0,durationMs:0});
  const reads=group(read,maxReads),writes=group(writer?[writer]:[],maxWrites);
  let closed=false,closing;
  const healthy=pool=>!closed&&pool.connections.length>0&&pool.connections.every(slot=>slot.connection.healthy);
  async function run(pool,method,args){
    if(closed){pool.rejected++;throw new HttpError(503,'Link store unavailable');}
    if(!pool.connections.length){pool.rejected++;throw new HttpError(403,'Store is read-only');}
    const slot=pool.connections.filter(slot=>slot.connection.healthy).sort((a,b)=>a.inFlight-b.inFlight)[0];
    if(!slot || pool.inFlight>=pool.limit){pool.rejected++;throw new HttpError(503,'Link pool capacity unavailable');}
    pool.inFlight++;slot.inFlight++;const started=performance.now();
    try{const value=await slot.connection[method](...args);pool.completed++;return value;}
    catch(error){pool.failed++;throw error;}
    finally{pool.inFlight--;slot.inFlight--;pool.durationMs+=performance.now()-started;}
  }
  const stats=pool=>({connections:pool.connections.length,healthyConnections:pool.connections.filter(s=>s.connection.healthy).length,limit:pool.limit,inFlight:pool.inFlight,completed:pool.completed,failed:pool.failed,rejected:pool.rejected,durationMs:pool.durationMs});
  return {
    get readHealthy(){return healthy(reads);},
    get writeHealthy(){return healthy(writes);},
    get healthy(){return healthy(reads)&&(!writer||healthy(writes));},
    atomicAudit:true,
    stats:()=>({closed,read:stats(reads),write:stats(writes)}),
    get:(...args)=>run(reads,'get',args),list:(...args)=>run(reads,'list',args),
    create:(...args)=>run(writes,'create',args),update:(...args)=>run(writes,'update',args),delete:(...args)=>run(writes,'delete',args),
    close(){
      if(closing)return closing;closed=true;
      closing=(async()=>{
        const results=await Promise.allSettled([...read,...(writer?[writer]:[])].map(connection=>connection.close()));
        const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
      })();return closing;
    },
  };
}
