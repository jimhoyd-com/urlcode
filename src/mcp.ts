import {realpath} from 'node:fs/promises';
import type {Readable,Writable} from 'node:stream';
import {once} from 'node:events';
import {Ajv} from 'ajv';
import {inspectProject,validateProject,explainRoute,getCapabilities,getCapability,getSchemaFragment,previewImport,previewExport,listRecipes,showRecipe,searchRecipes,searchExamples,describeExtensions,buildContext,buildTaskContext,planFeature} from './tooling.ts';
import {loadOperatorHost} from './operator-host.ts';
import {buildManifest} from './manifest.ts';
import type {InterchangeFormat} from './interchange.ts';
import {authoringDefinitions,callAuthoringTool} from './mcp-authoring.ts';
import {listSkills,getSkill,searchDocs,getExample,validateYaml,explainError} from './agent-context.ts';
import {describeArtifactCache,readArtifactMember} from './extension-artifacts.ts';
const protocolVersion='2025-11-25';
const maxBytes=1048576;
const text={type:'string',maxLength:8192};
const format={enum:['csv','json','yaml','netlify','cloudflare','vercel','netlify-toml']};
const definitions=[
 {name:'inspect',description:'Inspect semantically validated route metadata without binding values or code execution.',properties:{target:text,offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:1000}}},
 {name:'validate',description:'Validate project syntax and route/policy semantics without activation.',properties:{}},
 {name:'capabilities',description:'Describe implementation compatibility, separately from deployment evidence.',properties:{target:text}},
 {name:'get_capability',description:'Describe one catalog capability: schema fragment, constraints, grants, target support and bundled recipe/cookbook uses.',properties:{name:{type:'string',maxLength:64}},required:['name']},
 {name:'get_schema',description:'Return the resolved JSON Schema fragment for a dotted urlcode.yaml path such as route, redirect or policies.cache.',properties:{path:{type:'string',maxLength:256}},required:['path']},
 {name:'explain',description:'Explain the route a path selects from the compiled configuration: methods, handler, middleware, inputs, policies, cache outcome, bindings and target support. Nothing executes.',properties:{target:text},required:['target']},
 {name:'get_manifest',description:'The generated semantic manifest: routes, capabilities, extensions, external requirements, functions, target support and the revision digest.',properties:{}},
 {name:'import_preview',description:'Preview redirect conversion from supplied text; writes no files.',properties:{format,text:{type:'string',maxLength:524288},acceptProviderDifferences:{type:'boolean'}},required:['format','text']},
 {name:'export_preview',description:'Preview redirect export from this project; writes no files.',properties:{format,acceptProviderDifferences:{type:'boolean'}},required:['format']},
 {name:'recipes_list',description:'List bundled local recipes.',properties:{}},
 {name:'recipes_show',description:'Show a bundled local recipe without writing it; metadata (capabilities, targets, grants, inputs, expected behavior) comes before file contents.',properties:{name:{type:'string',maxLength:64}},required:['name']},
 {name:'search_recipes',description:'Search bundled recipes by id, description, tags and capabilities; local text matching, no service. Check here before generating a common route by hand.',properties:{text:{type:'string',maxLength:256}},required:['text']},
 {name:'search_examples',description:'Search bundled runnable examples and the cookbook route index; returns the smallest matching example and its route.',properties:{text:{type:'string',maxLength:256}},required:['text']},
 {name:'list_skills',description:'List compact metadata for the bundled agent skills. Load a skill only when it applies.',properties:{}},
 {name:'get_skill',description:'Load one bundled agent SKILL.md by name.',properties:{name:{type:'string',maxLength:64}},required:['name']},
 {name:'search_docs',description:'Deterministically search the small packaged agent documentation corpus and return at most three short excerpts.',properties:{text:{type:'string',maxLength:256}},required:['text']},
 {name:'get_example',description:'Return the README and urlcode.yaml from one bundled runnable example.',properties:{name:{type:'string',maxLength:64}},required:['name']},
 {name:'validate_yaml',description:'Validate supplied URLCode YAML syntax and schema only. It never reads includes, source files, bindings or a project directory.',properties:{yaml:{type:'string',maxLength:524288}},required:['yaml']},
 {name:'explain_error',description:'Give deterministic next-step guidance for supplied URLCode validation output.',properties:{error:{type:'string',maxLength:8192}},required:['error']},
 {name:'get_extension_artifacts',description:'Validate and list the project\'s locked declarative extension artifacts and their allowlisted files. Artifacts are inert data and do not activate extension code.',properties:{}},
 {name:'get_extension_artifact',description:'Read one bounded JSON or Markdown file from a verified cached declarative extension artifact. The artifact name and member path must exist in the project lock/cache.',properties:{name:{type:'string',maxLength:64},path:{type:'string',maxLength:128}},required:['name','path']},
 {name:'get_context',description:'Emit the compact project context an authoring agent needs: versions, project summary, constraints, target support and exact commands, derived from the compiled project. Pass `task: "redirects"` for a bounded, redirect-focused call instead (supported/gap shapes, exact YAML, this project\'s redirects). Optional token budget drops sections in a fixed order.',properties:{target:text,task:{enum:['redirects']},budget:{type:'integer',minimum:1}}},
 {name:'plan_feature',description:'Plan a bounded feature from the compiled project, current capability catalog, local recipes, locked inert artifacts and already-loaded operator registrations. Returns contracts and next calls, never generated application code, binding values, remote content or mutations.',properties:{goal:{type:'string',minLength:1,maxLength:512},target:{enum:['self-hosted','cloudflare','aws','vercel','static']}},required:['goal']},
];
// Only the operator's own --host-file exposes registered extension contracts; no tool argument can name one.
const hostDefinition={name:'get_extensions',description:'List operator-registered extension contracts, schemas, hooks, and supported project-owned customization surfaces with fast checks; use these before generating replacement framework code. Activates nothing.',properties:{}};
const ajv=new Ajv({strict:false});
const readTools=definitions.map(def=>({name:def.name,description:def.description,inputSchema:{type:'object',properties:def.properties,required:def.required??[],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}}));
const hostTool={name:hostDefinition.name,description:hostDefinition.description,inputSchema:{type:'object',properties:hostDefinition.properties,required:[],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}};
const authoringTools=authoringDefinitions.map(def=>({name:def.name,description:def.description,inputSchema:{type:'object',properties:def.properties,required:def.required,additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}}));
const validators=new Map([...readTools,hostTool,...authoringTools].map(tool=>[tool.name,ajv.compile(tool.inputSchema)]));
function object(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
/** `allowAuthoring` and `hostFile` are set only by the `--allow-authoring` and `--host-file` command-line flags; tool arguments and the environment never enable them. */
export interface McpOptions {project:string;input?:Readable;output?:Writable;origin?:string;allowAuthoring?:boolean;hostFile?:string}
/** Operator selects the only project root. Read tools have no path, credential, write or execution authority; authoring tools write inside that root only. */
export async function serveMcp(options:McpOptions):Promise<void> {
 const project=await realpath(options.project),input=options.input??process.stdin,output=options.output??process.stdout;
 const authoring=options.allowAuthoring===true,tools=[...readTools,...(options.hostFile===undefined?[]:[hostTool]),...(authoring?authoringTools:[])],names=new Set(tools.map(tool=>tool.name));
 const host=await loadOperatorHost(options.hostFile,project);
 try{await serve();}finally{await host.close?.();}
 async function serve():Promise<void> {
 let initialized=false,ready=false,pending=Buffer.alloc(0);
 const send=async(value:unknown)=> {let line=JSON.stringify(value);if(Buffer.byteLength(line)>maxBytes)line=JSON.stringify({jsonrpc:'2.0',id:object(value)?value.id??null:null,error:{code:-32603,message:'Result exceeds output limit'}});if(!output.write(line+'\n'))await once(output,'drain');};
 const error=(id:unknown,code:number,message:string)=>send({jsonrpc:'2.0',id,error:{code,message}});
 const call=async(name:string,args:Record<string,unknown>):Promise<unknown>=> {
  const base=options.origin?{origin:options.origin}:{};
  switch(name){
   case 'inspect':return inspectProject(project,{...base,...args} as Parameters<typeof inspectProject>[1]);
   case 'validate':return validateProject(project,base);
   case 'capabilities':return getCapabilities(args.target as string|undefined);
   case 'get_capability':return getCapability(args.name as string);
   case 'get_schema':return getSchemaFragment(args.path as string);
   case 'explain':return explainRoute(project,args.target as string,base);
   case 'get_manifest':return buildManifest(project,base);
   case 'import_preview':return previewImport({format:args.format as InterchangeFormat,text:args.text as string,acceptProviderDifferences:args.acceptProviderDifferences===true});
   case 'export_preview':return previewExport(project,args.format as InterchangeFormat,args.acceptProviderDifferences===true);
   case 'recipes_list':return listRecipes();
   case 'recipes_show':return showRecipe(args.name as string);
   case 'search_recipes':return searchRecipes(args.text as string);
   case 'search_examples':return searchExamples(args.text as string);
   case 'list_skills':return listSkills();
   case 'get_skill':return getSkill(args.name as string);
   case 'search_docs':return searchDocs(args.text as string);
   case 'get_example':return getExample(args.name as string);
   case 'validate_yaml':return validateYaml(args.yaml as string);
   case 'explain_error':return explainError(args.error as string);
   case 'get_extension_artifacts':return describeArtifactCache(project);
   case 'get_extension_artifact':return readArtifactMember(project,args.name as string,args.path as string);
   case 'get_extensions':return describeExtensions(project,host.extensions??[]);
   case 'get_context':return typeof args.task==='string'
    ?buildTaskContext(project,args.task,{...(typeof args.budget==='number'?{budget:args.budget}:{})})
    :buildContext(project,{projectFlag:'.',...(typeof args.target==='string'?{target:args.target}:{}),...(typeof args.budget==='number'?{budget:args.budget}:{})});
   case 'plan_feature':return planFeature(project,args.goal as string,{...(typeof args.target==='string'?{target:args.target}:{}),extensions:host.extensions});
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
   initialized=true;await send({jsonrpc:'2.0',id,result:{protocolVersion,capabilities:{tools:{}},serverInfo:{name:'urlcode',version:'0.5.3'}}});return;
  }
  if(message.method==='ping'){await send({jsonrpc:'2.0',id,result:{}});return;}
  if(!ready){await error(id,-32002,'Initialize first');return;}
  if(message.method==='tools/list'){await send({jsonrpc:'2.0',id,result:{tools}});return;}
  if(message.method!=='tools/call'){await error(id,-32601,'Method not found');return;}
  const name=params.name,args=params.arguments??{};
  if(typeof name!=='string'||!names.has(name)||!validators.get(name)!(args)){await error(id,-32602,'Invalid tool or arguments');return;}
  try{const result=await call(name,args as Record<string,unknown>);await send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}]}});}catch{await send({jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:'Operation failed validation; inspect locally for details.'}]}});}
 };
 for await(const chunk of input){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as string);let start=0;
  for(let index=0;index<bytes.length;index++){if(bytes[index]!==10)continue;if(pending.length+index-start>maxBytes){await error(null,-32600,'Message exceeds input limit');return;}const message=Buffer.concat([pending,bytes.subarray(start,index)]);pending=Buffer.alloc(0);start=index+1;await line(message);}
  if(pending.length+bytes.length-start>maxBytes){await error(null,-32600,'Message exceeds input limit');return;}pending=Buffer.concat([pending,bytes.subarray(start)]);
 }
 if(pending.length)await error(null,-32700,'Truncated message');
 }
}
