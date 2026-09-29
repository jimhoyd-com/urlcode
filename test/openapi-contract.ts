// The OpenAPI checks shared by the export's own tests (test/openapi.test.ts) and an extension's contribution
// (packages/store/test/openapi.test.ts): validity against the official OpenAPI 3.1 schema, and a contract run that
// derives requests from the document and checks each answer against the operation that declares it.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import type {OpenApiDocument} from '../packages/core/src/openapi.ts';
import {request} from './helpers.ts';
import type {Addressed,Response} from './helpers.ts';

export type Json=Record<string,unknown>;
export type Operation={operationId:string;requestBody?:{required?:boolean;content:Record<string,{schema?:Json}>;'x-urlcode'?:{maxBytes?:number}};responses:Record<string,{content?:Record<string,{schema?:Json}>;headers?:Json}>;security?:unknown[]};
export const methods=['get','put','post','delete','options','head','patch'];
/** The headers the runtime sets on every response, and the one it fixes on its own errors. */
export const always={'X-Request-Id':{$ref:'#/components/headers/UrlcodeRequestId'},'X-Content-Type-Options':{$ref:'#/components/headers/UrlcodeNosniff'}};
export const noStore={'Cache-Control':{$ref:'#/components/headers/UrlcodeNoStore'}};
export const operations=(document:OpenApiDocument):[string,string,Operation][]=>Object.entries(document.paths).flatMap(([path,item])=>methods.filter(method=>item[method]).map(method=>[path,method,item[method] as Operation] as [string,string,Operation]));

// The official OpenAPI 3.1 schema (test/fixtures/openapi/README.md). Its Schema Objects are `$dynamicRef: "#meta"`,
// whose only `$dynamicAnchor: meta` in this document is `$defs/schema`; Ajv resolves that dynamic reference against
// the wrong scope, so it is replaced by the equivalent static `$ref` before compiling.
const officialSchema=JSON.parse((await readFile(new URL('./fixtures/openapi/oas-3.1-schema-2025-09-15.json',import.meta.url),'utf8')).replaceAll('"$dynamicRef": "#meta"','"$ref": "#/$defs/schema"')) as Json;
const oas=new Ajv2020.default({strict:false,allErrors:true,validateFormats:false}).compile(officialSchema);
/** Every Schema Object in the document, with where it is. */
function schemaObjects(document:OpenApiDocument):[string,Json][] {
  const found:[string,Json][]=Object.entries(document.components.schemas).map(([name,schema])=>[`components.schemas.${name}`,schema as Json]);
  for(const [path,item] of Object.entries(document.paths)){
    for(const parameter of (item.parameters??[]) as {name:string;schema:Json}[])found.push([`${path} parameter ${parameter.name}`,parameter.schema]);
    for(const [,method,operation] of operations(document).filter(([candidate])=>candidate===path)){
      for(const [type,media] of Object.entries(operation.requestBody?.content??{}))if(media.schema)found.push([`${method} ${path} request ${type}`,media.schema]);
      for(const [status,response] of Object.entries(operation.responses)){
        for(const [type,media] of Object.entries(response.content??{}))if(media.schema)found.push([`${method} ${path} ${status} ${type}`,media.schema]);
        for(const [name,header] of Object.entries(response.headers??{}))if(!(header as Json).$ref)found.push([`${method} ${path} ${status} header ${name}`,(header as {schema:Json}).schema]);
      }
    }
  }
  for(const [name,header] of Object.entries(document.components.headers))found.push([`components.headers.${name}`,header.schema as Json]);
  for(const [name,response] of Object.entries(document.components.responses??{}))for(const [type,media] of Object.entries((response.content??{}) as Record<string,{schema?:Json}>))if(media.schema)found.push([`components.responses.${name} ${type}`,media.schema]);
  return found;
}
/** Every header reference in the document points at a declared component. */
function assertHeaderRefs(document:OpenApiDocument):void {
  const text=JSON.stringify(document);
  for(const [,name] of text.matchAll(/"#\/components\/headers\/([A-Za-z]+)"/g))assert.ok(Object.hasOwn(document.components.headers,name!),String(name));
  for(const [,name] of text.matchAll(/"#\/components\/responses\/([A-Za-z]+)"/g))assert.ok(Object.hasOwn(document.components.responses??{},name!),String(name));
}
/** Valid against the official OpenAPI 3.1 schema, and every Schema Object valid against the JSON Schema 2020-12 meta-schema. */
export function assertValidOpenApi(document:OpenApiDocument):void {
  assert.equal(oas(document),true,JSON.stringify(oas.errors,null,1));
  assertHeaderRefs(document);
  const meta=new Ajv2020.default({strict:false});
  for(const [where,schema] of schemaObjects(document))assert.equal(meta.validateSchema(schema),true,`${where}: ${JSON.stringify(meta.errors)}`);
}

