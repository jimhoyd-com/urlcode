import {basename,dirname,join,resolve} from 'node:path';
import type {Readable,Writable} from 'node:stream';
import {once} from 'node:events';
import {Ajv} from 'ajv';
import type {ErrorObject} from 'ajv';
import {describeError} from './errors.ts';
import {inspectProject,validateProject,explainRoute,getCapabilities,getCapability,getSchemaFragment,previewImport,previewExport,listRecipes,showRecipe,searchRecipes,searchExamples,describeExtensions,buildContext,buildTaskContext,planFeature,reviewProject} from './tooling.ts';
import {runProjectTests} from './project-tests.ts';
import {loadOperatorHost} from './operator-host.ts';
import {buildManifest} from './manifest.ts';
import type {InterchangeFormat} from './interchange.ts';
import {authoringDefinitions,authoringAnnotations,callAuthoringTool} from './mcp-authoring.ts';
// Only the public @jimhoyd/urlcode/agent-context surface is used here; scripts/package-smoke.ts proves that
// subpath sufficient from the packed package (docs/TOOLING.md). A relative import keeps the source from loading
// the built dist/, which tests rebuild concurrently.
import {listSkills,getSkill,listAgentCatalog,readAddonCatalog,searchDocs,getExample,validateYaml,explainError,suggestFixtures} from './agent-context.ts';
import {suggestProjectFixtures} from './fixture-suggestions.ts';
import {summarizeChange} from './yaml-change.ts';
import {realpath} from 'node:fs/promises';
import {isRecord as object} from './object-guards.ts';
import {describeInstalledAgentTooling,describeInstalledArtifacts,readArtifactMember} from './addon-install.ts';
// Newest first. The tool surface used here (initialize, tools/list, tools/call,
// ping, text content, isError) is the same in every listed revision; newer
// fields such as tool annotations are optional hints older clients ignore.
const protocolVersions=['2025-11-25','2025-06-18','2025-03-26','2024-11-05'] as const;
// MCP lifecycle negotiation: echo a requested revision this server supports, otherwise offer the latest.
function negotiateProtocolVersion(requested:string):string {return (protocolVersions as readonly string[]).includes(requested)?requested:protocolVersions[0];}
const maxBytes=1048576;
const text={type:'string',maxLength:8192};
const format={enum:['csv','json','yaml','netlify','cloudflare','vercel','netlify-toml']};
const deployTargetEnum={enum:['self-hosted','cloudflare','aws','vercel','static']};
// `target` means two unrelated things across this surface: a route-selecting path (`explain`'s
// `target`) and a deployment target (self-hosted/cloudflare/aws/vercel/static, everywhere else).
// `deployTarget` is the canonical name for the latter; `target` stays accepted on these tools as a
// deprecated alias for one release so an existing caller is not broken by the rename.
const deployTargetProps={deployTarget:deployTargetEnum,target:{...deployTargetEnum,description:'Deprecated alias for deployTarget; use deployTarget.'}};
// Canonical, verb-first tool names. `legacy` names the pre-#590 name this tool answers to as well
// (kept working, and listed in tools/list, for one release); see aliasOf/legacyNames below.
const definitions=[
 {name:'get_context',description:'Emit the compact project context an authoring agent needs: versions, project summary, constraints, target support and exact commands, derived from the compiled project. Pass `task: "redirects"` for a bounded, redirect-focused call instead (supported/gap shapes, exact YAML, this project\'s redirects). Optional token budget drops sections in a fixed order. Call this first.',properties:{...deployTargetProps,task:{enum:['redirects']},budget:{type:'integer',minimum:1}}},
 {name:'inspect',description:'Inspect semantically validated route metadata without binding values or code execution.',properties:{...deployTargetProps,offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:1000}}},
 {name:'validate',description:'Validate project syntax and route/policy semantics without activation.',properties:{}},
 {name:'list_capabilities',legacy:'capabilities',description:'Describe implementation compatibility, separately from deployment evidence.',properties:deployTargetProps},
 {name:'get_capability',description:'Describe one catalog capability: schema fragment, constraints, grants, target support and bundled recipe/cookbook uses.',properties:{name:{type:'string',maxLength:64}},required:['name']},
 {name:'get_schema',description:'Return the resolved JSON Schema fragment for a dotted urlcode.yaml path such as route, redirect or policies.cache.',properties:{path:{type:'string',maxLength:256}},required:['path']},
 {name:'explain',description:'Explain the route a path selects from the compiled configuration: methods, handler, middleware, inputs, policies, cache outcome, bindings and target support. Nothing executes.',properties:{target:text},required:['target']},
 {name:'get_manifest',description:'The generated semantic manifest: routes, capabilities, extensions, external requirements, functions, target support and the revision digest.',properties:{}},
 {name:'preview_import',legacy:'import_preview',description:'Preview redirect conversion from supplied text; writes no files.',properties:{format,text:{type:'string',maxLength:524288},acceptProviderDifferences:{type:'boolean'}},required:['format','text']},
 {name:'preview_export',legacy:'export_preview',description:'Preview redirect export from this project; writes no files.',properties:{format,acceptProviderDifferences:{type:'boolean'}},required:['format']},
 {name:'list_recipes',legacy:'recipes_list',description:'List bundled local recipes.',properties:{}},
 {name:'get_recipe',legacy:'recipes_show',description:'Show a bundled local recipe without writing it; metadata (capabilities, targets, grants, inputs, expected behavior) comes before file contents.',properties:{name:{type:'string',maxLength:64}},required:['name']},
 {name:'search_recipes',description:'Search bundled recipes by id, description, tags and capabilities; local text matching, no service. Check here before generating a common route by hand.',properties:{text:{type:'string',maxLength:256}},required:['text']},
 {name:'search_examples',description:'Search bundled runnable examples and the cookbook route index; returns the smallest matching example and its route.',properties:{text:{type:'string',maxLength:256}},required:['text']},
 {name:'list_skills',description:'List every bundled agent skill (name and its own SKILL.md description). Load a skill only when it applies.',properties:{}},
 {name:'get_skill',description:'Load one bundled agent SKILL.md by name.',properties:{name:{type:'string',maxLength:64}},required:['name']},
 {name:'list_agent_catalog',description:'List the revision-pinned agent discovery index: core skills/references and signed add-ons. Use get_extensions or get_extension_artifacts for project-installed component details.',properties:{}},
 {name:'get_release_addon_catalog',description:'Return the release-wide add-on catalog pinned to this core: every signed extension and artifact with its package, version, description, requirements and descriptor agent references (paths relative to that add-on\'s package). Discovery metadata only: it is not evidence that this project installed or activated an add-on, and it never imports, fetches or installs one. Use get_addon_agent_tooling, get_extensions or get_extension_artifacts for what this project has installed.',properties:{}},
 {name:'search_docs',description:'Deterministically search the small packaged agent documentation corpus and return at most three short excerpts.',properties:{text:{type:'string',maxLength:256}},required:['text']},
 {name:'get_example',description:'Return the README and urlcode.yaml from one bundled runnable example.',properties:{name:{type:'string',maxLength:64}},required:['name']},
 {name:'validate_yaml',description:'Validate supplied URLCode YAML syntax and schema only. It never reads includes, source files, bindings or a project directory.',properties:{yaml:{type:'string',maxLength:524288}},required:['yaml']},
 {name:'explain_error',description:'Give deterministic next-step guidance for supplied URLCode validation output.',properties:{error:{type:'string',maxLength:8192}},required:['error']},
 {name:'suggest_fixtures',description:'Suggest tests/requests.json cases for the project\'s YAML (urlcode.yaml and its includes, each entry naming its file), or for supplied `yaml`, only where the YAML alone determines the answer (redirect, respond, page/download, 405, 404, simple input refusals). Function, middleware, proxy, extension, pattern-constrained and binding routes, and the includes of supplied `yaml`, are returned under `gaps`, never as fixtures; `review` names routes needing hand-written cases. Reads YAML only (never sources, assets or bindings); writes and executes nothing.',properties:{yaml:{type:'string',maxLength:524288},maxFixtures:{type:'integer',minimum:1,maximum:1000}}},
 {name:'summarize_yaml_change',description:'Summarize what changes from `before` YAML to `after` YAML (default: the project\'s urlcode.yaml read with its includes, each route naming its file): routes added/removed/changed with the changed keys, capability names, trusted and sandboxed function/middleware seams and sandbox flips, and operator grants (env, secret, egress, extension) newly requested or released. Names and keys only, never values; both documents must validate. Reads and executes nothing else.',properties:{before:{type:'string',maxLength:524288},after:{type:'string',maxLength:524288}},required:['before']},
 {name:'get_extension_artifacts',description:'List the artifacts installed in this site (inert data add-ons such as schemas), whether each matches the runtime\'s pin, and their files. Artifacts never execute and activate nothing.',properties:{}},
 {name:'get_extension_artifact',description:'Read one bounded JSON or Markdown file from an installed, pinned artifact. The name and path must be listed by get_extension_artifacts.',properties:{name:{type:'string',maxLength:64},path:{type:'string',maxLength:128}},required:['name','path']},
 {name:'get_addon_agent_tooling',description:'List agent references declared by installed, core-pinned extensions and inert artifacts. Metadata only: it never imports an extension or reads a reference file.',properties:{}},
 {name:'plan_feature',description:'Plan a bounded feature from the compiled project, current capability catalog, local recipes, installed inert artifacts and already-loaded operator registrations. Returns contracts and next calls, never generated application code, binding values, remote content or mutations.',properties:{goal:{type:'string',minLength:1,maxLength:512},...deployTargetProps},required:['goal']},
 {name:'review',legacy:'review_project',description:'Opt-in, read-only static review of the project\'s own function/middleware source for avoidable plumbing: native-alternative/extension-alternative/gap/manual-review. Already-loaded operator registrations (--host-file) sharpen extension-alternative findings with registered/revision-pinned state; without a host file that state stays conservative ("declared, setup unconfirmed"). No execution, no secrets, no network. Named to match the CLI\'s `urlcode review`.',properties:deployTargetProps},
];
// Pre-#590 tool name -> canonical name, and its inverse. A legacy-named entry is a second tools/list
// row (own description, "Deprecated alias for ...") with the same input schema and handler as its
// canonical tool, so an existing client keeps working unmodified for one release.
const legacyNames=Object.fromEntries(definitions.filter(def=>'legacy' in def).map(def=>[def.name,(def as {legacy:string}).legacy]));
const aliasOf=Object.fromEntries(Object.entries(legacyNames).map(([canonical,legacy])=>[legacy,canonical]));
// Only the operator's own --host-file exposes registered extension contracts; no tool argument can name one.
// run_tests executes the project's code, so it is not a read tool: it is offered only under the operator's
// --allow-authoring flag, alongside the authoring tools, and annotated as able to do anything Node can (#590).
const runTestsDefinition={name:'run_tests',description:'Run this project\'s request fixtures (tests/requests.json) in-process against a temporary local server instance, the same behavior `urlcode test` uses. This EXECUTES the project\'s trusted function and middleware modules and its registered extensions with full Node access, so they may write or delete files, spawn processes or reach the network; the scratch data directory it creates and removes afterward is not confinement. Routes that declare `sandbox: true` still run in their isolated sandbox. Offered only when the operator starts the server with --allow-authoring. Bindings that need an operator-granted policy still fail as usual; this tool accepts no --policy file.',properties:{}};
const hostDefinition={name:'get_extensions',description:'List operator-registered extension contracts, schemas, hooks, and supported project-owned customization surfaces with fast checks; use these before generating replacement framework code. Activates nothing.',properties:{}};
const ajv=new Ajv({strict:false,allErrors:true});
// A -32602 message an agent can act on: the offending argument by name, and
// what the tool does accept.
function argumentProblems(tool:{name:string;inputSchema:{properties:Record<string,unknown>;required:readonly string[]}},errors:ErrorObject[]|null|undefined):string {
 const problems=[...new Set((errors??[]).map(error=>{
  const at=error.instancePath?`argument ${JSON.stringify(error.instancePath.slice(1).replaceAll('/','.'))}`:'arguments';
  if(error.keyword==='additionalProperties')return `unknown argument ${JSON.stringify((error.params as {additionalProperty:string}).additionalProperty)}`;
  if(error.keyword==='required')return `missing required argument ${JSON.stringify((error.params as {missingProperty:string}).missingProperty)}`;
  if(error.keyword==='enum')return `${at} must be one of ${(error.params as {allowedValues:unknown[]}).allowedValues.map(value=>JSON.stringify(value)).join(', ')}`;
  return `${at} ${error.message??'is invalid'}`;
 }))];
 const accepted=Object.keys(tool.inputSchema.properties);
 return `Invalid arguments for ${tool.name}: ${problems.join('; ')||'arguments must be an object'}. Accepted arguments: ${accepted.length?accepted.map(name=>tool.inputSchema.required.includes(name)?`${name} (required)`:name).join(', '):'none'}`;
}
const canonicalReadTools=definitions.map(def=>({name:def.name,description:def.description,inputSchema:{type:'object',properties:def.properties,required:def.required??[],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}}));
// One tools/list row per pre-#590 name, same schema and handler as its canonical tool, kept for
// one release so an existing client that calls the old name is not broken by this rename.
const legacyReadTools=canonicalReadTools.filter(tool=>legacyNames[tool.name]!==undefined).map(tool=>({...tool,name:legacyNames[tool.name]!,description:`Deprecated alias for \`${tool.name}\`; use \`${tool.name}\`. ${tool.description}`}));
const readTools=[...canonicalReadTools,...legacyReadTools];
const hostTool={name:hostDefinition.name,description:hostDefinition.description,inputSchema:{type:'object',properties:hostDefinition.properties,required:[],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}};
const runTestsTool={name:runTestsDefinition.name,description:runTestsDefinition.description,inputSchema:{type:'object',properties:runTestsDefinition.properties,required:[],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true}};
const authoringTools=[...authoringDefinitions.map(def=>({name:def.name,description:def.description,inputSchema:{type:'object',properties:def.properties,required:def.required,additionalProperties:false},annotations:authoringAnnotations(def)})),runTestsTool];
/** The tool names each server mode exposes; scripts/check-agent-facts.ts compares documented tool counts against it. */
export const mcpToolInventory:{readonly read:readonly string[];readonly hostFile:readonly string[];readonly authoring:readonly string[]}={read:readTools.map(tool=>tool.name),hostFile:[hostTool.name],authoring:authoringTools.map(tool=>tool.name)};
/** Canonical (non-legacy) read tool names, including the host-file get_extensions tool: every tool another module suggests as a next call must be one of these. */
export const canonicalMcpToolNames:readonly string[]=[...definitions.map(def=>def.name),hostDefinition.name];
const validators=new Map([...readTools,hostTool,...authoringTools].map(tool=>[tool.name,{tool,validate:ajv.compile(tool.inputSchema)}]));
/** `allowAuthoring` and `hostFile` are set only by the `--allow-authoring` and `--host-file` command-line flags; tool arguments and the environment never enable them. */
export interface McpOptions {project:string;input?:Readable;output?:Writable;origin?:string;allowAuthoring?:boolean;hostFile?:string}
/** Operator selects the only project root. Read tools have no path, credential, write or execution authority; authoring tools write inside that root only, and `run_tests` (also authoring-gated) executes the project's trusted code. */
export async function serveMcp(options:McpOptions):Promise<void> {
 // `mcp print-config` registers the site's app/ before `urlcode init` creates it (#542): a project directory that does
 // not exist yet is anchored under its real parent (nothing below it can be a symlink), so tools answer "run urlcode
 // init" instead of the server failing to start.
 const project=await realpath(options.project).catch(async (error:unknown)=>{
  if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  const absolute=resolve(options.project);return join(await realpath(dirname(absolute)),basename(absolute));
 }),input=options.input??process.stdin,output=options.output??process.stdout;
 const authoring=options.allowAuthoring===true,tools=[...readTools,...(options.hostFile===undefined?[]:[hostTool]),...(authoring?authoringTools:[])],names=new Set(tools.map(tool=>tool.name));
 const host=await loadOperatorHost(options.hostFile,project);
 try{await serve();}finally{await host.close?.();}
 async function serve():Promise<void> {
 let initialized=false,ready=false,pending=Buffer.alloc(0);
 const send=async(value:unknown)=> {let line=JSON.stringify(value);if(Buffer.byteLength(line)>maxBytes)line=JSON.stringify({jsonrpc:'2.0',id:object(value)?value.id??null:null,error:{code:-32603,message:'Result exceeds output limit'}});if(!output.write(line+'\n'))await once(output,'drain');};
 const error=(id:unknown,code:number,message:string)=>send({jsonrpc:'2.0',id,error:{code,message}});
 // `deployTarget` is canonical; `target` still works on these tools (deprecated) for one release.
 const deployTargetOf=(value:Record<string,unknown>):string|undefined=> {const picked=value.deployTarget??value.target;return typeof picked==='string'?picked:undefined;};
 const call=async(name:string,args:Record<string,unknown>):Promise<unknown>=> {
  // The operator's --host-file registrations reach every compiled-project tool exactly as `urlcode explain/manifest
  // --host-file` and the SDK's `extensions` option pass them (#755); with no host file nothing is added.
  const registered=host.extensions===undefined?{}:{extensions:host.extensions};
  const base={...(options.origin?{origin:options.origin}:{}),...registered};
  // Legacy tool names route to the same handler as their canonical name (see aliasOf/legacyNames).
  switch(aliasOf[name]??name){
   case 'get_context':{const deployTarget=deployTargetOf(args);return typeof args.task==='string'
    ?buildTaskContext(project,args.task,{...(typeof args.budget==='number'?{budget:args.budget}:{})})
    :buildContext(project,{projectFlag:'.',...(options.hostFile===undefined?{}:{host}),...(deployTarget!==undefined?{target:deployTarget}:{}),...(typeof args.budget==='number'?{budget:args.budget}:{})});}
   case 'inspect':{const deployTarget=deployTargetOf(args);return inspectProject(project,{...base,...(args.offset!==undefined?{offset:args.offset as number}:{}),...(args.limit!==undefined?{limit:args.limit as number}:{}),...(deployTarget!==undefined?{target:deployTarget}:{})});}
   case 'validate':return validateProject(project,base);
   // Reachable only when --allow-authoring listed it: the names check above refuses it otherwise.
   case 'run_tests':{const events:unknown[]=[],result=await runProjectTests(project,{...base,extensions:host.extensions,log:(event:object)=>{events.push(event);}});return {...result,events};}
   case 'list_capabilities':return getCapabilities(deployTargetOf(args));
   case 'get_capability':return getCapability(args.name as string);
   case 'get_schema':return getSchemaFragment(args.path as string);
   case 'explain':return explainRoute(project,args.target as string,base);
   case 'get_manifest':return buildManifest(project,base);
   case 'preview_import':return previewImport({format:args.format as InterchangeFormat,text:args.text as string,acceptProviderDifferences:args.acceptProviderDifferences===true});
   case 'preview_export':return previewExport(project,args.format as InterchangeFormat,args.acceptProviderDifferences===true);
   case 'list_recipes':return listRecipes();
   case 'get_recipe':return showRecipe(args.name as string);
   case 'search_recipes':return searchRecipes(args.text as string);
   case 'search_examples':return searchExamples(args.text as string);
   case 'list_skills':return listSkills();
   case 'get_skill':return getSkill(args.name as string);
   case 'list_agent_catalog':return listAgentCatalog();
   case 'get_release_addon_catalog':return readAddonCatalog();
   case 'search_docs':return searchDocs(args.text as string);
   case 'get_example':return getExample(args.name as string);
   case 'validate_yaml':return validateYaml(args.yaml as string);
   case 'explain_error':return explainError(args.error as string);
   // Supplied `yaml`/`after` is text only (its includes are gaps); without it the project's YAML is read through the
   // configuration loader with its root-confined includes (#733). Neither reads a source file or executes anything.
   case 'suggest_fixtures':{const bound=typeof args.maxFixtures==='number'?{maxFixtures:args.maxFixtures}:{};return typeof args.yaml==='string'?suggestFixtures(args.yaml,bound):suggestProjectFixtures(project,bound);}
   case 'summarize_yaml_change':return summarizeChange({yaml:args.before as string},typeof args.after==='string'?{yaml:args.after}:{project});
   case 'get_extension_artifacts':return describeInstalledArtifacts(project);
   case 'get_extension_artifact':return readArtifactMember(project,args.name as string,args.path as string);
   case 'get_addon_agent_tooling':return describeInstalledAgentTooling(project);
   case 'get_extensions':return describeExtensions(project,host.extensions??[]);
   // With no host file there is no get_extensions tool, and the plan must not point at one.
   case 'plan_feature':{const deployTarget=deployTargetOf(args);return planFeature(project,args.goal as string,{...(deployTarget!==undefined?{target:deployTarget}:{}),...(options.hostFile===undefined?{}:{extensions:host.extensions??[]})});}
   case 'review':{const deployTarget=deployTargetOf(args);return reviewProject(project,{...base,...(deployTarget!==undefined?{target:deployTarget}:{}),extensions:host.extensions});}
   default:if(authoring)return callAuthoringTool(project,name,args,options.origin);throw new Error('Unknown tool');
  }
 };
 const line=async(bytes:Buffer)=> {
  let message:unknown;try{message=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{await error(null,-32700,'Parse error');return;}
  if(!object(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string'||('id'in message&&typeof message.id!=='string'&&!(typeof message.id==='number'&&Number.isSafeInteger(message.id)))) {await error(null,-32600,'Invalid request');return;}
  const id=message.id;
  if(id===undefined){if(message.method==='notifications/initialized'&&initialized)ready=true;return;}
  const params=message.params??{};
  if(!object(params)){await error(id,-32602,'Invalid params');return;}
  if(message.method==='initialize') {
   if(initialized){await error(id,-32600,'Already initialized');return;}
   if(typeof params.protocolVersion!=='string'||!object(params.capabilities)||!object(params.clientInfo)||typeof params.clientInfo.name!=='string'||typeof params.clientInfo.version!=='string'){await error(id,-32602,'Invalid initialize params');return;}
   initialized=true;await send({jsonrpc:'2.0',id,result:{protocolVersion:negotiateProtocolVersion(params.protocolVersion),capabilities:{tools:{}},serverInfo:{name:'urlcode',version:'0.6.1'}}});return;
  }
  if(message.method==='ping'){await send({jsonrpc:'2.0',id,result:{}});return;}
  if(!ready){await error(id,-32002,'Initialize first');return;}
  if(message.method==='tools/list'){await send({jsonrpc:'2.0',id,result:{tools}});return;}
  if(message.method!=='tools/call'){await error(id,-32601,'Method not found');return;}
  const name=params.name,args=params.arguments??{};
  if(typeof name!=='string'){await error(id,-32602,'tools/call requires a string "name"');return;}
  if(!names.has(name)){await error(id,-32602,`Unknown tool ${JSON.stringify(name.slice(0,64))}; call tools/list for the ${names.size} tools this session offers${validators.has(name)?` (${name} needs ${name==='get_extensions'?'the --host-file option':name==='run_tests'?'the --allow-authoring option because it executes the project\'s trusted code':'the --allow-authoring option'})`:''}`);return;}
  const checker=validators.get(name)!;
  if(!checker.validate(args)){await error(id,-32602,argumentProblems(checker.tool,checker.validate.errors));return;}
  // The server is local and operator-started with read access to this project
  // only, so the caller gets the same message the CLI prints for the failure.
  // structuredContent mirrors the same JSON already in the text content, for a client that reads it
  // directly instead of parsing text; only when the result is itself a JSON object, per the MCP
  // structuredContent shape (a bare array or scalar result stays text-only).
  try{const result=await call(name,args as Record<string,unknown>);await send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}],...(object(result)?{structuredContent:result}:{})}});}catch(failure){await send({jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:describeError(failure,{internal:true})}]}});}
 };
 for await(const chunk of input){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as string);let start=0;
  for(let index=0;index<bytes.length;index++){if(bytes[index]!==10)continue;if(pending.length+index-start>maxBytes){await error(null,-32600,'Message exceeds input limit');return;}const message=Buffer.concat([pending,bytes.subarray(start,index)]);pending=Buffer.alloc(0);start=index+1;await line(message);}
  if(pending.length+bytes.length-start>maxBytes){await error(null,-32600,'Message exceeds input limit');return;}pending=Buffer.concat([pending,bytes.subarray(start)]);
 }
 if(pending.length)await error(null,-32700,'Truncated message');
 }
}
