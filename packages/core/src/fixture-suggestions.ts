// Deterministic request-fixture suggestions from URLCode YAML
// (#722; public API in agent-context.ts, contract in docs/TOOLING.md#fixture-suggestions).
//
// Only a fixture whose response core can predict from the YAML alone is
// generated. Anything that depends on project code, an operator grant or
// registration, an unread included file, the clock, request conditions or a
// regex is reported under `gaps` or `review`, never as a fixture: a suggestion
// must not read as "this route is tested" when nothing here could know its answer.
//
// Two modes (#733). Text mode (`suggestFixtures`, the public agent-context API)
// reads the supplied document only and reports its includes as gaps. Project
// mode (`suggestProjectFixtures`, CLI and local MCP only) reads the project's
// YAML through the configuration loader, which resolves and root-confines the
// includes exactly as serving does, and tags every entry with its file.
import {Ajv} from 'ajv';
import {loadDocument,parseYaml,validateDocument,normalizeRouteAuth} from './config.ts';
import {ConfigError} from './errors.ts';
import {contextFor,matchRoute,parameterName,parseTarget,redirectLocation} from './match.ts';
import type {CompiledParameter,CompiledRoutes,MatchableRoute,ParameterSchema,RedirectSpec} from './match.ts';
import {effectiveExtensionPolicies} from './extensions.ts';
import {effectivePolicies} from './policies.ts';
import type {ProjectDocument,RouteConfig} from './types.ts';

/** One `tests/requests.json` case (schemas/requests.schema.json). */
export interface SuggestedFixture {
  path: string; method?: 'GET'|'HEAD'|'POST'|'PUT'|'PATCH'|'DELETE'|'OPTIONS'; headers?: Record<string,string>;
  status: number; expectHeaders?: Record<string,string>; expectBody?: string;
}
export type FixtureKind = 'redirect'|'respond'|'page'|'download'|'disabled'|'method-refusal'|'missing-parameter'|'invalid-parameter'|'body-required'|'unknown-path';
export type FixtureGapCode = 'function'|'middleware'|'proxy'|'signals'|'extension'|'extension-policy'|'external-binding'|'pattern-constrained'|'include';
export type FixtureReviewCode = 'conditional'|'expires'|'static-directory'|'policy'|'parameter-schema'|'shadowed'|'include-shadowing'|'request-body'|'site'|'unknown-path'|'size';
/** Why a route has no generated fixture although nothing here claims it untestable: a person or agent writes its cases. */
export interface FixtureReview { route: string; code: FixtureReviewCode; reason: string; /** Project mode: the YAML file that declares the route. */ file?: string }
/** A route (or include) whose answer depends on something the YAML text cannot determine. Never covered by a suggestion. */
export interface FixtureGap { route: string; codes: FixtureGapCode[]; reason: string; /** Project mode: the YAML file that declares the route. */ file?: string }
export interface FixtureSuggestions {
  format: 1;
  /**
   * `supplied-yaml-only`: only the supplied document; its includes are gaps. `project-yaml`: the project's
   * `urlcode.yaml` and its includes, as the loader resolves them. Function sources, asset files, bindings and
   * operator policy are never read in either mode.
   */
  scope: 'supplied-yaml-only'|'project-yaml';
  /** Project mode: the YAML files read, `urlcode.yaml` first, then the includes in declaration order. */
  files?: string[];
  routeCount: number;
  /** Ready to write as `tests/requests.json`. Parallel to `cases`. */
  fixtures: SuggestedFixture[];
  cases: { route: string|null; kind: FixtureKind; /** Project mode: the YAML file that declares the route. */ file?: string }[];
  review: FixtureReview[];
  gaps: FixtureGap[];
  limits: { maxFixtures: number; maxEntries: number; maxBodyBytes: number; maxFixtureBytes: number };
  /** Counts dropped by a limit; all zero when nothing was cut. */
  truncated: { fixtures: number; review: number; gaps: number };
}
export interface FixtureSuggestionOptions { maxFixtures?: number }

