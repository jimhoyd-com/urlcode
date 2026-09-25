import {loadDocument} from './config.ts';
import {applySite} from './site.ts';
import {prepareFunctionSnapshot,requestedPermissions} from './policy.ts';
import {compileRoutes,matchRoute,parseTarget} from './router.ts';
import {compilePolicies,closePolicies} from './policies.ts';
import {analyzeCompiledCapabilities,routeCapabilities} from './capabilities.ts';
import type {CompatibilityReport} from './capabilities.ts';
import {importRoutes,exportRoutes} from './interchange.ts';
import type {ImportRoutesOptions,InterchangeFormat} from './interchange.ts';
import {listRecipes,showRecipe,searchRecipes} from './recipes.ts';
import {listExamples,searchExamples} from './examples.ts';
import type {CompiledRoute,PolicyChain,PolicyShared} from './types.ts';
import {checkExtensionPolicies,effectiveExtensionPolicies,emptyPolicyOnly} from './extensions.ts';
import {readInstalledDescriptor} from './addon-install.ts';
import Ajv from 'ajv/dist/2020.js';
import {dirname} from 'node:path';
import type {LoadedDocument} from './types.ts';
import type {RuntimeExtension} from './extensions.ts';
import {loadOperatorHost} from './operator-host.ts';
import {explainCompiledRoute,nearestRoutes} from './explain.ts';
import type {RouteExplanation} from './explain.ts';
export {getCapabilities} from './capabilities.ts';
export {getCapability} from './capability-query.ts';
export type {CapabilityEntry,CapabilityUsage} from './capability-query.ts';
export {getSchemaFragment,schemaPathNames} from './schema-query.ts';
export type {SchemaFragment} from './schema-query.ts';
export {listRecipes,showRecipe,searchRecipes,listExamples,searchExamples};
export {buildContext,renderContext,estimateTokens,documentationTokens,buildTaskContext,renderTaskContext,contextTasks} from './context.ts';
export type {ContextOptions,ProjectContext,ContextSection,ContextTask,TaskContext,TaskShape} from './context.ts';
export {planFeature,featurePlanMaxBytes,featurePlanMaxGoalLength} from './feature-plan.ts';
export type {FeaturePlan,FeaturePlanOptions} from './feature-plan.ts';
export type {RouteExplanation,ExplainedHandler,ExplainedCache,ExplainedExtensionRequirement,ExtensionProvider,TargetSupport} from './explain.ts';
export {reviewProject} from './review.ts';
export type {ProjectReview,ReviewObservation,ReviewCategory,ReviewSignal} from './review.ts';
/** `extensions` are operator registrations from a host file; explain reports whether each requirement has a provider. Nothing is activated. */
export interface InspectOptions {origin?:string;target?:string;offset?:number;limit?:number;extensions?:RuntimeExtension[]|undefined}
function routesOf(table:Awaited<ReturnType<typeof compileRoutes>>):CompiledRoute[] {return [...table.exact.values(),...[...table.byLength.values()].flat(),...table.mounts];}
export async function prepare(project:string,options:InspectOptions={}) {
 const loaded=await loadDocument(project);await applySite(loaded,{...(options.origin?{origin:options.origin}:{})});
 const snapshot=await prepareFunctionSnapshot(loaded),bindings:Record<string,string>=Object.create(null);
 for(const route of Object.values(loaded.routes)) {for(const ref of Object.values(route.env||{}))if(ref.env)bindings[ref.env]='validation-only';for(const ref of Object.values(route.secrets||{}))bindings[ref.secret]='validation-only';}
 const compiled=await compileRoutes(loaded,bindings,requestedPermissions(loaded,snapshot),snapshot.projectSha256),routes=routesOf(compiled);
 const shared:PolicyShared={target:'node',routes:routes.length,log:()=>{}};
 // The same policy inventory the runtime attaches (src/runtime.ts): compiled for every route when the project declares any.
 const anyPolicy=Boolean(loaded.document.policies)||routes.some(route=>route.policies),chains=new Map<string,PolicyChain>();
 try {for(const route of routes){const chain=await compilePolicies(loaded.document,route,{route,shared,target:'node',root:loaded.root});if(anyPolicy)chains.set(route.pattern,chain);}}finally{await closePolicies(shared);}
 return {loaded,compiled,routes,chains,projectSha256:snapshot.projectSha256};
}
function compatibilitySummary(report:CompatibilityReport) {return {target:report.target,compatible:report.compatible,deployment:report.deployment,requirementCount:report.requirements.length,issueCount:report.issues.length};}
/** Semantic authoring inspection; no binding reads, sandbox execution or runtime activation. */
export async function inspectProject(project:string,options:InspectOptions={}) {inspectionPage(options);return inspectPrepared(await prepare(project,options),options);}
function inspectionPage(options:InspectOptions):{offset:number;limit:number} {
 const offset=options.offset??0,limit=options.limit??100;
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new Error('Invalid inspection page');
 return {offset,limit};
}
function inspectPrepared({loaded,compiled,routes,projectSha256}:Awaited<ReturnType<typeof prepare>>,options:InspectOptions) {
 const {offset,limit}=inspectionPage(options);
 const report=analyzeCompiledCapabilities(loaded.document,compiled,options.target??'self-hosted',options.extensions);
 return {format:1,projectSha256,routeCount:compiled.count,offset,limit,routes:routes.slice(offset,offset+limit).map(route=>({path:route.pattern,methods:route.methods,enabled:route.enabled!==false,capabilities:routeCapabilities(route,loaded.document)})),compatibility:{...compatibilitySummary(report),offset,limit,hasMore:offset+limit<report.issues.length,issues:report.issues.slice(offset,offset+limit)}};
}
/**
 * Each declared extension's route requirements against the policy schema that will judge them at startup: the
 * supplied operator registration's, else the installed package's static `urlcode.json` descriptor in the enclosing
 * site. Core does not know any extension's policy keys (not even the `auth:` short form's), so this is what refuses
 * a bad requirement at validate time. An extension with neither is left to the runtime; nothing is activated.
 */
