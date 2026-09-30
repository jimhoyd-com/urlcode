// `urlcode recipes add <name> --project <dir>` (#1014): merges a bundled recipe into an existing project instead of
// creating a new one. Contract: docs/RECIPES.md#adding-a-recipe-to-an-existing-project.
import {lstat,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {Document,YAMLMap,isMap,isScalar,parseDocument} from 'yaml';
import type {Pair} from 'yaml';
import {checkedYamlEdit,configuredRouteCount,snapshot,yamlAppendItem,yamlInsertEntry} from './addon-install.ts';
import {authoringPath} from './authoring-files.ts';
import {loadDocument,parseYaml,validateDocument} from './config.ts';
import {shellWord} from './context.ts';
import {ConfigError,assert} from './errors.ts';
import {seedFile} from './extensions.ts';
import {isCode,isRecord} from './object-guards.ts';
import {auditExpectationFile,readAuditExpectation,readFixtures} from './readiness.ts';
import {showRecipe} from './recipes.ts';

const FIXTURES='tests/requests.json',ENTRY='urlcode.yaml';
/** Files a recipe ships for its own catalog page, not for the project it joins. */
const notMerged=new Set(['README.md']);
/** What one part of the project gained (`added`) or already had exactly (`unchanged`). */
export interface MergeCounts { added: string[]; unchanged: string[] }
export interface RecipeMergeReport {
  name: string;
  /** The project the recipe was merged into, as given. */
  project: string;
  dryRun: boolean;
  routes: MergeCounts;
  includes: MergeCounts;
  /** Per extension, the configuration entries (`collections.bookings`) added or already present. */
  extensions: Record<string,MergeCounts>;
  /** Other top-level entries, such as `site.spa`. */
  settings: MergeCounts;
  files: MergeCounts & { skipped: string[] };
  fixtures: { added: number; unchanged: number };
  seed: MergeCounts;
  /** The committed audit route count, when the project has one. */
  expectRoutes: { file: string; from: number; to: number } | null;
  /** Project-relative files this command wrote (or, with dryRun, would write). */
  written: string[];
  notes: string[];
  next: string[];
}

/** Key-order-insensitive identity, so an entry written in another order is the same entry. */
function canonical(value: unknown): string {
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value!==null&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value)??'null';
}
const same=(a: unknown,b: unknown)=>canonical(a)===canonical(b);
const plainMap=(value: unknown): value is Record<string,unknown>=>isRecord(value)&&!Array.isArray(value);
const counts=(): MergeCounts=>({added:[],unchanged:[]});

/** One `key: value` entry of the recipe's YAML, rendered as block YAML with its own comments. */
function entryBlock(doc: Document,path: readonly string[],key: string): string {
  const map=path.length?doc.getIn(path,true):doc.contents;
  assert(isMap(map),'Recipe YAML entry is not a mapping');
  const index=map.items.findIndex(item=>isScalar(item.key)&&item.key.value===key);
  assert(index>=0,'Recipe YAML entry is missing');
  const pair=(map.items[index] as Pair).clone();
  // The comment above a mapping's first entry belongs to the mapping; it describes that entry, so it travels with it.
  if(index===0&&map.commentBefore&&isScalar(pair.key))pair.key.commentBefore=[map.commentBefore,pair.key.commentBefore].filter(Boolean).join('\n');
  const out=new Document(),single=new YAMLMap();single.items.push(pair);out.contents=single;
  return out.toString({lineWidth:0,flowCollectionPadding:false});
}
function setIn(target: Record<string,unknown>,path: readonly string[],value: unknown): void {
  let at=target;
  for(const key of path.slice(0,-1)){if(!plainMap(at[key]))at[key]={};at=at[key] as Record<string,unknown>;}
  at[path.at(-1)!]=structuredClone(value);
}

