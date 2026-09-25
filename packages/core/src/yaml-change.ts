// Deterministic summary of what changed between two URLCode YAML documents
// (#722; public API in agent-context.ts, contract in docs/TOOLING.md#yaml-change-summaries).
//
// It reports names and keys, never values: no redirect destination, literal,
// env default or secret appears in the result. Requested operator grants use
// the same projection `urlcode permissions` prints (policy.ts
// requestedPermissions), minus the project digest, which depends on files this
// helper does not read.
//
// Each side is either supplied YAML text (its includes unread, the public
// agent-context API) or a project directory read through the configuration
// loader with its includes (#733, CLI and local MCP only); project sides name
// the file each route lives in.
import {readProjectDirectory,readProjectYaml} from './fixture-suggestions.ts';
import type {YamlProject} from './fixture-suggestions.ts';
import {routeCapabilities} from './capabilities.ts';
import type {CapabilityName} from './capabilities.ts';
import {effectiveExtensionPolicies} from './extensions.ts';
import {requestedPermissions} from './policy.ts';
import {resolveHandlerName} from './types.ts';
import type {LoadedDocument,ProjectDocument,RouteConfig} from './types.ts';

export type ExecutionMode = 'trusted'|'sandboxed';
export interface RouteChangeEntry { route: string; handler: string; mode: ExecutionMode; /** From a project side: the YAML file that declares the route. */ file?: string }
export interface ChangedRoute {
  route: string;
  /** From a project side: the YAML file that declares the route (the after side's when both are projects). */
  file?: string;
  /** Both sides are projects and the route moved: the file it was declared in before. */
  movedFrom?: string;
  /** Top-level route keys whose value differs (after `use:` and `auth:` expansion), sorted. Values are never included. */
  keys: string[];
  handler: { before: string; after: string };
  capabilities: { added: CapabilityName[]; removed: CapabilityName[] };
}
/** One project code seam: a route's `function` or one `middleware` entry. */
export interface CodeSeam { route: string; kind: 'function'|'middleware'; source: string; export: string; mode: ExecutionMode; /** From a project side: the YAML file that declares the route. */ file?: string }
export type YamlSide = 'yaml'|'project';
export interface GrantSet {
  env: { route: string; name: string }[];
  secrets: { route: string; name: string }[];
  egress: { route: string; purpose: 'proxy'|'signals'; origin: string }[];
  /** An operator-registered extension the project needs: declared under `extensions`, mounted by a route, or required by a route's `policies.extensions` (including `auth:`). */
  extensions: { route: string; extension: string; via: 'declaration'|'mount'|'policy' }[];
}
export interface YamlChangeSummary {
  format: 1;
  /**
   * `supplied-yaml-only`: two supplied documents, includes unread. `project-yaml`: two projects read with their
   * includes. `mixed`: one of each (see `routes.unresolved`). Function sources and operator policy are never read.
   */
  scope: 'supplied-yaml-only'|'project-yaml'|'mixed';
  /** Present unless both sides are supplied YAML: how each side was read. */
  sides?: { before: YamlSide; after: YamlSide };
  changed: boolean;
  routes: {
    before: number; after: number; added: RouteChangeEntry[]; removed: RouteChangeEntry[]; changed: ChangedRoute[];
    /**
     * `mixed` only: project-side routes in an include the YAML side also lists but does not read, so neither added,
     * removed nor compared (their extension declarations are set aside the same way).
     */
    unresolved?: { route: string; file: string; side: 'before'|'after' }[];
  };
  /** Project-wide union of capability names (capabilities.ts vocabulary). */
  capabilities: { added: CapabilityName[]; removed: CapabilityName[] };
  code: {
    added: CodeSeam[]; removed: CodeSeam[];
    /** Same source and export on the same route, with different `args`. */
    argsChanged: CodeSeam[];
    /** A `sandbox:` flip on a route that has code in both versions. */
    modeChanged: { route: string; before: ExecutionMode; after: ExecutionMode }[];
    /** Code seams in the new version by execution mode. */
    trusted: number; sandboxed: number;
  };
  grants: { requested: GrantSet; released: GrantSet; note: string };
  /** Top-level document keys other than `routes` whose value differs, sorted, and the `includes` entries added and removed. */
  project: { changed: string[]; includes: { added: string[]; removed: string[] } };
  limits: { maxEntries: number };
  /** Entries dropped per list by the limit; empty when nothing was cut. */
  truncated: Record<string, number>;
}

