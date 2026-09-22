import {readFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {capabilityTargets,analyzeCompiledCapabilities,routeCapabilities} from './capabilities.ts';
import type {CapabilityName,CapabilityTarget} from './capabilities.ts';
import {parseYaml,safeFile} from './config.ts';
import {effectiveExtensionPolicies} from './extensions.ts';
import {egressUrl} from './egress.ts';
import {prepare} from './tooling.ts';
import type {InspectOptions} from './tooling.ts';
import {explainCompiledRoute} from './explain.ts';
import type {RouteExplanation} from './explain.ts';

// A generated description of what a project declares, for agents, reviews and
// deployment tooling. It is derived from the compiled IR on every call, never
// checked in as a source of truth, and it is deterministic: the same project
// yields the same bytes. Nothing in it is a binding value or source text.

// Bumped to 3 when `sandbox`/`sandboxReason` moved from the `function` handler
// record to the route, so a middleware-only route reports its execution mode too.
export const MANIFEST_SCHEMA_VERSION=3;
export interface ManifestRoute {
  path:string; methods:string[]; handler:RouteExplanation['handler']; enabled:boolean; expires?:string; generated?:string; description?:string;
  /** Execution mode for the route's whole `function`/`middleware` chain: `true` for the
   * QuickJS sandbox, `false` for trusted in-process execution. */
  sandbox:boolean; sandboxReason?:string;
  middleware:{source:string;export:string}[]; parameters:RouteExplanation['inputs']['parameters']; body?:RouteExplanation['inputs']['body'];
  policies:string[]; extensions:Record<string,Record<string,unknown>>; cache:RouteExplanation['cache'];
  bindings:{env:string[];secrets:string[]}; egress:RouteExplanation['egress']; capabilities:CapabilityName[];
  targets:Record<CapabilityTarget,boolean>;
}
export interface ManifestModule { source:string; export:string; routes:string[] }
export interface RecipeProvenance { id:string; description?:string; version?:string; source?:string }
export interface Manifest {
  schemaVersion:typeof MANIFEST_SCHEMA_VERSION; urlcode:string; entry:string; files:string[]; revision:string; configVersion:string;
  routeCount:number; routes:ManifestRoute[]; capabilities:CapabilityName[];
  extensions:Record<string,{version:string;configKeys:string[];mounts:string[];protectedRoutes:string[]}>;
  recipes:RecipeProvenance[];
  external:{env:string[];secrets:string[];egress:{proxy:string[];signals:string[]};extensions:string[]};
  functions:ManifestModule[]; middleware:ManifestModule[];
  targets:Record<CapabilityTarget,{compatible:boolean;issues:number}>;
}
const compare=(a:string,b:string):number=>a<b?-1:a>b?1:0;
const sorted=(values:Iterable<string>):string[]=>[...new Set(values)].sort(compare);
const packageVersion=(JSON.parse(await readFile(new URL('../../../package.json',import.meta.url),'utf8')) as {version:string}).version;
function origin(url:string):string {try{return egressUrl(url).origin;}catch{return url;}}
/**
 * Recipe provenance is read from an optional `recipe.yaml` beside the entry
 * file (the shape `urlcode recipes` metadata uses: `id`, `description`, ...).
 * Only its identifying fields are copied; an absent or unreadable file means no provenance.
 */
async function recipeProvenance(root:string):Promise<RecipeProvenance[]> {
  let path:string;
  try{path=await safeFile(root,'recipe.yaml');}catch{return [];}
  let data:unknown;
  try{data=parseYaml(await readFile(path,'utf8'));}catch{return [];}
  if(!data||typeof data!=='object'||Array.isArray(data))return [];
  const record=data as Record<string,unknown>;
  if(typeof record.id!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(record.id))return [];
  const entry:RecipeProvenance={id:record.id};
  for(const key of ['description','version','source'] as const)if(typeof record[key]==='string'&&record[key].length<=512)entry[key]=record[key];
  return [entry];
}
/** Build the semantic manifest for a project from its compiled IR. Deterministic for a given project. */
export async function buildManifest(project:string,options:InspectOptions={}):Promise<Manifest> {
  const {loaded,compiled,routes,chains,projectSha256}=await prepare(project,options);
  const explanations=routes.map(route=>explainCompiledRoute(loaded,route,chains.get(route.pattern),{projectSha256,now:0})).sort((a,b)=>compare(a.path,b.path));
  const functions=new Map<string,ManifestModule>(),middleware=new Map<string,ManifestModule>();
  const register=(table:Map<string,ManifestModule>,source:string,name:string,path:string)=>{const key=`${source}#${name}`;const entry=table.get(key)??{source,export:name,routes:[]};entry.routes.push(path);table.set(key,entry);};
  const env=new Set<string>(),secrets=new Set<string>(),proxy=new Set<string>(),signals=new Set<string>();
  const manifestRoutes:ManifestRoute[]=[];
  for(const explanation of explanations){
    const declared=loaded.routes[explanation.path];
    const routeEnv=sorted(Object.values(declared?.env??{}).flatMap(ref=>ref.env?[ref.env]:[])),routeSecrets=sorted(Object.values(declared?.secrets??{}).map(ref=>ref.secret));
    for(const name of routeEnv)env.add(name);for(const name of routeSecrets)secrets.add(name);
    if(declared?.proxy)proxy.add(origin(declared.proxy.url));for(const signal of declared?.signals??[])signals.add(origin(signal.url));
    if(explanation.handler.kind==='function')register(functions,explanation.handler.source as string,explanation.handler.export as string,explanation.path);
    for(const item of explanation.middleware)register(middleware,item.source,item.export,explanation.path);
    const extensions:Record<string,Record<string,unknown>>={};
    for(const name of Object.keys(explanation.policies.extensions).sort(compare))extensions[name]=explanation.policies.extensions[name]!.requirement;
    const targets={} as Record<CapabilityTarget,boolean>;
    for(const target of capabilityTargets)targets[target]=explanation.targets[target].compatible;
    manifestRoutes.push({
      path:explanation.path,methods:explanation.methods,handler:explanation.handler,enabled:explanation.enabled,
      ...(explanation.expires?{expires:explanation.expires}:{}),...(explanation.generated?{generated:explanation.generated}:{}),...(explanation.description?{description:explanation.description}:{}),
      sandbox:explanation.sandbox,...(explanation.sandboxReason?{sandboxReason:explanation.sandboxReason}:{}),
      middleware:explanation.middleware,parameters:explanation.inputs.parameters,...(explanation.inputs.body?{body:explanation.inputs.body}:{}),
      policies:explanation.policies.names,extensions,cache:explanation.cache,bindings:{env:routeEnv,secrets:routeSecrets},egress:explanation.egress,
      capabilities:explanation.capabilities,targets,
    });
  }
  const extensionDeclarations:Manifest['extensions']={};
  for(const name of Object.keys(loaded.document.extensions??{}).sort(compare)){
    const declaration=loaded.document.extensions![name]!;
    extensionDeclarations[name]={version:declaration.version,configKeys:sorted(Object.keys(declaration.config??{})),
      mounts:sorted(Object.entries(loaded.routes).filter(([,route])=>route.extension===name).map(([path])=>path)),
      protectedRoutes:sorted(Object.entries(loaded.routes).filter(([,route])=>Object.hasOwn(effectiveExtensionPolicies(loaded.document,route),name)).map(([path])=>path))};
  }
  const targets={} as Manifest['targets'];
  for(const target of capabilityTargets){const report=analyzeCompiledCapabilities(loaded.document,compiled,target,options.extensions);targets[target]={compatible:report.compatible,issues:report.issues.length};}
  const capabilities=new Set<CapabilityName>();
  for(const route of routes)for(const capability of routeCapabilities(route,loaded.document))capabilities.add(capability);
  const modules=(table:Map<string,ManifestModule>)=>[...table.values()].map(entry=>({...entry,routes:sorted(entry.routes)})).sort((a,b)=>compare(a.source,b.source)||compare(a.export,b.export));
  return {
    schemaVersion:MANIFEST_SCHEMA_VERSION,urlcode:packageVersion,entry:'urlcode.yaml',
    files:loaded.files.map(file=>relative(loaded.root,file).split('\\').join('/')),
    revision:projectSha256,configVersion:loaded.version,routeCount:manifestRoutes.length,routes:manifestRoutes,
    capabilities:[...capabilities].sort(compare),extensions:extensionDeclarations,recipes:await recipeProvenance(loaded.root),
    external:{env:sorted(env),secrets:sorted(secrets),egress:{proxy:sorted(proxy),signals:sorted(signals)},extensions:Object.keys(extensionDeclarations)},
    functions:modules(functions),middleware:modules(middleware),targets,
  };
}
/** The manifest as `build` writes it: two-space JSON with a trailing newline. */
export function renderManifest(manifest:Manifest):string {return JSON.stringify(manifest,null,2)+'\n';}
const manifestFileName='manifest.json';
export function manifestPath(out:string):string {return join(out,manifestFileName);}
