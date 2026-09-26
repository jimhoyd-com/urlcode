import {readFile,readdir} from 'node:fs/promises';
import {basename,join,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadDocument,parseYaml} from './config.ts';
import {applySite} from './site.ts';
import {routeCapabilities} from './capabilities.ts';
import {readMetadata,searchMetadata,searchTerms} from './catalog.ts';
import type {CatalogMetadata,SearchHit} from './catalog.ts';
import {assert} from './errors.ts';
import {authoringPath,readAuthoringFile,publishAuthoringProject} from './authoring-files.ts';
import {resolveHandlerName} from './types.ts';
import type {RouteConfig} from './types.ts';

/** example.yaml, the same schema as recipe.yaml; `name` repeats `id`. */
export interface ExampleSummary extends CatalogMetadata { name: string }
/** One cookbook route in the generated tag index (examples/cookbook/route-index.json). */
export interface RouteIndexEntry { path: string; file: string; handler: string; methods: string[]; tags: string[]; description: string }
export interface RouteIndex { format: 1; project: string; routes: number; entries: RouteIndexEntry[] }
/** `omitted` names packaged files an authoring copy refuses (dotfiles, package.json); they stay readable in the installed package. */
export interface ExampleAddReport { name: string; output: string; dryRun: boolean; files: string[]; omitted: string[] }
export interface ExampleSearchResult {
  query: string; count: number;
  /** The smallest matching runnable example, and its best matching cookbook route when the cookbook is that example. */
  best: (ExampleSummary & {route?: RouteIndexEntry})|null;
  results: (ExampleSummary & {score: number; matched: string[]; matchedRoutes: RouteIndexEntry[]})[];
}
// Fixed package data, like the recipe catalog: names come from here, metadata from each example.yaml.
export const exampleNames=['assets','aws','body-validation','cloudflare','compliance','conditions','cookbook','coverage-waiver','data-dir','egress','extensions','lifecycle','monitoring','not-found','prerender','provider-conformance','shared-blocks','tunnel','vercel'] as const;
export const routeIndexFile='route-index.json';
const examplesRoot=fileURLToPath(new URL('../../../examples/',import.meta.url));
const root=(name: string)=>examplesRoot+name+'/';
async function metadata(name: string): Promise<ExampleSummary> {const value=await readMetadata(root(name),name,'example.yaml');return {name,...value};}
export async function listExamples(): Promise<ExampleSummary[]> {
  const result: ExampleSummary[]=[];
  for(const name of exampleNames)result.push(await metadata(name));
  return result;
}
/** The command that copies a runnable example into a new directory, where its `tests.commands` run. */
export const exampleAddCommand=(name: string): string=>`urlcode examples add ${name} --out ${name}`;
// Package metadata beside the project, not part of it.
const catalogFiles=new Set(['example.yaml',routeIndexFile]);
/** Every regular file of one fixed packaged example, project-relative and sorted; `dist/` and `node_modules/` are local build state. */
async function exampleFiles(name: string): Promise<string[]> {
  const found: string[]=[];
  for(const entry of await readdir(root(name),{recursive:true,withFileTypes:true})){
    const path=relative(root(name),join(entry.parentPath,entry.name)).split(sep).join('/');
    if(/^(?:dist|node_modules)(?:\/|$)/.test(path)||catalogFiles.has(path)||entry.isDirectory())continue;
    assert(entry.isFile(),`examples/${name}/${path} is not an ordinary file`);
    found.push(path);
  }
  return found.sort();
}
const safe=(path: string): boolean=>{try{authoringPath(path);return true;}catch{return false;}};
/**
 * Copies one fixed runnable example into a new directory, the way `addRecipe`
 * copies a recipe, so its `tests.commands` (written for `--project .`) run there
 * with only the published package installed. It refuses an existing destination.
 */