const MAX_YAML_BYTES=1048576, MAX_ENTRIES=200, MAX_BODY_BYTES=1024, MAX_PATH=2048, MAX_FIXTURE_BYTES=393216;
const methodOrder=['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'] as const;
type Method=typeof methodOrder[number];
const scalarKeywords=new Set(['type','enum','default','minLength','maxLength','minimum','maximum','exclusiveMinimum','exclusiveMaximum','description','title','examples','items']);
const runnerHeaders=new Set(['host','user-agent','connection','content-length','transfer-encoding']);
const unmatchedCandidates=['/__urlcode-fixture-unmatched','/__urlcode-fixture/unmatched/path'];

/** Parsed and schema-validated document with the `auth:` short form expanded, as every runtime consumer sees it. Throws on invalid YAML. */
export function readProjectYaml(text:string, label='YAML'):{document:ProjectDocument; routes:Record<string,RouteConfig>} {
  if(typeof text!=='string')throw new TypeError(`${label} must be a string`);
  if(Buffer.byteLength(text)>MAX_YAML_BYTES)throw new ConfigError(`${label} exceeds 1 MiB`);
  let document:ProjectDocument;
  try{document=validateDocument(parseYaml(text));}
  catch(error){throw new ConfigError(`Invalid URLCode ${label}: ${error instanceof Error?error.message:'invalid document'}`);}
  const routes=Object.assign(Object.create(null) as Record<string,RouteConfig>,document.routes);
  try{normalizeRouteAuth(document,routes);}
  catch(error){throw new ConfigError(`Invalid URLCode ${label}: ${error instanceof Error?error.message:'invalid auth short form'}`);}
  return {document,routes};
}

/** One project's YAML as these tools read it. `sources` (project mode only) names the file of each route and extension declaration. */
export interface YamlProject {
  document: ProjectDocument; routes: Record<string,RouteConfig>;
  sources?: { routes: Record<string,string>; extensions: Record<string,string> };
}
/**
 * Project mode: the entry `urlcode.yaml` and its includes through `loadDocument`, so include resolution, root
 * containment, the nesting/duplicate rules and every size bound are the loader's own. Reads YAML only; executes nothing.
 */
export async function readProjectDirectory(project:string):Promise<YamlProject> {
  const {document,routes,sources}=await loadDocument(project,{sources:true});
  return {document,routes,sources:sources!};
}
const projectFiles=(project:YamlProject)=>['urlcode.yaml',...(project.document.includes??[])];

interface Probe extends MatchableRoute { config: RouteConfig }
/** The same precedence router.ts compiles (exact, then parameterized by specificity, then mounts by prefix length), over the supplied routes only. */
function matchTable(routes:Record<string,RouteConfig>):CompiledRoutes<Probe> {
  const exact=new Map<string,Probe>(), dynamic:(Probe&{specificity:number})[]=[], mounts:Probe[]=[];
  for(const [pattern,config] of Object.entries(routes)){
    const parts=pattern.split('/').slice(1), names=parts.map(parameterName).filter(Boolean);
    const probe:Probe={pattern,parts,parameters:[],env:{},secrets:{},config,...(config.extension?{extension:config.extension}:{})};
    if(config.redirect&&pattern.endsWith('/**'))mounts.push({...probe,prefix:pattern.slice(0,-2),wildcard:true});
    else if(config.static||config.extension)mounts.push({...probe,prefix:pattern.slice(0,-1)});
    else if(!names.length)exact.set(pattern,probe);
    else dynamic.push({...probe,specificity:parts.length-names.length});
  }
  dynamic.sort((a,b)=>b.specificity-a.specificity);
  const byLength=new Map<number,Probe[]>();
  for(const route of dynamic){const list=byLength.get(route.parts.length)??[];list.push(route);byLength.set(route.parts.length,list);}
  mounts.sort((a,b)=>b.prefix!.length-a.prefix!.length);
  return {exact,byLength,mounts};
}
function resolves(table:CompiledRoutes<Probe>, target:string):string|null|undefined {
  try{return matchRoute(table,parseTarget(target))?.route.pattern??null;}catch{return undefined;}
}

