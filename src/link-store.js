import {Worker} from 'node:worker_threads';
import {realpath,lstat,open} from 'node:fs/promises';
import {dirname,basename,join,relative,isAbsolute,sep} from 'node:path';
import {ConfigError,HttpError,assert} from './errors.js';
export async function outsideProject(file,project) {
  assert(typeof file==='string' && isAbsolute(file),'Operator file must use an absolute path');
  const parent=await realpath(dirname(file));const actual=join(parent,basename(file));
  const root=await realpath(project);const rel=relative(root,actual);
  assert(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep),'Operator file must be outside the application project');
  return actual;
}
export async function openLinkStore({file,project='.',readOnly=false}) {
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
    create:(collection,data,code)=>call('create',{collection,data,code}),
    update:(collection,code,data,expectedVersion)=>call('update',{collection,code,data,expectedVersion}),
    delete:(collection,code,expectedVersion)=>call('delete',{collection,code,expectedVersion}),
    close(){
      if(closing)return closing;
      closed=true;
      // Reserve shutdown admission and enqueue it after all accepted operations.
      closing=(async()=>{try{if(healthy)await call('close',{},true);}finally{fail();await worker.terminate();}})();
      return closing;
    },
  };
}
