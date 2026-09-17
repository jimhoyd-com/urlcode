import {fileURLToPath} from 'node:url';
import {readAuthoringFile,publishAuthoringProject} from './authoring-files.ts';
import {validateDocument,parseYaml} from './config.ts';
import {assert} from './errors.ts';

export interface RecipeSummary { name: string; description: string; files: string[] }
export interface Recipe extends RecipeSummary { content: Record<string,string> }
export interface RecipeAddReport { name: string; output: string; dryRun: boolean; files: string[] }
// This fixed local catalog is trusted package data, never an executable registry.
const catalog: RecipeSummary[]=[
  {name:'redirect',description:'Permanent redirect with explicit query passthrough.',files:['urlcode.yaml','README.md']},
  {name:'json-api',description:'Validated JSON request and a sandboxed JavaScript response.',files:['urlcode.yaml','functions/echo.mjs','README.md']},
  {name:'typescript',description:'Typed guest function compiled ahead of the QuickJS runtime.',files:['urlcode.yaml','functions/hello.ts','README.md']},
];
export function listRecipes(): RecipeSummary[] {return catalog.map(recipe=>({...recipe,files:[...recipe.files]}));}
export async function showRecipe(name: string): Promise<Recipe> {
  const recipe=catalog.find(value=>value.name===name);assert(recipe,'Unknown local recipe');
  const root=fileURLToPath(new URL('../recipes/'+recipe.name+'/',import.meta.url)),content: Record<string,string>=Object.create(null) as Record<string,string>;
  for(const path of recipe.files)content[path]=(await readAuthoringFile(root,path,1048576)).toString('utf8');
  validateDocument(parseYaml(content['urlcode.yaml']!));
  return {...recipe,files:[...recipe.files],content};
}
export async function addRecipe(name: string,output: string,{dryRun=false}: {dryRun?: boolean|undefined}={}): Promise<RecipeAddReport> {
  const recipe=await showRecipe(name);
  return {name,output:await publishAuthoringProject(output,new Map(Object.entries(recipe.content)),dryRun),dryRun,files:recipe.files};
}
