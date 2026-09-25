// `urlcode studio`: the review report (project-report.ts) served on loopback and rebuilt from disk on every request,
// so reloading the page shows the project as it is now (docs/TOOLING.md#studio). It adds no analysis: one page, the
// same data as `urlcode report`. Read-only: it writes nothing and never runs project code. The operator policy and
// BEFORE are re-read per request, so a re-pin or a new baseline shows on reload; the host file is trusted operator
// code, loaded once by the CLI and never re-imported here.
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {ConfigError} from './errors.ts';
import {loadOperatorPolicy} from './policy.ts';
import {buildProjectReport,renderProjectReport,renderReportError,reportContentSecurityPolicy} from './project-report.ts';
import {readChangeInput} from './yaml-change.ts';
import type {RuntimeExtension} from './extensions.ts';

export interface StudioPageOptions {
  project:string;
  /** An earlier version, as `urlcode report` takes it: a project directory or a YAML file. */
  before?:string|undefined;
  /** Path to the operator binding policy (`--policy`). */
  policyFile?:string|undefined;
  /** Registrations from the operator host file (`--host-file`). */
  extensions?:RuntimeExtension[]|undefined;
}
export interface StudioOptions extends StudioPageOptions { host:string; port:number }
export interface Studio { url:string; close():Promise<void> }

// The page describes the project to whoever can load it, so it is served to this machine only. Checking the Host
// header as well keeps a web page that rebinds its own name to 127.0.0.1 from reading it.
const loopback=new Set(['127.0.0.1','::1','[::1]','localhost']);
const hostname=(header:string|undefined):string=>header===undefined?'':header.startsWith('[')?header.slice(0,header.indexOf(']')+1):header.split(':')[0]!;

/** One page, fresh from disk. A project that does not load renders its error instead of stopping the studio. */
export async function renderStudioPage(options:StudioPageOptions):Promise<{status:number;html:string}> {
  try{
    const policy=await loadOperatorPolicy(options.policyFile,options.project);
    const before=options.before===undefined?undefined:{input:await readChangeInput(options.before),label:options.before};
    return {status:200,html:renderProjectReport(await buildProjectReport(options.project,{extensions:options.extensions,policy,before}))};
  }catch(error){
    return {status:500,html:renderReportError(error instanceof Error?error.message:String(error))};
  }
}

export function startStudio(options:StudioOptions):Promise<Studio> {
  if(!loopback.has(options.host))throw new ConfigError('studio listens on this machine only: use --host 127.0.0.1, ::1 or localhost');
  // Requests that arrive while a page is being built share that build: reloads and extra tabs never start more
  // project loads than one report needs.
  let building:Promise<{status:number;html:string}>|undefined;
  const current=()=>building??=renderStudioPage(options).finally(()=>{building=undefined;});
  const server=http.createServer((req,res)=>{
    const text=(status:number,body:string,headers:Record<string,string>={})=>res.writeHead(status,{'content-type':'text/plain; charset=utf-8',...headers}).end(body);
    if(!loopback.has(hostname(req.headers.host)))return text(403,'Studio answers requests for localhost only\n');
    if(req.method!=='GET'&&req.method!=='HEAD')return text(405,'Method not allowed\n',{allow:'GET, HEAD'});
    if(new URL(req.url??'/','http://localhost').pathname!=='/')return text(404,'Not found\n');
    void current().then(({status,html})=>{
      res.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':reportContentSecurityPolicy,'x-content-type-options':'nosniff','referrer-policy':'no-referrer'});
      res.end(req.method==='HEAD'?undefined:html);
    });
  });
  return new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(options.port,options.host,()=>{
      const address=server.address() as AddressInfo;
      resolve({url:`http://${address.family==='IPv6'?`[${address.address}]`:address.address}:${address.port}/`,close:()=>new Promise(done=>{server.close(()=>done());server.closeAllConnections();})});
    });
  });
}
