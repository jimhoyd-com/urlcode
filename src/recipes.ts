import {fileURLToPath} from 'node:url';
import {readAuthoringFile,publishAuthoringProject} from './authoring-files.ts';
import {validateDocument,parseYaml} from './config.ts';
import {readMetadata,searchMetadata} from './catalog.ts';
import type {CatalogMetadata,SearchHit} from './catalog.ts';
import {assert} from './errors.ts';

/** recipe.yaml, validated against schemas/recipe.schema.json; `name` repeats `id` and `files` is the copy list. */
export interface RecipeSummary extends CatalogMetadata { name: string }
export interface Recipe extends RecipeSummary { content: Record<string,string> }
export interface RecipeAddReport { name: string; output: string; dryRun: boolean; files: string[] }
export interface RecipeSearchResult { query: string; count: number; results: (RecipeSummary & {score: number; matched: string[]})[] }
// This fixed local catalog is trusted package data, never an executable registry:
// names come from here, metadata from each recipe's schema-checked recipe.yaml.
export const recipeNames=['redirect','json-api','typescript','middleware','health-page','static-page','static-plus-api','cors-api','webhook-receiver','contact-form','authenticated-json-api','protected-download','store-crud'] as const;
const recipesRoot=fileURLToPath(new URL('../recipes/',import.meta.url));
const root=(name: string)=>recipesRoot+name+'/';
async function metadata(name: string): Promise<RecipeSummary> {const value=await readMetadata(root(name),name,'recipe.yaml');return {name,...value};}
export async function listRecipes(): Promise<RecipeSummary[]> {
  const result: RecipeSummary[]=[];
  for(const name of recipeNames)result.push(await metadata(name));
  return result;
}
function flatten(hits: SearchHit<RecipeSummary>[]): RecipeSearchResult['results'] {return hits.map(hit=>({...hit.entry,score:hit.score,matched:hit.matched}));}
/** Matches id, description, tags and capabilities locally; no service is consulted. */
export async function searchRecipes(text: string): Promise<RecipeSearchResult> {
  const hits=searchMetadata(await listRecipes(),text);
  return {query:text,count:hits.length,results:flatten(hits)};
}
export async function showRecipe(name: string): Promise<Recipe> {
  assert((recipeNames as readonly string[]).includes(name),'Unknown local recipe');
  const summary=await metadata(name),content: Record<string,string>=Object.create(null) as Record<string,string>;
  for(const path of summary.files)content[path]=(await readAuthoringFile(root(name),path,1048576)).toString('utf8');
  assert(content['urlcode.yaml'],'Recipe must copy urlcode.yaml');
  validateDocument(parseYaml(content['urlcode.yaml']));
  return {...summary,content};
}
export async function addRecipe(name: string,output: string,{dryRun=false}: {dryRun?: boolean|undefined}={}): Promise<RecipeAddReport> {
  const recipe=await showRecipe(name);
  return {name,output:await publishAuthoringProject(output,new Map(Object.entries(recipe.content)),dryRun),dryRun,files:[...recipe.files]};
}
