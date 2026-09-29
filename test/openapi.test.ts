import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Readable,Writable} from 'node:stream';
import Ajv2020 from 'ajv/dist/2020.js';
import {buildOpenApi,renderOpenApi} from '../packages/core/src/openapi.ts';
import type {OpenApiDocument} from '../packages/core/src/openapi.ts';
import {startServer} from '../packages/core/src/server.ts';
import {serveMcp} from '../packages/core/src/mcp.ts';
import {byReplyId,project,request} from './helpers.ts';
import {inspectExtensionRevision,isSameOriginRequest} from '../packages/core/src/extensions.ts';
import type {RuntimeExtension} from '../packages/core/src/extensions.ts';
import type {Addressed,Response} from './helpers.ts';
import {pathToFileURL} from 'node:url';

const example=fileURLToPath(new URL('../examples/body-validation/',import.meta.url));
const cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));
const node_modules=fileURLToPath(new URL('../node_modules/',import.meta.url));
type Json=Record<string,unknown>;
type Operation={operationId:string;requestBody?:{required?:boolean;content:Record<string,{schema?:Json}>;'x-urlcode'?:{maxBytes?:number}};responses:Record<string,{content?:Record<string,{schema?:Json}>;headers?:Json}>;security?:unknown[]};
const methods=['get','put','post','delete','options','head','patch'];
/** The headers the runtime sets on every response, and the one it fixes on its own errors. */
const always={'X-Request-Id':{$ref:'#/components/headers/UrlcodeRequestId'},'X-Content-Type-Options':{$ref:'#/components/headers/UrlcodeNosniff'}};
const noStore={'Cache-Control':{$ref:'#/components/headers/UrlcodeNoStore'}};
const operations=(document:OpenApiDocument):[string,string,Operation][]=>Object.entries(document.paths).flatMap(([path,item])=>methods.filter(method=>item[method]).map(method=>[path,method,item[method] as Operation] as [string,string,Operation]));

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
function assertValidOpenApi(document:OpenApiDocument):void {
  assert.equal(oas(document),true,JSON.stringify(oas.errors,null,1));
  assertHeaderRefs(document);
  const meta=new Ajv2020.default({strict:false});
  for(const [where,schema] of schemaObjects(document))assert.equal(meta.validateSchema(schema),true,`${where}: ${JSON.stringify(meta.errors)}`);
}

test('the example project exports a valid OpenAPI 3.1 document with per-method bodies and runtime error shapes',async()=>{
  const document=await buildOpenApi(example,{origin:'https://api.example'});
  assertValidOpenApi(document);
  assert.equal(document.openapi,'3.1.1');assert.equal(document.jsonSchemaDialect,'https://json-schema.org/draft/2020-12/schema');
  assert.deepEqual(document.servers,[{url:'https://api.example'}]);
  // GET and POST on one path are two operations, each with its own body rule (#845).
  const requests=document.paths['/requests']!;
  assert.deepEqual(Object.keys(requests).filter(key=>methods.includes(key)),['get','post']);
  assert.equal((requests.get as Operation).requestBody,undefined);assert.deepEqual((requests.get as Json)['x-urlcode'],{body:{maxBytes:0}});
  assert.deepEqual(Object.keys((requests.get as Operation).responses),['200','413']);
  const post=requests.post as Operation;
  assert.equal(post.requestBody?.required,true);assert.equal(post.requestBody?.['x-urlcode']?.maxBytes,4096);
  assert.deepEqual(Object.keys(post.responses),['200','400','413','415','422']);
  assert.deepEqual(post.responses['422']!.content,{'application/json':{schema:{$ref:'#/components/schemas/UrlcodeBodyValidationError'}}});
  assert.deepEqual(post.responses['400']!.content,{'text/plain':{schema:{type:'string'}}});
  // The author's 2020-12 schema is the component; its local $defs become components so the refs resolve in OpenAPI.
  const contacts=document.components.schemas.PostContactsRequestBody as Json;
  assert.equal(contacts.$schema,'https://json-schema.org/draft/2020-12/schema');assert.equal(contacts.$defs,undefined);
  assert.deepEqual((contacts.properties as Json).email,{$ref:'#/components/schemas/PostContactsRequestBody_email'});
  assert.deepEqual((contacts.properties as Json).phone,{type:['string','null'],maxLength:32});
  assert.deepEqual(document.components.schemas.PostContactsRequestBody_email,{type:'string',format:'email'});
  assert.deepEqual(document.paths['/todos/{id}']!.parameters,[{name:'id',in:'path',required:true,schema:{type:'string',format:'uuid'}}]);
  // Deterministic: the same project yields the same bytes.
  assert.equal(renderOpenApi(await buildOpenApi(example,{origin:'https://api.example'})),renderOpenApi(document));
});