const MAX_ENTRIES=200;
const grantNote='Grants come only from operator policy outside the project and are pinned to the project revision (urlcode permissions prints the digest); any change to the project, including its code, needs the policy re-reviewed and re-pinned.';
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value!==null&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value)??'null';
}
const mode=(route:RouteConfig):ExecutionMode=>route.sandbox===true?'sandboxed':'trusted';
const handler=(route:RouteConfig)=>resolveHandlerName(route,'none');
const fileOf=(side:YamlProject,route:string):string|undefined=>side.sources&&Object.hasOwn(side.sources.routes,route)?side.sources.routes[route]:undefined;
const inFile=(side:YamlProject,route:string):{file?:string}=>{const file=fileOf(side,route);return file===undefined?{}:{file};};
function seams(side:YamlProject):CodeSeam[] {
  const list:CodeSeam[]=[];
  for(const [route,config] of Object.entries(side.routes)){
    for(const entry of config.middleware??[])list.push({route,kind:'middleware',source:entry.source,export:entry.export??'default',mode:mode(config),...inFile(side,route)});
    if(config.function)list.push({route,kind:'function',source:config.function.source,export:config.function.export??'default',mode:mode(config),...inFile(side,route)});
  }
  return list;
}
/**
 * A project side compared with a YAML side that lists includes it does not read: the project side's routes and
 * extension declarations from those files cannot be classed, so they are set aside and reported, never guessed.
 */
function setAside(side:YamlProject, other:YamlProject, name:'before'|'after', unresolved:NonNullable<YamlChangeSummary['routes']['unresolved']>):YamlProject {
  if(!side.sources||other.sources)return side;
  const unread=new Set(other.document.includes??[]);
  if(!unread.size)return side;
  const routes=Object.create(null) as Record<string,RouteConfig>;
  for(const [route,config] of Object.entries(side.routes)){
    const file=side.sources.routes[route];
    if(file!==undefined&&unread.has(file))unresolved.push({route,file,side:name});else routes[route]=config;
  }
  const extensions=Object.entries(side.document.extensions??{}).filter(([extension])=>!unread.has(side.sources!.extensions[extension]??''));
  const document:ProjectDocument={...side.document};
  if(extensions.length)document.extensions=Object.fromEntries(extensions);else delete document.extensions;
  return {document,routes,sources:side.sources};
}
const seamKey=(seam:Pick<CodeSeam,'route'|'kind'|'source'|'export'>)=>`${seam.route}\u0000${seam.kind}\u0000${seam.source}\u0000${seam.export}`;
function grants(document:ProjectDocument, routes:Record<string,RouteConfig>):GrantSet {
  const loaded:LoadedDocument={root:'',document,routes,files:[],version:''};
  const policy=requestedPermissions(loaded,{projectSha256:''});
  const set:GrantSet={env:[],secrets:[],egress:[],extensions:[]};
  for(const [route,grant] of Object.entries(policy.routes)){
    for(const name of grant.env??[])set.env.push({route,name});
    for(const name of grant.secrets??[])set.secrets.push({route,name});
    for(const purpose of ['proxy','signals'] as const)for(const origin of grant.egress?.[purpose]??[])set.egress.push({route,purpose,origin});
  }
  for(const extension of Object.keys(document.extensions??{}))set.extensions.push({route:'(project)',extension,via:'declaration'});
  for(const [route,config] of Object.entries(routes)){
    if(config.extension)set.extensions.push({route,extension:config.extension,via:'mount'});
    for(const extension of Object.keys(effectiveExtensionPolicies(document,config)))set.extensions.push({route,extension,via:'policy'});
  }
  return set;
}
const grantKey={
  env:(entry:GrantSet['env'][number])=>`${entry.route}\u0000${entry.name}`,
  secrets:(entry:GrantSet['secrets'][number])=>`${entry.route}\u0000${entry.name}`,
  egress:(entry:GrantSet['egress'][number])=>`${entry.route}\u0000${entry.purpose}\u0000${entry.origin}`,
  extensions:(entry:GrantSet['extensions'][number])=>`${entry.route}\u0000${entry.via}\u0000${entry.extension}`,
};
function minus<T>(left:T[], right:T[], key:(item:T)=>string):T[] {
  const known=new Set(right.map(key));
  return left.filter(item=>!known.has(key(item))).sort((a,b)=>compare(key(a),key(b)));
}
function difference(after:GrantSet, before:GrantSet):GrantSet {
  return {env:minus(after.env,before.env,grantKey.env),secrets:minus(after.secrets,before.secrets,grantKey.secrets),egress:minus(after.egress,before.egress,grantKey.egress),extensions:minus(after.extensions,before.extensions,grantKey.extensions)};
}
const capabilitySet=(document:ProjectDocument,route:RouteConfig)=>new Set(routeCapabilities(route,document));
const sortedMinus=(left:Iterable<CapabilityName>,right:Set<CapabilityName>)=>[...left].filter(item=>!right.has(item)).sort(compare);

