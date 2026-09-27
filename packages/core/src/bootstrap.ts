import {createHash} from 'node:crypto';
import {readFile,readdir,realpath,stat} from 'node:fs/promises';
import {basename,dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stringify} from 'yaml';
import {loadDocument,parseYaml} from './config.ts';
import {ConfigError,describeError} from './errors.ts';
import {capabilityNames,capabilityTargets,normalizeCapabilityTarget} from './capabilities.ts';
import type {CapabilityName,CapabilitySupport,CapabilityTarget} from './capabilities.ts';
import {getCapability} from './capability-query.ts';
import type {CapabilityUsage} from './capability-query.ts';
import type {SchemaFragment} from './schema-query.ts';
import {cliInvocation,prerequisitesFor,shellWord} from './context.ts';
import type {Prerequisite} from './context.ts';
import {HOST_FILE,PROJECT_DIRECTORY} from './addon-install.ts';
import {readAddonCatalog} from './addon-manifest.ts';
import {isRecord} from './object-guards.ts';
import {enclosingProject,isFile} from './site-layout.ts';

/**
 * The local agent bootstrap (#807): one read of a directory that says whether it holds a URLCode site, where its
 * route project and entry file are, which runtime it pins, the exact commands to run from the site root, how YAML
 * file references map onto the site, and (only for capabilities the caller names) the running runtime's schema
 * fragments and one bundled example each. It composes init, context's command quoting, the capability catalog and
 * the schema query; it reads package data and the site's own metadata only, runs no project code and needs no
 * network, hosted service or MCP. It writes nothing unless the caller passes `create`, which delegates to init.
 */
