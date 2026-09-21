import {readFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
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
/** Estimated size of the shipped offline documentation bundle, for comparison with an emitted context. */
export async function documentationTokens():Promise<number> {
 return Math.ceil((await readFile(new URL('../llms-full.txt',import.meta.url),'utf8')).length/4);
}

/** Tasks `--task` / MCP `get_context` accept. Each is fixed guidance plus the project's own facts for that task. */
export const contextTasks=['redirects'] as const;
export type ContextTask=typeof contextTasks[number];
export interface TaskShape {
 need:string;
 support:'supported'|'gap';
 /** Exact YAML to merge into urlcode.yaml (`routes` entries or `site`); absent for a gap. */
 yaml?:Record<string,unknown>;
 /** The rule that applies, or the exact validation error a gap produces. */
 note?:string;
 /** For a gap: the tested declarative alternative. */
 workaround?:string;
}
const idParam=(name:string)=>({name,in:'path',required:true,schema:{type:'string',minLength:1,maxLength:64}});
/** Established by running `urlcode validate` and `urlcode test` on each shape; test/context.test.ts compiles every `yaml` entry so this cannot drift from the runtime. */
export const redirectShapes:TaskShape[]=[
 {need:'fixed',support:'supported',yaml:{routes:{'/old':{redirect:{url:'https://example.com/new',status:301}}}},note:'status defaults to 302; allowed 301, 302, 303, 307, 308. Only GET/HEAD match unless methods is set.'},
 {need:'parameterized path (/users/:id to /profiles/:id)',support:'supported',yaml:{routes:{'/users/{id}':{parameters:[idParam('id')],redirect:{url:'https://example.com/profiles/{id}',status:308}}}},note:'{name} placeholders only in the destination path, each naming a declared path parameter; the value is encoded as one component.'},
 {need:'fixed-depth suffix (/legacy/a/b to /modern/a/b)',support:'supported',yaml:{routes:{'/legacy/{a}/{b}':{parameters:[idParam('a'),idParam('b')],redirect:{url:'https://example.com/modern/{a}/{b}'}}}},note:'One route per depth; a path with more or fewer segments is a 404.'},
 {need:'query-string preservation',support:'supported',yaml:{routes:{'/search':{parameters:[{name:'q',in:'query',schema:{type:'string',maxLength:100}}],redirect:{url:'https://example.com/find',query:{pass:['q','utm_source']}}}}},note:'Nothing is forwarded by default; pass is an explicit allowlist (pass: true is refused by the schema); query.map renames or maps declared inputs.'},
 {need:'method-preserving redirect',support:'supported',yaml:{routes:{'/form':{methods:['GET','POST'],redirect:{url:'https://example.com/form2',status:307}}}},note:'Default methods GET/HEAD; other methods answer 405. Use 307/308 to keep the method and body.'},
 {need:'404 for unmatched paths',support:'supported',yaml:{site:{notFound:'404.html'}},note:'Unmatched GET/HEAD answer 404 (plain without site.notFound; that .html file, still status 404, with it). Trailing slashes are not normalized: /old/ is a 404 unless declared as its own route.'},
 {need:'wildcard suffix (/legacy/* to /modern/*, any depth)',support:'gap',note:'`/legacy/*` on a redirect fails validation: "Only static or extension routes support a terminal /* wildcard"; `{rest...}` fails with "Invalid route parameter". Report the gap; proposal in docs/OPEN-DECISIONS.md.',workaround:'a fixed-depth route per depth you need, or one route per known path (urlcode bulk-import). A function handler cannot match a subtree either.'},
 {need:'host, scheme or relative destination',support:'gap',note:'Destination must be a literal absolute http(s) URL: "/x" and "//h/x" fail with "Redirect URL must be absolute HTTP(S)"; {param} in host or query fails with "Redirect placeholders are allowed only in path segments"; other schemes fail with "Redirect must use HTTP(S) without credentials". Routes do not match on Host.',workaround:'a literal https destination per route; report host-based redirects as a gap.'},
 {need:'redirect loop detection',support:'gap',note:'Validation accepts a route that redirects to its own URL; nothing detects cycles. Write a fixture with expectHeaders location for each redirect and review chains by hand.'},
];
export interface TaskContext {
 urlcode:string;schema:'1';task:ContextTask;
 shapes?:TaskShape[];
 project?:{entry:string;routes:number;redirects:{path:string;status:number;url:string}[];site:string[]};
 recipe?:string;
 commands?:Record<string,string>;
 omitted?:string[];
}
export function renderTaskContext(context:TaskContext):string {return stringify(context,{lineWidth:0,aliasDuplicateObjects:false,flowCollectionPadding:false});}
/**
 * One bounded call for a task: fixed guidance plus this project's facts for that task. Same compiler as buildContext;
 * a directory without urlcode.yaml still gets the guidance, any other load failure propagates.
 */
export async function buildTaskContext(project:string,task:string,options:{budget?:number|undefined;hostFile?:string|undefined;projectFlag?:string|undefined}={}):Promise<TaskContext> {
 if(!(contextTasks as readonly string[]).includes(task))throw new Error(`Unknown context task; use one of: ${contextTasks.join(', ')}`);
 const budget=options.budget;
 if(budget!==undefined&&(!Number.isSafeInteger(budget)||budget<1))throw new Error('Invalid context budget');
 const flag=options.projectFlag??project;
 const context:TaskContext={urlcode:await packageVersion(),schema:'1',task:'redirects',shapes:redirectShapes.map(shape=>({...shape}))};
 const exists=await readFile(join(project,'urlcode.yaml')).then(()=>true,()=>false);
 if(exists) {
  const host=await loadOperatorHost(options.hostFile,project);
  try {
   const {loaded,compiled,routes}=await compile(project);
   context.project={entry:'urlcode.yaml',routes:compiled.count,redirects:routes.filter(route=>route.redirect).map(route=>({path:route.pattern,status:route.redirect!.status??302,url:route.redirect!.url})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0).slice(0,20),site:sorted(Object.keys(loaded.document.site??{}))};
  } finally {await host.close?.();}
 }
 context.recipe='urlcode recipes show redirect';
 context.commands={validate:`urlcode validate --local --project ${flag}`,test:`urlcode test --project ${flag}`,audit:`urlcode audit --project ${flag} --expect-routes ${context.project?context.project.routes:'N'}`,schema:'urlcode schema redirect'};
 if(budget===undefined)return context;
 // Fixed order, like fitBudget: this project's facts, then commands, then the notes, then the shapes.
 const omitted:string[]=[];
 const fits=()=>estimateTokens(renderTaskContext(omitted.length?{...context,omitted}:context))<=budget;
 const steps:[string,()=>void][]=[
  ['project',()=>{delete context.project;}],
  ['commands',()=>{delete context.commands;delete context.recipe;}],
  ['notes',()=>{context.shapes=context.shapes!.map(({need,support,yaml})=>({need,support,...(yaml?{yaml}:{})}));}],
  ['shapes',()=>{delete context.shapes;}],
 ];
 for(const [name,drop] of steps) {if(fits())break;drop();omitted.push(name);}
 if(!fits())throw new Error(`Context budget ${budget} is below the smallest rendering`);
 return omitted.length?{...context,omitted}:context;
}
