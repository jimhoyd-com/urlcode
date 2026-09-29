import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Readable,Writable} from 'node:stream';
import {buildOpenApi,renderOpenApi} from '../packages/core/src/openapi.ts';
import type {RuntimeExtension} from '../packages/core/src/extensions.ts';
import {startServer} from '../packages/core/src/server.ts';
import {serveMcp} from '../packages/core/src/mcp.ts';
import {byReplyId,project,request} from './helpers.ts';
import {inspectExtensionRevision,isSameOriginRequest} from '../packages/core/src/extensions.ts';
import {always,assertValidOpenApi,contractRun,methods,noStore,operations} from './openapi-contract.ts';
import type {Json,Operation} from './openapi-contract.ts';
import {pathToFileURL} from 'node:url';

const example=fileURLToPath(new URL('../examples/body-validation/',import.meta.url));
const cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));
const node_modules=fileURLToPath(new URL('../node_modules/',import.meta.url));

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
  // auth: true → the provider's cookie-session requirement and its 401 on every method; its 403 refuses only a
  // cross-origin unsafe method, so a GET never declares it. Bodies are extension-defined.
  assert.deepEqual(op('/me').security,[{'urlcodeSession.auth':[]}]);
  assert.deepEqual(Object.keys(op('/me').responses),['401','default']);
  assert.deepEqual(Object.keys(op('/me','post').responses),['401','403','default']);
  assert.equal(op('/me').responses['401']!.content,undefined);
  assert.match(String((op('/me').responses['401'] as Json).description),/refused by the auth extension/);
  const scheme=document.components.securitySchemes?.['urlcodeSession.auth'] as Json;
  assert.equal(scheme.type,'apiKey');assert.equal(scheme.in,'cookie');assert.equal(scheme.name,'session');
  assert.deepEqual(scheme['x-urlcode'],{extension:'auth',cookieName:'operator-defined'});
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

