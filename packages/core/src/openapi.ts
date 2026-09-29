import {basename,dirname} from 'node:path';
import mime from 'mime-types';
import {prepare} from './tooling.ts';
import type {InspectOptions} from './tooling.ts';
import {explainCompiledRoute} from './explain.ts';
import {effectiveExtensionPolicies,extensionOpenApiLimits} from './extensions.ts';
import type {RuntimeExtension} from './extensions.ts';
import {ConfigError,extensionError} from './errors.ts';
import {isRecord} from './object-guards.ts';
import {principalProvidersOf} from './addon-manifest.ts';
import {bodyPolicy,bodylessMethods} from './http-policy.ts';
import type {RequestBodyPolicy} from './http-policy.ts';
import {bodySchemaDialect} from './body-validation.ts';
import {errorCodes} from './http-response.ts';
import type {ErrorFormat} from './http-response.ts';
import {runningCoreVersion} from './version.ts';
import type {CompiledRoute,PolicyChain} from './types.ts';

// An OpenAPI 3.1 description of the HTTP operations a project declares, derived from the compiled IR (config → router
// → policies) like explain and manifest. It states only what URLCode enforces or writes itself; a handler-defined
// answer is a `default` response with no schema, and an opaque mount is listed, never enumerated (#845). Binding
// names and values, egress targets, module paths and operator policy never appear.

/** The OpenAPI version written; the body-schema profile is JSON Schema 2020-12, which is OpenAPI 3.1's schema dialect family. */
export const openApiVersion='3.1.1';
type Json=Record<string,unknown>;
export interface OpenApiDocument {
  openapi:typeof openApiVersion; jsonSchemaDialect:string; info:{title:string;version:string;description:string};
  servers?:{url:string}[]; paths:Record<string,Json>;
  components:{schemas:Record<string,unknown>;responses?:Record<string,Json>;headers:Record<string,Json>;securitySchemes?:Record<string,Json>};
  'x-urlcode':OpenApiFacts;
}
/** Facts about the project that OpenAPI has no field for, under one namespaced extension. */
export interface OpenApiFacts {
  urlcode:string; revision:string;
  /** Paths below an extension, static or wildcard-redirect mount: the provider serves them and URLCode does not enumerate them. */
  opaqueMounts:{path:string;handler:string;extension?:string;registered?:boolean}[];
  /** Extension mounts whose paths the loaded registration's `describe()` contributed (RIM-OPENAPI-001). */
  describedMounts:{path:string;extension:string}[];
  /** Declared routes left out of `paths`, with the reason. */
  omitted:{path:string;reason:string}[];
  note:string;
}

const methodOrder=['GET','PUT','POST','DELETE','OPTIONS','HEAD','PATCH'];
const compare=(a:string,b:string):number=>a<b?-1:a>b?1:0;
/** The media type essence of a Content-Type value. */
const essence=(value:string):string=>value.split(';')[0]!.trim().toLowerCase();
const pascal=(text:string):string=>text.split(/[^A-Za-z0-9]+/).filter(Boolean).map(word=>word[0]!.toUpperCase()+word.slice(1)).join('');
/** `GET /todos/{id}` → `getTodosById`; `/` → `getRoot`. Unique within a document (a numeric suffix settles a clash). */
function operationName(method:string,pattern:string,taken:Set<string>):string {
  const words=pattern.split('/').filter(Boolean).map(part=>part.startsWith('{')?`By${pascal(part.slice(1,-1))}`:pascal(part)).join('')||'Root';
  const base=method.toLowerCase()+words;
  let name=base;for(let n=2;taken.has(name);n++)name=`${base}${n}`;
  taken.add(name);return name;
}

