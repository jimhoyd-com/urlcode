import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import {loadDocument,parseYaml} from './config.ts';
import {applySite} from './site.ts';
import {analyzeProjectCapabilities,capabilityTargets} from './capabilities.ts';
import type {CapabilityName,CapabilityTarget} from './capabilities.ts';
import {readAuthoringFile,authoringPath} from './authoring-files.ts';
import {assert} from './errors.ts';

/**
 * The metadata shape shared by recipes/NAME/recipe.yaml and examples/NAME/example.yaml
 * (schemas/recipe.schema.json). The catalog entries are fixed package data: names
 * come from a list in code, never from a directory scan, a registry or an argument.
 */
export type TargetVerdict='compatible'|'conditional'|'refused'|'unknown';
export type Complexity='starter'|'intermediate'|'advanced';
export interface CatalogMetadata {
  id: string; description: string; tags: string[]; complexity: Complexity; runnable?: boolean;
  capabilities?: string[]; targets?: Record<CapabilityTarget,TargetVerdict>; routes?: number;
  services?: {name: string; description: string}[]; grants?: {kind: string; description: string}[];
  inputs?: {name: string; file: string; description: string}[]; files: string[];
  tests?: {fixtures?: string; commands: string[]}; behavior?: string[];
}
/** The fields the capability preflight determines; `npm run check` refuses hand-written values that differ. */
export interface DerivedMetadata { capabilities: CapabilityName[]; targets: Record<CapabilityTarget,TargetVerdict>; routes: number }
export interface SearchHit<T extends CatalogMetadata> { entry: T; score: number; matched: string[] }

const schemaFile=fileURLToPath(new URL('../schemas/recipe.schema.json',import.meta.url));
type Validator=((value: unknown)=>boolean)&{errors?: {instancePath: string; message?: string}[]|null};
let validator: Validator|undefined;
async function validate(): Promise<Validator> {
  if(!validator){
    const schema: unknown=JSON.parse(await readFile(schemaFile,'utf8'));
    validator=new Ajv.default({allErrors:false,strict:true,strictRequired:false}).compile(schema as object) as Validator;
  }
  return validator;
}
/** Reads and schema-validates one metadata file; the id must equal the directory name, and file lists stay authoring-safe paths. */
export async function readMetadata(root: string,id: string,file: 'recipe.yaml'|'example.yaml'): Promise<CatalogMetadata> {
  const text=(await readAuthoringFile(root,file,65536)).toString('utf8');
  const value: unknown=parseYaml(text),valid=await validate();
  const first=valid(value)?undefined:valid.errors?.[0];
  assert(!first,`${id}/${file} does not match schemas/recipe.schema.json: ${first?.instancePath||'/'} ${first?.message??''}`);
  const metadata=value as CatalogMetadata;
  assert(metadata.id===id,`${id}/${file} declares id ${metadata.id}`);
  for(const path of metadata.files){try{authoringPath(path);}catch{assert(false,`${id}/${file} lists ${path}, which is not an authoring-safe path`);}}
  return metadata;
}
const strength: Record<TargetVerdict,number>={compatible:0,conditional:1,unknown:2,refused:3};
/** Preflight only: loads the project, expands site routes and asks the capability analysis for every target. No bindings, code or activation. */
export async function deriveMetadata(root: string): Promise<DerivedMetadata> {
  const loaded=await loadDocument(root);await applySite(loaded,{});
  const capabilities=new Set<CapabilityName>();
  const targets={} as Record<CapabilityTarget,TargetVerdict>;
  for(const target of capabilityTargets){
    const report=analyzeProjectCapabilities(loaded,target);
    let verdict: TargetVerdict='compatible';
    for(const issue of report.issues){const support=issue.support as TargetVerdict;if(strength[support]>strength[verdict])verdict=support;}
    targets[target]=verdict;
    if(target==='self-hosted')for(const requirement of report.requirements)capabilities.add(requirement.capability);
  }
  return {capabilities:[...capabilities].sort(),targets,routes:Object.keys(loaded.routes).length};
}
/** Reports where hand-written derived fields disagree with the preflight; empty means consistent. */
export function derivedDifferences(metadata: CatalogMetadata,derived: DerivedMetadata): string[] {
  const problems: string[]=[];
  const same=(a: unknown,b: unknown)=>JSON.stringify(a)===JSON.stringify(b);
  if(!same(metadata.capabilities??[],derived.capabilities))problems.push(`capabilities should be [${derived.capabilities.join(', ')}]`);
  for(const target of capabilityTargets)if(metadata.targets?.[target]!==derived.targets[target])problems.push(`targets.${target} should be ${derived.targets[target]}`);
  if(metadata.routes!==derived.routes)problems.push(`routes should be ${derived.routes}`);
  return problems;
}
const stopWords=new Set(['a','an','and','the','with','for','to','of','in','on','that','my','i','want','need']);
export function searchTerms(text: string): string[] {
  assert(typeof text==='string' && text.length<=256,'Search text must be at most 256 characters');
  const words=text.toLowerCase().split(/[^a-z0-9.-]+/).filter(Boolean);
  const terms=[...new Set(words.filter(word=>!stopWords.has(word)||words.length===1))];
  assert(terms.length>0 && terms.length<=16,'Provide one to sixteen search words');
  return terms;
}
/**
 * Local search over id, description, tags and capabilities: every term must match
 * somewhere; the score prefers whole-tag and id hits over description substrings.
 * Ties keep catalog order, so the smallest entry wins when a caller sorts by size first.
 */
export function searchMetadata<T extends CatalogMetadata>(entries: readonly T[],text: string,extraText: (entry: T)=>string[]=()=>[]): SearchHit<T>[] {
  const terms=searchTerms(text),hits: SearchHit<T>[]=[];
  for(const entry of entries){
    const tags=entry.tags.map(tag=>tag.toLowerCase()),capabilities=(entry.capabilities??[]).map(name=>name.toLowerCase());
    const id=entry.id.toLowerCase(),description=entry.description.toLowerCase(),extra=extraText(entry).map(value=>value.toLowerCase());
    let score=0;const matched: string[]=[];
    for(const term of terms){
      let best=0;
      if(id===term || tags.includes(term) || capabilities.includes(term))best=4;
      else if(id.includes(term) || tags.some(tag=>tag.includes(term)) || capabilities.some(name=>name.includes(term)))best=2;
      else if(description.includes(term) || extra.some(value=>value.includes(term)))best=1;
      if(best===0){score=0;break;}
      score+=best;matched.push(term);
    }
    if(score>0)hits.push({entry,score,matched});
  }
  return hits.sort((a,b)=>b.score-a.score);
}