test('an extension mount a loaded registration describes becomes real paths; the contribution is checked and completed by core (#881)',async t=>{
  const root=await project(t,{
    '/api/notes/*':{extension:'notes',methods:['GET','HEAD','POST'],auth:true},
    '/files/*':{extension:'files'},
  },{},{extensions:{notes:{version:'1',config:{limit:5}},files:{version:'1',config:{}},auth:{version:'1',config:{}}}});
  const revision=await inspectExtensionRevision(root);
  const registration=(name:string,describe?:RuntimeExtension['describe'],providesPrincipal=false):RuntimeExtension=>({name,version:'1',projectSha256:revision,targets:['node'],schema:{type:'object'},providesPrincipal,...(describe?{describe}:{}),activate(){return {handle(){return {status:404,headers:[],body:''};},authorize(){return undefined;}};}});
  const seen:unknown[]=[];
  const note={type:'object',properties:{title:{type:'string'}}};
  const notes=(contribution:(mount:string)=>unknown)=>registration('notes',request=>{seen.push(request);return contribution(request.mount) as never;});
  const good=(mount:string)=>({schemas:{NotesNote:note},paths:{
    [mount]:{summary:'Notes',get:{operationId:'ignored',responses:{'200':{description:'The notes.',content:{'application/json':{schema:{type:'array',items:{$ref:'#/components/schemas/NotesNote'}}}}}}},
      post:{requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/NotesNote'}}}},responses:{'201':{description:'Created.'},'401':{description:'The extension\'s own refusal.',content:{'application/json':{schema:{$ref:'#/components/schemas/UrlcodeErrorEnvelope'}}}}}},
      // Not a method the route declares: the runtime answers it, so core drops it.
      delete:{responses:{'204':{description:'Deleted.'}}}},
    [`${mount}/{id}`]:{parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}],delete:{responses:{'204':{description:'Deleted.'}}}},
  }});
  const document=await buildOpenApi(root,{extensions:[notes(good),registration('files',()=>undefined),registration('auth',undefined,true)]});
  assertValidOpenApi(document);
  assert.deepEqual(seen,[{mount:'/api/notes',methods:['GET','HEAD','POST'],config:{limit:5}}]);
  assert.deepEqual(document['x-urlcode'].describedMounts,[{path:'/api/notes/*',extension:'notes'}]);
  assert.deepEqual(document['x-urlcode'].opaqueMounts,[{path:'/files/*',handler:'extension',extension:'files',registered:true}],'undefined leaves a mount opaque');
  assert.deepEqual(Object.keys(document.paths),['/api/notes'],'a path left with no declared method is dropped');
  const item=document.paths['/api/notes']!;
  assert.deepEqual(Object.keys(item),['summary','get','post','x-urlcode']);
  assert.deepEqual(item['x-urlcode'],{handler:'extension',extension:'notes',route:'/api/notes/*',extensions:['auth']});
  const get=item.get as Operation,post=item.post as Operation;
  assert.equal(get.operationId,'getApiNotes','core names every operation');
  assert.deepEqual(get.security,[{'urlcodeSession.auth':[]}]);
  assert.deepEqual(get.responses['200']!.headers,{...always,...noStore},'the runtime headers and no-store on every extension answer');
  assert.ok(get.responses['401'],'the sign-in gate\'s 401 is added');
  // A status the gate and the extension both answer carries either body, so no schema is claimed for it.
  assert.equal(post.responses['401']!.content,undefined);assert.match(String((post.responses['401'] as Json).description),/extension's own refusal\. Or: No verified session/);
  assert.ok(post.responses['403'],'the gate\'s cross-origin 403 on an unsafe method');
  assert.deepEqual(document.components.schemas.NotesNote,note);
  assert.deepEqual(document.components.securitySchemes?.['urlcodeSession.auth']?.type,'apiKey');
  // Without a host file (or without describe) the mount stays opaque.
  assert.equal((await buildOpenApi(root))['x-urlcode'].describedMounts.length,0);
  // The contribution is data within the contract, or the export fails naming the extension.
  for(const [contribution,message] of [
    [()=>({paths:{'/elsewhere':{get:{responses:{'200':{description:'x'}}}}},schemas:{}}),/path \/elsewhere must be the mount or a path below it/],
    [(mount:string)=>({paths:{[mount]:{get:{responses:{'200':{description:'x'}}}}},schemas:{Note:note}}),/schema Note must be named Notes<Name>/],
    [(mount:string)=>({paths:{[mount]:{get:{responses:{'200':{description:'x',content:{'application/json':{schema:{$ref:'https://example.test/remote.json'}}}}}}}}}),/every \$ref must name one of its schemas/],
    [(mount:string)=>({paths:{[mount]:{trace:{responses:{}}}}}),/must be a path item of/],
    [(mount:string)=>({paths:{[mount]:{get:{}}}}),/get \/api\/notes needs responses/],
    [(mount:string)=>({paths:{[mount]:{}},servers:[]}),/an object of paths and optional schemas/],
    [(mount:string)=>({paths:{[mount]:{get:{responses:{'200':{description:'x'.repeat(300000)}}}}}}),/at most 262144 bytes/],
    [()=>{throw new Error('config refused');},/Extension "notes" could not describe its mount for OpenAPI: config refused/],
  ] as const)await assert.rejects(buildOpenApi(root,{extensions:[notes(contribution as (mount:string)=>unknown),registration('files'),registration('auth',undefined,true)]}),message);
});