const handlerDefined='Handler-defined; not described by URLCode.';
const components={
  UrlcodeErrorEnvelope:{
    description:'The fixed JSON error envelope URLCode writes for its own errors under `errors.format: json` (docs/HTTP.md#error-format). `issues` and `truncated` appear only on a body-schema 422.',
    type:'object',required:['error'],additionalProperties:false,
    properties:{error:{type:'object',required:['code','message'],additionalProperties:false,properties:{
      code:{type:'string',enum:[...new Set([...Object.values(errorCodes),'ERROR'])]},message:{type:'string'},
      issues:{type:'array',items:{$ref:'#/components/schemas/UrlcodeBodyValidationIssue'}},truncated:{type:'boolean'},
    }}},
  },
  UrlcodeBodyValidationError:{
    description:'The JSON 422 a route with a request body schema answers when the body breaks it (docs/HTTP.md#body-schema-and-input-patterns). Capped at 4096 bytes.',
    type:'object',required:['error','message','issues'],additionalProperties:false,
    properties:{error:{const:'body_validation_failed'},message:{type:'string'},truncated:{type:'boolean'},issues:{type:'array',items:{$ref:'#/components/schemas/UrlcodeBodyValidationIssue'}}},
  },
  UrlcodeBodyValidationIssue:{
    description:'One body-schema failure. Values the client sent are never included.',
    type:'object',required:['pointer','keyword','message'],additionalProperties:false,
    properties:{pointer:{type:'string',description:'RFC 6901 pointer into the body; array positions are /[] and undeclared keys /*.'},keyword:{type:'string'},message:{type:'string'},expected:{description:'The type, bound, format or declared values the schema states, when it states one.'},property:{type:'string'}},
  },
} as const;
/** The security scheme for routes a principal-providing extension gates, one per provider: `urlcodeSession.<name>`. */
const sessionScheme=(provider:string):string=>`urlcodeSession.${provider}`;
const extensionList=(names:readonly string[]):string=>names.length===1?`the ${names[0]} extension`:`the ${names.slice(0,-1).join(', ')} and ${names.at(-1)} extensions`;
/** The methods the auth extension refuses from another origin (packages/auth: unsafe methods); every method may get its 401. */
const unsafeMethods=['POST','PUT','PATCH','DELETE'];
const headerRef=(name:string):Json=>({$ref:`#/components/headers/${name}`});
/**
 * Headers the runtime itself sets (http-response.ts: prepareResponse, prepareStream, errorResponse). X-Request-Id and
 * X-Content-Type-Options are on every response and a handler cannot replace them; Cache-Control is fixed only on an
 * error the runtime writes, since elsewhere a handler, declared header or cache policy may set its own.
 */
const headerComponents={
  UrlcodeRequestId:{description:'Set by the runtime on every response: a fresh UUID, or the inbound X-Request-Id when the operator trusts one (docs/OPERATIONS.md). A handler cannot set or replace it.',required:true,schema:{type:'string'}},
  UrlcodeNosniff:{description:'Set by the runtime on every response; a handler cannot set or replace it.',required:true,schema:{const:'nosniff'}},
  UrlcodeNoStore:{description:'Fixed on an error the runtime writes itself and on every answer from an extension mount; neither a declared header nor a policy changes it.',required:true,schema:{const:'no-store'}},
  UrlcodeAllow:{description:'The methods the route declares, in declared order and comma-separated: the path item\'s x-urlcode.methodNotAllowed.allow.',required:true,schema:{type:'string'}},
} as const;
const alwaysHeaders={'X-Request-Id':headerRef('UrlcodeRequestId'),'X-Content-Type-Options':headerRef('UrlcodeNosniff')};
const errorHeaders={'Cache-Control':headerRef('UrlcodeNoStore')};
/**
 * The format of a route's runtime-written errors: its own `errors.format`, else `site.errors`. `mixed` is a templated
 * route some but not all of whose concrete paths a scope entry covers (an exact `/users/42` beside `/users/{id}`), so
 * the answer is JSON on those paths and text on the rest; `scope` names the entries.
 */