export async function addExample(name: string,output: string,{dryRun=false}: {dryRun?: boolean|undefined}={}): Promise<ExampleAddReport> {
  assert((exampleNames as readonly string[]).includes(name),'Unknown bundled example');
  const example=await metadata(name);
  assert(example.runnable!==false,`${name} is not a runnable project; read its files with get_example or from the installed package`);
  const all=await exampleFiles(name),files=all.filter(safe),content=new Map<string,Buffer>();
  for(const path of files)content.set(path,await readAuthoringFile(root(name),path,1048576));
  return {name,output:await publishAuthoringProject(output,content,dryRun),dryRun,files,omitted:all.filter(path=>!safe(path))};
}
const handlerOf = (route: RouteConfig): string => resolveHandlerName(route, 'unknown');
/**
 * Derives the per-route tag index of one project from its loaded routes: handler,
 * methods, capabilities, policy names and middleware module names. The file each
 * route comes from is read from the entry and its includes; routes that neither
 * declares were generated by `site`.
 */
export async function buildRouteIndex(project: string,label: string): Promise<RouteIndex> {
  const loaded=await loadDocument(project);await applySite(loaded,{});
  const origin=new Map<string,string>();
  for(const file of ['urlcode.yaml',...(loaded.document.includes??[])]){
    const parsed=parseYaml(await readFile(project+'/'+file,'utf8')) as {routes?: Record<string,unknown>};
    for(const path of Object.keys(parsed.routes??{}))origin.set(path,file);
  }
  const entries: RouteIndexEntry[]=Object.entries(loaded.routes).map(([path,route])=>{
    const handler=handlerOf(route),file=origin.get(path)??'site';
    const methods=route.methods??['GET','HEAD'];
    const tags=new Set<string>([handler,...(file==='site'?['site']:[]),...methods.map(method=>method.toLowerCase())]);
    for(const capability of routeCapabilities(route,loaded.document))if(capability!=='methods'&&capability!=='enabled')tags.add(capability);
    for(const module of route.middleware??[])tags.add(basename(module.source).replace(/\.[cm]?js$/,''));
    if(route.enabled===false)tags.add('disabled');
    if(route.expires)tags.add('expiring');
    return {path,file,handler,methods,tags:[...tags],description:route.description??''};
  });
  return {format:1,project:label,routes:entries.length,entries};
}
export async function readRouteIndex(name: string): Promise<RouteIndex> {
  const value: unknown=JSON.parse(await readFile(root(name)+routeIndexFile,'utf8'));
  assert(typeof value==='object'&&value!==null&&(value as RouteIndex).format===1&&Array.isArray((value as RouteIndex).entries),'Malformed route index');
  return value as RouteIndex;
}
function matchRoutes(index: RouteIndex,terms: string[]): RouteIndexEntry[] {
  const scored=index.entries.map(entry=>{
    const text=[entry.path,entry.description].join(' ').toLowerCase();
    let score=0;
    for(const term of terms){if(entry.tags.includes(term))score+=4;else if(entry.tags.some(tag=>tag.includes(term)))score+=2;else if(text.includes(term))score+=1;}
    return {entry,score};
  }).filter(item=>item.score>0).sort((a,b)=>b.score-a.score);
  return scored.map(item=>item.entry);
}
/**
 * Searches example.yaml files and the cookbook's per-route index locally. Results
 * are ordered smallest runnable example first, so `best` is the least code that
 * demonstrates the match; cookbook hits carry their matching routes.
 */
export async function searchExamples(text: string): Promise<ExampleSearchResult> {
  const terms=searchTerms(text),examples=await listExamples();
  const indexes=new Map<string,RouteIndex>();
  for(const example of examples)if(example.id==='cookbook')indexes.set(example.id,await readRouteIndex(example.id));
  const routeText=(example: ExampleSummary)=>(indexes.get(example.id)?.entries??[]).flatMap(entry=>[entry.path,entry.description,...entry.tags]);
  const hits: SearchHit<ExampleSummary>[]=searchMetadata(examples,text,routeText);
  const results=hits.map(hit=>({...hit.entry,score:hit.score,matched:hit.matched,matchedRoutes:indexes.has(hit.entry.id)?matchRoutes(indexes.get(hit.entry.id)!,terms):[]}))
    .sort((a,b)=>Number(b.runnable!==false)-Number(a.runnable!==false)||(a.routes??0)-(b.routes??0)||b.score-a.score);
  const first=results.find(result=>result.runnable!==false);
  let best: ExampleSearchResult['best']=null;
  if(first){const {score:_score,matched:_matched,matchedRoutes,...summary}=first;best={...summary,...(matchedRoutes[0]?{route:matchedRoutes[0]}:{})};}
  return {query:text,count:results.length,best,results};
}
