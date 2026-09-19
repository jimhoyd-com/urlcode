import {readdirSync,readFileSync,statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parse} from 'yaml';
import {capabilityDetails,capabilityNames,capabilityTargets,formatCapabilities,getCapabilities,routeCapabilities} from './capabilities.ts';
import type {CapabilityDecision,CapabilityDetail,CapabilityName,CapabilityTarget} from './capabilities.ts';
import {ConfigError} from './errors.ts';
import {getSchemaFragment} from './schema-query.ts';
import type {SchemaFragment} from './schema-query.ts';
import type {ProjectDocument,RouteConfig} from './types.ts';

export interface CapabilityUsage {file:string;routes:string[]}
export interface CapabilityEntry extends CapabilityDetail {
  format:1;name:CapabilityName;
  schemaFragments:SchemaFragment[];
  targets:Record<CapabilityTarget,CapabilityDecision>;
  refused:{target:CapabilityTarget;reason:string}[];
  recipes:CapabilityUsage[];
  cookbook:CapabilityUsage[];
}
const root=(...parts:string[])=>fileURLToPath(new URL('../'+parts.join('/'),import.meta.url));
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function yamlFiles(directory:string):string[] {
  const out:string[]=[];
  for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
    if(entry.name.startsWith('.')||entry.name==='node_modules')continue;
    const file=directory+'/'+entry.name;
    if(entry.isDirectory())out.push(...yamlFiles(file));else if(/\.ya?ml$/.test(entry.name))out.push(file);
  }
  return out;
}
/** Bundled examples are fixed package content; they are read as data and never validated or activated here. */
function usage(base:string,files:string[],name:CapabilityName):CapabilityUsage[] {
  const result:CapabilityUsage[]=[];
  for(const file of files) {
    let document:unknown;try{document=parse(readFileSync(file,'utf8'));}catch{continue;}
    if(!object(document))continue;
    const routes:string[]=[];
    if(name==='extension'&&object(document.extensions)&&Object.keys(document.extensions).length)routes.push('(project)');
    for(const [path,route] of Object.entries(object(document.routes)?document.routes:{})) {
      if(!object(route))continue;
      try{if(routeCapabilities(route as RouteConfig,document as unknown as ProjectDocument).includes(name))routes.push(path);}catch{/* unparsable example route: not a use */}
    }
    if(routes.length)result.push({file:file.slice(base.length+1),routes});
  }
  return result;
}
export function capabilityNameList():readonly CapabilityName[] {return capabilityNames;}
/** One catalog entry with its schema fragments and bundled usage. No project, credentials or network are read. */
export function getCapability(name:string):CapabilityEntry {
  if(typeof name!=='string'||!(capabilityNames as readonly string[]).includes(name))throw new ConfigError('Unknown capability; valid names: '+capabilityNames.join(', '));
  const capability=name as CapabilityName,detail=capabilityDetails[capability];
  const catalog=getCapabilities();
  const targets=Object.fromEntries(capabilityTargets.map(target=>[target,catalog.capabilities.find(row=>row.capability===capability)!.targets[target]!])) as Record<CapabilityTarget,CapabilityDecision>;
  const refused=capabilityTargets.flatMap(target=>targets[target].support==='refused'?[{target,reason:targets[target].reason}]:[]);
  const recipesRoot=root('recipes'),cookbookRoot=root('examples','cookbook');
  const recipes=usage(recipesRoot,readdirSync(recipesRoot,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>recipesRoot+'/'+entry.name+'/urlcode.yaml').filter(file=>{try{return statSync(file).isFile();}catch{return false;}}),capability);
  const cookbook=usage(cookbookRoot,yamlFiles(cookbookRoot),capability);
  return {format:1,name:capability,...detail,schemaFragments:detail.schema.map(getSchemaFragment),targets,refused,recipes,cookbook};
}
export function formatCapability(entry:CapabilityEntry):string {
  const list=(items:string[])=>items.length?items.map(item=>'  - '+item):['  (none)'];
  const usageLines=(items:CapabilityUsage[])=>items.length?items.map(item=>`  - ${item.file}: ${item.routes.join(', ')}`):['  (none)'];
  return [`${entry.name} (${entry.kind})`,entry.summary,'','Schema: '+entry.schema.join(', ')+'  (urlcode schema <path>)',
    ...entry.schemaFragments.map(fragment=>`  ${fragment.pointer}\n`+JSON.stringify(fragment.schema,null,2).split('\n').map(line=>'    '+line).join('\n')),
    '','Constraints:',...list(entry.constraints),'','Required grants:',...list(entry.grants),'','Targets:',
    ...capabilityTargets.map(target=>`  ${target.padEnd(12)}${entry.targets[target].support.padEnd(12)}${entry.targets[target].reason}`),
    '','Unsupported:',...(entry.refused.length?entry.refused.map(item=>`  - ${item.target}: ${item.reason}`):['  (none)']),
    '','Recipes:',...usageLines(entry.recipes),'','Cookbook routes:',...usageLines(entry.cookbook),
    '','Provider deployments: unverified; see docs/CAPABILITIES.md.',''].join('\n');
}
export {formatCapabilities};