type RouteErrorFormat=ErrorFormat|'mixed';
/** Which of a route's concrete paths one `site.errors` entry covers (http-response.ts: errorScope), segment by segment. */
function coverage(entry:string,parts:readonly string[]):'all'|'some'|'none' {
  const prefix=entry.endsWith('/*'),want=(prefix?entry.slice(0,-2):entry).split('/').slice(1);
  if(prefix?parts.length<want.length:parts.length!==want.length)return 'none';
  let every=true;
  for(const [index,segment] of want.entries()){
    const part=parts[index]!;
    // A path parameter takes every segment value, so only one of its values is this entry's.
    if(part.startsWith('{')&&part.endsWith('}'))every=false;
    else if(part!==segment)return 'none';
  }
  return every?'all':'some';
}
function routeErrorFormat(route:CompiledRoute,entries:readonly string[]):{format:RouteErrorFormat;scope:string[]} {
  if(route.errors?.format)return {format:route.errors.format,scope:[]};
  const covered=entries.map(entry=>[entry,coverage(entry,route.parts)] as const);
  if(covered.some(([,how])=>how==='all'))return {format:'json',scope:[]};
  const some=covered.filter(([,how])=>how==='some').map(([entry])=>entry);
  return some.length?{format:'mixed',scope:some}:{format:'text',scope:[]};
}
const mixedNote=' JSON on the concrete paths the `site.errors` entries in x-urlcode.errorScope cover, plain text on the rest.';
const envelope={$ref:'#/components/schemas/UrlcodeErrorEnvelope'},plain={type:'string'};
/** The runtime's own 405 in each error format, referenced from a path item's x-urlcode.methodNotAllowed. */
function methodNotAllowedResponse(format:RouteErrorFormat):Json {
  return {
    description:`The runtime's answer to a method the path does not declare, after any gate that runs first (an enforced throttle or agents policy, an extension's authorize, an operator plugin).${format==='mixed'?mixedNote:''}`,
    headers:{Allow:headerRef('UrlcodeAllow'),...alwaysHeaders},
    content:{...(format!=='json'?{'text/plain':{schema:plain}}:{}),...(format!=='text'?{'application/json':{schema:envelope}}:{})},
  };
}
const methodNotAllowedName=(format:RouteErrorFormat):string=>`UrlcodeMethodNotAllowed${pascal(format)}`;

/** A runtime-written error answer in the route's error format. */
function runtimeError(format:RouteErrorFormat,description:string):Json {
  return {description:format==='mixed'?description+mixedNote:description,headers:{...errorHeaders},
    content:{...(format!=='json'?{'text/plain':{schema:plain}}:{}),...(format!=='text'?{'application/json':{schema:envelope}}:{})}};
}
/** Rewrites each local `#/$defs/<name>` reference in a body schema to the component the definition was hoisted to. Annotation and value keywords are copied as they are. */
function relocate(schema:unknown,defsBase:string):unknown {
  if(Array.isArray(schema))return schema.map(item=>relocate(item,defsBase));
  if(!schema||typeof schema!=='object')return schema;
  const out:Json={};
  for(const [key,value] of Object.entries(schema as Json)){
    if(key==='$ref'&&typeof value==='string'&&value.startsWith('#/$defs/'))out[key]=`#/components/schemas/${defsBase}${value.slice('#/$defs/'.length)}`;
    else if(key==='properties'||key==='patternProperties')out[key]=Object.fromEntries(Object.entries(value as Json).map(([name,child])=>[name,relocate(child,defsBase)]));
    else if(['allOf','anyOf','oneOf','prefixItems'].includes(key)&&Array.isArray(value))out[key]=value.map(child=>relocate(child,defsBase));
    else if(['not','items','additionalProperties','propertyNames'].includes(key))out[key]=relocate(value,defsBase);
    else out[key]=structuredClone(value);
  }
  return out;
}
/**
 * The request body a method's policy describes, registering its schema as a component. An OpenAPI `$ref` of
 * `#/$defs/x` would resolve against the whole document, so each `$defs` entry becomes its own component
 * (`<component>_<name>`) and the references are rewritten to it; every other keyword is the author's schema as written.
 */