const ajv=new Ajv({strict:false,allErrors:false});
const validators=new Map<string,(value:unknown)=>boolean>();
function schemaAccepts(schema:ParameterSchema, value:unknown):boolean {
  const {default:_default,...shape}=schema, key=JSON.stringify(shape);
  let validate=validators.get(key);
  if(!validate){if(validators.size>=256)validators.clear();const compiled=ajv.compile(shape);validate=(input:unknown)=>compiled(input);validators.set(key,validate);}
  return validate(value);
}
const constrained=(schema:ParameterSchema)=>Object.hasOwn(schema,'pattern')||Object.hasOwn(schema,'format');
/** A value the declared schema accepts, as request text and as the runtime parses it; undefined when this helper cannot pick one. */
function sampleValue(schema:ParameterSchema):{text:string;value:unknown}|undefined {
  if(Object.keys(schema).some(key=>!scalarKeywords.has(key)))return undefined;
  const numeric=(value:unknown)=>typeof value==='number'?value:undefined;
  let text:string, value:unknown;
  if(Array.isArray(schema.enum)){
    const first:unknown=schema.enum[0];
    if(!['string','number','boolean'].includes(typeof first))return undefined;
    text=String(first); value=first;
  } else if(schema.type==='string'){
    const min=numeric(schema.minLength)??0, max=numeric(schema.maxLength)??Infinity, length=Math.max(1,Math.min(6,max),min);
    if(length>max||length>256)return undefined;
    text=length<=6?'sample'.slice(0,length):'sample'+'a'.repeat(length-6); value=text;
  } else if(schema.type==='integer'||schema.type==='number'){
    const min=numeric(schema.minimum), exclusive=numeric(schema.exclusiveMinimum);
    const candidate=min!==undefined?Math.ceil(min):exclusive!==undefined?Math.floor(exclusive)+1:1;
    text=String(candidate); value=candidate;
  } else if(schema.type==='boolean'){text='true';value=true;}
  else return undefined;
  return schemaAccepts(schema,value)?{text,value}:undefined;
}
/** A value the runtime refuses for this input, or undefined when none is certain. */
function invalidValue(schema:ParameterSchema):string|undefined {
  if(schema.type==='integer'||schema.type==='number'||schema.type==='boolean')return 'not-a-'+schema.type;
  if(schema.type==='string'&&Array.isArray(schema.enum)&&schema.enum.every(item=>typeof item==='string')){
    let candidate='urlcode-invalid';while((schema.enum as string[]).includes(candidate))candidate+='-x';return candidate;
  }
  return undefined;
}

interface Request { path:string; query:[string,string][]; headers:Record<string,string>; pathValues:Record<string,string> }
const encodePath=(segments:string[])=>'/'+segments.map(segment=>encodeURIComponent(segment)).join('/');
function target(request:Request):string {
  const query=new URLSearchParams(request.query).toString();
  return request.path+(query?`?${query}`:'');
}

/**
 * Suggests `tests/requests.json` cases for one supplied URLCode YAML document.
 * Deterministic and bounded: the same text always yields the same bytes, routes
 * are visited in code-point order, and nothing is read, executed or fetched.
 */
export function suggestFixtures(yaml:string, options:FixtureSuggestionOptions={}):FixtureSuggestions {
  return suggestFor(readProjectYaml(yaml),options);
}
/**
 * Project mode (CLI and local MCP): the same suggestions over the project's `urlcode.yaml` and its includes, read
 * through the configuration loader. Included routes are analysed like entry routes; each entry names its file.
 */
export async function suggestProjectFixtures(project:string, options:FixtureSuggestionOptions={}):Promise<FixtureSuggestions> {
  return suggestFor(await readProjectDirectory(project),options);
}

