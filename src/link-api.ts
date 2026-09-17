import http from 'node:http';
import {createHash,timingSafeEqual,randomUUID} from 'node:crypto';
import {readFile,lstat} from 'node:fs/promises';
import type {AddressInfo} from 'node:net';
import {outsideProject} from './link-store.ts';
import type {AuditIdentity,LinkRow,ListOptions} from './link-store.ts';
import type {ManagementAuthorizer,ManagementPrincipal} from './management-policy.ts';
import {linkCollection,linkCode} from './link-records.ts';
import {assert,HttpError} from './errors.ts';
import {createJsonLogger} from './logging.ts';
/** The store surface management needs: the pooled link store, or anything with the same contract. */
export interface ManagementStore {
  readonly atomicAudit?: boolean;
  get(collection: string,code: string): Promise<LinkRow|null>;
  list(collection: string,options?: ListOptions): Promise<LinkRow[]>;
  create(collection: string,data: unknown,code?: unknown,audit?: AuditIdentity|undefined): Promise<LinkRow>;
  update(collection: string,code: string,data: unknown,expectedVersion: unknown,audit?: AuditIdentity|undefined): Promise<LinkRow>;
  delete(collection: string,code: string,expectedVersion: unknown,audit?: AuditIdentity|undefined): Promise<boolean>;
}
export interface LinkApiOptions {
  store: ManagementStore; collection: string; token?: string|undefined; authorize?: ManagementAuthorizer|undefined;
  host?: string|undefined; port?: number|undefined; maxInFlightRequests?: number|undefined; socketTimeoutMs?: number|undefined; log?: ((event: object)=>void)|undefined;
}
export interface LinkApi { address: AddressInfo; close(): Promise<void> }
export async function loadLinkToken(file: unknown,project: string): Promise<string> {
  const path=await outsideProject(file,project);const info=await lstat(path);
  assert(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&info.size<=1024,'Invalid management token file');
  assert(process.platform==='win32'||(info.mode&0o077)===0,'Management token file must be private (mode 600)');
  const token=(await readFile(path,'utf8')).trim();
  assert(/^[A-Za-z0-9_-]{43,256}$/.test(token),'Management token must contain at least 43 base64url characters');return token;
}
function body(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve,reject)=>{
    let bytes=0;const chunks: Buffer[]=[];
    const cleanup=()=>{req.off('data',data);req.off('end',end);req.off('error',failed);req.off('aborted',failed);};
    const failed=()=>{cleanup();reject(new HttpError(400,'Incomplete management body'));};
    const data=(chunk: Buffer)=>{
      bytes+=chunk.length;
      if(bytes>16384){cleanup();req.resume();reject(new HttpError(413,'Management body too large'));return;}
      chunks.push(chunk);
    };
    const end=()=>{
      cleanup();
      if(!bytes){reject(new HttpError(400,'JSON body required'));return;}
      try{resolve(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));}
      catch{reject(new HttpError(400,'Invalid JSON body'));}
    };
    req.on('data',data);req.once('end',end);req.once('error',failed);req.once('aborted',failed);
  });
}
const isRecord=(value: unknown): value is Record<string,unknown>=>value!==null && typeof value==='object' && !Array.isArray(value);
const mutations: Record<string,string|undefined>={POST:'create',PUT:'update',DELETE:'delete'};
export async function startLinkApi({store,collection,token,authorize,host='127.0.0.1',port=3001,maxInFlightRequests=32,socketTimeoutMs=10000,log=createJsonLogger()}: LinkApiOptions): Promise<LinkApi> {
  linkCollection(collection);assert(['127.0.0.1','::1'].includes(host),'Management must bind a literal loopback address; use a private authenticated tunnel');
  assert(!authorize || store.atomicAudit===true,'Scoped management requires a store with atomic audit support');
  assert(authorize===undefined || typeof authorize==='function','Invalid management authorizer');
  assert(authorize || typeof token==='string'&&/^[A-Za-z0-9_-]{43,256}$/.test(token),'Invalid management token');
  assert(Number.isInteger(maxInFlightRequests)&&maxInFlightRequests>=1&&maxInFlightRequests<=64,'Management admission must be 1–64');
  assert(Number.isInteger(socketTimeoutMs)&&socketTimeoutMs>=100&&socketTimeoutMs<=60000,'Management socket timeout must be 100–60000 ms');
  let inFlight=0,shuttingDown=false,closing: Promise<void>|undefined;
  const digest=(value: string)=>createHash('sha256').update(value).digest();const expected=digest('Bearer '+token);
  const server=http.createServer({maxHeaderSize:8192,headersTimeout:5000,requestTimeout:10000,keepAliveTimeout:5000},async(req,res)=>{
    req.on('error',()=>{});res.on('error',()=>{});
    const requestId=randomUUID(),started=performance.now();let principal: ManagementPrincipal|undefined;let authenticated=false,action='request',admitted=false,reported=false;
    const target=req.url??'',method=req.method??'';
    const report=()=>{
      if(reported)return;reported=true;if(admitted)inFlight--;
      try{log({event:'management_request',timestamp:new Date().toISOString(),requestId,collection,action,authenticated,principal:principal?.id,status:res.headersSent?res.statusCode:0,outcome:res.writableFinished?'finished':'aborted',durationMs:Math.round((performance.now()-started)*100)/100});}catch{/* Logging must not fail requests. */}
    };
    res.once('finish',report);res.once('close',report);
    const send=(status: number,value?: unknown,headers: http.OutgoingHttpHeaders={})=>{const payload=value===undefined?undefined:JSON.stringify(value);res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff','x-request-id':requestId,...headers});res.end(payload);};
    try {
      if(shuttingDown || inFlight>=maxInFlightRequests)throw new HttpError(503,'Management capacity unavailable');
      inFlight++;admitted=true;
      let authCount=0;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i]?.toLowerCase()==='authorization')authCount++;
      if(authCount===1){
        if(authorize){
          const bearer=/^Bearer ([A-Za-z0-9_-]{43,256})$/.exec(req.headers.authorization||'');
          if(bearer?.[1]!==undefined)principal=await authorize(bearer[1]);
        }else if(timingSafeEqual(expected,digest(req.headers.authorization||'')))principal={id:'legacy-shared',collections:[collection],actions:['get','list','create','update','delete']};
      }
      if(!principal) {req.resume();send(401,{error:'Unauthorized'},{'www-authenticate':'Bearer',connection:'close'});return;}
      authenticated=true;
      if(req.headers.origin!==undefined)throw new HttpError(403,'Browser-origin management requests are unsupported');
      if(!target.startsWith('/')||target.startsWith('//')||target.length>2048)throw new HttpError(400,'Invalid management target');
      const url=new URL(target,'http://localhost');
      if(target.split('?')[0]!==url.pathname)throw new HttpError(400,'Noncanonical management path');
      const match=/^\/v1\/links(?:\/([A-Za-z0-9_-]{1,128}))?$/.exec(url.pathname);
      if(!match)throw new HttpError(404,'Not found');
      const code=match[1];if(code)linkCode(code);
      if([...url.searchParams.keys()].some(k=>!['limit','after'].includes(k)) || (code && url.search))throw new HttpError(400,'Unsupported query');
      const allowed=code?['GET','PUT','DELETE']:['GET','POST'];
      if(!allowed.includes(method)){req.resume();send(405,{error:'Method not allowed'},{allow:allowed.join(', '),connection:'close'});return;}
      action=method==='GET'?(code?'get':'list'):mutations[method]??'request';
      if(!principal.collections.includes(collection) || !principal.actions.includes(action))throw new HttpError(403,'Management permission denied');
      const audit: AuditIdentity={actor:principal.id,requestId};
      if(method==='GET'){
        req.resume();
        if(code){const value=await store.get(collection,code);if(!value)throw new HttpError(404,'Link not found');send(200,value,{etag:`"${value.version}"`});}
        else {
          if([...url.searchParams.keys()].some(k=>url.searchParams.getAll(k).length!==1))throw new HttpError(400,'Duplicate query');
          const raw=url.searchParams.get('limit')??'100';if(!/^\d{1,3}$/.test(raw))throw new HttpError(400,'Invalid limit');
          const items=await store.list(collection,{limit:Number(raw),after:url.searchParams.get('after')||''});
          send(200,{items,nextAfter:items.length===Number(raw)?items.at(-1)?.code??null:null});
        }
        return;
      }
      if(url.search)throw new HttpError(400,'Query unsupported for mutations');
      let expectedVersion: number|undefined;
      if(method!=='POST'){
        const etag=req.headers['if-match'];if(!etag)throw new HttpError(428,'If-Match is required');
        if(!/^"[1-9]\d{0,15}"$/.test(etag))throw new HttpError(400,'Invalid If-Match');expectedVersion=Number(etag.slice(1,-1));
      }
      if(method==='DELETE'){req.resume();await store.delete(collection,code??'',expectedVersion,audit);send(204);return;}
      if(req.headers['content-encoding'] && req.headers['content-encoding']!=='identity')throw new HttpError(415,'Encoding unsupported');
      if(req.headers['content-type']?.split(';')[0]?.trim().toLowerCase()!=='application/json')throw new HttpError(415,'Expected application/json');
      const data=await body(req);
      if(!isRecord(data))throw new HttpError(400,'Invalid record');
      let value: LinkRow;
      if(method==='POST'){const {code:assigned,...record}=data;value=await store.create(collection,record,assigned,audit);}
      else value=await store.update(collection,code??'',data,expectedVersion,audit);
      send(method==='POST'?201:200,value,{etag:`"${value.version}"`});
    }catch(e){req.resume();if(res.headersSent){res.destroy();return;}if(!res.destroyed){const status=e instanceof HttpError?e.status:503;send(status,{error:e instanceof HttpError?e.message:'Management service unavailable'},{connection:'close'});}}
  });
  server.setTimeout(socketTimeoutMs,socket=>socket.destroy());
  server.maxConnections=64;server.maxRequestsPerSocket=100;
  server.on('clientError',(_error,socket)=>{if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.off('error',reject);resolve();});});
  const address=server.address();
  assert(address!==null && typeof address==='object','Management server has no address');
  return {address,close(){
    if(closing)return closing;shuttingDown=true;
    closing=(async()=>{const timeout=setTimeout(()=>server.closeAllConnections(),10000);timeout.unref();try{await new Promise<void>(resolve=>server.close(()=>resolve()));}finally{clearTimeout(timeout);}})();return closing;
  }};
}