function requestBody(policy:RequestBodyPolicy,name:string,schemas:Record<string,unknown>):Json|undefined {
  if(policy.maxBytes===0)return undefined;
  // A required body with no declared media type or format may be anything.
  const types=policy.contentTypes??(policy.format==='json'?['application/json']:policy.format==='text'?['text/plain']:policy.required?['*/*']:[]);
  if(!types.length)return undefined;
  let schema:unknown;
  if(policy.schema){
    // A named schema (RIM-SCHEMA-001) is one component under its own name, written the first time an operation uses
    // it and referenced by every operation that does; an inline schema is its operation's own component.
    const component=policy.schemaName??`${name}RequestBody`;
    if(policy.schemaName===undefined||!Object.hasOwn(schemas,component)){
      const {$defs,...root}=policy.schema as Json,add=(key:string,value:unknown):void=>{
        if(Object.hasOwn(schemas,key))throw new ConfigError(`OpenAPI component ${key} would be written twice: rename the named schema (top-level schemas:) or the $defs entry that produces it`,{code:'openapi-component-clash'});
        schemas[key]=value;
      };
      for(const [def,value] of Object.entries(($defs??{}) as Json))add(`${component}_${def}`,relocate(value,`${component}_`));
      add(component,relocate(root,`${component}_`));
    }
    schema={$ref:`#/components/schemas/${component}`};
  }else if(policy.format==='text')schema={type:'string'};
  const content:Json={};
  for(const type of types)content[type]=schema===undefined?{}:{schema};
  return {...(policy.required?{required:true}:{}),content,'x-urlcode':{...(policy.maxBytes!==undefined?{maxBytes:policy.maxBytes}:{}),...(policy.format?{format:policy.format}:{})}};
}
function reply(route:CompiledRoute):{status:number;response:Json} {
  if(route.redirect)return {status:route.redirect.status??302,response:{description:'Redirect declared by the route.',headers:{Location:{required:true,schema:{type:'string'}}}}};
  const status=route.reply?.status??route.respond?.status??200;
  const declared=route.responseHeaders.find(([name])=>name==='content-type')?.[1]??route.reply?.headers.find(([name])=>name==='content-type')?.[1];
  const response:Json={description:'Declared response.'};
  if(route.respond&&route.reply?.body.length){
    const value=Object.hasOwn(route.respond,'json')?route.respond.json:route.respond.text;
    response.content={[essence(declared??'text/plain')]:{schema:{const:value}}};
  }
  return {status,response};
}
function assetResponses(route:CompiledRoute):Record<string,Json> {
  const config=route.page??route.download!;
  const type=essence(String(mime.contentType(config.contentType||mime.lookup(config.file)||'application/octet-stream')));
  return {
    '200':{description:'The declared file.',...(route.download?{headers:{'Content-Disposition':{schema:{type:'string'}}}}:{}),content:{[type]:{}}},
    '206':{description:'One satisfiable byte range of the file (docs/ASSETS.md).',content:{[type]:{}}},
    '304':{description:'Not modified: a conditional request matched the current validator.'},
    '416':{description:'Range not satisfiable.'},
  };
}
/** The responses URLCode itself knows for one method of a route. */
/** `signIn` are the gates that provide the request principal (`providesPrincipal`): a sign-in gate, whatever it is named. */
function responses(route:CompiledRoute,method:string,format:RouteErrorFormat,chain:PolicyChain|undefined,gates:string[],signIn:string[],body:RequestBodyPolicy|undefined):Record<string,Json> {
  const out:Record<string,Json>={};
  const kind=route.redirect?'redirect':route.respond?'respond':route.conditional?'conditional':route.page||route.download?'asset':route.proxy?'proxy':'handler';
  if(kind==='redirect'||kind==='respond'){const {status,response}=reply(route);out[String(status)]=response;}
  else if(kind==='conditional'){
    const branches=[...(route.conditionalRoutes?.cases??[]).map(item=>item.route),...(route.conditionalRoutes?.fallback?[route.conditionalRoutes.fallback]:[])];
    for(const branch of branches){
      const {status,response}=reply(branch),key=String(status),existing=out[key];
      if(!existing){out[key]={...response,description:`${String(response.description)} Chosen by a conditional case or the fallback.`};continue;}
      // Two branches answer the same status: their bodies become alternatives of one response.
      const merged=(existing.content??{}) as Record<string,{schema?:Json}>;
      for(const [type,media] of Object.entries((response.content??{}) as Record<string,{schema:Json}>)){
        const prior=merged[type]?.schema;
        merged[type]={schema:prior?{anyOf:[...(prior.anyOf as Json[]|undefined??[prior]),media.schema]}:media.schema};
      }
      if(Object.keys(merged).length)existing.content=merged;
      if(response.headers)existing.headers=response.headers;
    }
    if(!route.conditionalRoutes?.fallback)out['404']=runtimeError(format,'No conditional case matched and the route declares no fallback.');
  }
  else if(kind==='asset')Object.assign(out,assetResponses(route));
  else out.default={description:kind==='proxy'?'The upstream response, relayed by the proxy; not described by URLCode.':handlerDefined};
  if(route.match)out['404']??=runtimeError(format,'The route\'s match conditions did not hold.');
  const admits=body!==undefined&&body.maxBytes!==0;
  if(route.parameters.length||admits)out['400']=runtimeError(format,'A declared input is missing or invalid, or the body is malformed.');
  if(body){
    out['413']=runtimeError(format,'The request body exceeds the route\'s maxBytes.');
    if(admits)out['415']=runtimeError(format,'Unsupported media type or content encoding.');
    // Always JSON: the envelope in the json format, the bounded issue list in the text format.
    const issues={$ref:'#/components/schemas/UrlcodeBodyValidationError'};
    if(body.schema)out['422']={description:format==='mixed'?'The body failed the declared schema.'+mixedNote:'The body failed the declared schema.',headers:{...errorHeaders},
      content:{'application/json':{schema:format==='json'?envelope:format==='text'?issues:{anyOf:[envelope,issues]}}}};
  }
  for(const [status,response] of Object.entries(gateResponses(method,chain,signIn)))out[status]??=response;
  const unknown=[...(route.middleware.length?['middleware']:[]),...gates.filter(name=>!signIn.includes(name)).map(name=>`the ${name} extension`)];
  if(unknown.length&&!out.default)out.default={description:`May be answered by ${unknown.join(' or ')} before the handler; not described by URLCode.`};
  for(const [key,value] of Object.entries(out)){
    const {content,headers,...rest}=value;
    out[key]={...rest,headers:{...(headers as Json|undefined),...alwaysHeaders},...(content&&method!=='HEAD'?{content}:{})};
  }
  return Object.fromEntries(Object.entries(out).sort(([a],[b])=>compare(a,b)));
}

