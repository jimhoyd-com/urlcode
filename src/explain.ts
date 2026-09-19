import {relative} from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import {analyzeCompiledCapabilities,capabilityTargets,routeCapabilities} from './capabilities.ts';
import type {CapabilityName,CapabilityTarget} from './capabilities.ts';
import {effectiveExtensionPolicies} from './extensions.ts';
import type {RuntimeExtension} from './extensions.ts';
import {effectivePolicies} from './policies.ts';
import type {CompiledRoute,LoadedDocument,PolicyChain,PolicyInventory,RouteState} from './types.ts';
import type {HandlerName} from './readiness.ts';
import type {ParameterSchema,ParameterLocation} from './match.ts';
import type {RequestBodyPolicy} from './http-policy.ts';

// Effective route behavior read from the compiled IR (config → router →
// policies), never from request execution. Everything here is safe to print:
// binding values are replaced by their names, module paths are made
// project-relative and secrets never appear.

const handlerNames=['extension','proxy','conditional','redirect','function','page','static','download','respond'] as const satisfies readonly HandlerName[];

export interface ExplainedHandler { kind:HandlerName|'none'; [detail:string]:unknown }
export interface ExplainedParameter { name:string; in:ParameterLocation; required:boolean; schema:ParameterSchema }
export interface ExtensionProvider { registered:boolean; version?:string; targets?:string[]; revisionMatch?:boolean; requirementValid?:boolean|null }
export interface ExplainedExtensionRequirement { requirement:Record<string,unknown>; provider?:ExtensionProvider }
export interface ExplainedCache {
  /** What a response from this route carries: the policy strategy, the header source or `none`. */
  outcome:string; cacheControl?:string; forcedNoStore:boolean; reason?:string;
}
export interface TargetSupport { compatible:boolean; issues:{capability:CapabilityName;support:string;reason:string}[] }
export interface RouteExplanation {
  matched:true; path:string; description?:string; generated?:string; state:RouteState; enabled:boolean; expires?:string;
  methods:string[]; conditional:boolean; handler:ExplainedHandler; middleware:{source:string;export:string}[];
  inputs:{parameters:ExplainedParameter[];body?:RequestBodyPolicy};
  policies:{names:string[];inventory:PolicyInventory;extensions:Record<string,ExplainedExtensionRequirement>};
  cache:ExplainedCache;
  bindings:{env:Record<string,{env:string}|{literal:true}>;secrets:Record<string,{secret:string}>};
  egress:{proxy?:string;signals?:string[]};
  responseHeaders:[string,string][]; capabilities:CapabilityName[]; targets:Record<CapabilityTarget,TargetSupport>;
  note:string;
}
export interface ExplainOptions { extensions?:RuntimeExtension[]|undefined; projectSha256?:string|undefined; now?:number|undefined }

const relativeSource=(root:string,source:string):string=>relative(root,source).split('\\').join('/');
function origin(url:string):string {try{return new URL(url).origin;}catch{return url;}}