test('handler-defined answers, mounts, auth and operator configuration are stated rather than invented',async t=>{
  const root=await project(t,{
    '/go':{redirect:{url:'https://example.com/',status:308},policies:{throttle:{quota:5,window:60}}},
    '/fn':{methods:['GET','POST'],function:{source:'functions/fn.mjs'},env:{KEY:{env:'OPERATOR_ONLY_ENV_NAME'}},secrets:{TOKEN:{secret:'OPERATOR_ONLY_SECRET_NAME'}},request:{body:{POST:{format:'json',contentTypes:['application/json'],schema:{type:'object'}}}}},
    '/me':{auth:true,methods:['GET','POST'],function:{source:'functions/fn.mjs'}},
    '/api/auth/*':{extension:'auth',methods:['GET','POST']},
    '/assets/*':{static:{directory:'public'}},
    '/old/**':{redirect:{url:'https://example.com/new/{**}'}},
    '/off':{enabled:false,respond:{text:'off'}},
    '/doc':{page:{file:'public/doc.html'}},
    '/api/status':{respond:{json:{status:'ok'}}},
    '/pick':{conditional:{cases:[{match:{query:{v:'a'}},respond:{json:{v:'a'}}},{match:{query:{v:'b'}},redirect:{url:'https://example.com/b'}}]}},
  },{'functions/fn.mjs':'export default () => new Response("ok");','public/doc.html':'<h1>doc</h1>'},{
    extensions:{auth:{version:'1',config:{}}},
    site:{errors:{format:'json',paths:['/api/*']}},
  });
  const document=await buildOpenApi(root);
  assertValidOpenApi(document);
  const text=renderOpenApi(document);
  for(const secret of ['OPERATOR_ONLY_ENV_NAME','OPERATOR_ONLY_SECRET_NAME','KEY','TOKEN','functions/fn.mjs','better-auth'])assert.ok(!text.includes(secret),secret);
  const op=(path:string,method='get')=>document.paths[path]![method] as Operation;
  assert.deepEqual(op('/go').responses['308'],{description:'Redirect declared by the route.',headers:{Location:{required:true,schema:{type:'string'}},...always}});
  // An enforced throttle adds its own refusal; the policy's settings stay out of the document.
  assert.deepEqual(Object.keys(op('/go').responses),['308','429']);assert.ok(op('/go').responses['429']!.headers?.['Retry-After']);
  assert.deepEqual((document.paths['/go']!['x-urlcode'] as Json).policies,['throttle']);
  // A function's own answer has no schema; URLCode's own body checks still do.
  assert.deepEqual(op('/fn').responses.default,{description:'Handler-defined; not described by URLCode.',headers:always});
  // The runtime's own errors fix Cache-Control; every response carries the request id and nosniff.
  assert.deepEqual(op('/fn','post').responses['400']!.headers,{...noStore,...always});
  assert.deepEqual(Object.keys(op('/fn','post').responses),['400','413','415','422','default']);
  const facts=document.paths['/fn']!['x-urlcode'] as Json;
  assert.deepEqual({...facts,targets:undefined},{handler:'function',execution:'trusted',errors:'text',methodNotAllowed:{status:405,allow:'GET, POST',response:'#/components/responses/UrlcodeMethodNotAllowedText'},targets:undefined});
  assert.deepEqual(Object.keys(facts.targets as Json),['self-hosted','cloudflare','aws','vercel','static']);assert.equal((facts.targets as Json)['self-hosted'],true);
  // auth: true → a generic cookie-session requirement and the extension's 401 on every method; its 403 refuses only
  // a cross-origin unsafe method, so a GET never declares it. Bodies are extension-defined.
  assert.deepEqual(op('/me').security,[{urlcodeSession:[]}]);
  assert.deepEqual(Object.keys(op('/me').responses),['401','default']);
  assert.deepEqual(Object.keys(op('/me','post').responses),['401','403','default']);
  assert.equal(op('/me').responses['401']!.content,undefined);
  const scheme=document.components.securitySchemes?.urlcodeSession as Json;
  assert.equal(scheme.type,'apiKey');assert.equal(scheme.in,'cookie');assert.equal(scheme.name,'session');
  // Mounts are listed, never enumerated; a disabled route is left out and says so.
  assert.deepEqual(document['x-urlcode'].opaqueMounts,[{path:'/api/auth/*',handler:'extension',extension:'auth'},{path:'/assets/*',handler:'static'},{path:'/old/**',handler:'redirect'}]);
  for(const path of Object.keys(document.paths))assert.ok(!path.includes('*'),path);
  assert.deepEqual(document['x-urlcode'].omitted,[{path:'/off',reason:'disabled'}]);
  assert.deepEqual(Object.keys(op('/doc').responses),['200','206','304','416']);assert.deepEqual(op('/doc').responses['200']!.content,{'text/html':{}});
  // site.errors scopes /api/*: its runtime errors use the JSON envelope. The respond body is known exactly.
  assert.deepEqual(op('/api/status').responses['200']!.content,{'application/json':{schema:{const:{status:'ok'}}}});
  assert.equal((document.paths['/api/status']!['x-urlcode'] as Json).errors,'json');
  assert.deepEqual(Object.keys(op('/pick').responses),['200','302','404']);
  assert.deepEqual(op('/api/status','head').responses['200'],{description:'Declared response.',headers:always});
  // An undeclared method answers 405 with Allow, in the path's error format; the response is a shared component.
  assert.deepEqual((document.paths['/api/status']!['x-urlcode'] as Json).methodNotAllowed,{status:405,allow:'GET, HEAD',response:'#/components/responses/UrlcodeMethodNotAllowedJson'});
  const refusal=document.components.responses!.UrlcodeMethodNotAllowedJson!;
  assert.deepEqual(refusal.headers,{Allow:{$ref:'#/components/headers/UrlcodeAllow'},...always});
  assert.deepEqual(refusal.content,{'application/json':{schema:{$ref:'#/components/schemas/UrlcodeErrorEnvelope'}}});
  assert.deepEqual(Object.keys(document.components.responses!),['UrlcodeMethodNotAllowedJson','UrlcodeMethodNotAllowedText']);
  // The host file's registrations say whether a mount's provider is registered; nothing else changes.
  const hosted=await buildOpenApi(root,{extensions:[]});
  assert.deepEqual(hosted['x-urlcode'].opaqueMounts[0],{path:'/api/auth/*',handler:'extension',extension:'auth',registered:false});
});

