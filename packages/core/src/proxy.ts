import { EgressError, egressUrl, safeEgressHeaders } from './egress.ts';
import type { EgressRequest, EgressResponse } from './egress.ts';
import { isReservedContextHeader } from './extensions.ts';
export interface ProxyDefinition { url:string; query?:string[]; requestHeaders?:string[]; responseHeaders?:string[]; headers?:Record<string,string> }
interface ProxyInput { method:string; url:string|URL; params:Record<string,unknown>; headers:Record<string,string|undefined>; body?:Uint8Array; signal?:AbortSignal }
export interface EgressTransport { request(input:EgressRequest):Promise<EgressResponse> }
const sensitive=new Set(['authorization','cookie','set-cookie','proxy-authorization','forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto']);
export function validateProxy(definition:ProxyDefinition):void {
  if(!definition||typeof definition!=='object'||Object.keys(definition).some(key=>!['url','query','requestHeaders','responseHeaders','headers'].includes(key))) throw new EgressError('denied');
  const parsed=egressUrl(definition.url);
  if(/[{}]/.test(parsed.host)||(/[{}]/.test(parsed.search)||/%7[bd]/i.test(parsed.search))||/%7[bd]/i.test(parsed.host)) throw new EgressError('denied');
  if(/%7[bd]/i.test(parsed.pathname.replace(/%7B[A-Za-z_][A-Za-z0-9_]*%7D/gi,''))) throw new EgressError('denied');
  if(definition.url.length>8192) throw new EgressError('limit');
  for(const list of [definition.query,definition.requestHeaders,definition.responseHeaders]) if(list&&(!Array.isArray(list)||list.length>32||list.some(value=>typeof value!=='string'||!value||value.length>128))) throw new EgressError('denied');
  // The reserved extension-context namespace (RIM-EXT-CONTEXT-001) is meant only
  // for a route's own trusted function/middleware; a project author must never be
  // able to opt a proxy route into forwarding it to an external upstream just by
  // naming it, the same way `sensitive` already blocks credential-shaped names.
  for(const name of [...definition.requestHeaders||[],...definition.responseHeaders||[]]) {if(sensitive.has(name.toLowerCase())||/^x-forwarded-/i.test(name)||isReservedContextHeader(name)) throw new EgressError('denied');safeEgressHeaders({[name]:'x'});}
  safeEgressHeaders(definition.headers||{});
}
export async function executeProxy(client:EgressTransport,definition:ProxyDefinition,input:ProxyInput):Promise<EgressResponse> {
  validateProxy(definition);
  const url=egressUrl(definition.url); const origin=url.origin;
  // URL serializes braces in path unchanged. Arguments can never affect origin/query.
  url.pathname=url.pathname.replace(/%7B([A-Za-z_][A-Za-z0-9_]*)%7D/gi,(_all,name:string)=> {
    const value=input.params[name]; if(typeof value!=='string'||value==='.'||value==='..') throw new EgressError('denied'); return encodeURIComponent(value);
  });
  if((/[{}]/.test(url.pathname))||url.origin!==origin) throw new EgressError('denied');
  const incoming=new URL(input.url); for(const name of definition.query||[]) for(const value of incoming.searchParams.getAll(name)) url.searchParams.append(name,value);
  if(url.href.length>8192) throw new EgressError('limit');
  const headers:Record<string,string>=Object.create(null);
  const requestHop=new Set((input.headers.connection||'').toLowerCase().split(',').map(name=>name.trim()));
  for(const name of definition.requestHeaders||[]) {const value=input.headers[name.toLowerCase()]; if(value!==undefined&&!requestHop.has(name.toLowerCase())) headers[name.toLowerCase()]=value;}
  Object.assign(headers,definition.headers||{});
  const safeHeaders=safeEgressHeaders(headers);
  if(input.body?.byteLength){
    const coding=(value:string|undefined)=>value?.split(',').map(part=>part.trim().toLowerCase()).join(',')||'identity';
    const incomingCoding=coding(input.headers['content-encoding']);
    if(incomingCoding!==coding(safeHeaders['content-encoding'])||(incomingCoding!=='identity'&&!(definition.requestHeaders||[]).some(name=>name.toLowerCase()==='content-encoding')))throw new EgressError('denied');
  }
  const result=await client.request({url:url.href,method:input.method,headers:safeHeaders,...(input.body?{body:input.body}:{}),...(input.signal?{signal:input.signal}:{})});
  if(result.headers['content-encoding']&&result.headers['content-encoding']!=='identity'&&!(definition.responseHeaders||[]).some(name=>name.toLowerCase()==='content-encoding'))throw new EgressError('denied');
  const selected:Record<string,string>=Object.create(null);
  const responseHop=new Set((result.headers.connection||'').toLowerCase().split(',').map(name=>name.trim()));
  for(const name of definition.responseHeaders||[]) {const value=result.headers[name.toLowerCase()]; if(value!==undefined&&!responseHop.has(name.toLowerCase())) selected[name.toLowerCase()]=value;}
  if(result.headers['content-encoding']&&result.headers['content-encoding']!=='identity'&&!selected['content-encoding'])throw new EgressError('denied');
  return {...result,headers:safeEgressHeaders(selected)};
}