/** The answers a sign-in gate or an enforced throttle/agents policy gives before the handler (or extension) runs. */
function gateResponses(method:string,chain:PolicyChain|undefined,signIn:string[]):Record<string,Json> {
  const out:Record<string,Json>={};
  if(signIn.length){
    out['401']={description:`No verified session: refused by ${extensionList(signIn)} before the handler runs. The body is extension-defined.`};
    if(unsafeMethods.includes(method))out['403']={description:`A request from another origin, refused by ${extensionList(signIn)} before the handler runs. The body is extension-defined.`};
  }
  const throttle=chain?.describe.throttle,agents=chain?.describe.agents;
  if(throttle?.mode==='enforce'&&throttle.status!==undefined)out[String(throttle.status)]={description:'Refused by the throttle policy.',headers:{'Retry-After':{schema:{type:'integer'}}},content:{'text/plain':{schema:{type:'string'}}}};
  if(agents?.mode==='enforce'&&agents.status!==undefined)out[String(agents.status)]??={description:'Refused by the agents policy.',content:{'text/plain':{schema:{type:'string'}}}};
  return out;
}

const operationKeys=['get','put','post','delete','options','head','patch'];
const pathItemKeys=new Set(['summary','description','parameters',...operationKeys]);
const segment='(?:[A-Za-z0-9._~-]+|\\{[A-Za-z_][A-Za-z0-9_]{0,63}\\})';
const templatedPath=new RegExp(`^(?:/${segment})+$`);
/**
 * One extension mount described by its registration's `describe()` (RIM-OPENAPI-001), checked against the
 * contribution contract (`ExtensionOpenApi`): JSON data within `extensionOpenApiLimits`, paths at or below the mount
 * that no other route declares, prefixed schema names and `$ref`s only to those or to core's components. Core keeps
 * the operations the route declares, names them, and adds what the runtime does on every extension answer (its
 * always-set headers and `Cache-Control: no-store`) and what a gate or policy on the route answers first; an
 * extension's own answer for the same status wins. `undefined` when the extension leaves the mount opaque.
 */