test('site.errors entries are matched against templated paths segment by segment, and a partial match is stated',async t=>{
  const id=()=>({name:'id',in:'path',required:true,schema:{type:'string',format:'uuid'}});
  const root=await project(t,{
    '/users/{id}':{parameters:[id()],respond:{json:{ok:true}}},
    '/users/{id}/posts':{parameters:[id()],respond:{json:{ok:true}}},
    '/v1/{id}':{parameters:[id()],respond:{json:{ok:true}}},
    '/{id}/items/list':{parameters:[id()],respond:{json:{ok:true}}},
    '/plain':{respond:{json:{ok:true}}},
    '/own/{id}':{parameters:[id()],errors:{format:'text'},respond:{json:{ok:true}}},
  },{},{site:{errors:{format:'json',paths:['/users/not-a-uuid','/v1/*','/v2/*','/plain','/own/*']}}});
  const document=await buildOpenApi(root);
  assertValidOpenApi(document);
  const facts=(path:string)=>document.paths[path]!['x-urlcode'] as Json;
  // An exact entry names one concrete instance of /users/{id}: JSON there, text on every other id.
  assert.equal(facts('/users/{id}').errors,'mixed');assert.deepEqual(facts('/users/{id}').errorScope,['/users/not-a-uuid']);
  const bad=(document.paths['/users/{id}']!.get as Operation).responses['400']!;
  assert.deepEqual(bad.content,{'text/plain':{schema:{type:'string'}},'application/json':{schema:{$ref:'#/components/schemas/UrlcodeErrorEnvelope'}}});
  assert.equal(facts('/users/{id}').methodNotAllowed&&(facts('/users/{id}').methodNotAllowed as Json).response,'#/components/responses/UrlcodeMethodNotAllowedMixed');
  // A deeper path is not the exact entry; a literal prefix covers every instance below it; a template under a
  // prefix covers one value of the parameter; an exact literal is the path; a route's own format wins.
  assert.deepEqual([facts('/users/{id}/posts').errors,facts('/v1/{id}').errors,facts('/{id}/items/list').errors,facts('/plain').errors,facts('/own/{id}').errors],['text','json','mixed','json','text']);
  assert.deepEqual(facts('/{id}/items/list').errorScope,['/v1/*','/v2/*','/own/*']);
  assert.equal(facts('/v1/{id}').errorScope,undefined);
  // The server agrees: the covered instance answers JSON, the others text.
  const app=await startServer({project:root,port:0,log:()=>{}});t.after(()=>app.close());
  for(const [path,method,status,type] of [['/users/not-a-uuid','GET',400,'application/json'],['/users/zzz','GET',400,'text/plain'],['/users/not-a-uuid','POST',405,'application/json'],['/users/zzz','POST',405,'text/plain']] as const){
    const response=await request(app,path,{method});
    assert.equal(response.status,status,path);assert.equal(String(response.headers['content-type']??'text/plain').split(';')[0],type,`${method} ${path}`);
  }
});