function suggestFor(project:YamlProject, options:FixtureSuggestionOptions):FixtureSuggestions {
  const maxFixtures=Math.min(Math.max(Math.trunc(options.maxFixtures??200),1),1000);
  const {document,routes}=project, sources=project.sources?.routes;
  // In project mode every included route is in `routes`, so nothing unread can shadow a route or match a probe path.
  const table=matchTable(routes), hasIncludes=!sources&&(document.includes??[]).length>0;
  const at=(route:string|null):{file?:string}=>route!==null&&sources&&Object.hasOwn(sources,route)?{file:sources[route]!}:{};
  const fixtures:SuggestedFixture[]=[], cases:FixtureSuggestions['cases']=[], review:FixtureReview[]=[], gaps:FixtureGap[]=[];
  const truncated={fixtures:0,review:0,gaps:0};
  let bytes=0;
  const add=(route:string|null,kind:FixtureKind,fixture:SuggestedFixture)=>{
    const size=Buffer.byteLength(JSON.stringify(fixture));
    if(fixtures.length>=maxFixtures||bytes+size>MAX_FIXTURE_BYTES){truncated.fixtures++;return;}
    bytes+=size;fixtures.push(fixture);cases.push({route,kind,...at(route)});
  };
  const note=(route:string,code:FixtureReviewCode,reason:string)=>{if(review.length>=MAX_ENTRIES)truncated.review++;else review.push({route,code,reason,...at(route)});};
  const gap=(route:string,codes:FixtureGapCode[],reason:string)=>{if(gaps.length>=MAX_ENTRIES)truncated.gaps++;else gaps.push({route,codes,reason,...at(route)});};

  if(hasIncludes)for(const include of [...(document.includes??[])].sort())gap(include,['include'],'Routes in an included file are not read from supplied YAML; suggest fixtures for the project itself (urlcode fixtures suggest, or MCP suggest_fixtures without yaml) to cover them, or write them by hand.');
  const gapReasons:Record<FixtureGapCode,string>={
    function:'a function answers it, so the response is project code',
    middleware:'middleware runs project code around the handler',
    proxy:'a proxy answers from an upstream through an operator egress grant',
    signals:'signals send egress that needs an operator grant before the route activates',
    extension:'an operator-registered extension answers it',
    'extension-policy':'an extension policy (including the auth: short form) can answer before the handler',
    'external-binding':'it reads env or secret bindings that come from the operator',
    'pattern-constrained':'an input is constrained by pattern or format',
    include:'',
  };
  for(const pattern of Object.keys(routes).sort()){
    const route=routes[pattern]!;
    const codes:FixtureGapCode[]=[];
    if(route.function)codes.push('function');
    if(route.middleware?.length)codes.push('middleware');
    if(route.proxy)codes.push('proxy');
    if(route.signals?.length)codes.push('signals');
    if(route.extension)codes.push('extension');
    if(Object.keys(effectiveExtensionPolicies(document,route)).length)codes.push('extension-policy');
    if(Object.values(route.env??{}).some(ref=>ref.env!==undefined)||Object.keys(route.secrets??{}).length)codes.push('external-binding');
    if((route.parameters??[]).some(parameter=>constrained(parameter.schema)||(parameter.schema.items!==undefined&&constrained(parameter.schema.items as ParameterSchema))))codes.push('pattern-constrained');
    if(codes.length){gap(pattern,codes,`Not suggested: ${codes.map(code=>gapReasons[code]).join('; ')}. Write its cases against the behavior you implement and run urlcode test.`);continue;}
    if(hasIncludes&&(pattern.includes('{')||pattern.includes('*'))){note(pattern,'include-shadowing','The document has includes, and an included route may be more specific than this parameterized or wildcard route; write its cases by hand.');continue;}

    // The request that reaches this route: literal segments, one accepted value per input.
    const request:Request={path:'',query:[],headers:{},pathValues:{}};
    let unsupported:string|undefined;
    for(const parameter of route.parameters??[]){
      const schema=parameter.schema;
      if(schema.type==='array'){ if(parameter.required&&!Object.hasOwn(schema,'default'))unsupported=`the required array input ${parameter.name}`; continue; }
      // The fixture runner sets these itself, so a case cannot reliably send or omit them.
      const sample=parameter.in==='header'&&runnerHeaders.has(parameter.name.toLowerCase())?undefined:sampleValue(schema);
      if(!sample){unsupported=`the ${parameter.in} input ${parameter.name}`;break;}
      if(parameter.in!=='path'&&!parameter.required)continue;
      if(parameter.in==='path')request.pathValues[parameter.name]=sample.text;
      else if(parameter.in==='query'){ if(!Object.hasOwn(schema,'default'))request.query.push([parameter.name,sample.text]); }
      else if(!Object.hasOwn(schema,'default'))request.headers[parameter.name.toLowerCase()]=sample.text;
    }
    if(unsupported){note(pattern,'parameter-schema',`No certain sample value for ${unsupported}; write its cases by hand.`);continue;}
    const parts=pattern.split('/').slice(1);
    request.path=encodePath(parts.map(part=>part==='**'?'sample':parameterName(part)!==null?request.pathValues[parameterName(part)!]!:part));
    if(route.static){note(pattern,'static-directory','The static directory\'s file names are not in the YAML; add a case per file you publish.');continue;}
    if(route.enabled!==false){
      if(route.conditional||route.match){note(pattern,'conditional','Its answer depends on request conditions; write one case per branch.');continue;}
      if(route.expires){note(pattern,'expires','Its answer changes at the expiry time (410 afterwards); a fixed fixture would start failing.');continue;}
      const policies=effectivePolicies(document,route);
      if(policies.agents||policies.throttle){note(pattern,'policy',policies.agents?'The agents policy can answer before the handler depending on the caller\'s user agent.':'The throttle policy can answer 429 before the handler once its budget is spent, which depends on how many cases run.');continue;}
    }
    const sent=target(request);
    if(sent.length>MAX_PATH){note(pattern,'size','The sample request target exceeds 2048 characters.');continue;}
    if(resolves(table,sent)!==pattern){note(pattern,'shadowed','The sample request is answered by another route; write a case with a path that reaches this one.');continue;}
    const headers=Object.keys(request.headers).length?{headers:request.headers}:{};
    const methods=(route.methods??['GET','HEAD']) as Method[];
    if(route.enabled===false){add(pattern,'disabled',{path:sent,...headers,status:404});continue;}
    const method=methodOrder.find(candidate=>methods.includes(candidate))!;
    const methodKey=method==='GET'?{}:{method};
    // A required body is refused before any handler runs; a positive case needs a real body, which only the author knows.
    if(route.request?.body?.required){
      add(pattern,'body-required',{path:sent,...methodKey,...headers,status:400});
      note(pattern,'request-body','Only the missing-body refusal is suggested; add a case with a valid body.');
    } else {
      const primary=expected(pattern,route,request,method);
      if('review' in primary)note(pattern,'size',primary.review);
      else add(pattern,primary.kind,{path:sent,...methodKey,...headers,...primary.fixture});
    }
    const refused=(['POST','PUT','PATCH','DELETE','GET'] as const).find(candidate=>!methods.includes(candidate));
    if(refused)add(pattern,'method-refusal',{path:sent,...(refused==='GET'?{}:{method:refused}),...headers,status:405,expectHeaders:{allow:methods.join(', ')}});
    // One refused input per route: the first required input without a default (omitted), else the first typed or enumerated one.
    const params=(route.parameters??[]).filter(parameter=>parameter.schema.type!=='array');
    const missing=params.find(parameter=>parameter.in!=='path'&&parameter.required&&!Object.hasOwn(parameter.schema,'default'));
    if(missing){
      const without:Request={...request,query:request.query.filter(([name])=>!(missing.in==='query'&&name===missing.name)),headers:Object.fromEntries(Object.entries(request.headers).filter(([name])=>!(missing.in==='header'&&name===missing.name.toLowerCase())))};
      add(pattern,'missing-parameter',{path:target(without),...methodKey,...(Object.keys(without.headers).length?{headers:without.headers}:{}),status:400});
    } else {
      const typed=params.map(parameter=>({parameter,bad:invalidValue(parameter.schema)})).find(item=>item.bad!==undefined);
      if(typed){
        const {parameter,bad}=typed, changed:Request={...request,query:[...request.query],headers:{...request.headers}};
        if(parameter.in==='path')changed.path=encodePath(parts.map(part=>parameterName(part)===parameter.name?bad!:parameterName(part)!==null?request.pathValues[parameterName(part)!]!:part==='**'?'sample':part));
        else if(parameter.in==='query')changed.query=[...request.query.filter(([name])=>name!==parameter.name),[parameter.name,bad!]];
        else changed.headers[parameter.name.toLowerCase()]=bad!;
        const invalidTarget=target(changed);
        if(resolves(table,invalidTarget)===pattern)add(pattern,'invalid-parameter',{path:invalidTarget,...methodKey,...(Object.keys(changed.headers).length?{headers:changed.headers}:{}),status:400});
      }
    }
  }
  if(document.site&&Object.keys(document.site).length)note('site','site','Routes generated from site.* (robots, sitemap, favicon, security.txt, llms.txt, notFound) are not suggested; their bodies come from generation and files.');
  const unmatched=hasIncludes?undefined:unmatchedCandidates.find(candidate=>resolves(table,candidate)===null);
  if(unmatched)add(null,'unknown-path',{path:unmatched,status:404});
  else note('(unmatched path)','unknown-path',hasIncludes?'Included routes are not read, so no path is certain to match nothing.':'Every candidate unmatched path reaches a route (a root mount or parameter); write a 404 case by hand.');
  return {format:1,...(sources?{scope:'project-yaml' as const,files:projectFiles(project)}:{scope:'supplied-yaml-only' as const}),routeCount:Object.keys(routes).length,fixtures,cases,review,gaps,limits:{maxFixtures,maxEntries:MAX_ENTRIES,maxBodyBytes:MAX_BODY_BYTES,maxFixtureBytes:MAX_FIXTURE_BYTES},truncated};
}