/** Refuses a symlink or a non-directory on the way to `rel`; says whether the file exists and which directory must be created. */
async function target(root: string,rel: string): Promise<{path: string; exists: boolean; firstMissing?: string}> {
  authoringPath(rel);
  let path=root,firstMissing: string|undefined;
  const parts=rel.split('/');
  for(const [index,part] of parts.entries()){
    path=join(path,part);
    if(firstMissing)continue;
    try{
      const info=await lstat(path);
      assert(!info.isSymbolicLink(),`Refusing to write ${rel}: it passes through a symlink`);
      if(index<parts.length-1)assert(info.isDirectory(),`Refusing to write ${rel}: ${parts.slice(0,index+1).join('/')} is not a directory`);
      else assert(info.isFile()&&info.nlink===1,`Refusing to write ${rel}: it is not an ordinary file`);
    }catch(error){
      if(!isCode(error,'ENOENT'))throw error;
      if(index<parts.length-1)firstMissing=path;
      else return {path,exists:false};
    }
  }
  return {path,exists:firstMissing===undefined,...(firstMissing===undefined?{}:{firstMissing})};
}
async function readText(file: string): Promise<string> {return (await readFile(file,'utf8'));}
const sameText=(a: string,b: string)=>a.replace(/\r\n/g,'\n')===b.replace(/\r\n/g,'\n');

/** JSON the way the recipes write fixtures: `", "` and `": "` separators on one line. */
function inline(value: unknown): string {
  if(Array.isArray(value))return `[${value.map(inline).join(', ')}]`;
  if(value!==null&&typeof value==='object')return `{${Object.entries(value).map(([key,item])=>`${JSON.stringify(key)}: ${inline(item)}`).join(', ')}}`;
  return JSON.stringify(value);
}
/** One fixture per line; a steps fixture keeps one step per line. */
function renderFixture(fixture: unknown): string {
  if(plainMap(fixture)&&Array.isArray(fixture.steps)&&Object.keys(fixture).length===1)return `  {"steps": [\n${fixture.steps.map(step=>`    ${inline(step)}`).join(',\n')}\n  ]}`;
  return `  ${inline(fixture)}`;
}
/** The project's fixture file with `added` appended after its last fixture, every existing line left alone. */
function appendFixtures(text: string|undefined,existing: unknown[],added: unknown[]): string {
  const rendered=added.map(renderFixture).join(',\n');
  if(text!==undefined&&existing.length){
    const close=text.lastIndexOf(']');
    const candidate=`${text.slice(0,close).trimEnd()},\n${rendered}\n]\n`;
    try{if(same(JSON.parse(candidate),[...existing,...added]))return candidate;}catch{/* rewrite below */}
  }
  return `[\n${[...existing.map(renderFixture),rendered].filter(Boolean).join(',\n')}\n]\n`;
}
/** The request a single-request fixture sends: two fixtures sending it with different expectations contradict each other. */
function requestKey(fixture: unknown): string|undefined {
  if(!plainMap(fixture)||'steps' in fixture)return undefined;
  return canonical({method:typeof fixture.method==='string'?fixture.method.toUpperCase():'GET',path:fixture.path,headers:fixture.headers??{},body:fixture.body??null});
}
/** Seed JSON: an extension per line group, arrays of objects one per line, as the recipes write it. */
function renderSeed(seed: Record<string,unknown>): string {
  const render=(value: unknown,indent: string): string=>{
    if(Array.isArray(value))return value.some(item=>item!==null&&typeof item==='object')?`[\n${value.map(item=>`${indent}  ${inline(item)}`).join(',\n')}\n${indent}]`:inline(value);
    if(plainMap(value)){
      const entries=Object.entries(value);
      if(!entries.length)return '{}';
      return `{\n${entries.map(([key,item])=>`${indent}  ${JSON.stringify(key)}: ${render(item,`${indent}  `)}`).join(',\n')}\n${indent}}`;
    }
    return JSON.stringify(value);
  };
  return `${render(seed,'')}\n`;
}
/**
 * Merges a recipe's seed into the project's: maps key by key, lists of `{id}` objects by id, lists of plain values
 * (membership ids) as a union. A value present in both that differs is a clash.
 */
