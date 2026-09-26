import {lstat,readFile,open,rename,rm,mkdtemp} from 'node:fs/promises';
import {join,extname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {parseDocument,isMap} from 'yaml';
import {loadDocument,validateDocument,parseYaml,normalizeRouteAuth,MAX_CONFIG_BYTES} from './config.ts';
import {compileRoutes} from './router.ts';
import {prepareFunctionSnapshot,requestedPermissions} from './policy.ts';
import {validateProject} from './tooling.ts';
import {scaffoldProject} from './scaffold.ts';
import {isRecord as object, isCode} from './object-guards.ts';
import {addRecipe} from './recipes.ts';
import {authoringPath} from './authoring-files.ts';
import {assert} from './errors.ts';
import type {LoadedDocument,MiddlewareConfig,RouteConfig} from './types.ts';
import type {RuntimeExtension} from './extensions.ts';

/**
 * Authoring tools for `urlcode mcp --allow-authoring`. Every write lands inside
 * the operator-selected project root (after realpath), through the existing
 * authoring, recipe and scaffold paths. Nothing here reads bindings, creates
 * grants, deploys, or touches operator policy, compliance rules or host files.
 * The runners spawn the CLI against the same root only; they activate the local
 * runtime, so the project's trusted code runs with full Node access. They repeat
 * only the operator's own `--host-file` and `--origin` (the server takes no
 * `--policy`), so the operator host module's code runs in the child too.
 */
const text={type:'string',maxLength:1024};
const handler={anyOf:[{type:'string',maxLength:2048},{type:'object'}]};
const middleware={type:'array',maxItems:32,items:{anyOf:[{type:'string',maxLength:1024},{type:'object'}]}};
export const authoringDefinitions=[
 {name:'create_route',description:'Add one route to urlcode.yaml or a named include under the project. The merged project is validated before the write; missing function sources are reported for scaffold_feature.',properties:{path:{type:'string',maxLength:2048},handler,middleware,file:text},required:['path','handler']},
 {name:'add_recipe',description:'Copy a bundled recipe into a new directory inside the project (recipes add). dryRun reports the destination and writes nothing.',properties:{name:{type:'string',maxLength:64},destination:text,dryRun:{type:'boolean'}},required:['name','destination']},
 {name:'scaffold_feature',description:'Create placeholder modules, pages and directories the project YAML references and that do not exist yet; existing files are never edited.',properties:{dryRun:{type:'boolean'}},required:[]},
 {name:'run_validate',executes:true,description:'Run `urlcode validate --local` against the project in a child process; returns exit code and bounded output. This activates the local runtime, which imports the project\'s trusted function and middleware modules with full Node access (their top-level code runs and may write or delete files, spawn processes or reach the network); the minimal environment is not confinement. With the operator\'s --host-file the child receives that same path and, besides PATH, exactly one environment variable: PROJECT_SHA256, only when the server\'s own is a well-formed 64-hex revision, the pin its host already loaded under and imports that operator-supplied host module, whose code runs with full Node access too; --origin is repeated only when the operator gave it. No other flag and no other environment variable is forwarded: the server accepts no --policy, so bindings that need an operator grant fail as they do without one, and no grant is created or changed.',properties:{},required:[]},
 {name:'run_test',executes:true,description:'Run `urlcode test` against the project in a child process; returns exit code and bounded output. This activates the local runtime and executes the fixtures, so the project\'s trusted function and middleware modules run with full Node access and may write or delete files, spawn processes or reach the network; the minimal environment and scratch data directory are not confinement. With the operator\'s --host-file the child receives that same path and, besides PATH, exactly one environment variable: PROJECT_SHA256, only when the server\'s own is a well-formed 64-hex revision, the pin its host already loaded under and imports that operator-supplied host module, whose code runs with full Node access too; --origin is repeated only when the operator gave it. No other flag and no other environment variable is forwarded: the server accepts no --policy, so bindings that need an operator grant fail as they do without one, and no grant is created or changed.',properties:{},required:[]},
 {name:'run_audit',executes:true,description:'Run `urlcode audit` against the project in a child process; returns exit code and bounded output. This starts the local runtime and sends probe requests, so the project\'s trusted function and middleware modules run with full Node access and may write or delete files, spawn processes or reach the network; the minimal environment is not confinement. With the operator\'s --host-file the child receives that same path and, besides PATH, exactly one environment variable: PROJECT_SHA256, only when the server\'s own is a well-formed 64-hex revision, the pin its host already loaded under and imports that operator-supplied host module, whose code runs with full Node access too; --origin is repeated only when the operator gave it. No other flag and no other environment variable is forwarded: the server accepts no --policy, so bindings that need an operator grant fail as they do without one, and no grant is created or changed.',properties:{},required:[]},
];
/** Annotations for an authoring tool: every one writes, and a runner (`executes`) runs trusted project code that can do anything Node can. */
export function authoringAnnotations(def:{executes?:boolean}):{readOnlyHint:false;destructiveHint:boolean;idempotentHint?:false;openWorldHint:boolean} {
 return def.executes===true?{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true}:{readOnlyHint:false,destructiveHint:false,openWorldHint:false};
}
// Operator-owned material never lives under an authoring write, even when an
// operator mistakenly placed it in the checkout.
const operatorFile=/^(?:.*policy.*\.json|.*compliance.*\.(?:json|mjs|js|cjs|ts)|host(?:-file)?\.(?:mjs|js|cjs|ts)|.*\.(?:sqlite3?|db)(?:-wal|-shm|-journal)?|urlcode\.yaml\.lock)$/i;
/** A project-relative path an authoring tool may create or replace: no absolute, `..`, hidden (`.env*`, `.git`), credential or operator names, and no symlink anywhere on the walk. */
export async function confinedPath(root:string,path:unknown):Promise<string> {
 assert(typeof path==='string'&&path.length>0&&!isAbsolute(path)&&!path.includes('\\')&&!/^[A-Za-z]:/.test(path),'Authoring paths must be project-relative');
 authoringPath(path);
 const parts=path.split('/');
 assert(parts.every(part=>!operatorFile.test(part)&&!/^\.env/i.test(part)&&part!=='.git'),'Authoring never writes operator, credential or version-control files');
 let file=root;
 for(const part of parts){
  file=join(file,part);let info;
  try{info=await lstat(file);}catch(error){if(isCode(error,'ENOENT'))break;throw error;}
  assert(!info.isSymbolicLink(),'Authoring through symlinks is forbidden');
 }
 return join(root,path);
}
// The operator's --host-file registrations reach the verdict exactly as they reach MCP `validate` (#755, #778).
async function verdict(root:string,origin?:string,extensions?:RuntimeExtension[]) {
 try{return await validateProject(root,{...(origin?{origin}:{}),...(extensions===undefined?{}:{extensions})});}
 catch{return {valid:false as const,note:'Project does not validate; call run_validate for the CLI report.'};}
}
function expandHandler(handler:unknown):Record<string,unknown> {
 if(object(handler))return handler;
 assert(typeof handler==='string','Handler must be a route object or a short form');
 if(/^https?:\/\//.test(handler))return {redirect:{url:handler}};
 assert(['.js','.mjs'].includes(extname(handler)),'Short-form handler must be an HTTP(S) URL or a .js/.mjs function source');
 // Written as the YAML short form; validateDocument expands it to the canonical parameters/args (see normalizeRoute).
 return {function:handler};
}
function expandMiddleware(value:unknown):(string|MiddlewareConfig)[]|undefined {
 if(value===undefined)return undefined;
 assert(Array.isArray(value),'middleware must be a list');
 return value.map(entry=>{if(typeof entry==='string')return entry;assert(object(entry),'middleware entries must be sources or objects');return entry as unknown as MiddlewareConfig;});
}
async function sources(root:string,route:RouteConfig):Promise<{present:string[];missing:string[]}> {
 const present:string[]=[],missing:string[]=[];
 for(const definition of [...(route.middleware??[]),...(route.function?[route.function]:[])]){
  const source=definition.source;
  let exists=false;try{await confinedPath(root,source);exists=(await lstat(join(root,source))).isFile();}catch(error){if(!isCode(error,'ENOENT'))throw error;}
  (exists?present:missing).push(source);
 }
 return {present,missing:[...new Set(missing)]};
}
async function createRoute(root:string,args:Record<string,unknown>,origin?:string,extensions?:RuntimeExtension[]) {
 const path=args.path;assert(typeof path==='string'&&path.startsWith('/'),'Route path must start with /');
 const loaded=await loadDocument(root);
 const file=typeof args.file==='string'?args.file:'urlcode.yaml';
 assert(file==='urlcode.yaml'||(loaded.document.includes??[]).includes(file),'file must be urlcode.yaml or an include listed in it');
 const target=await confinedPath(root,file);
 assert(!Object.hasOwn(loaded.routes,path),'Route already exists');
 const route={...expandHandler(args.handler)};
 const middleware=expandMiddleware(args.middleware);if(middleware)route.middleware=middleware;
 const lockPath=join(root,'urlcode.yaml.lock'),lock=await open(lockPath,'wx',0o600);
 let temp:string|undefined;
 try {
  const original=await readFile(target);assert(original.length<=MAX_CONFIG_BYTES,'Configuration exceeds 32 MiB');
  const latest=await loadDocument(root);assert(!Object.hasOwn(latest.routes,path),'Route already exists');
  const doc=parseDocument(original.toString('utf8'),{uniqueKeys:false});
  doc.setIn(['routes',path],route);
  const routesNode=doc.getIn(['routes']);if(isMap(routesNode))routesNode.flow=false;
  const data=validateDocument(parseYaml(String(doc)));
  const added=data.routes[path];assert(added,'Route was not written');
  const routes={...latest.routes,[path]:added};
  normalizeRouteAuth(latest.document,routes);
  const candidate:LoadedDocument={...latest,routes};
  const {present,missing}=await sources(root,added);
  if(!missing.length){
   // Same pre-write check as `urlcode add`: shape and references with dummy values, no credential reads, no execution, no grant.
   const snapshot=await prepareFunctionSnapshot(candidate),bindings:Record<string,string>=Object.create(null) as Record<string,string>;
   for(const value of Object.values(routes)){for(const ref of Object.values(value.env||{}))if(ref.env)bindings[ref.env]='validation-only';for(const ref of Object.values(value.secrets||{}))bindings[ref.secret]='validation-only';}
   await compileRoutes(candidate,bindings,requestedPermissions(candidate,snapshot),snapshot.projectSha256);
  }
  temp=await mkdtemp(join(root,'.urlcode-edit-'));
  const temporary=join(temp,'edit.yaml'),out=await open(temporary,'wx',0o600);
  try{await out.writeFile(String(doc));await out.sync();}finally{await out.close();}
  assert((await readFile(target)).equals(original),'Configuration changed during edit; retry');
  await rename(temporary,target);
  return {created:true,path,file,route:added,sources:present,missingSources:missing,next:missing.length?'Call scaffold_feature to create placeholder modules, then implement them.':null,validation:await verdict(root,origin,extensions)};
 } finally {if(temp)await rm(temp,{recursive:true,force:true});await lock.close();await rm(lockPath,{force:true});}
}
const outputLimit=32768;
function bounded(chunks:Buffer[]):{text:string;truncated:boolean} {
 const all=Buffer.concat(chunks);return {text:all.subarray(0,outputLimit).toString('utf8'),truncated:all.length>outputLimit};
}
/** What the operator put on the `urlcode mcp` command line; the runners repeat exactly this and nothing a tool argument names. */
export interface OperatorFlags {hostFile?:string|undefined;origin?:string|undefined}
async function runCli(root:string,command:'validate'|'test'|'audit',operator:OperatorFlags) {
 const cli=fileURLToPath(new URL('./cli.ts',import.meta.url));
 const args=[cli,command,'--project',root,...(command==='validate'?['--local']:[]),...(operator.origin?['--origin',operator.origin]:[]),...(operator.hostFile===undefined?[]:['--host-file',operator.hostFile])];
 // A fresh minimal environment: the runner never forwards this process's ambient variables to the project. The one
 // exception is the revision pin a composed host needs (#778): with the operator's host file, PROJECT_SHA256 goes
 // along when it is a well-formed revision, since the server's own host already loaded under it. It is not a credential and grants nothing.
 const pin=process.env.PROJECT_SHA256,env:Record<string,string>={PATH:process.env.PATH??''};
 if(operator.hostFile!==undefined&&pin!==undefined&&/^[a-f0-9]{64}$/.test(pin))env.PROJECT_SHA256=pin;
 const child=spawn(process.execPath,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});
 const stdout:Buffer[]=[],stderr:Buffer[]=[];let total=0;
 const collect=(sink:Buffer[])=>(chunk:Buffer)=>{if(total<outputLimit*4){sink.push(chunk);total+=chunk.length;}};
 child.stdout.on('data',collect(stdout));child.stderr.on('data',collect(stderr));
 const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
 const exit=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));}).finally(()=>clearTimeout(timer));
 const out=bounded(stdout),err=bounded(stderr);
 return {command,exitCode:exit.code,signal:exit.signal,stdout:out.text,stderr:err.text,truncated:out.truncated||err.truncated};
}
/** `extensions` are the registrations the server already loaded from the operator's --host-file, for the verdicts only. */
export async function callAuthoringTool(root:string,name:string,args:Record<string,unknown>,operator:OperatorFlags={},extensions?:RuntimeExtension[]):Promise<unknown> {
 const origin=operator.origin;
 switch(name){
  case 'create_route':return createRoute(root,args,origin,extensions);
  case 'add_recipe':{
   const destination=await confinedPath(root,args.destination);
   const report=await addRecipe(args.name as string,destination,{dryRun:args.dryRun===true});
   return {...report,output:args.destination,validation:await verdict(root,origin,extensions)};
  }
  case 'scaffold_feature':return {...await scaffoldProject(root,{dryRun:args.dryRun===true}),validation:await verdict(root,origin,extensions)};
  case 'run_validate':return runCli(root,'validate',operator);
  case 'run_test':return runCli(root,'test',operator);
  case 'run_audit':return runCli(root,'audit',operator);
  default:throw new Error('Unknown tool');
 }
}