test('a route gated by any principal-providing extension gets 401/403 and its session scheme, whatever it is named (#888)',async t=>{
  const site=await mkdtemp(join(tmpdir(),'urlcode-openapi-principal-'));t.after(()=>rm(site,{recursive:true,force:true}));
  const app=join(site,'app');await mkdir(app);
  for(const [name,provides] of [['authjs',true],['audit-trail',false]] as const){
    const directory=join(site,'node_modules','@example',`urlcode-${name}`);await mkdir(directory,{recursive:true});
    await writeFile(join(directory,'urlcode.json'),JSON.stringify({kind:'extension',name,description:`${name} stand-in`,contract:1,requires:[],targets:['node'],...(provides?{providesPrincipal:true}:{}),schema:{type:'object'}}));
  }
  await writeFile(join(site,'package.json'),JSON.stringify({private:true,dependencies:{'@example/urlcode-authjs':'1.0.0','@example/urlcode-audit-trail':'1.0.0'}}));
  await writeFile(join(app,'urlcode.yaml'),JSON.stringify({version:'1',extensions:{authjs:{version:'1',config:{}},'audit-trail':{version:'1',config:{}}},routes:{
    '/signin/*':{extension:'authjs'},'/me':{auth:true,respond:{text:'me'}},'/explicit':{respond:{text:'x'},policies:{extensions:{authjs:{}}}},'/logged':{respond:{text:'x'},policies:{extensions:{'audit-trail':{}}}},
  }}));
  const document=await buildOpenApi(app);
  assertValidOpenApi(document);
  const op=(path:string)=>document.paths[path]!.get as Operation;
  for(const path of ['/me','/explicit']){
    assert.deepEqual(op(path).security,[{'urlcodeSession.authjs':[]}],path);
    assert.deepEqual(Object.keys(op(path).responses),['200','401'],path);
    assert.match(String((op(path).responses['401'] as Json).description),/refused by the authjs extension/);
  }
  // An extension that provides no principal is not a sign-in gate: no security, only the generic may-answer note.
  assert.equal(op('/logged').security,undefined);
  assert.deepEqual(op('/logged').responses.default,{description:'May be answered by the audit-trail extension before the handler; not described by URLCode.',headers:{'X-Request-Id':{$ref:'#/components/headers/UrlcodeRequestId'},'X-Content-Type-Options':{$ref:'#/components/headers/UrlcodeNosniff'}}});
  assert.deepEqual(Object.keys(document.components.securitySchemes??{}),['urlcodeSession.authjs']);
  assert.deepEqual((document.components.securitySchemes!['urlcodeSession.authjs'] as Json)['x-urlcode'],{extension:'authjs',cookieName:'operator-defined'});
  assert.ok(!renderOpenApi(document).includes('urlcodeSession.auth"'));
  // With a host file, a registered extension's own providesPrincipal decides.
  const registered=(name:string,providesPrincipal:boolean):RuntimeExtension=>({name,version:'1',projectSha256:'0'.repeat(64),targets:['node'],schema:{type:'object'},providesPrincipal,activate:()=>({handle:()=>({status:404,headers:[]})})});
  const hosted=await buildOpenApi(app,{extensions:[registered('authjs',false),registered('audit-trail',true)]});
  assert.deepEqual((hosted.paths['/logged']!.get as Operation).security,[{'urlcodeSession.audit-trail':[]}]);
  assert.equal((hosted.paths['/explicit']!.get as Operation).security,undefined);
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
  const auth:RuntimeExtension={name:'auth',version:'1',projectSha256:await inspectExtensionRevision(root),targets:['node'],providesPrincipal:true,
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

test('urlcode openapi --check validates the export or a file against the shipped OpenAPI 3.1 schema and exits 1 when invalid (#917)',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'urlcode-openapi-check-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const run=(args:string[])=>spawnSync(process.execPath,['--conditions=development',cli,'openapi','--check',...args,'--json'],{encoding:'utf8',timeout:60000});
  const exported=run(['--project',example,'--out',join(dir,'openapi.json')]);
  assert.equal(exported.status,0,exported.stderr);
  const report=JSON.parse(exported.stdout) as {event:string;source:string;valid:boolean;schema:string;problems:unknown[];operations:number;schemaObjects:number};
  assert.equal(report.event,'openapi-check');assert.equal(report.source,'export');assert.equal(report.valid,true);assert.deepEqual(report.problems,[]);
  assert.equal(report.schema,'https://spec.openapis.org/oas/3.1/schema/2025-09-15');
  assert.ok(report.operations>0&&report.schemaObjects>0);
  // --out still writes the document it checked, and the written file checks the same.
  const file=run([join(dir,'openapi.json')]);
  assert.equal(file.status,0,file.stderr);assert.equal((JSON.parse(file.stdout) as {valid:boolean}).valid,true);
  // A broken document: a wrong version string, a Schema Object that is not a schema and a $ref to nothing.
  const document=JSON.parse(await readFile(join(dir,'openapi.json'),'utf8')) as Json&{components:{schemas:Json}};
  document.openapi='3.0.3';
  document.components.schemas.Broken={type:'not-a-type'};
  document.components.schemas.Dangling={$ref:'#/components/schemas/Missing'};
  await writeFile(join(dir,'broken.json'),JSON.stringify(document));
  const broken=run([join(dir,'broken.json')]);
  assert.equal(broken.status,1);
  const problems=(JSON.parse(broken.stdout) as {valid:boolean;problems:{where:string;message:string}[]}).problems;
  assert.ok(problems.some(problem=>problem.where==='/openapi'&&/pattern/.test(problem.message)),JSON.stringify(problems));
  assert.ok(problems.some(problem=>problem.where.startsWith('components.schemas.Broken')&&/JSON Schema 2020-12/.test(problem.message)),JSON.stringify(problems));
  assert.ok(problems.some(problem=>problem.where==='/components/schemas/Dangling'&&/Missing names nothing/.test(problem.message)),JSON.stringify(problems));
  await writeFile(join(dir,'not.json'),'{');
  const notJson=run([join(dir,'not.json')]);
  assert.equal(notJson.status,1);assert.match(notJson.stderr,/is not JSON/);
  const elsewhere=spawnSync(process.execPath,['--conditions=development',cli,'routes','--check','--project',example],{encoding:'utf8',timeout:60000});
  assert.match(elsewhere.stderr,/--check is only supported by upgrade and openapi/);
});