/**
 * Compares two URLCode YAML documents (both must validate) and reports route,
 * capability, code-seam, operator-grant and project-key changes. Deterministic:
 * every list is sorted and bounded, so identical inputs give identical output.
 */
export function summarizeYamlChange(beforeYaml:string, afterYaml:string):YamlChangeSummary {
  return summarizeProjects(readProjectYaml(beforeYaml,'before YAML'),readProjectYaml(afterYaml,'after YAML'));
}
/** One side of a CLI or local MCP comparison: supplied YAML text, or a project directory read with its includes. */
export type YamlChangeInput = {yaml:string}|{project:string};
/** CLI and local MCP entry point: each side is YAML text (includes unread) or a project directory (includes read). */
export async function summarizeChange(before:YamlChangeInput, after:YamlChangeInput):Promise<YamlChangeSummary> {
  const read=async(input:YamlChangeInput,label:string)=>'yaml' in input?readProjectYaml(input.yaml,label):readProjectDirectory(input.project);
  return summarizeProjects(await read(before,'before YAML'),await read(after,'after YAML'));
}
/** Compares two read sides; see `summarizeYamlChange`. A project side (`sources` present) reports each route's file. */
export function summarizeProjects(beforeSide:YamlProject, afterSide:YamlProject):YamlChangeSummary {
  const unresolved:NonNullable<YamlChangeSummary['routes']['unresolved']>=[];
  const before=setAside(beforeSide,afterSide,'before',unresolved), after=setAside(afterSide,beforeSide,'after',unresolved);
  const sides={before:(before.sources?'project':'yaml') as YamlSide,after:(after.sources?'project':'yaml') as YamlSide};
  const scope=sides.before===sides.after?(sides.before==='yaml'?'supplied-yaml-only':'project-yaml'):'mixed';
  const truncated:Record<string,number>={};
  const cap=<T>(name:string,list:T[]):T[]=>{if(list.length>MAX_ENTRIES){truncated[name]=list.length-MAX_ENTRIES;return list.slice(0,MAX_ENTRIES);}return list;};
  const patterns=[...new Set([...Object.keys(before.routes),...Object.keys(after.routes)])].sort(compare);
  const added:RouteChangeEntry[]=[], removed:RouteChangeEntry[]=[], changed:ChangedRoute[]=[];
  for(const route of patterns){
    const old=before.routes[route], now=after.routes[route];
    if(!old&&now)added.push({route,handler:handler(now),mode:mode(now),...inFile(after,route)});
    else if(old&&!now)removed.push({route,handler:handler(old),mode:mode(old),...inFile(before,route)});
    else if(old&&now){
      const oldFile=fileOf(before,route), newFile=fileOf(after,route), file=newFile??oldFile;
      const moved=oldFile!==undefined&&newFile!==undefined&&oldFile!==newFile;
      const keys=[...new Set([...Object.keys(old),...Object.keys(now)])].filter(key=>canonical(old[key as keyof RouteConfig])!==canonical(now[key as keyof RouteConfig])).sort(compare);
      const oldCaps=capabilitySet(before.document,old), newCaps=capabilitySet(after.document,now);
      const capabilities={added:sortedMinus(newCaps,oldCaps),removed:sortedMinus(oldCaps,newCaps)};
      // A project-level policy or profile change alters a route's effective capabilities without touching its keys.
      if(keys.length||capabilities.added.length||capabilities.removed.length||moved)changed.push({route,...(file===undefined?{}:{file}),...(moved?{movedFrom:oldFile}:{}),keys,handler:{before:handler(old),after:handler(now)},capabilities});
    }
  }
  const union=(side:typeof before)=>{const all=new Set<CapabilityName>();for(const route of Object.values(side.routes))for(const name of routeCapabilities(route,side.document))all.add(name);if(Object.keys(side.document.extensions??{}).length)all.add('extension');return all;};
  const oldCaps=union(before), newCaps=union(after);

  const oldSeams=seams(before), newSeams=seams(after);
  const seamSort=(a:CodeSeam,b:CodeSeam)=>compare(seamKey(a),seamKey(b));
  const argsChanged=newSeams.filter(seam=>{
    const old=before.routes[seam.route]?.function, now=after.routes[seam.route]?.function;
    return seam.kind==='function'&&old!==undefined&&now!==undefined&&old.source===now.source&&(old.export??'default')===(now.export??'default')&&canonical(old.args??{})!==canonical(now.args??{});
  }).sort(seamSort);
  const hasCode=(route:RouteConfig|undefined)=>Boolean(route?.function||route?.middleware?.length);
  const modeChanged=patterns.filter(route=>hasCode(before.routes[route])&&hasCode(after.routes[route])&&mode(before.routes[route]!)!==mode(after.routes[route]!))
    .map(route=>({route,before:mode(before.routes[route]!),after:mode(after.routes[route]!)}));

  const oldGrants=grants(before.document,before.routes), newGrants=grants(after.document,after.routes);
  const requested=difference(newGrants,oldGrants), released=difference(oldGrants,newGrants);
  const capGrants=(prefix:string,set:GrantSet):GrantSet=>({env:cap(`${prefix}.env`,set.env),secrets:cap(`${prefix}.secrets`,set.secrets),egress:cap(`${prefix}.egress`,set.egress),extensions:cap(`${prefix}.extensions`,set.extensions)});

  const topKeys=[...new Set([...Object.keys(before.document),...Object.keys(after.document)])].filter(key=>key!=='routes'&&key!=='version'&&canonical(before.document[key as keyof ProjectDocument])!==canonical(after.document[key as keyof ProjectDocument])).sort(compare);
  const oldIncludes=before.document.includes??[], newIncludes=after.document.includes??[];

  const summary:YamlChangeSummary={
    format:1,scope,...(scope==='supplied-yaml-only'?{}:{sides}),changed:false,
    routes:{before:Object.keys(before.routes).length,after:Object.keys(after.routes).length,added:cap('routes.added',added),removed:cap('routes.removed',removed),changed:cap('routes.changed',changed),
      ...(scope==='mixed'?{unresolved:cap('routes.unresolved',unresolved.sort((a,b)=>compare(`${a.side}\u0000${a.route}`,`${b.side}\u0000${b.route}`)))}:{})},
    capabilities:{added:sortedMinus(newCaps,oldCaps),removed:sortedMinus(oldCaps,newCaps)},
    code:{
      added:cap('code.added',minus(newSeams,oldSeams,seamKey)),removed:cap('code.removed',minus(oldSeams,newSeams,seamKey)),
      argsChanged:cap('code.argsChanged',argsChanged),modeChanged:cap('code.modeChanged',modeChanged),
      trusted:newSeams.filter(seam=>seam.mode==='trusted').length,sandboxed:newSeams.filter(seam=>seam.mode==='sandboxed').length,
    },
    grants:{requested:capGrants('grants.requested',requested),released:capGrants('grants.released',released),note:grantNote},
    project:{changed:topKeys,includes:{added:newIncludes.filter(item=>!oldIncludes.includes(item)).sort(compare),removed:oldIncludes.filter(item=>!newIncludes.includes(item)).sort(compare)}},
    limits:{maxEntries:MAX_ENTRIES},truncated,
  };
  summary.changed=added.length+removed.length+changed.length+topKeys.length>0||canonical(before.document.version)!==canonical(after.document.version);
  return summary;
}