/** A value the schema accepts, for the contract run: the first enum/const/branch, the smallest string that fits. */
function sample(schema:Json,document:OpenApiDocument):unknown {
  if(typeof schema.$ref==='string')return sample(document.components.schemas[schema.$ref.split('/').at(-1)!] as Json,document);
  if('const' in schema)return schema.const;
  if(Array.isArray(schema.enum))return schema.enum[0];
  for(const key of ['anyOf','oneOf'])if(Array.isArray(schema[key]))return sample((schema[key] as Json[])[0]!,document);
  const type=Array.isArray(schema.type)?schema.type.find(item=>item!=='null'):schema.type;
  if(type==='object')return Object.fromEntries(((schema.required??[]) as string[]).map(name=>[name,sample(((schema.properties??{}) as Record<string,Json>)[name]??{},document)]));
  if(type==='integer'||type==='number')return (schema.minimum as number|undefined)??0;
  if(type==='boolean')return true;
  if(type==='array')return [];
  if(schema.format==='uuid')return '123e4567-e89b-42d3-a456-426614174000';
  if(schema.format==='email')return 'ada@example.test';
  if(schema.format==='date-time')return '2026-01-02T03:04:05Z';
  if(schema.format==='date')return '2026-01-02';
  const fits=(value:string)=>value.length>=((schema.minLength as number|undefined)??0)&&value.length<=((schema.maxLength as number|undefined)??Infinity)&&(schema.pattern===undefined||new RegExp(schema.pattern as string,'u').test(value));
  const found=['a','abc','a@example.com','a-1','1'].find(fits);assert.ok(found,`no sample string for ${JSON.stringify(schema)}`);return found;
}

/**
 * A contract run: requests derived from the document, each answered with a status the operation declares, a body
 * its schema accepts and the headers the document says the runtime always sets. `base` headers go on every request
 * (a session and a same-origin Origin for an auth route). Returns one line per exchange.
 */
