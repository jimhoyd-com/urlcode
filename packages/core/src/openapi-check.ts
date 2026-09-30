import {readFileSync} from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import {isRecord} from './object-guards.ts';

// `urlcode openapi --check` (#917): an OpenAPI document checked against the official OpenAPI 3.1 schema that ships
// with core (data/openapi, Apache-2.0, see NOTICE), every Schema Object against the JSON Schema 2020-12 meta-schema,
// and every local `$ref` against the document. The same checks back the repository's own export tests.

type Json=Record<string,unknown>;
export interface OpenApiProblem {where:string;message:string}
export interface OpenApiCheck {valid:boolean;schema:string;problems:OpenApiProblem[];schemaObjects:number;operations:number}
/** The dated OpenAPI 3.1 schema iteration core ships, by its `$id`. */
const officialOpenApiSchema='https://spec.openapis.org/oas/3.1/schema/2025-09-15';
const MAX_PROBLEMS=50;
const methods=['get','put','post','delete','options','head','patch','trace'];

let compiled:ReturnType<InstanceType<typeof Ajv2020.default>['compile']>|undefined;
/**
 * The official schema, compiled once. Its Schema Objects are `$dynamicRef: "#meta"`, whose only `$dynamicAnchor: meta`
 * in the file is `$defs/schema`; Ajv resolves that dynamic reference against the wrong scope, so it is replaced by
 * the equivalent static `$ref` before compiling (data/openapi/README.md). Formats are not checked.
 */
function officialValidator() {
  if(compiled)return compiled;
  const text=readFileSync(new URL('../../../data/openapi/oas-3.1-schema-2025-09-15.json',import.meta.url),'utf8');
  compiled=new Ajv2020.default({strict:false,allErrors:true,validateFormats:false}).compile(JSON.parse(text.replaceAll('"$dynamicRef": "#meta"','"$ref": "#/$defs/schema"')) as Json);
  return compiled;
}
const entries=(value:unknown):[string,unknown][]=>isRecord(value)?Object.entries(value):[];
const schemaOf=(value:unknown):unknown=>isRecord(value)?value.schema:undefined;
/** Every operation in the document's paths, with its path and method. */
function operationsOf(document:Json):[string,string,Json][] {
  return entries(document.paths).flatMap(([path,item])=>methods.flatMap(method=>isRecord(item)&&isRecord(item[method])?[[path,method,item[method]] as [string,string,Json]]:[]));
}
/** Every Schema Object in the document (components, parameters, bodies, responses and headers), with where it is. */
function openApiSchemaObjects(document:Json):[string,unknown][] {
  const found:[string,unknown][]=[];
  const components=isRecord(document.components)?document.components:{};
  for(const [name,schema] of entries(components.schemas))found.push([`components.schemas.${name}`,schema]);
  const media=(where:string,content:unknown)=>{for(const [type,value] of entries(content)){const schema=schemaOf(value);if(schema!==undefined)found.push([`${where} ${type}`,schema]);}};
  const headers=(where:string,value:unknown)=>{for(const [name,header] of entries(value)){const schema=schemaOf(header);if(schema!==undefined)found.push([`${where} header ${name}`,schema]);}};
  for(const [path,item] of entries(document.paths))for(const parameter of Array.isArray(isRecord(item)?item.parameters:undefined)?(item as {parameters:unknown[]}).parameters:[]){const schema=schemaOf(parameter);if(schema!==undefined)found.push([`${path} parameter ${String(isRecord(parameter)?parameter.name:'')}`,schema]);}
  for(const [path,method,operation] of operationsOf(document)){
    for(const parameter of Array.isArray(operation.parameters)?operation.parameters:[]){const schema=schemaOf(parameter);if(schema!==undefined)found.push([`${method} ${path} parameter ${String(isRecord(parameter)?parameter.name:'')}`,schema]);}
    media(`${method} ${path} request`,isRecord(operation.requestBody)?operation.requestBody.content:undefined);
    for(const [status,response] of entries(operation.responses)){media(`${method} ${path} ${status}`,isRecord(response)?response.content:undefined);headers(`${method} ${path} ${status}`,isRecord(response)?response.headers:undefined);}
  }
  headers('components.headers',Object.fromEntries(entries(components.headers)));
  for(const [name,parameter] of entries(components.parameters)){const schema=schemaOf(parameter);if(schema!==undefined)found.push([`components.parameters.${name}`,schema]);}
  for(const [name,body] of entries(components.requestBodies))media(`components.requestBodies.${name}`,isRecord(body)?body.content:undefined);
  for(const [name,response] of entries(components.responses)){media(`components.responses.${name}`,isRecord(response)?response.content:undefined);headers(`components.responses.${name}`,isRecord(response)?response.headers:undefined);}
  return found;
}
/** The value an RFC 6901 fragment pointer (`#/components/schemas/X`) names in `document`, or undefined. */
function resolvePointer(document:unknown,ref:string):unknown {
  let value=document;
  for(const raw of ref.slice(2).split('/')){
    const key=decodeURIComponent(raw).replaceAll('~1','/').replaceAll('~0','~');
    if(!isRecord(value)&&!Array.isArray(value))return undefined;
    if(!Object.hasOwn(value,key))return undefined;
    value=(value as Record<string,unknown>)[key];
  }
  return value;
}
/** Every local `$ref` (`#/…`) in the document that names nothing. Remote references are left to their owner. */
function danglingRefs(document:Json):OpenApiProblem[] {
  const problems:OpenApiProblem[]=[];
  const walk=(value:unknown,where:string):void=>{
    if(Array.isArray(value)){value.forEach((item,index)=>{walk(item,`${where}/${index}`);});return;}
    if(!isRecord(value))return;
    for(const [key,child] of Object.entries(value)){
      if(key==='$ref'&&typeof child==='string'&&child.startsWith('#/')&&resolvePointer(document,child)===undefined)problems.push({where:where||'/',message:`$ref ${child} names nothing in this document`});
      else walk(child,`${where}/${key.replaceAll('~','~0').replaceAll('/','~1')}`);
    }
  };
  walk(document,'');
  return problems;
}
/**
 * Checks a parsed OpenAPI document: the official OpenAPI 3.1 schema (the document's structure), the JSON Schema 2020-12
 * meta-schema (each Schema Object) and local `$ref` targets. At most 50 problems are reported, each located by a JSON
 * pointer or the operation it belongs to; no value from the document is repeated.
 */
