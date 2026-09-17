import {realpath} from 'node:fs/promises';
import type {Readable,Writable} from 'node:stream';
import {once} from 'node:events';
import {Ajv} from 'ajv';
import {inspectProject,validateProject,explainRoute,getCapabilities,previewImport,previewExport,listRecipes,showRecipe} from './tooling.ts';
import type {InterchangeFormat} from './interchange.ts';
const protocolVersion='2025-11-25';
const maxBytes=1048576;
const text={type:'string',maxLength:8192};
const format={enum:['csv','json','yaml','netlify','cloudflare','vercel','netlify-toml']};
const definitions=[
 {name:'inspect',description:'Inspect semantically validated route metadata without binding values or code execution.',properties:{target:text,offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:1000}}},
 {name:'validate',description:'Validate project syntax and route/policy semantics without activation.',properties:{}},
 {name:'capabilities',description:'Describe implementation compatibility, separately from deployment evidence.',properties:{target:text}},
 {name:'explain',description:'Explain path selection only; does not execute a route.',properties:{target:text},required:['target']},
 {name:'import_preview',description:'Preview redirect conversion from supplied text; writes no files.',properties:{format,text:{type:'string',maxLength:524288},acceptProviderDifferences:{type:'boolean'}},required:['format','text']},
 {name:'export_preview',description:'Preview redirect export from this project; writes no files.',properties:{format,acceptProviderDifferences:{type:'boolean'}},required:['format']},
 {name:'recipes_list',description:'List bundled local recipes.',properties:{}},
 {name:'recipes_show',description:'Show a bundled local recipe without writing it.',properties:{name:{type:'string',maxLength:64}},required:['name']},
];
const ajv=new Ajv({strict:false});
const tools=definitions.map(def=>({name:def.name,description:def.description,inputSchema:{type:'object',properties:def.properties,required:def.required??[],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}}));
const validators=new Map(tools.map(tool=>[tool.name,ajv.compile(tool.inputSchema)]));
function object(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
export interface McpOptions {project:string;input?:Readable;output?:Writable;origin?:string}
/** Operator selects the only project root. Tools have no path, credential, write or execution authority. */
export async function serveMcp(options:McpOptions):Promise<void> {
 const project=await realpath(options.project),input=options.input??process.stdin,output=options.output??process.stdout;
 let initialized=false,ready=false,pending=Buffer.alloc(0);
 const send=async(value:unknown)=> {let line=JSON.stringify(value);if(Buffer.byteLength(line)>maxBytes)line=JSON.stringify({jsonrpc:'2.0',id:object(value)?value.id??null:null,error:{code:-32603,message:'Result exceeds output limit'}});if(!output.write(line+'\n'))await once(output,'drain');};
 const error=(id:unknown,code:number,message:string)=>send({jsonrpc:'2.0',id,error:{code,message}});
 const call=async(name:string,args:Record<string,unknown>):Promise<unknown>=> {
  const base=options.origin?{origin:options.origin}:{};
  switch(name){
   case 'inspect':return inspectProject(project,{...base,...args} as Parameters<typeof inspectProject>[1]);
   case 'validate':return validateProject(project,base);
   case 'capabilities':return getCapabilities(args.target as string|undefined);
   case 'explain':return explainRoute(project,args.target as string,base);
   case 'import_preview':return previewImport({format:args.format as InterchangeFormat,text:args.text as string,acceptProviderDifferences:args.acceptProviderDifferences===true});
   case 'export_preview':return previewExport(project,args.format as InterchangeFormat,args.acceptProviderDifferences===true);
   case 'recipes_list':return listRecipes();
   case 'recipes_show':return showRecipe(args.name as string);
   default:throw new Error('Unknown tool');
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
   initialized=true;await send({jsonrpc:'2.0',id,result:{protocolVersion,capabilities:{tools:{}},serverInfo:{name:'urlcode',version:'0.3.0'}}});return;
  }
  if(message.method==='ping'){await send({jsonrpc:'2.0',id,result:{}});return;}
  if(!ready){await error(id,-32002,'Initialize first');return;}
  if(message.method==='tools/list'){await send({jsonrpc:'2.0',id,result:{tools}});return;}
  if(message.method!=='tools/call'){await error(id,-32601,'Method not found');return;}
  const name=params.name,args=params.arguments??{};
  if(typeof name!=='string'||!validators.has(name)||!validators.get(name)!(args)){await error(id,-32602,'Invalid tool or arguments');return;}
  try{const result=await call(name,args as Record<string,unknown>);await send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}]}});}catch{await send({jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:'Operation failed validation; inspect locally for details.'}]}});}
 };
 for await(const chunk of input){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as string);let start=0;
  for(let index=0;index<bytes.length;index++){if(bytes[index]!==10)continue;if(pending.length+index-start>maxBytes){await error(null,-32600,'Message exceeds input limit');return;}const message=Buffer.concat([pending,bytes.subarray(start,index)]);pending=Buffer.alloc(0);start=index+1;await line(message);}
  if(pending.length+bytes.length-start>maxBytes){await error(null,-32600,'Message exceeds input limit');return;}pending=Buffer.concat([pending,bytes.subarray(start)]);
 }
 if(pending.length)await error(null,-32700,'Truncated message');
}