type Expected={kind:FixtureKind;fixture:Pick<SuggestedFixture,'status'|'expectHeaders'|'expectBody'>}|{review:string};
function expected(pattern:string, route:RouteConfig, request:Request, method:Method):Expected {
  const declared=Object.entries(route.response?.headers??{}).find(([name])=>name.toLowerCase()==='content-type')?.[1];
  if(route.redirect){
    const parts=pattern.split('/').slice(1), wildcard=pattern.endsWith('/**');
    // The runtime's own assembly (match.ts): declared inputs with schema defaults applied, literal env values, the sample query.
    const parameters:CompiledParameter[]=(route.parameters??[]).map(parameter=>({...parameter,name:parameter.in==='header'?parameter.name.toLowerCase():parameter.name,required:parameter.required===true,validate:()=>true}));
    const env=Object.fromEntries(Object.entries(route.env??{}).flatMap(([alias,ref])=>ref.value!==undefined?[[alias,ref.value]]:[]));
    const probe:MatchableRoute&{redirect:RedirectSpec}={pattern,parts,parameters,env,secrets:{},...(wildcard?{wildcard:true,prefix:pattern.slice(0,-2)}:{}),redirect:route.redirect as RedirectSpec};
    const pathValues:Record<string,string>=wildcard?{'**':'sample'}:{...request.pathValues};
    const query=new URLSearchParams(request.query), headers=new Headers(request.headers);
    const location=redirectLocation(probe,contextFor(probe,pathValues,query,headers),query);
    if(location.length>MAX_PATH)return {review:'The expected Location exceeds 2048 characters.'};
    return {kind:'redirect',fixture:{status:route.redirect.status??302,expectHeaders:{location}}};
  }
  if(route.respond){
    const json=Object.hasOwn(route.respond,'json'), body=json?JSON.stringify(route.respond.json):route.respond.text??'';
    const contentType=declared!==undefined&&!Array.isArray(declared)?declared:json?'application/json; charset=utf-8':'text/plain; charset=utf-8';
    const withBody=method!=='HEAD'&&Buffer.byteLength(body)<=MAX_BODY_BYTES;
    return {kind:'respond',fixture:{status:route.respond.status??200,expectHeaders:{'content-type':contentType},...(withBody?{expectBody:body}:{})}};
  }
  // page/download: the file must exist for the project to activate at all, so 200 is certain; its bytes are not in the YAML.
  return {kind:route.download?'download':'page',fixture:{status:200}};
}
