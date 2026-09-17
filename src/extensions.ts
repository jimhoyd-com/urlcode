import Ajv from 'ajv/dist/2020.js';
import { assert, HttpError } from './errors.ts';
import { loadDocument } from './config.ts';
import { prepareFunctionSnapshot } from './policy.ts';
import { validateHeaderName, validateHeaderValue } from './header-validation.ts';
import type { HandlerResult } from './http-response.ts';
import type { ProjectDocument, RouteConfig, TargetName } from './types.ts';
export type { HandlerResult } from './http-response.ts';
export interface ExtensionDeclaration { version:'1'; config:Record<string,unknown> }
export type ExtensionPolicies = Record<string,Record<string,unknown>|false>;
export interface ExtensionActivation { origin:string; target:TargetName; projectSha256:string; mounts:readonly string[] }
export interface ExtensionRequest {
  method:string; target:string; path:string; query:URLSearchParams; headers:Headers;
  headerCounts:Record<string,number>; body:Uint8Array; origin:string; route:string;
  mount:string|null; client:string|null;
}
export interface ExtensionInstance {
  handle(request:ExtensionRequest):HandlerResult|Promise<HandlerResult>;
  authorize?(requirement:Readonly<Record<string,unknown>>,request:ExtensionRequest):HandlerResult|undefined|Promise<HandlerResult|undefined>;
  close?():void|Promise<void>;
}
/** Trusted operator code only. YAML declares names/configuration, never modules. */
export interface RuntimeExtension {
  name:string; version:'1'; projectSha256:string; targets:TargetName[];
  schema:object; policySchema?:object; credentialHeaders?:string[];
  activate(config:Readonly<Record<string,unknown>>,context:ExtensionActivation):ExtensionInstance|Promise<ExtensionInstance>;
}
export interface ActiveExtension { instance:ExtensionInstance; policies:Map<string,Readonly<Record<string,unknown>>> }
export interface ExtensionRegistry { entries:Map<string,ActiveExtension>; credentialHeaders:string[]; close():Promise<void> }
const namePattern=/^[a-z][a-z0-9-]{0,63}$/;
const cacheHeaders=new Set(['cache-control','cdn-cache-control','vercel-cdn-cache-control','surrogate-control']);
function frozen<T>(value:T):T {if(value&&typeof value==='object'){for(const child of Object.values(value))frozen(child);Object.freeze(value);}return value;}
/** Inspection alone grants nothing; operators must explicitly pin the returned revision. */
export async function inspectExtensionRevision(project:string):Promise<string> {return (await prepareFunctionSnapshot(await loadDocument(project))).projectSha256;}
export function effectiveExtensionPolicies(document:ProjectDocument,route:Pick<RouteConfig,'policies'>):Record<string,Record<string,unknown>> {
  const project=document.policies??{},local=route.policies??{};
  const layers=[project.profile?document.profiles?.[project.profile]:undefined,project,local.profile?document.profiles?.[local.profile]:undefined,local];
  const result:Record<string,Record<string,unknown>>=Object.create(null) as Record<string,Record<string,unknown>>;
  for(const layer of layers){if(layer?.extensions===false){for(const key of Object.keys(result))delete result[key];continue;}
    for(const [name,value]of Object.entries(layer?.extensions??{})) {if(value===false)delete result[name];else result[name]={...result[name],...value};}
  }
  return result;
}
export function hasExtensionPolicy(document:ProjectDocument,route:Pick<RouteConfig,'policies'>):boolean {return Object.keys(effectiveExtensionPolicies(document,route)).length>0;}
export function prepareExtensions(document:ProjectDocument,routes:Record<string,RouteConfig>,registrations:RuntimeExtension[]|undefined,context:Omit<ExtensionActivation,'mounts'>): {activate():Promise<ExtensionRegistry>} {
  assert(registrations===undefined||Array.isArray(registrations)&&registrations.length<=16,'Extensions must be an array of at most 16 operator registrations');
  const provided=new Map<string,RuntimeExtension>(),entries=new Map<string,ActiveExtension>(),credentialHeaders=new Set<string>();
  for(const registration of registrations??[]){
    assert(registration&&typeof registration==='object'&&typeof registration.name==='string'&&namePattern.test(registration.name),'Invalid extension registration');
    assert(!provided.has(registration.name),'Duplicate extension provider');
    assert(registration.version==='1'&&typeof registration.activate==='function','Invalid extension version or activation hook');
    assert(Array.isArray(registration.targets)&&registration.targets.every(target=>['node','aws','vercel'].includes(target)),'Extension targets must be node, aws or vercel');
    assert(typeof registration.projectSha256==='string'&&/^[a-f0-9]{64}$/.test(registration.projectSha256),'Extension requires an explicit operator revision pin');
    provided.set(registration.name,registration);
  }
  const declarations=document.extensions??{};
  if(Object.keys(declarations).length){let origin:URL;try{origin=new URL(context.origin);}catch{throw new Error('Extensions require an explicit operator origin');}assert(['http:','https:'].includes(origin.protocol)&&!origin.username&&!origin.password&&origin.origin===context.origin,'Extensions require an explicit canonical HTTP(S) operator origin');}
  for(const route of Object.values(routes)){
    if(route.extension)assert(Object.hasOwn(declarations,route.extension),'Extension route has no declaration');
    for(const name of Object.keys(effectiveExtensionPolicies(document,route)))assert(Object.hasOwn(declarations,name),'Extension policy has no declaration');
  }
  const preparations:{name:string;registration:RuntimeExtension;config:Readonly<Record<string,unknown>>;policies:Map<string,Readonly<Record<string,unknown>>>;mounts:string[]}[]=[];
  for(const [name,declaration]of Object.entries(declarations)){
      const registration=provided.get(name);assert(registration,`Missing operator extension: ${name}`);
      assert(registration.projectSha256===context.projectSha256,`Extension revision pin mismatch: ${name}`);
      assert(registration.targets.includes(context.target),`Extension ${name} refuses target ${context.target}`);
      assert(declaration.version===registration.version,`Extension contract version mismatch: ${name}`);
      const config=structuredClone(declaration.config);
      const ajv=new Ajv.default({strict:true,allErrors:false});
      assert(ajv.compile(registration.schema)(config),`Invalid extension configuration: ${name}`);
      const policyValidator=registration.policySchema?ajv.compile(registration.policySchema):undefined;
      const policies=new Map<string,Readonly<Record<string,unknown>>>();
      for(const [path,route]of Object.entries(routes)){const policy=effectiveExtensionPolicies(document,route)[name];if(policy){assert(policyValidator&&policyValidator(policy),`Invalid extension policy: ${name} at ${path}`);policies.set(path,frozen(structuredClone(policy)));}}
      const declaredHeaders=registration.credentialHeaders??[];
      assert(Array.isArray(declaredHeaders)&&declaredHeaders.length<=64,'Invalid extension credential headers');
      for(const header of declaredHeaders){assert(typeof header==='string'&&header.length<=128,'Invalid extension credential header');validateHeaderName(header);credentialHeaders.add(header.toLowerCase());}
      // Session and bearer credentials never cross into application guests.
      credentialHeaders.add('cookie');credentialHeaders.add('authorization');
      const mounts=Object.entries(routes).filter(([,route])=>route.extension===name).map(([path])=>path.endsWith('/*')?path.slice(0,-2):path);
      preparations.push({name,registration,config:frozen(config),policies,mounts});
  }
  return {async activate(){
    try{for(const {name,registration,config,policies,mounts}of preparations){
      const instance=await registration.activate(config,frozen({...context,mounts}));
      if(instance&&typeof instance==='object')entries.set(name,{instance,policies});
      assert(instance&&typeof instance.handle==='function'&&(!policies.size||typeof instance.authorize==='function'),`Extension ${name} lacks a required handler or authorization hook`);
      entries.set(name,{instance,policies});
    }}catch(error){for(const entry of [...entries.values()].reverse())try{await entry.instance.close?.();}catch{/* Keep the activation failure. */}throw error;}
    return {entries,credentialHeaders:[...credentialHeaders],async close(){for(const entry of [...entries.values()].reverse())try{await entry.instance.close?.();}catch{/* Operators own extension lifecycle diagnostics. */}}};
  }};
}
/** Mandatory privacy floor after trusted response hooks, with bounded output. */
export function extensionResponse(result:HandlerResult):HandlerResult {
  assert(result&&Number.isInteger(result.status)&&result.status>=200&&result.status<=599&&Array.isArray(result.headers),'Invalid extension response');
  if(result.body&&Buffer.byteLength(result.body)>1048576)throw new HttpError(502,'Extension response exceeds limit');
  let bytes=0;assert(result.headers.length<=256,'Extension response has too many headers');
  for(const [name,value]of result.headers){validateHeaderName(name);validateHeaderValue(name,value);bytes+=Buffer.byteLength(name)+Buffer.byteLength(value)+4;}
  if(bytes>16384)throw new HttpError(502,'Extension response headers exceed limit');
  return {...result,headers:[...result.headers.filter(([name])=>!cacheHeaders.has(name.toLowerCase())),['cache-control','no-store']]};
}
