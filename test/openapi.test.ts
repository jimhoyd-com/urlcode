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
import type {Addressed,Response} from './helpers.ts';
import {pathToFileURL} from 'node:url';

const example=fileURLToPath(new URL('../examples/body-validation/',import.meta.url));
const cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));
const node_modules=fileURLToPath(new URL('../node_modules/',import.meta.url));
type Json=Record<string,unknown>;
type Operation={operationId:string;requestBody?:{required?:boolean;content:Record<string,{schema?:Json}>;'x-urlcode'?:{maxBytes?:number}};responses:Record<string,{content?:Record<string,{schema?:Json}>;headers?:Json}>;security?:unknown[]};
const methods=['get','put','post','delete','options','head','patch'];
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
        for(const [name,header] of Object.entries(response.headers??{}))found.push([`${method} ${path} ${status} header ${name}`,(header as {schema:Json}).schema]);
      }
    }
  }
  return found;
}
/** Valid against the official OpenAPI 3.1 schema, and every Schema Object valid against the JSON Schema 2020-12 meta-schema. */
function assertValidOpenApi(document:OpenApiDocument):void {
  assert.equal(oas(document),true,JSON.stringify(oas.errors,null,1));
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
    '/me':{auth:true,function:{source:'functions/fn.mjs'}},
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
  assert.deepEqual(op('/go').responses['308'],{description:'Redirect declared by the route.',headers:{Location:{required:true,schema:{type:'string'}}}});
  // An enforced throttle adds its own refusal; the policy's settings stay out of the document.
  assert.deepEqual(Object.keys(op('/go').responses),['308','429']);assert.ok(op('/go').responses['429']!.headers?.['Retry-After']);
  assert.deepEqual((document.paths['/go']!['x-urlcode'] as Json).policies,['throttle']);
  // A function's own answer has no schema; URLCode's own body checks still do.
  assert.deepEqual(op('/fn').responses.default,{description:'Handler-defined; not described by URLCode.'});
  assert.deepEqual(Object.keys(op('/fn','post').responses),['400','413','415','422','default']);
  const facts=document.paths['/fn']!['x-urlcode'] as Json;
  assert.deepEqual({...facts,targets:undefined},{handler:'function',execution:'trusted',errors:'text',targets:undefined});
  assert.deepEqual(Object.keys(facts.targets as Json),['self-hosted','cloudflare','aws','vercel','static']);assert.equal((facts.targets as Json)['self-hosted'],true);
  // auth: true → a generic cookie-session requirement and the extension's 401/403, bodies extension-defined.
  assert.deepEqual(op('/me').security,[{urlcodeSession:[]}]);
  assert.deepEqual(Object.keys(op('/me').responses),['401','403','default']);
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
  assert.deepEqual(op('/api/status','head').responses['200'],{description:'Declared response.'});
  // The host file's registrations say whether a mount's provider is registered; nothing else changes.
  const hosted=await buildOpenApi(root,{extensions:[]});
  assert.deepEqual(hosted['x-urlcode'].opaqueMounts[0],{path:'/api/auth/*',handler:'extension',extension:'auth',registered:false});
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

test('a contract run: requests derived from the document get declared statuses and bodies from the served example',async t=>{
  const document=await buildOpenApi(example);
  const app=await startServer({project:example,port:0,log:()=>{}});t.after(()=>app.close());
  // The whole document is one schema resource, so `#/components/...` references resolve as they do for a client.
  const ajv=new Ajv2020.default({strict:false});ajv.addSchema({...document,$id:'urn:urlcode:openapi'});
  const pointer=(...parts:string[])=>`urn:urlcode:openapi#/${parts.map(part=>part.replace(/~/g,'~0').replace(/\//g,'~1')).join('/')}`;
  const checked:string[]=[];
  async function exchange(path:string,method:string,operation:Operation,label:string,url:string,options:{headers?:Record<string,string>;body?:string}={}):Promise<Response> {
    // An explicit Content-Length: without it Node frames a body in chunks, which the server refuses on GET before routing.
    const headers={...options.headers,...(options.body===undefined?{}:{'content-length':String(Buffer.byteLength(options.body))})};
    const response=await request(app as Addressed,url,{method:method.toUpperCase(),headers,...(options.body===undefined?{}:{body:options.body})});
    const status=String(response.status),declared=operation.responses[status]??operation.responses.default;
    assert.ok(declared,`${label}: ${method.toUpperCase()} ${url} answered ${status}, which ${operation.operationId} does not declare`);
    const type=String(response.headers['content-type']??'').split(';')[0]!.trim();
    if(declared.content&&method!=='head'){
      assert.ok(Object.hasOwn(declared.content,type),`${label}: ${status} ${type} is not a declared media type`);
      if(declared.content[type]!.schema){
        const validate=ajv.getSchema(pointer('paths',path,method,'responses',operation.responses[status]?status:'default','content',type,'schema'))!;
        const value=type==='application/json'?JSON.parse(response.body):response.body;
        assert.equal(validate(value),true,`${label}: ${JSON.stringify(validate.errors)} for ${response.body}`);
      }
    }
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
  // Every operation ran at least its valid request, and each declared runtime refusal was provoked somewhere.
  assert.equal(checked.filter(line=>line.startsWith('valid ')).length,operations(document).length);
  for(const status of ['400','413','415','422'])assert.ok(checked.some(line=>line.endsWith(` ${status}`)),status);
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