function handlerOf(route:CompiledRoute,root:string):ExplainedHandler {
  const kind=handlerNames.find(key=>route[key]);
  switch(kind){
    case 'extension':return {kind,name:route.extension};
    case 'proxy':return {kind,url:route.proxy!.url,...(route.proxy!.query?{query:route.proxy!.query}:{}),...(route.proxy!.requestHeaders?{requestHeaders:route.proxy!.requestHeaders}:{}),...(route.proxy!.responseHeaders?{responseHeaders:route.proxy!.responseHeaders}:{})};
    case 'conditional':{
      const branch=(entry:CompiledRoute)=>entry.redirect?{redirect:{url:entry.redirect.url,status:entry.redirect.status??302}}:{respond:{status:entry.reply?.status??200}};
      return {kind,cases:(route.conditionalRoutes?.cases??[]).map(item=>({match:item.match,...branch(item.route)})),...(route.conditionalRoutes?.fallback?{fallback:branch(route.conditionalRoutes.fallback)}:{})};
    }
    case 'redirect':return {kind,url:route.redirect!.url,status:route.redirect!.status??302,...(route.redirect!.query?{query:route.redirect!.query}:{})};
    case 'function':return {kind,source:relativeSource(root,route.function!.source),export:route.function!.export,...(route.function!.args?{args:route.function!.args}:{}),sandbox:route.sandbox===true};
    case 'page':return {kind,file:route.page!.file,...(route.page!.contentType?{contentType:route.page!.contentType}:{})};
    case 'static':return {kind,directory:route.static!.directory,...(route.static!.index?{index:route.static!.index}:{})};
    case 'download':return {kind,file:route.download!.file,...(route.download!.filename?{filename:route.download!.filename}:{}),...(route.download!.contentType?{contentType:route.download!.contentType}:{})};
    case 'respond':return {kind,status:route.reply?.status??route.respond!.status??200};
    default:return {kind:'none'};
  }
}
function cacheOf(route:CompiledRoute,chain:PolicyChain|undefined,extensionPolicies:string[]):ExplainedCache {
  const forced=route.extension?'extension mount':extensionPolicies.length?'extension-protected route':route.proxy?'proxy':route.match||route.conditional?'conditional routing':undefined;
  if(forced)return {outcome:'no-store',cacheControl:'no-store',forcedNoStore:true,reason:`The runtime replaces every cache header on this ${forced} with no-store`};
  const policy=chain?.describe.cache;
  if(policy){const cacheControl=policy.cacheControl;return {outcome:policy.strategy??'policy',...(cacheControl===undefined?{}:{cacheControl}),forcedNoStore:false,reason:policy.target==='delegated'?'policies.cache is delegated to the provider on this target':'policies.cache compiled for this route'};}
  const header=route.responseHeaders.find(([name])=>name.toLowerCase()==='cache-control');
  if(header)return {outcome:'explicit response header',cacheControl:header[1],forcedNoStore:false,reason:'response.headers declares Cache-Control'};
  const asset=route.page?.cacheControl??route.download?.cacheControl??route.static?.cacheControl;
  if(asset)return {outcome:'asset handler',cacheControl:asset,forcedNoStore:false,reason:'the asset declaration sets cacheControl'};
  return {outcome:'none',forcedNoStore:false,reason:'no cache policy or Cache-Control header is declared'};
}
function providerOf(name:string,requirement:Record<string,unknown>|undefined,options:ExplainOptions):ExtensionProvider|undefined {
  if(!options.extensions)return undefined;
  const registration=options.extensions.find(entry=>entry.name===name);
  if(!registration)return {registered:false};
  let requirementValid:boolean|null=null;
  if(requirement)try{requirementValid=registration.policySchema?Boolean(new Ajv.default({strict:false,allErrors:false}).compile(registration.policySchema)(requirement)):false;}catch{requirementValid=false;}
  return {registered:true,version:registration.version,targets:[...registration.targets],revisionMatch:options.projectSha256===undefined?false:registration.projectSha256===options.projectSha256,requirementValid};
}
function targetsOf(loaded:LoadedDocument,route:CompiledRoute,options:ExplainOptions):Record<CapabilityTarget,TargetSupport> {
  const table={exact:new Map([[route.pattern,route]]),byLength:new Map(),mounts:[],modules:[],count:1};
  const result={} as Record<CapabilityTarget,TargetSupport>;
  for(const target of capabilityTargets){
    const report=analyzeCompiledCapabilities(loaded.document,table,target,options.extensions);
    const issues=report.issues.filter(issue=>issue.path===route.pattern).map(({capability,support,reason})=>({capability,support,reason}));
    result[target]={compatible:issues.length===0,issues};
  }
  return result;
}
export function routeState(route:CompiledRoute,now:number):RouteState {return route.enabled===false?'disabled':route.expiresAt&&now>=route.expiresAt?'expired':'active';}
/** Describe one compiled route. `chain` is the policy chain compiled for it, when the project declares policies. */
export function explainCompiledRoute(loaded:LoadedDocument,route:CompiledRoute,chain:PolicyChain|undefined,options:ExplainOptions={}):RouteExplanation {
  const root=loaded.root,declared=loaded.routes[route.pattern];
  const extensionRequirements=effectiveExtensionPolicies(loaded.document,route),extensionNames=Object.keys(extensionRequirements).sort();
  const extensions:Record<string,ExplainedExtensionRequirement>={};
  for(const name of extensionNames){const provider=providerOf(name,extensionRequirements[name],options);extensions[name]={requirement:extensionRequirements[name]!,...(provider?{provider}:{})};}
  const env:RouteExplanation['bindings']['env']={};
  for(const [alias,ref]of Object.entries(declared?.env??{}))env[alias]=ref.env?{env:ref.env}:{literal:true};
  const secrets:RouteExplanation['bindings']['secrets']={};
  for(const [alias,ref]of Object.entries(declared?.secrets??{}))secrets[alias]={secret:ref.secret};
  const inventory=chain?.describe??{};
  const names=[...Object.keys(effectivePolicies(loaded.document,route)),...extensionNames.map(name=>`extensions.${name}`)];
  const handler=handlerOf(route,root);
  if(handler.kind==='extension'){const provider=providerOf(route.extension!,undefined,options);if(provider)handler.provider=provider;}
  const egress:RouteExplanation['egress']={...(route.proxy?{proxy:origin(route.proxy.url)}:{}),...(route.signals?.length?{signals:[...new Set(route.signals.map(signal=>origin(signal.url)))]}:{})};
  return {
    matched:true,path:route.pattern,...(route.description?{description:route.description}:{}),...(route.generated?{generated:route.generated}:{}),
    state:routeState(route,options.now??Date.now()),enabled:route.enabled!==false,...(route.expires?{expires:route.expires}:{}),
    methods:[...route.methods],conditional:Boolean(route.match||route.conditional),handler,
    middleware:route.middleware.map(item=>({source:relativeSource(root,item.source),export:item.export})),
    inputs:{parameters:route.parameters.map(({name,in:location,required,schema})=>({name,in:location,required,schema})),...(route.request?.body?{body:route.request.body}:{})},
    policies:{names,inventory,extensions},
    cache:cacheOf(route,chain,extensionNames),
    bindings:{env,secrets},egress,
    responseHeaders:route.responseHeaders.map(([name,value])=>[name,value]),
    capabilities:routeCapabilities(route,loaded.document),targets:targetsOf(loaded,route,options),
    note:'Derived from the compiled configuration; request conditions, parameter values and handler execution are not evaluated.',
  };
}
// Edit distance between a requested path and each pattern, so a typo points
// at the route the author probably meant.
function distance(a:string,b:string):number {
  const previous=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){let diagonal=previous[0]!;previous[0]=i;for(let j=1;j<=b.length;j++){const temp=previous[j]!;previous[j]=Math.min(previous[j]!+1,previous[j-1]!+1,diagonal+(a[i-1]===b[j-1]?0:1));diagonal=temp;}}
  return previous[b.length]!;
}
export function nearestRoutes(target:string,patterns:Iterable<string>,limit=3):string[] {
  return [...patterns].map(pattern=>({pattern,score:distance(target.toLowerCase(),pattern.toLowerCase())})).sort((a,b)=>a.score-b.score||(a.pattern<b.pattern?-1:1)).slice(0,limit).map(item=>item.pattern);
}