function describedMount(route:CompiledRoute,registration:RuntimeExtension,config:Record<string,unknown>,context:{signIn:string[];gates:string[];chain:PolicyChain|undefined;taken:Set<string>;paths:Record<string,Json>;schemas:Record<string,unknown>}):Record<string,Json>|undefined {
  const name=registration.name,mount=route.pattern.endsWith('/*')?route.pattern.slice(0,-2):route.pattern;
  const fail=(problem:string):never=>{throw new ConfigError(`Extension ${JSON.stringify(name)} described mount ${mount} outside the OpenAPI contribution contract: ${problem}`,{extension:name,code:'extension-registration'});};
  let raw:unknown;
  try{raw=registration.describe!({mount,methods:[...route.methods],config:structuredClone(config)});}
  catch(error){throw extensionError(error,name,'describe');}
  if(raw===undefined)return undefined;
  let text:string|undefined;
  try{text=JSON.stringify(raw);}catch{fail('it is not JSON data');}
  if(text===undefined||Buffer.byteLength(text)>extensionOpenApiLimits.bytes)fail(`it must be JSON data of at most ${extensionOpenApiLimits.bytes} bytes`);
  const described=JSON.parse(text!) as unknown;
  if(!isRecord(described)||!isRecord(described.paths)||Object.keys(described).some(key=>key!=='paths'&&key!=='schemas'))fail('it must be an object of paths and optional schemas');
  const {paths,schemas={}}=described as {paths:Record<string,unknown>;schemas?:unknown};
  if(!isRecord(schemas))fail('schemas must be an object');
  if(Object.keys(paths).length>extensionOpenApiLimits.paths||Object.keys(schemas as object).length>extensionOpenApiLimits.schemas)fail(`at most ${extensionOpenApiLimits.paths} paths and ${extensionOpenApiLimits.schemas} schemas`);
  const prefix=pascal(name),own=new Set(Object.keys(schemas as object));
  for(const [schemaName,schema] of Object.entries(schemas as Record<string,unknown>)){
    if(!new RegExp(`^${prefix}[A-Za-z0-9_]{0,63}$`).test(schemaName))fail(`schema ${schemaName.slice(0,64)} must be named ${prefix}<Name>`);
    if(Object.hasOwn(context.schemas,schemaName)&&JSON.stringify(context.schemas[schemaName])!==JSON.stringify(schema))fail(`schema ${schemaName} differs from the one another mount contributed`);
  }
  // Every reference resolves inside the document: this contribution's schemas or core's own components.
  const refs=(value:unknown):void=>{
    if(Array.isArray(value)){value.forEach(refs);return;}
    if(!isRecord(value))return;
    for(const [key,child] of Object.entries(value)){
      if(key==='$ref'){
        const target=typeof child==='string'?/^#\/components\/schemas\/([A-Za-z0-9_]+)$/.exec(child)?.[1]:undefined;
        if(target===undefined||!(own.has(target)||Object.hasOwn(components,target)))fail('every $ref must name one of its schemas or a core Urlcode component');
      }else refs(child);
    }
  };
  refs(described);
  const out:Record<string,Json>={},declared=route.methods.map(method=>method.toLowerCase());
  for(const [path,item] of Object.entries(paths)){
    if(!templatedPath.test(path)||path.length>512||!(path===mount||path.startsWith(`${mount}/`)))fail(`path ${path.slice(0,64)} must be the mount or a path below it`);
    if(Object.hasOwn(context.paths,path)||Object.hasOwn(out,path))fail(`path ${path} is already described`);
    if(!isRecord(item)||Object.keys(item).some(key=>!pathItemKeys.has(key)))fail(`path ${path} must be a path item of ${[...pathItemKeys].join(', ')}`);
    const pathItem:Json={};
    for(const [key,value] of Object.entries(item as Json)){
      if(!operationKeys.includes(key)){pathItem[key]=value;continue;}
      // The runtime answers a method the route does not declare itself, before the extension runs.
      if(!declared.includes(key))continue;
      if(!isRecord(value)||!isRecord(value.responses)||!Object.keys(value.responses).length)fail(`${key} ${path} needs responses`);
      const {operationId:_id,responses,security:_security,...rest}=value as Json;
      const method=key.toUpperCase(),answers:Record<string,Json>=gateResponses(method,context.chain,context.signIn);
      for(const [status,response] of Object.entries(responses as Record<string,unknown>)){
        if(!isRecord(response))fail(`${key} ${path} response ${status.slice(0,8)} must be an object`);
        const gate=answers[status];
        // A status both the gate and the extension answer carries either body, so neither schema is claimed.
        if(gate){const {content:_content,...other}=response as Json;answers[status]={...other,description:`${String(other.description??'')} Or: ${String(gate.description)}`.trim()};}
        else answers[status]=response as Json;
      }
      for(const [status,response] of Object.entries(answers)){
        const {content,headers,...other}=response;
        answers[status]={...other,headers:{...(headers as Json|undefined),...alwaysHeaders,...errorHeaders},...(content&&key!=='head'?{content}:{})};
      }
      pathItem[key]={operationId:operationName(method,path,context.taken),...rest,responses:Object.fromEntries(Object.entries(answers).sort(([a],[b])=>compare(a,b))),
        ...(context.signIn.length?{security:[Object.fromEntries(context.signIn.map(provider=>[sessionScheme(provider),[]]))]}:{})};
    }
    if(!Object.keys(pathItem).some(key=>operationKeys.includes(key)))continue;
    pathItem['x-urlcode']={handler:'extension',extension:name,route:route.pattern,...(context.gates.length?{extensions:context.gates}:{})};
    out[path]=pathItem;
  }
  for(const [schemaName,schema] of Object.entries(schemas as Record<string,unknown>))context.schemas[schemaName]=schema;
  return out;
}