function mergeSeed(site: unknown,recipe: unknown,path: string,added: string[],unchanged: string[],clashes: string[]): unknown {
  if(site===undefined){added.push(path);return structuredClone(recipe);}
  if(plainMap(site)&&plainMap(recipe)){
    const result: Record<string,unknown>={...site};
    for(const [key,value] of Object.entries(recipe))result[key]=mergeSeed(site[key],value,`${path}.${key}`,added,unchanged,clashes);
    return result;
  }
  if(Array.isArray(site)&&Array.isArray(recipe)){
    const byId=(items: unknown[])=>items.every(item=>plainMap(item)&&typeof item.id==='string');
    const scalar=(items: unknown[])=>items.every(item=>item===null||typeof item!=='object');
    if(byId(site)&&byId(recipe)){
      const result=[...site] as Record<string,unknown>[];
      for(const item of recipe as Record<string,unknown>[]){
        const existing=result.find(entry=>entry.id===item.id),label=`${path}[id=${String(item.id)}]`;
        if(!existing){result.push(structuredClone(item));added.push(label);}
        else if(same(existing,item))unchanged.push(label);
        else clashes.push(`seed ${label} in ${seedFile} differs`);
      }
      return result;
    }
    if(scalar(site)&&scalar(recipe)){
      const result=[...site];
      for(const item of recipe){if(result.some(entry=>same(entry,item)))unchanged.push(`${path}[${String(item)}]`);else{result.push(item);added.push(`${path}[${String(item)}]`);}}
      return result;
    }
  }
  if(same(site,recipe))unchanged.push(path);else clashes.push(`seed ${path} in ${seedFile} differs`);
  return site;
}

/**
 * Merges the bundled recipe `name` into the existing project at `project`: its routes, include files, other files,
 * extension configuration, request fixtures and seed, and the committed audit route count. Any clash with what the
 * project already has refuses the whole merge with every clash named and nothing written; an identical entry is not a
 * clash. Writes are all-or-nothing: a failure restores every file and removes every file and directory it created.
 */