async function validateExtensionPolicies(loaded:LoadedDocument,registrations:RuntimeExtension[]|undefined):Promise<void> {
 const ajv=new Ajv.default({strict:false,allErrors:false,verbose:true});
 for(const name of Object.keys(loaded.document.extensions??{})){
  const registration=registrations?.find(candidate=>candidate?.name===name);
  if(registration){checkExtensionPolicies(loaded.document,loaded.routes,loaded.routeAuth,name,registration.policySchema?ajv.compile(registration.policySchema):undefined);continue;}
  const descriptor=await readInstalledDescriptor(dirname(loaded.root),name).catch(()=>undefined);
  if(descriptor?.kind!=='extension')continue;
  checkExtensionPolicies(loaded.document,loaded.routes,loaded.routeAuth,name,descriptor.policySchema?ajv.compile(descriptor.policySchema):emptyPolicyOnly);
 }
}
export async function validateProject(project:string,options:InspectOptions={}) {
 const prepared=await prepare(project,options);
 await validateExtensionPolicies(prepared.loaded,options.extensions);
 const result=inspectPrepared(prepared,{...options,offset:0,limit:1});
 const {target,compatible,deployment,requirementCount,issueCount,issues}=result.compatibility;
 return {valid:true,projectSha256:result.projectSha256,routeCount:result.routeCount,compatibility:{target,compatible,deployment,requirementCount,issueCount,firstIssue:issues[0]??null}};
}
export interface RouteMiss {matched:false;nearest:string[];note:string}
/** Explain the route a path selects from the compiled IR: effective methods, handler, middleware, inputs, policies, cache outcome, bindings and target support. Nothing executes and no binding is read. */
export async function explainRoute(project:string,target:string,options:InspectOptions={}):Promise<RouteExplanation|RouteMiss> {
 const {loaded,compiled,chains,projectSha256}=await prepare(project,options),match=matchRoute(compiled,parseTarget(target));
 if(!match)return {matched:false,nearest:nearestRoutes(target,routesOf(compiled).map(route=>route.pattern)),note:'No route selects this path.'};
 return explainCompiledRoute(loaded,match.route,chains.get(match.route.pattern),{extensions:options.extensions,projectSha256});
}
/** Every route's explanation, in the router's precedence order. */
export async function explainProject(project:string,options:InspectOptions={}):Promise<{projectSha256:string;routeCount:number;routes:RouteExplanation[]}> {
 const {loaded,routes,chains,projectSha256}=await prepare(project,options);
 return {projectSha256,routeCount:routes.length,routes:routes.map(route=>explainCompiledRoute(loaded,route,chains.get(route.pattern),{extensions:options.extensions,projectSha256}))};
}
export async function previewImport(options:ImportRoutesOptions) {return importRoutes(options);}
export async function previewExport(project:string,format:InterchangeFormat,acceptProviderDifferences=false) {const loaded=await loadDocument(project);const {includes:_includes,...document}=loaded.document;return exportRoutes({format,document:{...document,routes:loaded.routes},acceptProviderDifferences});}
export interface ExtensionInspection {
 format:1;projectSha256:string;hostLoaded:boolean;note:string;
 extensions:{name:string;version:string;targets:string[];credentialHeaders:string[];schema:object;policySchema:object|null;hooks:object[];authoring:object|null;declared:boolean;revisionPinned:boolean;mounts:string[];policyRoutes:string[]}[];
 declared:{name:string;version:string;registered:boolean;mounts:string[];policyRoutes:string[]}[];
}
/** Reports registered extension contracts against the project's declarations. Never activates an extension. */
export async function describeExtensions(project:string,registrations:RuntimeExtension[]|undefined):Promise<ExtensionInspection> {
 const loaded=await loadDocument(project),{projectSha256}=await prepareFunctionSnapshot(loaded),routes=Object.entries(loaded.routes);
 const declarations=Object.entries(loaded.document.extensions??{});
 const mountsOf=(name:string)=>routes.filter(([,route])=>route.extension===name).map(([path])=>path.endsWith('/*')?path.slice(0,-2):path);
 const policyRoutesOf=(name:string)=>routes.filter(([,route])=>Object.hasOwn(effectiveExtensionPolicies(loaded.document,route),name)).map(([path])=>path);
 const registered=new Set((registrations??[]).map(registration=>registration.name));
 const declared=declarations.map(([name,declaration])=>({name,version:String(declaration.version),registered:registered.has(name),mounts:mountsOf(name),policyRoutes:policyRoutesOf(name)}));
 if(registrations===undefined)return {format:1,projectSha256,hostLoaded:false,note:'Configuration and policy schemas come from the operator host file; supply --host-file to print them.',extensions:[],declared};
 const extensions=registrations.map(registration=>({
  name:String(registration.name),version:String(registration.version),targets:Array.isArray(registration.targets)?registration.targets.map(String):[],
  credentialHeaders:Array.isArray(registration.credentialHeaders)?registration.credentialHeaders.map(String):[],
  schema:structuredClone(registration.schema??{}),policySchema:registration.policySchema?structuredClone(registration.policySchema):null,
  hooks:structuredClone(registration.hooks??[]) as object[],
  authoring:registration.authoring?structuredClone(registration.authoring) as object:null,
  declared:Object.hasOwn(loaded.document.extensions??{},registration.name),revisionPinned:registration.projectSha256===projectSha256,
  mounts:mountsOf(registration.name),policyRoutes:policyRoutesOf(registration.name),
 }));
 return {format:1,projectSha256,hostLoaded:true,note:'Schemas describe operator-installed contracts; inspection activates nothing and grants no revision.',extensions,declared};
}
/** Executes the trusted operator host file to read its registrations, then releases it. */
export async function inspectExtensions(options:{project:string;hostFile?:string}):Promise<ExtensionInspection> {
 const host=await loadOperatorHost(options.hostFile,options.project);
 try{return await describeExtensions(options.project,options.hostFile===undefined?undefined:host.extensions??[]);}finally{await host.close?.();}
}
