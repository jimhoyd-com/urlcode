import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';

export const EGRESS_DNS_LIMIT=64;
let unresolvedDns=0;
export interface EgressRequest { url: string; method: string; headers?: Record<string,string>; body?: Uint8Array; signal?: AbortSignal }
export interface EgressResponse { status: number; headers: Record<string,string>; body: Buffer }
export interface EgressOptions { grantOrigins: string[]; timeoutMs?: number; maxRequestBytes?: number; maxResponseBytes?: number; maxHeaderBytes?: number; concurrency?: number }
type EgressErrorCode = 'denied'|'busy'|'closed'|'aborted'|'timeout'|'limit'|'upstream';
export class EgressError extends Error { readonly code:EgressErrorCode; constructor(code:EgressErrorCode) { super(`Egress ${code}`); this.code=code; } }
/** Conservative public-unicast filter. IPv4-mapped IPv6 and transition mechanisms are denied. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address)===4) {
    const [a=0,b=0,c=0] = address.split('.').map(Number);
    return !(a===0 || a===10 || a===127 || a>=224 || (a===100&&b>=64&&b<=127) || (a===169&&b===254) || (a===172&&b>=16&&b<=31) || (a===192&&(b===168 || b===0 || (b===88&&c===99) || (b===0&&c===2))) || (a===198&&(b===18||b===19|| (b===51&&c===100))) || (a===203&&b===0&&c===113));
  }
  if (isIP(address)!==6) return false;
  // Only ordinary global unicast; reject documentation and special 2001 allocations.
  if(address.includes('.')) return false;
  const first = parseInt(address.split(':')[0]!,16);
  return first>=0x2000 && first<=0x3fff && !/^2001:/i.test(address) && !/^2002:/i.test(address) && !/^3fff:/i.test(address);
}
export function egressUrl(value: string): URL {
  if(typeof value!=='string'||value.length>8192||/[\\\x00-\x20\x7f]/.test(value)) throw new EgressError('denied');
  let url: URL; try { url=new URL(value); } catch { throw new EgressError('denied'); }
  if(url.protocol!=='https:' || url.username || url.password || url.hash || !url.hostname || url.hostname.endsWith('.') || url.hostname.includes('%')) throw new EgressError('denied');
  return url;
}
const forbidden = new Set(['host','connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','content-length']);
export function safeEgressHeaders(headers: Record<string,string>, maxBytes=16384): Record<string,string> {
  if(!headers||typeof headers!=='object'||Array.isArray(headers)) throw new EgressError('denied');
  const result: Record<string,string> = Object.create(null); let bytes=0;
  for(const [name,value] of Object.entries(headers)) {
    const key=name.toLowerCase();
    if(typeof value!=='string'||!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(key) || forbidden.has(key) || /[\x00-\x1f\x7f]/.test(value)) throw new EgressError('denied');
    bytes+=Buffer.byteLength(key)+Buffer.byteLength(value)+4;
    if(bytes>maxBytes) throw new EgressError('limit'); result[key]=value;
  }
  return result;
}
/** Operator-owned transport. Never exposed to guests. Each request has its own nonpooled socket. */
export interface EgressDependencies { resolve?: (hostname:string)=>Promise<{address:string;family:number}[]>; request?: typeof request }
export class EgressClient {
  readonly #dependencies:EgressDependencies; readonly #origins: Set<string>; readonly #options: Required<Omit<EgressOptions,'grantOrigins'>>;
  readonly #active = new Set<AbortController>(); readonly #pending = new Set<Promise<unknown>>(); #closed=false; #resolving=0;
  constructor(options:EgressOptions, dependencies:EgressDependencies={}) {
    this.#dependencies=dependencies;
    if(!Array.isArray(options.grantOrigins)||options.grantOrigins.length>64) throw new EgressError('denied');
    this.#origins=new Set(options.grantOrigins.map(origin=> {const u=egressUrl(origin); if(u.pathname!=='/'||u.search) throw new EgressError('denied'); return u.origin;}));
    this.#options={timeoutMs:5000,maxRequestBytes:1048576,maxResponseBytes:1048576,maxHeaderBytes:16384,concurrency:16,...options};
    for(const value of Object.values(this.#options)) if(typeof value==='number'&&(!Number.isSafeInteger(value)||value<1)) throw new EgressError('denied');
  }
  request(input:EgressRequest):Promise<EgressResponse> {
    if(this.#closed) return Promise.reject(new EgressError('closed'));
    if(this.#active.size>=this.#options.concurrency||this.#resolving>=this.#options.concurrency) return Promise.reject(new EgressError('busy'));
    const controller=new AbortController(); this.#active.add(controller);
    const pending=this.#request(input,controller).finally(()=>{this.#active.delete(controller);this.#pending.delete(pending);});
    this.#pending.add(pending); return pending;
  }
  async close():Promise<void> {this.#closed=true; for(const controller of this.#active) controller.abort(); await Promise.allSettled([...this.#pending]);}
  async #resolve(hostname:string):Promise<{address:string;family:number}[]> {
    if(this.#resolving>=this.#options.concurrency||unresolvedDns>=EGRESS_DNS_LIMIT) throw new EgressError('busy');
    this.#resolving++;unresolvedDns++;
    try {return await (this.#dependencies.resolve?this.#dependencies.resolve(hostname):lookup(hostname,{all:true,verbatim:true}));}
    finally {this.#resolving--;unresolvedDns--;}
  }
  async #request(input:EgressRequest,controller:AbortController):Promise<EgressResponse> {
    const opts=this.#options, url=egressUrl(input.url);
    if(!this.#origins.has(url.origin)||! /^[A-Z]+$/.test(input.method)) throw new EgressError('denied');
    if((input.body?.byteLength||0)>opts.maxRequestBytes) throw new EgressError('limit');
    const headers=safeEgressHeaders(input.headers||{},opts.maxHeaderBytes);
    let timedOut=false; const timer=setTimeout(()=>{timedOut=true;controller.abort();},opts.timeoutMs);
    const abort=()=>controller.abort(); input.signal?.addEventListener('abort',abort,{once:true}); if(input.signal?.aborted) controller.abort();
    try {
      return await new Promise<EgressResponse>((resolve,reject)=>{
        const fail=()=>reject(new EgressError(timedOut?'timeout':'aborted'));
        controller.signal.addEventListener('abort',fail,{once:true}); if(controller.signal.aborted) {fail();return;}
        void (async()=> {
          const hostname=url.hostname.replace(/^\[|\]$/g,'');
          const answers=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:await this.#resolve(hostname);
          if(controller.signal.aborted) return;
          if(!answers.length||answers.some(answer=>!isPublicAddress(answer.address))) throw new EgressError('denied');
          const pinned=answers[0]!;
          const req=(this.#dependencies.request||request)(url,{method:input.method,headers,agent:false,maxHeaderSize:opts.maxHeaderBytes,signal:controller.signal,
            lookup:(_host,options,callback)=>options.all?callback(null,[pinned]):callback(null,pinned.address,pinned.family)},res=>{
            const chunks:Buffer[]=[]; let size=0;
            res.on('data',(chunk:Buffer)=>{size+=chunk.length; if(size>opts.maxResponseBytes) {reject(new EgressError('limit'));req.destroy();} else chunks.push(chunk);});
            res.on('error',()=>reject(new EgressError('upstream')));
            res.on('end',()=>{const result:Record<string,string>=Object.create(null); for(const [name,value] of Object.entries(res.headers)) if(typeof value==='string') result[name]=value; resolve({status:res.statusCode||502,headers:result,body:Buffer.concat(chunks)});});
          });
          req.on('error',()=>reject(new EgressError(controller.signal.aborted?(timedOut?'timeout':'aborted'):'upstream')));
          req.end(input.body);
        })().catch(error=>reject(error instanceof EgressError?error:new EgressError('upstream')));
      });
    } finally {clearTimeout(timer); input.signal?.removeEventListener('abort',abort);}
  }
}
