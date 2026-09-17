import {loadDocument} from './config.ts';
import {applySite} from './site.ts';
import {prepareFunctionSnapshot,requestedPermissions} from './policy.ts';
import {compileRoutes,matchRoute,parseTarget} from './router.ts';
import {compilePolicies,closePolicies} from './policies.ts';
import {analyzeCompiledCapabilities,routeCapabilities} from './capabilities.ts';
import type {CompatibilityReport} from './capabilities.ts';
import {importRoutes,exportRoutes} from './interchange.ts';
import type {ImportRoutesOptions,InterchangeFormat} from './interchange.ts';
import {listRecipes,showRecipe} from './recipes.ts';
import type {CompiledRoute,PolicyShared} from './types.ts';
export {getCapabilities} from './capabilities.ts';
export {listRecipes,showRecipe};
export interface InspectOptions {origin?:string;target?:string;offset?:number;limit?:number}
function routesOf(table:Awaited<ReturnType<typeof compileRoutes>>):CompiledRoute[] {return [...table.exact.values(),...[...table.byLength.values()].flat(),...table.mounts];}
async function prepare(project:string,options:InspectOptions={}) {
 const loaded=await loadDocument(project);await applySite(loaded,{...(options.origin?{origin:options.origin}:{})});
 const snapshot=await prepareFunctionSnapshot(loaded),bindings:Record<string,string>=Object.create(null);
 for(const route of Object.values(loaded.routes)) {for(const ref of Object.values(route.env||{}))if(ref.env)bindings[ref.env]='validation-only';for(const ref of Object.values(route.secrets||{}))bindings[ref.secret]='validation-only';}
 const compiled=await compileRoutes(loaded,bindings,requestedPermissions(loaded,snapshot),snapshot.projectSha256),routes=routesOf(compiled);
 const shared:PolicyShared={target:'node',routes:routes.length,log:()=>{}};
 try {for(const route of routes)await compilePolicies(loaded.document,route,{route,shared,target:'node',root:loaded.root});}finally{await closePolicies(shared);}
 return {loaded,compiled,routes,projectSha256:snapshot.projectSha256};
}
function compatibilitySummary(report:CompatibilityReport) {return {target:report.target,compatible:report.compatible,deployment:report.deployment,requirementCount:report.requirements.length,issueCount:report.issues.length};}
/** Semantic authoring inspection; no binding reads, sandbox execution or runtime activation. */
export async function inspectProject(project:string,options:InspectOptions={}) {
 const offset=options.offset??0,limit=options.limit??100;
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new Error('Invalid inspection page');
 const {loaded,compiled,routes,projectSha256}=await prepare(project,options);
 const report=analyzeCompiledCapabilities(loaded.document,compiled,options.target??'self-hosted');
 return {format:1,projectSha256,routeCount:compiled.count,offset,limit,routes:routes.slice(offset,offset+limit).map(route=>({path:route.pattern,methods:route.methods,enabled:route.enabled!==false,capabilities:routeCapabilities(route,loaded.document)})),compatibility:{...compatibilitySummary(report),offset,limit,hasMore:offset+limit<report.issues.length,issues:report.issues.slice(offset,offset+limit)}};
}
export async function validateProject(project:string,options:InspectOptions={}) {
 const result=await inspectProject(project,{...options,offset:0,limit:1});
 const {target,compatible,deployment,requirementCount,issueCount,issues}=result.compatibility;
 return {valid:true,projectSha256:result.projectSha256,routeCount:result.routeCount,compatibility:{target,compatible,deployment,requirementCount,issueCount,firstIssue:issues[0]??null}};
}
/** Explain path selection without executing the selected handler or resolving bindings. */
export async function explainRoute(project:string,target:string,options:InspectOptions={}) {
 const {compiled}=await prepare(project,options),match=matchRoute(compiled,parseTarget(target));
 return {matched:Boolean(match),...(match?{path:match.route.pattern,methods:match.route.methods,enabled:match.route.enabled!==false,conditional:Boolean(match.route.match||match.route.conditional),note:'Path selection only; request conditions, parameters, policies and handler execution are not evaluated.'}:{})};
}
export async function previewImport(options:ImportRoutesOptions) {return importRoutes(options);}
export async function previewExport(project:string,format:InterchangeFormat,acceptProviderDifferences=false) {const loaded=await loadDocument(project);const {includes:_includes,...document}=loaded.document;return exportRoutes({format,document:{...document,routes:loaded.routes},acceptProviderDifferences});}