async function contractRun(document:OpenApiDocument,app:Addressed,base:Record<string,string>={}):Promise<string[]> {
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
    const values=Object.fromEntries(parameters.map(item=>[item.name,sample(item.schema,document)]));
    const media=Object.entries(operation.requestBody?.content??{})[0];
    const valid=media?{headers:{'content-type':media[0]},body:JSON.stringify(sample(media[1].schema??{},document))}:{};
    const ok=await exchange(path,method,operation,'valid',target(values),valid);
    assert.ok(ok.status<300||ok.status<400&&ok.headers.location!==undefined,`${operation.operationId} valid request answered ${ok.status}`);
    for(const item of parameters.filter(item=>item.required&&item.in!=='path'))assert.equal((await exchange(path,method,operation,'missing input',target(values,item.name))).status,400);
    for(const item of parameters.filter(item=>item.in==='path'&&item.schema.format==='uuid'))assert.equal((await exchange(path,method,operation,'invalid input',target({...values,[item.name]:'not-a-uuid'}))).status,400);
    if(operation.responses['413']){
      const limit=operation.requestBody?.['x-urlcode']?.maxBytes??(document.paths[path]![method] as {'x-urlcode'?:{body:{maxBytes:number}}})['x-urlcode']?.body.maxBytes;
      assert.equal((await exchange(path,method,operation,'too large',target(values),{headers:{'content-type':media?.[0]??'application/json'},body:'x'.repeat((limit??0)+1)})).status,413);
    }
    if(media){
      assert.equal((await exchange(path,method,operation,'wrong media type',target(values),{headers:{'content-type':'text/plain'},body:'hello'})).status,415);
      if(operation.requestBody?.required)assert.equal((await exchange(path,method,operation,'missing body',target(values))).status,400);
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

test('a contract run: requests derived from the document get declared statuses and bodies from the served example',async t=>{
  const document=await buildOpenApi(example);
  const app=await startServer({project:example,port:0,log:()=>{}});t.after(()=>app.close());
  const checked=await contractRun(document,app);
  // Every operation ran at least its valid request, and each declared runtime refusal was provoked somewhere.
  assert.equal(checked.filter(line=>line.startsWith('valid ')).length,operations(document).length);
  for(const status of ['400','405','413','415','422'])assert.ok(checked.some(line=>line.endsWith(` ${status}`)),status);
});

test('a contract run over an auth: true route and function routes answers only declared statuses',async t=>{
  const site='https://contract.example.test',elsewhere='https://elsewhere.example.test',unsafe=new Set(['POST','PUT','PATCH','DELETE']);
  const root=await project(t,{
    '/me':{auth:true,methods:['GET','POST'],function:{source:'functions/me.mjs'}},
    '/fn':{function:{source:'functions/fn.mjs'},parameters:[{name:'q',in:'query',required:true,schema:{type:'string',maxLength:8}}]},
    '/echo':{methods:['POST'],function:{source:'functions/fn.mjs'},request:{body:{POST:{format:'json',contentTypes:['application/json'],maxBytes:256,schema:{type:'object',required:['v'],properties:{v:{type:'string',format:'date'}}}}}}},
  },{'functions/me.mjs':'export default () => Response.json({signedIn: true});','functions/fn.mjs':'export default () => new Response("ok");'},{extensions:{auth:{version:'1',config:{}}}});
  // A synthetic stand-in for packages/auth's authorize(): a cross-origin unsafe method is 403, no session is 401.
  const auth:RuntimeExtension={name:'auth',version:'1',projectSha256:await inspectExtensionRevision(root),targets:['node'],
    schema:{type:'object',additionalProperties:false},policySchema:{type:'object',additionalProperties:false},
    activate(_config,activation){return {
      handle(){return {status:404,headers:[],body:''};},
      authorize(_policy,req){
        if(unsafe.has(req.method)&&!isSameOriginRequest(req,activation,{whenAbsent:'refuse'}))return {status:403,headers:[['content-type','application/json']],body:'{"error":"cross_origin_refused"}'};
        if(req.headers.get('cookie')!=='session=ok')return {status:401,headers:[['content-type','application/json']],body:'{"error":"authentication_required"}'};
        return undefined;
      },
    };},
  };
  const document=await buildOpenApi(root,{extensions:[auth]});
  assertValidOpenApi(document);
  const app=await startServer({project:root,port:0,log:()=>{},origin:site,extensions:[auth]});t.after(()=>app.close());
  const checked=await contractRun(document,app,{cookie:'session=ok',origin:site});
  assert.equal(checked.filter(line=>line.startsWith('valid ')).length,operations(document).length);
  for(const status of ['400','405','413','415','422'])assert.ok(checked.some(line=>line.endsWith(` ${status}`)),status);
  // The auth refusals, each against a status the operation declares by number (not through `default`).
  const me=(method:string)=>(document.paths['/me']![method] as Operation).responses;
  const cases:[string,Record<string,string>,number][]=[
    ['GET',{origin:site},401],['POST',{origin:site},401],['POST',{cookie:'session=ok',origin:elsewhere},403],
    // A safe method from another origin is not the extension's 403: with a session it reaches the handler.
    ['GET',{cookie:'session=ok',origin:elsewhere},200],
  ];
  for(const [method,headers,status] of cases){
    const response=await request(app,'/me',{method,headers});
    assert.equal(response.status,status,`${method} ${JSON.stringify(headers)}`);
    if(status!==200)assert.ok(me(method.toLowerCase())[String(status)],`${method} /me declares ${status}`);
    assert.equal(response.headers['x-content-type-options'],'nosniff');assert.ok(response.headers['x-request-id']);
  }
  assert.equal(me('get')['403'],undefined);
});

test('a client generated by @hey-api/openapi-ts from the document typechecks and calls the served example',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'urlcode-openapi-client-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'openapi.json'),renderOpenApi(await buildOpenApi(example)));
  const generated=spawnSync(process.execPath,[join(node_modules,'@hey-api/openapi-ts/bin/run.js'),'-i',join(dir,'openapi.json'),'-o',join(dir,'client'),'-c','@hey-api/client-fetch','--silent','--no-log-file'],{cwd:dir,encoding:'utf8',timeout:120000});
  assert.equal(generated.status,0,generated.stderr+generated.stdout);
  await writeFile(join(dir,'package.json'),'{"type":"module"}\n');
  await writeFile(join(dir,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:true,lib:['ES2022','DOM'],types:[],outDir:'out'},include:['client','use.ts']}));
  await writeFile(join(dir,'use.ts'),[
    "import {client} from './client/client.gen.js';",
    "import {postTodos,postContacts,getTags} from './client/sdk.gen.js';",
    "import type {PostTodosData} from './client/types.gen.js';",
    '// @ts-expect-error title is required by the declared body schema',
    "const missing: PostTodosData['body'] = {description: 'no title'};",
    'void missing;',
    'export async function run(baseUrl: string) {',
    '  client.setConfig({baseUrl});',
    "  const created = await postTodos({body: {title: 'Write the report', completed: false}});",
    "  const refused = await postTodos({body: {title: ''}});",
    "  const contact = await postContacts({body: {name: 'Ada', email: 'ada@example.com', phone: null, channel: 'email'}});",
    "  const tag = await getTags({query: {slug: 'news'}});",
    "  const issue = typeof refused.error === 'object' ? refused.error.issues[0]?.pointer : undefined;",
    '  return {created: created.response?.status, refused: refused.response?.status, issue, contact: contact.response?.status, tag: tag.response?.status};',
    '}',
  ].join('\n')+'\n');
  const compiled=spawnSync(process.execPath,[join(node_modules,'typescript/bin/tsc'),'-p',dir],{encoding:'utf8',timeout:120000});
  assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
  const app=await startServer({project:example,port:0,log:()=>{}});t.after(()=>app.close());
  const {run}=await import(pathToFileURL(join(dir,'out','use.js')).href) as {run:(baseUrl:string)=>Promise<Record<string,unknown>>};
  assert.deepEqual(await run(`http://127.0.0.1:${app.address.port}`),{created:201,refused:422,issue:'/title',contact:201,tag:200});
});