export async function mergeRecipe(name: string,project: string,{dryRun=false}: {dryRun?: boolean|undefined}={}): Promise<RecipeMergeReport> {
  const recipe=await showRecipe(name);
  const loaded=await loadDocument(project,{sources:true});
  const root=await realpath(project);
  const recipeText=recipe.content[ENTRY]!,recipeDoc=parseDocument(recipeText),recipeData=recipeDoc.toJS() as Record<string,unknown>;
  const report: RecipeMergeReport={name,project,dryRun,routes:counts(),includes:counts(),extensions:{},settings:counts(),files:{...counts(),skipped:[]},fixtures:{added:0,unchanged:0},seed:counts(),expectRoutes:null,written:[],notes:[],next:[]};

  // A recipe that needs an extension the project has not added cannot run there; adding one is an operator step.
  const declared=loaded.document.extensions??{},sources=loaded.sources!;
  const missing=Object.keys((recipeData.extensions as Record<string,unknown>|undefined)??{}).filter(extension=>!Object.hasOwn(declared,extension));
  if(missing.length)throw new ConfigError(`${name} needs the ${missing.join(' and ')} extension${missing.length===1?'':'s'}, which ${ENTRY} does not declare. Add ${missing.length===1?'it':'them'} from the site directory first with \`urlcode extensions add ${missing.join(' ')}\`, then add the recipe again. Nothing was changed`,{code:'recipe-needs-extension',extension:missing[0]!});

  const original=await readText(join(root,ENTRY)),reference=parseDocument(original).toJS() as Record<string,unknown>;
  const expected=structuredClone(reference),edits: ((text: string)=>string)[]=[];
  const clashes: string[]=[];
  /** Adds the recipe's entry at `path`/`key` to urlcode.yaml, keeping its comments. */
  const insert=(path: readonly string[],key: string,value: unknown)=>{
    const block=entryBlock(recipeDoc,path,key);
    setIn(expected,[...path,key],value);
    edits.push(text=>yamlInsertEntry(text,path,key,value,block));
  };
  // Raw routes of every project file, so the comparison is of what was written, not the loader's normalized form.
  const siteRoutes=new Map<string,{file: string; config: unknown}>();
  for(const file of [ENTRY,...(loaded.document.includes??[])]){
    const data=file===ENTRY?reference:parseYaml(await readText(join(root,file))) as Record<string,unknown>;
    for(const [pattern,config] of Object.entries((data.routes as Record<string,unknown>|undefined)??{}))siteRoutes.set(pattern,{file,config});
  }

  if(recipeData.version!==reference.version)clashes.push(`version: ${ENTRY} is version ${JSON.stringify(reference.version)}, the recipe ${JSON.stringify(recipeData.version)}`);

  // Extension declarations: every entry of a map-valued configuration key (collections.bookings) is its own unit.
  for(const [extension,declaration] of Object.entries((recipeData.extensions as Record<string,Record<string,unknown>>|undefined)??{})){
    const merged=report.extensions[extension]=counts(),file=sources.extensions[extension]??ENTRY;
    const before=clashes.length,pending=edits.length;
    const raw=((file===ENTRY?reference:parseYaml(await readText(join(root,file))) as Record<string,unknown>).extensions as Record<string,Record<string,unknown>>)[extension]!;
    for(const [key,value] of Object.entries(declaration)){
      const base=['extensions',extension];
      if(key==='config'&&plainMap(value)){
        const config=raw.config;
        if(config===undefined){insert(base,'config',value);merged.added.push('config');continue;}
        if(!plainMap(config)){clashes.push(`extensions.${extension}.config in ${file} is not a mapping`);continue;}
        for(const [section,entries] of Object.entries(value)){
          const current=config[section];
          if(current===undefined){insert([...base,'config'],section,entries);merged.added.push(section);}
          else if(plainMap(current)&&plainMap(entries)){
            for(const [entry,content] of Object.entries(entries)){
              if(!Object.hasOwn(current,entry)){insert([...base,'config',section],entry,content);merged.added.push(`${section}.${entry}`);}
              else if(same(current[entry],content))merged.unchanged.push(`${section}.${entry}`);
              else clashes.push(`extensions.${extension}.config.${section}.${entry} in ${file} differs`);
            }
          }else if(same(current,entries))merged.unchanged.push(section);
          else clashes.push(`extensions.${extension}.config.${section} in ${file} differs`);
        }
      }else if(raw[key]===undefined){insert(base,key,value);merged.added.push(key);}
      else if(same(raw[key],value)){if(key!=='version')merged.unchanged.push(key);}
      else clashes.push(`extensions.${extension}.${key} in ${file} differs`);
    }
    // urlcode.yaml is the only file this command edits in place.
    if(file!==ENTRY&&edits.length>pending&&clashes.length===before){edits.length=pending;clashes.push(`extensions.${extension} is declared in ${file}, which recipes add does not edit; declare it in ${ENTRY} or add ${merged.added.join(', ')} there by hand`);}
  }

  // Other top-level keys (site, shared, schemas, ...): a mapping merges entry by entry, anything else must match.
  for(const [key,value] of Object.entries(recipeData)){
    if(['version','extensions','routes','includes'].includes(key))continue;
    const current=reference[key];
    if(current===undefined){insert([],key,value);report.settings.added.push(key);}
    else if(plainMap(current)&&plainMap(value)){
      for(const [entry,content] of Object.entries(value)){
        if(!Object.hasOwn(current,entry)){insert([key],entry,content);report.settings.added.push(`${key}.${entry}`);}
        else if(same(current[entry],content))report.settings.unchanged.push(`${key}.${entry}`);
        else clashes.push(`${key}.${entry} in ${ENTRY} differs`);
      }
    }else if(same(current,value))report.settings.unchanged.push(key);
    else clashes.push(`${key} in ${ENTRY} differs`);
  }

  // Routes declared inline in the recipe's urlcode.yaml join the project's urlcode.yaml.
  const recipeRoutes=(recipeData.routes as Record<string,unknown>|undefined)??{};
  for(const [pattern,config] of Object.entries(recipeRoutes)){
    const existing=siteRoutes.get(pattern);
    if(!existing){insert(['routes'],pattern,config);report.routes.added.push(pattern);}
    else if(same(existing.config,config))report.routes.unchanged.push(pattern);
    else clashes.push(`route ${pattern} in ${existing.file} differs`);
  }

  // Include files: an identical copy (the routes/auth.yaml `extensions add auth` wrote) is the same file.
  const writes=new Map<string,string>();
  const siteIncludes=new Set(loaded.document.includes??[]);
  for(const include of (recipeData.includes as string[]|undefined)??[]){
    const text=recipe.content[include];
    assert(text!==undefined,`Recipe ${name} includes ${include} but does not ship it`);
    const data=parseYaml(text) as Record<string,unknown>,place=await target(root,include);
    const includeRoutes=Object.entries((data.routes as Record<string,unknown>|undefined)??{});
    if(place.exists){
      if(!same(parseYaml(await readText(place.path)),data)){clashes.push(`include ${include} differs from the recipe's`);continue;}
      report.includes.unchanged.push(include);
      if(siteIncludes.has(include)){for(const [pattern] of includeRoutes)report.routes.unchanged.push(pattern);continue;}
    }else writes.set(include,text);
    for(const [pattern] of includeRoutes){
      const existing=siteRoutes.get(pattern);
      if(existing)clashes.push(`route ${pattern} (in the recipe's ${include}) is already declared in ${existing.file}`);
      else if(Object.hasOwn(recipeRoutes,pattern))clashes.push(`route ${pattern} is declared twice by the recipe`);
      else report.routes.added.push(pattern);
    }
    const includes=(expected.includes as string[]|undefined)??[];
    expected.includes=[...includes,include];
    edits.push(text=>yamlAppendItem(text,['includes'],include));
    if(!place.exists)report.includes.added.push(include);
  }

  // Every other file the recipe ships (functions, pages, static files) is copied unless the project has it already.
  const special=new Set([ENTRY,FIXTURES,seedFile,...((recipeData.includes as string[]|undefined)??[])]);
  for(const file of recipe.files){
    if(special.has(file))continue;
    if(notMerged.has(file)){report.files.skipped.push(file);continue;}
    const place=await target(root,file),text=recipe.content[file]!;
    if(!place.exists){writes.set(file,text);report.files.added.push(file);}
    else if(sameText(await readText(place.path),text))report.files.unchanged.push(file);
    else clashes.push(`file ${file} differs from the recipe's`);
  }

  // Request fixtures carry no id: an identical fixture is the same one, and the same request expecting something else is a clash.
  const recipeFixtures=recipe.content[FIXTURES]===undefined?[]:JSON.parse(recipe.content[FIXTURES]) as unknown[];
  const fixturePlace=await target(root,FIXTURES);
  const siteFixtureText=fixturePlace.exists?await readText(fixturePlace.path):undefined;
  const siteFixtures: unknown[]=fixturePlace.exists?await readFixtures(root,true):[];
  const addedFixtures: unknown[]=[];
  for(const fixture of recipeFixtures){
    if(siteFixtures.some(existing=>same(existing,fixture))){report.fixtures.unchanged++;continue;}
    const key=requestKey(fixture),other=key===undefined?undefined:siteFixtures.find(existing=>requestKey(existing)===key);
    if(other&&plainMap(fixture)){clashes.push(`fixture ${typeof fixture.method==='string'?fixture.method.toUpperCase():'GET'} ${String(fixture.path)} in ${FIXTURES} expects something else`);continue;}
    addedFixtures.push(fixture);report.fixtures.added++;
  }
  assert(siteFixtures.length+addedFixtures.length<=10000,`${FIXTURES} would hold more than 10000 fixtures`);
  if(addedFixtures.length)writes.set(FIXTURES,appendFixtures(siteFixtureText,siteFixtures,addedFixtures));

  // The test seed: accounts by id, membership lists as a union.
  if(recipe.content[seedFile]!==undefined){
    const recipeSeed=JSON.parse(recipe.content[seedFile]) as Record<string,unknown>;
    const seedPlace=await target(root,seedFile);
    if(!seedPlace.exists){writes.set(seedFile,recipe.content[seedFile]);report.seed.added.push(...Object.keys(recipeSeed));}
    else{
      let current: unknown;
      try{current=JSON.parse(await readText(seedPlace.path));}catch{throw new ConfigError(`${seedFile} is not valid JSON`,{code:'invalid-seed',file:seedFile});}
      assert(plainMap(current),`${seedFile} must be an object keyed by extension name`);
      const merged: Record<string,unknown>={...current};
      for(const [extension,value] of Object.entries(recipeSeed))merged[extension]=mergeSeed(current[extension],value,extension,report.seed.added,report.seed.unchanged,clashes);
      if(report.seed.added.length)writes.set(seedFile,renderSeed(merged));
    }
  }

  if(clashes.length)throw new ConfigError(`Refusing to add ${name} to the project: ${clashes.length===1?'one entry clashes':`${clashes.length} entries clash`} with what the project already has, and nothing was changed.\n${clashes.map(clash=>`- ${clash}`).join('\n')}\nRename or remove the project's entry, or merge by hand from \`urlcode recipes show ${name}\`.`,{code:'recipe-clash'});

  let yamlText: string|undefined;
  if(edits.length){
    validateDocument(structuredClone(expected));
    yamlText=checkedYamlEdit(original,expected,edits,()=>`${ENTRY} is laid out in a way recipes add cannot edit in place without rewriting the rest of the file; copy the recipe's entries by hand from \`urlcode recipes show ${name}\`. Nothing was changed`);
    writes.set(ENTRY,yamlText);
  }
  for(const [file,text] of writes)if(file!==ENTRY&&/\.ya?ml$/.test(file)&&special.has(file))validateDocument(parseYaml(text));

  const newRoutes=report.routes.added.length;
  let expectedRoutes: number|undefined;
  try{expectedRoutes=await readAuditExpectation(root);}catch(error){if(!(error instanceof ConfigError))throw error;report.notes.push(`${auditExpectationFile} is not one the audit reads, so its route count was left alone`);}
  report.written=[...writes.keys()].sort((a,b)=>a===ENTRY?1:b===ENTRY?-1:a.localeCompare(b));
  if(expectedRoutes!==undefined&&newRoutes)report.written.push(auditExpectationFile);
  for(const input of recipe.inputs??[])report.notes.push(`Review ${input.name} (${input.file}): ${input.description}`);
  if(report.files.skipped.length)report.notes.push(`The recipe's ${report.files.skipped.join(', ')} was not copied; \`urlcode recipes show ${name}\` prints it`);
  const host=join(dirname(project),'host.mjs');
  let hasHost=false;try{hasHost=(await lstat(host)).isFile();}catch{/* no operator host beside the project */}
  const flags=`--project ${shellWord(project)}${hasHost?` --host-file ${shellWord(host)} --local-review`:''}`;
  report.next=[`urlcode validate --local ${flags}`,`urlcode test ${flags}`,`urlcode audit ${flags}`];
  if(dryRun){
    if(expectedRoutes!==undefined&&newRoutes)report.expectRoutes={file:auditExpectationFile,from:expectedRoutes,to:expectedRoutes+newRoutes};
    return report;
  }
  if(!writes.size){report.written=[];return report;}

  // All or nothing: dependencies first, urlcode.yaml last, then the audit count from the project as loaded.
  const routesBefore=await configuredRouteCount(root);
  const auditFile=join(root,...auditExpectationFile.split('/'));
  const places=new Map<string,Awaited<ReturnType<typeof target>>>();
  for(const file of writes.keys())places.set(file,await target(root,file));
  const state=await snapshot([...[...places.values()].map(place=>place.path),auditFile]);
  const createdDirectories: string[]=[];
  try{
    for(const file of report.written.filter(file=>writes.has(file))){
      const place=places.get(file)!;
      if(place.firstMissing&&!createdDirectories.includes(place.firstMissing)){await mkdir(place.firstMissing,{recursive:true,mode:0o755});createdDirectories.push(place.firstMissing);}
      else await mkdir(dirname(place.path),{recursive:true,mode:0o755});
      if(!place.exists)state.created.push(place.path);
      await writeFile(place.path,writes.get(file)!);
    }
    await loadDocument(root);
    await readFixtures(root,true);
    const routesAfter=await configuredRouteCount(root);
    if(expectedRoutes!==undefined&&routesAfter!==routesBefore){
      const to=Math.max(0,expectedRoutes+routesAfter-routesBefore);
      await writeFile(auditFile,`${JSON.stringify({expectRoutes:to},null,2)}\n`);
      report.expectRoutes={file:auditExpectationFile,from:expectedRoutes,to};
    }else report.written=report.written.filter(file=>file!==auditExpectationFile);
    return report;
  }catch(error){
    await state.restore();
    for(const directory of createdDirectories.reverse())await rm(directory,{recursive:true,force:true});
    throw error;
  }
}