/** Build the OpenAPI 3.1 document for a project's declared HTTP operations. Deterministic for a given project and options. */
export async function buildOpenApi(project:string,options:InspectOptions={}):Promise<OpenApiDocument> {
  const {loaded,routes,chains,projectSha256}=await prepare(project,options);
  const scopeEntries=loaded.document.site?.errors?.paths??[],taken=new Set<string>(),refusals:Record<string,Json>={};
  const paths:Record<string,Json>={},schemas:Record<string,unknown>={},facts:OpenApiFacts={urlcode:await runningCoreVersion(),revision:projectSha256,opaqueMounts:[],describedMounts:[],omitted:[],
    note:'Generated from the compiled configuration. Handler-defined responses have no schema; paths below opaque mounts are served by their provider and not enumerated, and paths below described mounts are what the loaded extension describes. Binding names and values, egress targets, module paths and operator policy are never included.'};
  // Sign-in gates follow the contract, not a name: the declared registrations that provide a principal when a host
  // file is loaded, else the installed descriptors (RIM-EXT-PRINCIPAL-001).
  const providers=await principalProvidersOf(dirname(loaded.root),Object.keys(loaded.document.extensions??{}),options.extensions),secured=new Set<string>();
  for(const route of [...routes].sort((a,b)=>compare(a.pattern,b.pattern))){
    if(route.enabled===false){facts.omitted.push({path:route.pattern,reason:'disabled'});continue;}
    if(route.prefix!==undefined){
      const registration=route.extension?options.extensions?.find(entry=>entry.name===route.extension):undefined;
      if(registration?.describe){
        const gates=Object.keys(effectiveExtensionPolicies(loaded.document,route)).sort(compare),signIn=gates.filter(name=>providers.includes(name));
        const described=describedMount(route,registration,(loaded.document.extensions?.[registration.name]?.config??{}) as Record<string,unknown>,{signIn,gates,chain:chains.get(route.pattern),taken,paths,schemas});
        if(described){
          Object.assign(paths,described);
          if(Object.keys(described).length)for(const name of signIn)secured.add(name);
          facts.describedMounts.push({path:route.pattern,extension:registration.name});
          continue;
        }
      }
      const handler=route.extension?'extension':route.static?'static':'redirect';
      const registered=route.extension&&options.extensions?options.extensions.some(entry=>entry.name===route.extension):undefined;
      facts.opaqueMounts.push({path:route.pattern,handler,...(route.extension?{extension:route.extension}:{}),...(registered===undefined?{}:{registered})});
      continue;
    }
    const chain=chains.get(route.pattern),explanation=explainCompiledRoute(loaded,route,chain,{extensions:options.extensions,projectSha256,now:0});
    const gates=Object.keys(effectiveExtensionPolicies(loaded.document,route)).sort(compare),signIn=gates.filter(name=>providers.includes(name));
    const {format,scope}=routeErrorFormat(route,scopeEntries);
    const item:Json={};
    if(route.description)item.description=route.description;
    if(route.parameters.length)item.parameters=route.parameters.map(parameter=>({name:parameter.name,in:parameter.in,...(parameter.required||parameter.in==='path'?{required:true}:{}),schema:structuredClone(parameter.schema)}));
    for(const method of [...route.methods].sort((a,b)=>methodOrder.indexOf(a)-methodOrder.indexOf(b))){
      const name=operationName(method,route.pattern,taken),policy=bodyPolicy(route,method);
      const operation:Json={operationId:name};
      const body=policy&&!bodylessMethods.includes(method)?requestBody(policy,name[0]!.toUpperCase()+name.slice(1),schemas):undefined;
      if(body)operation.requestBody=body;
      else if(policy?.maxBytes!==undefined)operation['x-urlcode']={body:{maxBytes:policy.maxBytes}};
      operation.responses=responses(route,method,format,chain,gates,signIn,policy);
      if(signIn.length){operation.security=[Object.fromEntries(signIn.map(name=>[sessionScheme(name),[]]))];for(const name of signIn)secured.add(name);}
      item[method.toLowerCase()]=operation;
    }
    const code=Boolean(route.function)||route.middleware.length>0,policies=explanation.policies.names.filter(name=>!name.startsWith('extensions.'));
    item['x-urlcode']={
      handler:explanation.handler.kind,
      ...(code?{execution:route.sandbox===true?'sandboxed':'trusted'}:{}),
      ...(route.middleware.length?{middleware:route.middleware.length}:{}),
      ...(gates.length?{extensions:gates}:{}),
      ...(policies.length?{policies}:{}),
      ...(route.match||route.conditional?{conditional:true}:{}),
      ...(route.stream?{stream:true}:{}),
      ...(route.generated?{generated:route.generated}:{}),
      ...(route.expires?{expires:route.expires}:{}),
      errors:format,
      ...(scope.length?{errorScope:scope}:{}),
      ...(route.methods.length<methodOrder.length?{methodNotAllowed:{status:405,allow:route.methods.join(', '),response:`#/components/responses/${methodNotAllowedName(format)}`}}:{}),
      targets:Object.fromEntries(Object.entries(explanation.targets).map(([target,support])=>[target,support.compatible])),
    };
    if(route.methods.length<methodOrder.length)refusals[methodNotAllowedName(format)]??=methodNotAllowedResponse(format);
    paths[route.pattern]=item;
  }
  const document:OpenApiDocument={
    openapi:openApiVersion,jsonSchemaDialect:bodySchemaDialect,
    info:{title:basename(loaded.root),version:projectSha256.slice(0,12),description:'The HTTP operations this URLCode project declares. Responses list only what URLCode itself enforces or writes; x-urlcode carries the facts OpenAPI has no field for.'},
    ...(options.origin?{servers:[{url:options.origin}]}:{}),
    paths,
    components:{
      schemas:{...structuredClone(components) as Record<string,unknown>,...Object.fromEntries(Object.entries(schemas).sort(([a],[b])=>compare(a,b)))},
      ...(Object.keys(refusals).length?{responses:Object.fromEntries(Object.entries(refusals).sort(([a],[b])=>compare(a,b)))}:{}),
      headers:structuredClone(headerComponents) as Record<string,Json>,
      ...(secured.size?{securitySchemes:Object.fromEntries([...secured].sort(compare).map(name=>[sessionScheme(name),{type:'apiKey',in:'cookie',name:'session',
        description:`A session credential the ${name} extension issues at sign-in and verifies before the handler runs; it provides the request principal. Its real cookie name is the operator's ${name} configuration and is not published here: \`session\` is a placeholder.`,
        'x-urlcode':{extension:name,cookieName:'operator-defined'}}]))}:{}),
    },
    'x-urlcode':facts,
  };
  return document;
}
/** The document as the CLI writes it: two-space JSON with a trailing newline. */
export function renderOpenApi(document:OpenApiDocument):string {return JSON.stringify(document,null,2)+'\n';}