/** A value the schema accepts, for the contract run: the first enum/const/branch, the smallest string that fits. */
export function sample(schema:Json,document:OpenApiDocument):unknown {
  if(typeof schema.$ref==='string')return sample(document.components.schemas[schema.$ref.split('/').at(-1)!] as Json,document);
  if('const' in schema)return schema.const;
  if(Array.isArray(schema.enum))return schema.enum[0];
  for(const key of ['anyOf','oneOf'])if(Array.isArray(schema[key]))return sample((schema[key] as Json[])[0]!,document);
  const type=Array.isArray(schema.type)?schema.type.find(item=>item!=='null'):schema.type;
  if(type==='object'){
    // The required properties, or as many declared ones as minProperties asks for (a partial update's body).
    const required=(schema.required??[]) as string[],names=required.length?required:Object.keys(schema.properties??{}).slice(0,(schema.minProperties as number|undefined)??0);
    return Object.fromEntries(names.map(name=>[name,sample(((schema.properties??{}) as Record<string,Json>)[name]??{},document)]));
  }
  if(type==='integer'||type==='number')return (schema.minimum as number|undefined)??0;
  if(type==='boolean')return true;
  if(type==='array')return [];
  if(schema.format==='uuid')return '123e4567-e89b-42d3-a456-426614174000';
  if(schema.format==='email')return 'ada@example.test';
  if(schema.format==='date-time')return '2026-01-02T03:04:05Z';
  if(schema.format==='date')return '2026-01-02';
  if(schema.format==='uri')return 'https://example.test/';
  const fits=(value:string)=>value.length>=((schema.minLength as number|undefined)??0)&&value.length<=((schema.maxLength as number|undefined)??Infinity)&&(schema.pattern===undefined||new RegExp(schema.pattern as string,'u').test(value));
  const found=['a','abc','a@example.com','a-1','1'].find(fits);assert.ok(found,`no sample string for ${JSON.stringify(schema)}`);return found;
}

/**
 * A contract run: requests derived from the document, each answered with a status the operation declares, a body
 * its schema accepts and the headers the document says the runtime always sets. `base` headers go on every request
 * (a session and a same-origin Origin for an auth route). Returns one line per exchange.
 */