test('urlcode openapi prints or writes the document, and MCP get_openapi returns the same one',async t=>{
  const expected=renderOpenApi(await buildOpenApi(example));
  const printed=spawnSync(process.execPath,[cli,'openapi','--project',example],{encoding:'utf8',timeout:60000});
  assert.equal(printed.status,0,printed.stderr);assert.equal(printed.stdout,expected);
  const dir=await mkdtemp(join(tmpdir(),'urlcode-openapi-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const written=spawnSync(process.execPath,[cli,'openapi','--project',example,'--out',join(dir,'openapi.json')],{encoding:'utf8',timeout:60000});
  assert.equal(written.status,0,written.stderr);assert.equal(await readFile(join(dir,'openapi.json'),'utf8'),expected);
  assert.equal(spawnSync(process.execPath,[cli,'openapi','/todos','--project',example],{encoding:'utf8',timeout:60000}).status,1);
  let text='';
  const output=new Writable({write(chunk,_encoding,callback){text+=String(chunk);callback();}});
  const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_openapi',arguments:{}}}];
  await serveMcp({project:example,input:Readable.from([messages.map(value=>JSON.stringify(value)+'\n').join('')]),output});
  const replies=text.trim().split('\n').map(line=>JSON.parse(line) as {result:{tools?:{name:string;annotations:{readOnlyHint:boolean}}[];content?:{text:string}[]}}).sort(byReplyId);
  assert.equal(replies[1]!.result.tools!.find(item=>item.name==='get_openapi')?.annotations.readOnlyHint,true);
  assert.deepEqual(JSON.parse(replies[2]!.result.content![0]!.text),JSON.parse(expected));
});
