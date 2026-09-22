import { request } from 'node:https';
import { createHash } from 'node:crypto';

export type VerificationTarget = 'self-hosted' | 'aws' | 'vercel' | 'cloudflare';
export interface ProviderProbe { id:string; path:string; method:string; headers:Record<string,string>; body?:string; expected:{status:number;headers?:Record<string,string>;body?:string} }
export interface ProviderAnswer { status:number; headers:Record<string,string>; body:string }
export type ProviderTransport = (probe:ProviderProbe, signal:AbortSignal)=>Promise<ProviderAnswer>;
export interface ProviderVerificationOptions { timeoutMs?:number; release?:string; gitCommit?:string }
export interface ProviderFinding { case:string; pass:boolean; expectedStatus:number; observedStatus:number|null; failures:string[] }
export interface ProviderVerificationReport {
  schemaVersion:1; fixtureVersion:1; target:VerificationTarget; origin:string|null;
  evidence:'local-adapter'|'deployment-http'; providerVerification:'unverified'|'observed';
  timestamp:string; release:string|null; gitCommit:string|null; fixtureSha256:string;
  pass:boolean; requests:number; findings:ProviderFinding[]; notes:string[];
}
const MAX_BYTES=64*1024;
const prefix='/urlcode-conformance';
/** Synthetic read-only routes, except a POST to a declared constant response. */
export function providerConformanceCases():ProviderProbe[] {
  return [
    {id:'redirect-query-drop',path:`${prefix}/redirect?ignored=secret`,method:'GET',headers:{},expected:{status:302,headers:{location:'https://example.test/destination'},body:''}},
    {id:'redirect-head',path:`${prefix}/redirect`,method:'HEAD',headers:{},expected:{status:302,headers:{location:'https://example.test/destination'},body:''}},
    {id:'path-component',path:`${prefix}/people/A%20B`,method:'GET',headers:{},expected:{status:307,headers:{location:'https://example.test/people/A%20B'},body:''}},
    {id:'query-validation',path:`${prefix}/query?n=7&ignored=yes`,method:'GET',headers:{},expected:{status:302,headers:{location:'https://example.test/query?n=7'},body:''}},
    {id:'query-invalid',path:`${prefix}/query?n=not-a-number`,method:'GET',headers:{},expected:{status:400}},
    {id:'query-duplicate',path:`${prefix}/query?n=1&n=2`,method:'GET',headers:{},expected:{status:400}},
    {id:'constant-response',path:`${prefix}/hello`,method:'GET',headers:{},expected:{status:200,headers:{'content-type':'text/plain; charset=utf-8','x-conformance':'v1'},body:'provider conformance v1'}},
    {id:'response-head',path:`${prefix}/hello`,method:'HEAD',headers:{},expected:{status:200,body:''}},
    {id:'method-refusal',path:`${prefix}/hello`,method:'POST',headers:{},body:'',expected:{status:405,headers:{allow:'GET, HEAD'}}},
    {id:'body-accepted',path:`${prefix}/body`,method:'POST',headers:{'content-type':'text/plain'},body:'small',expected:{status:200,body:'accepted'}},
    {id:'body-limit',path:`${prefix}/body`,method:'POST',headers:{'content-type':'text/plain'},body:'x'.repeat(33),expected:{status:413}},
    {id:'missing-route',path:`${prefix}/missing`,method:'GET',headers:{},expected:{status:404}},
  ];
}
function optionsChecked(target:VerificationTarget,options:ProviderVerificationOptions):number {
  if(!['self-hosted','aws','vercel','cloudflare'].includes(target))throw new Error('Unknown verification target');
  const timeout=options.timeoutMs??3000;
  if(!Number.isInteger(timeout)||timeout<50||timeout>10000)throw new Error('Timeout must be 50–10000 ms');
  for(const value of [options.release,options.gitCommit])if(value!==undefined&&(typeof value!=='string'||value.length>256||/[\u0000-\u001f\u007f]/u.test(value)))throw new Error('Release identity must be at most 256 printable characters');
  return timeout;
}
async function run(target:VerificationTarget,transport:ProviderTransport,options:ProviderVerificationOptions,origin:string|null):Promise<ProviderVerificationReport> {
  const timeout=optionsChecked(target,options),cases=providerConformanceCases(),findings:ProviderFinding[]=[];
  const deadline=performance.now()+60000;let requests=0;
  for(const probe of cases){
    const failures:string[]=[];let status:number|null=null;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const remaining=deadline-performance.now();if(remaining<=0)throw new Error('suite deadline');
      requests++;
      const answer=await Promise.race([transport(probe,controller.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(new Error('request deadline'));controller.abort();},Math.min(timeout,remaining));})]);
      status=answer.status;
      if(Buffer.byteLength(answer.body)>MAX_BYTES)throw new Error('response limit');
      if(answer.status!==probe.expected.status)failures.push('status differs');
      const headers=Object.fromEntries(Object.entries(answer.headers).map(([name,value])=>[name.toLowerCase(),value]));
      for(const [name,value]of Object.entries(probe.expected.headers??{}))if(headers[name]!==value)failures.push(`header ${name} differs`);
      if(probe.expected.body!==undefined&&answer.body!==probe.expected.body)failures.push('body differs');
    }catch{failures.push('transport, deadline or response-limit failure');}
    finally{clearTimeout(timer);controller.abort();}
    findings.push({case:probe.id,pass:failures.length===0,expectedStatus:probe.expected.status,observedStatus:status,failures});
  }
  return {schemaVersion:1,fixtureVersion:1,target,origin,evidence:origin===null?'local-adapter':'deployment-http',providerVerification:origin===null?'unverified':'observed',timestamp:new Date().toISOString(),release:options.release??null,gitCommit:options.gitCommit??null,fixtureSha256:createHash('sha256').update(JSON.stringify(cases)).digest('hex'),pass:findings.every(f=>f.pass),requests,findings,notes:[
    origin===null?'Local adapter replay is not evidence of a deployed provider.':'HTTP observations apply only to the supplied origin and timestamp; provider identity and ownership are asserted by the caller, not attested.',
    'Release and Git identities are caller-supplied labels, not independently verified deployment identity.',
    'No provisioning, credentials, policy guarantees, soak, recovery or independent security assessment is included.',
    'Duplicate raw header counts and malformed-path normalization can differ at provider ingress; this common suite does not prove those transports equivalent.'
  ]};
}
/** Replay against a caller-supplied local adapter; never label this a provider deployment. */
export async function runProviderConformance(target:VerificationTarget,transport:ProviderTransport,options:ProviderVerificationOptions={}):Promise<ProviderVerificationReport> {
  return run(target,transport,options,null);
}
function httpsTransport(origin:URL):ProviderTransport {
  return (probe,signal)=>new Promise((resolve,reject)=>{
    let settled=false;
    const fail=()=>{if(!settled){settled=true;reject(new Error('HTTPS probe failed'));}};
    const req=request(new URL(probe.path,origin),{method:probe.method,headers:{'user-agent':'URLCode-provider-conformance/1','accept-encoding':'identity',...probe.headers},agent:false,maxHeaderSize:16384,signal},res=>{
      const chunks:Buffer[]=[];let size=0;
      res.on('error',fail);res.on('aborted',fail);
      res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>MAX_BYTES){fail();res.destroy();req.destroy();}else chunks.push(chunk);});
      res.on('end',()=>{if(settled)return;settled=true;const headers:Record<string,string>={};for(const [name,value]of Object.entries(res.headers))if(value!==undefined)headers[name]=Array.isArray(value)?value.join(', '):value;resolve({status:res.statusCode??0,headers,body:Buffer.concat(chunks).toString('utf8')});});
    });
    req.on('error',fail);req.end(probe.body);
  });
}
/** Probe only an explicitly supplied, operator-owned deployment of the fixture. Redirects are never followed. */
export async function verifyProviderDeployment(target:VerificationTarget,origin:string,options:ProviderVerificationOptions={}):Promise<ProviderVerificationReport> {
  optionsChecked(target,options);
  const url=new URL(origin);
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.origin!==origin.replace(/\/$/,''))throw new Error('Provide an explicit HTTPS origin without credentials, path, query or fragment');
  return run(target,httpsTransport(url),options,url.origin);
}