export async function contractRun(document:OpenApiDocument,app:Addressed,base:Record<string,string>={},given:(path:string,method:string)=>Promise<Record<string,unknown>>|Record<string,unknown>=()=>({})):Promise<string[]> {
  // The whole document is one schema resource, so `#/components/...` references resolve as they do for a client.
  const ajv=new Ajv2020.default({strict:false});ajv.addSchema({...document,$id:'urn:urlcode:openapi'});
  const pointer=(...parts:string[])=>`urn:urlcode:openapi#/${parts.map(part=>part.replace(/~/g,'~0').replace(/\//g,'~1')).join('/')}`;
  const checked:string[]=[];
  /** The runtime's own headers, as the matched response declares them. */
  function assertHeaders(label:string,response:Response,declared:{headers?:Json}):void {
    const headers=(declared.headers??{}) as Record<string,{$ref?:string}>;
    assert.equal(headers['X-Request-Id']?.$ref,'#/components/headers/UrlcodeRequestId',`${label}: X-Request-Id not declared`);
    assert.match(String(response.headers['x-request-id']),/^[0-9a-f-]{36}$/,`${label}: X-Request-Id`);
    assert.equal(response.headers['x-content-type-options'],'nosniff',`${label}: nosniff`);
    if(headers['Cache-Control']?.$ref==='#/components/headers/UrlcodeNoStore')assert.equal(response.headers['cache-control'],'no-store',`${label}: Cache-Control`);
    if(headers.Allow)assert.ok(response.headers.allow,`${label}: Allow`);
  }
  function assertBody(label:string,response:Response,declared:{content?:Record<string,{schema?:Json}>},where:string[],method:string):void {
    if(!declared.content||method==='head')return;
    // The text-format 405 states no content type; its declared media type is text/plain.
    const media=String(response.headers['content-type']??'').split(';')[0]!.trim()||'text/plain';
    assert.ok(Object.hasOwn(declared.content,media),`${label}: ${response.status} ${media} is not a declared media type`);
    if(!declared.content[media]!.schema)return;
    const validate=ajv.getSchema(pointer(...where,'content',media,'schema'))!;
    const value=media==='application/json'?JSON.parse(response.body):response.body;
    assert.equal(validate(value),true,`${label}: ${JSON.stringify(validate.errors)} for ${response.body}`);
  }
  async function exchange(path:string,method:string,operation:Operation,label:string,url:string,options:{headers?:Record<string,string>;body?:string}={}):Promise<Response> {
    // An explicit Content-Length: without it Node frames a body in chunks, which the server refuses on GET before routing.
    const headers={...base,...options.headers,...(options.body===undefined?{}:{'content-length':String(Buffer.byteLength(options.body))})};
    const response=await request(app,url,{method:method.toUpperCase(),headers,...(options.body===undefined?{}:{body:options.body})});
    const status=String(response.status),key=operation.responses[status]?status:'default',declared=operation.responses[key];
    assert.ok(declared,`${label}: ${method.toUpperCase()} ${url} answered ${status}, which ${operation.operationId} does not declare`);
    assertHeaders(`${label} ${method} ${url}`,response,declared);
    assertBody(label,response,declared,['paths',path,method,'responses',key],method);
    checked.push(`${label} ${method.toUpperCase()} ${url} ${status}`);return response;
  }
  for(const [path,method,operation] of operations(document)){
    const parameters=(document.paths[path]!.parameters??[]) as {name:string;in:string;required?:boolean;schema:Json}[];
    const target=(values:Record<string,unknown>,omit?:string)=>{
      const url=path.replace(/\{([^}]+)\}/g,(_,name:string)=>encodeURIComponent(String(values[name])));
      const query=new URLSearchParams(parameters.filter(item=>item.in==='query'&&item.required&&item.name!==omit).map(item=>[item.name,String(values[item.name])]));
      return query.size?`${url}?${query}`:url;
    };
    // Parameter values: a sample of each schema, except where the caller supplies a real one (an existing record's id).
    const supplied=await given(path,method);
    const values={...Object.fromEntries(parameters.filter(item=>!Object.hasOwn(supplied,item.name)).map(item=>[item.name,sample(item.schema,document)])),...supplied};
    const media=Object.entries(operation.requestBody?.content??{})[0];
    const valid=media?{headers:{'content-type':media[0]},body:JSON.stringify(sample(media[1].schema??{},document))}:{};
    const ok=await exchange(path,method,operation,'valid',target(values),valid);
    assert.ok(ok.status<300||ok.status<400&&ok.headers.location!==undefined,`${operation.operationId} valid request answered ${ok.status}`);
    for(const item of parameters.filter(item=>item.required&&item.in!=='path'))assert.equal((await exchange(path,method,operation,'missing input',target(values,item.name))).status,400);
    for(const item of parameters.filter(item=>item.in==='path'&&item.schema.format==='uuid'))assert.equal((await exchange(path,method,operation,'invalid input',target({...values,[item.name]:'not-a-uuid'}))).status,400);
    const limit=operation.requestBody?.['x-urlcode']?.maxBytes??(document.paths[path]![method] as {'x-urlcode'?:{body:{maxBytes:number}}})['x-urlcode']?.body.maxBytes;
    if(operation.responses['413']&&limit!==undefined)assert.equal((await exchange(path,method,operation,'too large',target(values),{headers:{'content-type':media?.[0]??'application/json'},body:'x'.repeat(limit+1)})).status,413);
    if(media){
      assert.equal((await exchange(path,method,operation,'wrong media type',target(values),{headers:{'content-type':'text/plain'},body:'hello'})).status,415);
      // No body and no media type: the runtime answers 400, an extension that reads JSON may answer 415 first.
      if(operation.requestBody?.required)assert.ok([400,415].includes((await exchange(path,method,operation,'missing body',target(values))).status));
      if(operation.responses['422'])assert.equal((await exchange(path,method,operation,'schema failure',target(values),{headers:{'content-type':media[0]},body:'[]'})).status,422);
    }
  }
  // An undeclared method on each path answers the 405 its path item names, with Allow set to the declared methods.
  for(const [path,item] of Object.entries(document.paths)){
    const refusal=(item['x-urlcode'] as {methodNotAllowed?:{status:number;allow:string;response:string}}).methodNotAllowed;
    if(!refusal)continue;
    const method=methods.find(candidate=>!item[candidate]&&candidate!=='head')!;
    const parameters=(item.parameters??[]) as {name:string;in:string;required?:boolean;schema:Json}[];
    const url=path.replace(/\{([^}]+)\}/g,(_,name:string)=>encodeURIComponent(String(sample(parameters.find(entry=>entry.name===name)!.schema,document))));
    const response=await request(app,url,{method:method.toUpperCase(),headers:base});
    const name=refusal.response.split('/').at(-1)!,declared=document.components.responses![name]!;
    assert.equal(response.status,405,`${method} ${url}`);assert.equal(response.headers.allow,refusal.allow);
    assertHeaders(`405 ${method} ${url}`,response,declared);
    assertBody('undeclared method',response,declared as {content?:Record<string,{schema?:Json}>},['components','responses',name],method);
    checked.push(`undeclared method ${method.toUpperCase()} ${url} 405`);
  }
  return checked;
}