export function checkOpenApiDocument(document:unknown):OpenApiCheck {
  const problems:OpenApiProblem[]=[];
  const oas=officialValidator();
  if(!oas(document))for(const error of oas.errors??[])problems.push({where:error.instancePath||'/',message:`${error.keyword}: ${error.message??'is invalid'}`});
  let schemaObjects=0,operations=0;
  if(isRecord(document)){
    operations=operationsOf(document).length;
    const meta=new Ajv2020.default({strict:false});
    for(const [where,schema] of openApiSchemaObjects(document)){
      schemaObjects++;
      if(!meta.validateSchema(schema as Json))for(const error of meta.errors??[])problems.push({where:`${where}${error.instancePath}`,message:`not a JSON Schema 2020-12 schema: ${error.keyword}: ${error.message??'is invalid'}`});
    }
    problems.push(...danglingRefs(document));
  }
  return {valid:problems.length===0,schema:officialOpenApiSchema,problems:problems.slice(0,MAX_PROBLEMS),schemaObjects,operations};
}
/** The human report for `urlcode openapi --check`. */
export function renderOpenApiCheck(result:OpenApiCheck,source:string):string {
  if(result.valid)return `${source} is a valid OpenAPI 3.1 document (${result.operations} operation${result.operations===1?'':'s'}, ${result.schemaObjects} Schema Object${result.schemaObjects===1?'':'s'} checked against ${result.schema} and JSON Schema 2020-12)\n`;
  return `${source} is not a valid OpenAPI 3.1 document (checked against ${result.schema}):\n${result.problems.map(problem=>`  ${problem.where}: ${problem.message}`).join('\n')}\n`;
}
