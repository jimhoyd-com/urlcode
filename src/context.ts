import {readdir,readFile} from 'node:fs/promises';
import {relative} from 'node:path';
import {stringify} from 'yaml';
import {loadDocument} from './config.ts';
import {applySite} from './site.ts';
import {prepareFunctionSnapshot,requestedPermissions} from './policy.ts';
import {compileRoutes} from './router.ts';
import {compilePolicies,closePolicies,effectivePolicies,registry} from './policies.ts';
import {capabilityTargets,getCapabilities,normalizeCapabilityTarget,routeCapabilities} from './capabilities.ts';
import type {CapabilityName,CapabilityTarget} from './capabilities.ts';
import {loadOperatorHost} from './operator-host.ts';
import type {CompiledRoute,PolicyName,PolicyShared} from './types.ts';

export interface ContextOptions {
 /** Restrict the target table to one capability target. */
 target?:string|undefined;
 /** Absolute path to a trusted operator host module outside the project; its extensions and plugins are counted, never run. */
 hostFile?:string|undefined;
 /** Estimated token budget; sections are dropped in a fixed order until the YAML rendering fits. */
 budget?:number|undefined;
 /** What `--project` should say in the emitted commands; defaults to the project argument itself. */
 projectFlag?:string|undefined;
}
export type ContextSection='routes'|'targets'|'constraintNotes'|'files'|'commands'|'summary';
export interface ProjectContext {
 urlcode:string;schema:'1';
 project:{
  entry:string;routes:number;handlers:Record<string,number>;extensions:string[];
  policies:{project:string[];routes:Record<string,number>};
  bindings:{env:string[];secrets:string[]};site:string[];
  files?:{includes:string[];functions:string[];middleware:string[]};
  host?:{extensions:string[];plugins:number};
 };
 routes?:{path:string;methods:string[];handler:string;sandbox:boolean;sandboxReason?:string}[];
 constraints:Record<string,boolean|string|{value:boolean|string;note:string}>;
 targets?:Record<string,{deployment:string;supported:string[];conditional:string[];refused:string[];unknown:string[]}>;
 commands?:Record<string,string>;
 omitted?:ContextSection[];
}
/** Characters divided by four, rounded up: an estimate, not a tokenizer. */
export function estimateTokens(text:string):number {return Math.ceil(text.length/4);}
export function renderContext(context:ProjectContext):string {return stringify(context,{lineWidth:0,aliasDuplicateObjects:false});}
const handlerNames=['redirect','respond','page','static','download','function','proxy','conditional','extension'] as const;
const policyNames=Object.keys(registry).sort() as PolicyName[];
// Fixed for every project: what generation must not attempt, whatever the documentation says.
const constraints:Record<string,{value:boolean|string;note:string}>={
 guestNetwork:{value:true,note:'Trusted (default) functions and middleware run in-process with full Node network access; route `sandbox: true` runs that route in a WASM sandbox without fetch or sockets, where outbound calls must be proxy or signals routes under operator grants'},
 nodeApis:{value:true,note:'Trusted (default) functions and middleware have full Node built-ins, process, filesystem and npm packages available, same as any other project code; route `sandbox: true` restricts that route to relative ES-module imports only, no Node built-ins/filesystem/npm packages'},
 regexRoutes:{value:false,note:'Paths are whole segments: exact literals or {param} placeholders declared as required string parameters'},
 oneHandlerPerRoute:{value:true,note:'Exactly one of redirect, respond, page, static, download, function, proxy, conditional or extension; middleware wraps it'},
 pathShape:{value:'exact or {param}',note:'No greedy captures or general-purpose wildcards; a segment is a literal or a named placeholder'},
 wildcardMounts:{value:false,note:'Only static and extension routes mount a subtree; nothing else matches below its path'},
 yamlInterpolation:{value:false,note:'No ${...} templating; bind typed inputs through parameters, args and context'},
 builtInBeforeCode:{value:true,note:'Check built-ins before writing code: policies.security (security headers), cacheControl (four fixed values on page/download/static), request.body (size, type, JSON), methods, policies.throttle/agents/compression/cache, site (robots, sitemap, favicon, security.txt); no native storage or CORS'},
 secretsByOperatorGrant:{value:true,note:'Projects request named env and secret bindings; only an operator policy pinned to the project revision grants them'},
};
const routesOf=(table:Awaited<ReturnType<typeof compileRoutes>>):CompiledRoute[]=>[...table.exact.values(),...[...table.byLength.values()].flat(),...table.mounts];
const sorted=(values:Iterable<string>)=>[...new Set(values)].sort();
async function packageVersion():Promise<string> {return (JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')) as {version:string}).version;}
/** Same loader and semantic compiler as inspectProject: no binding reads, no guest execution, no network. */
async function compile(project:string) {
 const loaded=await loadDocument(project);await applySite(loaded,{});
 const snapshot=await prepareFunctionSnapshot(loaded),bindings:Record<string,string>=Object.create(null);
 for(const route of Object.values(loaded.routes)) {for(const ref of Object.values(route.env||{}))if(ref.env)bindings[ref.env]='validation-only';for(const ref of Object.values(route.secrets||{}))bindings[ref.secret]='validation-only';}
 const compiled=await compileRoutes(loaded,bindings,requestedPermissions(loaded,snapshot),snapshot.projectSha256),routes=routesOf(compiled);
 const shared:PolicyShared={target:'node',routes:routes.length,log:()=>{}};
 try {for(const route of routes)await compilePolicies(loaded.document,route,{route,shared,target:'node',root:loaded.root});}finally{await closePolicies(shared);}
 return {loaded,compiled,routes};
}
function handlerOf(route:CompiledRoute):string {return handlerNames.find(name=>route[name])??'none';}
/** Derived only from the compiled project and the capability catalog, never from prose. Key order is fixed. */
export async function buildContext(project:string,options:ContextOptions={}):Promise<ProjectContext> {
 const budget=options.budget;
 if(budget!==undefined&&(!Number.isSafeInteger(budget)||budget<1))throw new Error('Invalid context budget');
 const selected:CapabilityTarget[]=options.target===undefined?[...capabilityTargets]:[normalizeCapabilityTarget(options.target)];
 const host=await loadOperatorHost(options.hostFile,project);
 try {
  const {loaded,compiled,routes}=await compile(project),document=loaded.document;
  const handlers:Record<string,number>={},policyCounts:Record<string,number>={},used=new Set<CapabilityName>();
  for(const name of handlerNames)handlers[name]=0;
  for(const name of policyNames)policyCounts[name]=0;
  if(Object.keys(document.extensions??{}).length)used.add('extension');
  for(const route of routes) {
   handlers[handlerOf(route)]=(handlers[handlerOf(route)]??0)+1;
   for(const capability of routeCapabilities(route,document))used.add(capability);
   const effective=effectivePolicies(document,route);
   for(const name of policyNames)if(effective[name])policyCounts[name]!++;
  }
  for(const name of handlerNames)if(!handlers[name])delete handlers[name];
  for(const name of policyNames)if(!policyCounts[name])delete policyCounts[name];
  const declared=Object.values(loaded.routes),env=new Set<string>(),secrets=new Set<string>(),functions=new Set<string>(),middleware=new Set<string>();
  for(const route of declared) {
   for(const ref of Object.values(route.env??{}))if(ref.env)env.add(ref.env);
   for(const ref of Object.values(route.secrets??{}))secrets.add(ref.secret);
   if(route.function)functions.add(route.function.source);
   for(const item of route.middleware??[])middleware.add(item.source);
  }
  const topLevel=effectivePolicies(document,undefined);
  const catalog=getCapabilities();
  const targets:NonNullable<ProjectContext['targets']>={};
  for(const target of selected) {
   const entry={deployment:catalog.targets.find(item=>item.target===target)!.deployment,supported:[] as string[],conditional:[] as string[],refused:[] as string[],unknown:[] as string[]};
   for(const row of catalog.capabilities) {
    if(!used.has(row.capability))continue;
    const support=row.targets[target]?.support??'unknown';
    (support==='refused'?entry.refused:support==='conditional'?entry.conditional:support==='unknown'?entry.unknown:entry.supported).push(row.capability);
   }
   targets[target]=entry;
  }
  const flag=options.projectFlag??project;
  const context:ProjectContext={
   urlcode:await packageVersion(),schema:'1',
   project:{
    entry:'urlcode.yaml',routes:compiled.count,handlers,extensions:sorted(Object.keys(document.extensions??{})),
    policies:{project:policyNames.filter(name=>topLevel[name]),routes:policyCounts},
    bindings:{env:sorted(env),secrets:sorted(secrets)},site:sorted(Object.keys(document.site??{})),
    files:{includes:loaded.files.slice(1).map(file=>relative(loaded.root,file).split('\\').join('/')),functions:sorted(functions),middleware:sorted(middleware)},
    ...(options.hostFile===undefined?{}:{host:{extensions:sorted((host.extensions??[]).map(item=>item.name)),plugins:(host.plugins??[]).length}}),
   },
   routes:routes.map(route=>({path:route.pattern,methods:route.methods,handler:handlerOf(route),sandbox:route.sandbox===true,...(route.sandboxReason?{sandboxReason:route.sandboxReason}:{})})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),
   constraints:{...constraints},
   targets,
   commands:{
    validate:`urlcode validate --local --project ${flag}`,
    test:`urlcode test --project ${flag}`,
    audit:`urlcode audit --project ${flag} --expect-routes ${compiled.count}`,
    routes:`urlcode routes --project ${flag}`,
    capabilities:`urlcode capabilities${options.target===undefined?'':` --target ${selected[0]}`}`,
   },
  };
  return budget===undefined?context:fitBudget(context,budget);
 } finally {await host.close?.();}
}
// Sections leave in this order; each step is a fixed transformation so two runs agree.
const drops:[ContextSection,(context:ProjectContext)=>void][]=[
 ['routes',context=>{delete context.routes;}],
 ['targets',context=>{delete context.targets;}],
 ['constraintNotes',context=>{for(const [key,item] of Object.entries(context.constraints))context.constraints[key]=typeof item==='object'?item.value:item;}],
 ['files',context=>{delete context.project.files;}],
 ['commands',context=>{delete context.commands;}],
 ['summary',context=>{context.project={entry:context.project.entry,routes:context.project.routes,handlers:context.project.handlers,extensions:[],policies:{project:[],routes:{}},bindings:{env:[],secrets:[]},site:[]};}],
];
function fitBudget(context:ProjectContext,budget:number):ProjectContext {
 const omitted:ContextSection[]=[];
 const fits=()=>estimateTokens(renderContext(omitted.length?{...context,omitted}:context))<=budget;
 for(const [section,drop] of drops) {if(fits())break;drop(context);omitted.push(section);}
 if(!fits())throw new Error(`Context budget ${budget} is below the smallest rendering`);
 return omitted.length?{...context,omitted}:context;
}
/** Estimated size of the shipped documentation (docs/*.md and llms.txt), for comparison with an emitted context. */
export async function documentationTokens():Promise<number> {
 const docs=new URL('../docs/',import.meta.url);let chars=0;
 for(const name of (await readdir(docs)).filter(name=>name.endsWith('.md')).sort())chars+=(await readFile(new URL(name,docs),'utf8')).length;
 chars+=(await readFile(new URL('../llms.txt',import.meta.url),'utf8')).length;
 return Math.ceil(chars/4);
}