export interface BootstrapOptions {
 /** Capability catalog names to deliver as a packet. Never inferred from a task. */
 capabilities?:readonly string[]|undefined;
 /** Restricts the packet's target decisions to one deployment target and reports what it refuses. */
 target?:string|undefined;
 /** The operator's canonical origin; repeated in the emitted commands, never guessed. */
 origin?:string|undefined;
 /** Create a site at the directory when none is there (init). Refused inside an existing project or at an `app` directory. */
 create?:boolean|undefined;
 /** With create: init --adopt, so a directory already holding user files becomes the site root; nothing of theirs is moved. */
 adopt?:boolean|undefined;
}
export type BootstrapState='existing'|'created'|'none';
export interface BootstrapRuntime {
 /** The runtime answering this call; the packet below is its contract. */
 running:{version:string;schemaSha256:string};
 /** The runtime installed in the site's node_modules, when there is one. */
 installed:{version:string;schemaSha256:string|null}|null;
 /** The site package.json's @jimhoyd/urlcode requirement as written. */
 pinned:string|null;
 /** matched: same contract; mismatched: packet withheld; unverified: nothing site-local to compare against. */
 status:'matched'|'mismatched'|'unverified';
 note:string;
}
export interface CapabilityPacketEntry {
 name:CapabilityName;kind:string;summary:string;constraints:string[];grants:string[];
 schema:Pick<SchemaFragment,'path'|'pointer'|'schema'>[];
 targets:Record<string,CapabilitySupport|{support:CapabilitySupport;reason:string}>;
 refused:{target:CapabilityTarget;reason:string}[];
 example:{source:string;route:string;yaml:string;note:string}|null;
}
export interface Bootstrap {
 urlcode:string;schema:'1';kind:'bootstrap';
 state:BootstrapState;
 /** What was created (top-level names inside the site root) when state is created. */
 created?:string[];
 /** With create and adopt: the top-level entries that were already there and were left alone (at most 20). */
 leftAlone?:string[];
 site:null|{
  root:string;
  layout:'site'|'project';
  /** Site-relative. `.` for a project with no surrounding site. */
  project:string;
  projectRoot:string;
  entry:string;
  hostFile:string|null;
  packageJson:string|null;
 };
 runtime:BootstrapRuntime;
 paths?:{
  rule:string;
  example:{onDisk:string;yaml:string;declaration:string};
  outsideProject:{path:string;note:string}[];
 };
 commands?:Record<string,string>;
 prerequisites?:Prerequisite[];
 capabilities?:{
  requested:string[];
  packet:CapabilityPacketEntry[];
  unknown:{name:string;reason:string}[];
  unsupported:{name:string;target:CapabilityTarget;support:CapabilitySupport;reason:string}[];
  withheld?:string;
 };
 diagnostics?:{code:string;message:string}[];
 next:string[];
}
/** At most this many capabilities per call: the packet is a focused contract, not the catalog. */
export const bootstrapMaxCapabilities=8;
const exampleMaxCharacters=1500;
const exists=(path:string):Promise<boolean>=>stat(path).then(()=>true,()=>false);
const toPosix=(path:string)=>path.split('\\').join('/');
const sha256=(text:string|Buffer)=>createHash('sha256').update(text).digest('hex');
const schemaFile=()=>fileURLToPath(new URL('../../../schemas/urlcode.schema.json',import.meta.url));
async function runningRuntime():Promise<{version:string;schemaSha256:string}> {
 const manifest=JSON.parse(await readFile(new URL('../../../package.json',import.meta.url),'utf8')) as {version:string};
 return {version:manifest.version,schemaSha256:sha256(await readFile(schemaFile()))};
}
interface Located {root:string;layout:'site'|'project';project:string}
/** A site (`app/urlcode.yaml`), the `app/` project of a site, or a bare project; nothing else counts. */
async function locate(directory:string):Promise<Located|undefined> {
 if(await isFile(join(directory,PROJECT_DIRECTORY,'urlcode.yaml')))return {root:directory,layout:'site',project:join(directory,PROJECT_DIRECTORY)};
 if(!await isFile(join(directory,'urlcode.yaml')))return undefined;
 const parent=dirname(directory);
 if(basename(directory)===PROJECT_DIRECTORY&&(await isFile(join(parent,HOST_FILE))||await isFile(join(parent,'package.json'))))return {root:parent,layout:'site',project:directory};
 return {root:directory,layout:'project',project:directory};
}
async function canonical(directory:string):Promise<string> {
 const absolute=resolve(directory);
 return realpath(absolute).catch(async()=>{
  // Not there yet: anchor it under its nearest real ancestor so every path this reports agrees with a later realpath.
  const parent=dirname(absolute);
  return parent===absolute?absolute:join(await canonical(parent),basename(absolute));
 });
}
async function siteRuntime(root:string,running:{version:string;schemaSha256:string}):Promise<BootstrapRuntime> {
 let pinned:string|null=null,installed:BootstrapRuntime['installed']=null;
 try {
  const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8')) as {dependencies?:Record<string,unknown>;devDependencies?:Record<string,unknown>};
  const value=manifest.dependencies?.['@jimhoyd/urlcode']??manifest.devDependencies?.['@jimhoyd/urlcode'];
  if(typeof value==='string')pinned=value;
 } catch {/* no readable package metadata: nothing pinned */}
 const packageRoot=join(root,'node_modules','@jimhoyd','urlcode');
 try {
  const version=(JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8')) as {version?:unknown}).version;
  if(typeof version==='string') {
   const schema=await readFile(join(packageRoot,'schemas','urlcode.schema.json')).catch(()=>undefined);
   installed={version,schemaSha256:schema===undefined?null:sha256(schema)};
  }
 } catch {/* not installed in this site */}
 if(installed) {
  const same=installed.version===running.version&&(installed.schemaSha256===null||installed.schemaSha256===running.schemaSha256);
  return {running,installed,pinned,status:same?'matched':'mismatched',note:same?'The site\'s installed runtime has this contract; the packet and commands match it.':`The site installs ${installed.version}${installed.version===running.version?' with a different schema':''}, but ${running.version} answered. Run the site's own CLI (the commands below) so the contract matches what serves the site.`};
 }
 if(pinned===null)return {running,installed,pinned,status:'unverified',note:'No site-local runtime is pinned or installed; the packet is the running runtime\'s contract.'};
 if(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(pinned))return pinned===running.version
  ?{running,installed,pinned,status:'matched',note:'The site pins this exact runtime; run commands.install before the other commands.'}
  :{running,installed,pinned,status:'mismatched',note:`The site pins ${pinned}, but ${running.version} answered. Install the pinned runtime (commands.install) and bootstrap again with it.`};
 return {running,installed,pinned,status:'unverified',note:`The site requires ${pinned}, a range, and has not installed it; install it and bootstrap again with the installed runtime to compare contracts.`};
}
// Directories npm, git, editors and init itself put in a site: never application content YAML could need.
const siteInfrastructure=new Set([PROJECT_DIRECTORY,'node_modules','.git','.github']);
async function pathMapping(located:Located):Promise<NonNullable<Bootstrap['paths']>> {
 const projectRelative=toPosix(relative(located.root,located.project))||'.';
 const prefix=projectRelative==='.'?'':`${projectRelative}/`;
 const entries=await readdir(located.project,{withFileTypes:true}).catch(()=>[]);
 const sample=entries.filter(entry=>entry.isDirectory()&&!entry.name.startsWith('.')&&entry.name!=='node_modules'&&entry.name!=='tests').map(entry=>entry.name).sort()[0]??'assets';
 const outsideProject:{path:string;note:string}[]=[];
 if(located.layout==='site') {
  const names=(await readdir(located.root,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&!entry.name.startsWith('.')&&!siteInfrastructure.has(entry.name)).map(entry=>entry.name).sort();
  for(const name of names.slice(0,20))outsideProject.push({path:name,note:`Outside the route project, so urlcode.yaml cannot reference it. To serve it, build or copy it into ${prefix}${name} and reference it as ${name}.`});
 }
 return {
  rule:`Every file reference in urlcode.yaml (includes, page.file, download.file, static.directory, function and middleware source, site.notFound, tests/requests.json) is relative to the route project root ${prefix||'./'}, not to the site root, and must stay inside it.`,
  example:{onDisk:`${prefix}${sample}`,yaml:sample,declaration:`/${sample}/*: {static: {directory: ${sample}}}`},
  outsideProject,
 };
}
async function commandsFor(located:Located,hostFile:string|null,origin:string|undefined,installNeeded:boolean):Promise<Record<string,string>> {
 const cli=await cliInvocation(located.root);
 const project=toPosix(relative(located.root,located.project))||'.';
 const flags=`--project ${shellWord(project)}${hostFile===null?'':` --host-file ${shellWord(hostFile)}`}${origin===undefined?'':` --origin ${shellWord(origin)}`}`;
 return {
  cd:`cd ${shellWord(located.root)}`,
  ...(installNeeded?{install:'npm install'}:{}),
  start:`${cli} serve ${flags}`,
  dev:`${cli} dev ${flags}`,
  validate:`${cli} validate --local ${flags}`,
  test:`${cli} test ${flags}`,
  context:`${cli} context ${flags}`,
 };
}
/** The shortest bundled route that uses the capability: recipes first, then the cookbook. Read as data, never run. */
async function exampleFor(recipes:CapabilityUsage[],cookbook:CapabilityUsage[]):Promise<CapabilityPacketEntry['example']> {
 for(const [base,usages] of [['recipes',recipes],['examples/cookbook',cookbook]] as const) {
  let best:NonNullable<CapabilityPacketEntry['example']>|undefined;
  for(const usage of usages) {
   let document:unknown;
   try {document=parseYaml(await readFile(new URL(`../../../${base}/${usage.file}`,import.meta.url),'utf8'));} catch {continue;}
   if(!isRecord(document)||!isRecord(document.routes))continue;
   for(const route of usage.routes) {
    const value=(document.routes as Record<string,unknown>)[route];
    if(value===undefined)continue;
    const yaml=stringify({routes:{[route]:value}},{lineWidth:0,aliasDuplicateObjects:false});
    if(yaml.length>exampleMaxCharacters||(best&&best.yaml.length<=yaml.length))continue;
    const recipe=base==='recipes'?usage.file.split('/')[0]:undefined;
    best={source:`${base}/${usage.file}`,route,yaml,note:`Paths in it are relative to that example's project root.${recipe?` Full recipe: urlcode recipes show ${recipe}`:''}`};
   }
  }
  if(best)return best;
 }
 return null;
}
async function addonNames():Promise<Set<string>> {
 try {return new Set((await readAddonCatalog()).addons.map(addon=>addon.name));} catch {return new Set();}
}
async function capabilityPacket(requested:readonly string[],targetName:string|undefined):Promise<NonNullable<Bootstrap['capabilities']>> {
 const names=[...new Set(requested.map(name=>name.trim()).filter(Boolean))];
 if(names.length>bootstrapMaxCapabilities)throw new ConfigError(`Name at most ${bootstrapMaxCapabilities} capabilities per bootstrap; the packet is a focused contract, not the catalog (urlcode capabilities lists them all)`,{code:'invalid-option-value'});
 const target=targetName===undefined?undefined:normalizeCapabilityTarget(targetName);
 const packet:CapabilityPacketEntry[]=[],unknown:{name:string;reason:string}[]=[],unsupported:NonNullable<Bootstrap['capabilities']>['unsupported']=[];
 const addons=names.some(name=>!(capabilityNames as readonly string[]).includes(name))?await addonNames():new Set<string>();
 for(const name of names) {
  if(!(capabilityNames as readonly string[]).includes(name)) {
   unknown.push({name,reason:addons.has(name)
    ?`${name} is an add-on extension, not a core capability: urlcode extensions add ${name} installs it, and urlcode extensions --host-file host.mjs --json reports its schemas.`
    :'Not in this runtime\'s capability catalog; urlcode capabilities lists every name. Report it as a gap rather than inventing YAML for it.'});
   continue;
  }
  const entry=getCapability(name);
  const targets:CapabilityPacketEntry['targets']={};
  for(const item of target===undefined?capabilityTargets:[target]) {
   const decision=entry.targets[item];
   targets[item]=target===undefined?decision.support:{support:decision.support,reason:decision.reason};
   if(target!==undefined&&(decision.support==='refused'||decision.support==='unknown'))unsupported.push({name,target,support:decision.support,reason:decision.reason});
  }
  packet.push({
   name:entry.name,kind:entry.kind,summary:entry.summary,constraints:entry.constraints,grants:entry.grants,
   schema:entry.schemaFragments.map(({path,pointer,schema})=>({path,pointer,schema})),
   targets,refused:target===undefined?entry.refused:entry.refused.filter(item=>item.target===target),
   example:await exampleFor(entry.recipes,entry.cookbook),
  });
 }
 return {requested:names,packet,unknown,unsupported};
}
/** Extensions and binding requests decide which operator flags the commands still need; a load failure is a diagnostic. */
async function projectFacts(project:string):Promise<{extensions:number;bindings:number}|{error:string}> {
 try {
  const loaded=await loadDocument(project);
  let bindings=0;
  for(const route of Object.values(loaded.routes))bindings+=Object.keys(route.env??{}).length+Object.keys(route.secrets??{}).length;
  return {extensions:Object.keys(loaded.document.extensions??{}).length,bindings};
 } catch(error) {return {error:describeError(error)};}
}
async function createSite(directory:string,adopt:boolean):Promise<{created:string[];leftAlone:string[]}> {
 if(basename(directory)===PROJECT_DIRECTORY)throw new ConfigError(`A site keeps its route project in ${PROJECT_DIRECTORY}/, so creating a site at an ${PROJECT_DIRECTORY} directory nests ${PROJECT_DIRECTORY}/${PROJECT_DIRECTORY}; name the site directory (${shellWord(dirname(directory))}) instead`,{code:'nested-site'});
 const enclosing=await enclosingProject(directory);
 if(enclosing!==undefined)throw new ConfigError(`The destination is inside an existing URLCode project (${enclosing}); bootstrap that site instead of creating one inside it`,{code:'nested-site'});
 const before=new Set(await readdir(directory).catch(()=>[] as string[]));
 const {initSite,initListLimit}=await import('./authoring.ts');
 const {leftAlone}=await initSite(directory,{adopt});
 return {created:(await readdir(directory)).filter(name=>!before.has(name)).sort(),leftAlone:adopt?leftAlone.slice(0,initListLimit):[]};
}
/** With no site here: the create command that would succeed, or why init would refuse this directory. Read-only. */
async function createAdvice(target:string,destination:string,invocation:string):Promise<string> {
 const create=`${invocation} bootstrap --create ${shellWord(destination)}`;
 if(destination!==target)return `No URLCode site here, and nothing was created. To create one, name the destination explicitly: ${create}`;
 const {planInit,boundedList}=await import('./authoring.ts');
 const plan=await planInit(target,{adopt:true}).catch(()=>undefined);
 if(plan?.mode!=='adopt')return `No URLCode site here, and nothing was created. To create one, name the destination explicitly: ${create}`;
 if(plan.refusal!==undefined)return `No URLCode site here, and nothing was created. This directory already holds ${boundedList(plan.foreign,5)}, and init would refuse to adopt it: ${plan.refusal}`;
 return `No URLCode site here, and nothing was created. This directory already holds ${boundedList(plan.foreign,5)}, none of which collides with what init writes; to create the site around it (writing only new files, moving nothing): ${create} --adopt`;
}
export async function buildBootstrap(directory:string,options:BootstrapOptions={}):Promise<Bootstrap> {
 const running=await runningRuntime();
 if(options.target!==undefined)normalizeCapabilityTarget(options.target);
 const requested=options.capabilities??[];
 const packet=requested.length?await capabilityPacket(requested,options.target):undefined;
 const target=await canonical(directory);
 let located=await locate(target),state:BootstrapState=located?'existing':'none',created:string[]|undefined,leftAlone:string[]=[];
 if(!located&&options.create) {({created,leftAlone}=await createSite(target,options.adopt===true));located=await locate(target);state='created';}
 const invocation=await cliInvocation(target);
 if(!located) {
  const enclosing=await enclosingProject(target);
  const destination=basename(target)===PROJECT_DIRECTORY&&!await exists(target)?dirname(target):target;
  const runtime:BootstrapRuntime={running,installed:null,pinned:null,status:'unverified',note:'No site here; the packet is the running runtime\'s contract.'};
  return {
   urlcode:running.version,schema:'1',kind:'bootstrap',state,site:null,runtime,
   ...(packet?{capabilities:packet}:{}),
   ...(enclosing===undefined?{}:{diagnostics:[{code:'inside-project',message:`This directory is inside a URLCode project (${enclosing}); bootstrap from that site root instead.`}]}),
   next:enclosing===undefined
    ?[await createAdvice(target,destination,invocation)]
    :[`Run bootstrap from the enclosing site (${enclosing}); do not create a site inside a project.`],
  };
 }
 const hostFile=located.layout==='site'&&await isFile(join(located.root,HOST_FILE))?HOST_FILE:null;
 const packageJson=await isFile(join(located.root,'package.json'))?'package.json':null;
 const runtime=await siteRuntime(located.root,running);
 const installNeeded=runtime.pinned!==null&&runtime.installed===null;
 const facts=await projectFacts(located.project);
 const diagnostics:{code:string;message:string}[]=[];
 if('error' in facts)diagnostics.push({code:'project-invalid',message:facts.error});
 const prerequisites='error' in facts?[]:prerequisitesFor({hostFile:hostFile??undefined,origin:options.origin},facts.extensions,facts.bindings);
 const capabilities=packet&&runtime.status==='mismatched'
  ?{requested:packet.requested,packet:[],unknown:packet.unknown,unsupported:packet.unsupported,withheld:'The running runtime does not match the site\'s; its schema fragments could describe a different contract. Bootstrap again with the site\'s runtime.'}
  :packet;
 const commands=await commandsFor(located,hostFile,options.origin,installNeeded);
 const projectRelative=toPosix(relative(located.root,located.project))||'.';
 const entry=projectRelative==='.'?'urlcode.yaml':`${projectRelative}/urlcode.yaml`;
 const next=[
  `Run every command from the site root (commands.cd).`,
  ...(installNeeded?['Install the pinned runtime first: commands.install.']:[]),
  ...(runtime.status==='mismatched'?[`Resolve the runtime mismatch before authoring: ${runtime.note}`]:[]),
  ...('error' in facts?[`Fix ${entry} first: it does not load (see diagnostics).`]:[]),
  `Author routes in ${entry}; file references in it are relative to ${projectRelative==='.'?'the site root':`${projectRelative}/`} (paths.rule).`,
  'Check each change with commands.validate, then commands.test; commands.start serves the site.',
 ];
 return {
  urlcode:running.version,schema:'1',kind:'bootstrap',state,...(created?{created}:{}),...(leftAlone.length?{leftAlone}:{}),
  site:{root:located.root,layout:located.layout,project:projectRelative,projectRoot:located.project,entry,hostFile,packageJson},
  runtime,paths:await pathMapping(located),commands,
  ...(prerequisites.length?{prerequisites}:{}),
  ...(capabilities?{capabilities}:{}),
  ...(diagnostics.length?{diagnostics}:{}),
  next,
 };
}
export function renderBootstrap(bootstrap:Bootstrap):string {return stringify(bootstrap,{lineWidth:0,aliasDuplicateObjects:false});}
