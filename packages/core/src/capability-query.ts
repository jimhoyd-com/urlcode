import {docsUrl} from './release.ts';
import {readdirSync,readFileSync,statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {capabilityDetails,capabilityNames,capabilityTargets,formatCapabilities,getCapabilities,routeCapabilities} from './capabilities.ts';
import type {CapabilityDecision,CapabilityDetail,CapabilityName,CapabilityTarget} from './capabilities.ts';
import {ConfigError} from './errors.ts';
import {parseYaml} from './config.ts';
import {getSchemaFragment} from './schema-query.ts';
import type {SchemaFragment} from './schema-query.ts';
import {isRecord as object} from './object-guards.ts';
import type {ProjectDocument,RouteConfig} from './types.ts';

export interface CapabilityUsage {file:string;routes:string[]}
export interface CapabilityEntry extends CapabilityDetail {
  format:1;name:CapabilityName;
  schemaFragments:SchemaFragment[];
  targets:Record<CapabilityTarget,CapabilityDecision>;
  refused:{target:CapabilityTarget;reason:string}[];
  recipes:CapabilityUsage[];
  cookbook:CapabilityUsage[];
  /** A paired route and handler module read verbatim from bundled example files (#1106); only on handlers that run project code. */
  example?:HandlerExample;
}
export interface HandlerExample {
  /** Package-relative example project root; `file` and `module.file` are relative to it. */
  project:string;file:string;route:string;
  /** The route's lines exactly as the example file has them, under `routes:`. */
  yaml:string;
  module:{file:string;export:string;source:string};
  /** How the declared values reach the handler, and how to get the whole runnable example. */
  contract:string;
}
/** Upper bound on the serialized example, so capability discovery stays a bounded answer. */
export const handlerExampleMaxBytes=2048;
/** The one authoritative example per code-running capability: a route in a runnable, fixture-tested bundled example. */
const handlerExamples:Partial<Record<CapabilityName,{project:string;file:string;route:string;contract:string}>>={
  function:{project:'examples/cookbook',file:'routes/code.yaml',route:'/hello/{name}',
    contract:'The module exports `(request, context)` returning a Response: the default export, or the one `function.export` names. '
      +'`context.args` holds the declared `args` (literals, `{from}` inputs, `{env}` and `{secret}` bindings); '
      +'`context.inputs.path/query/header`, `context.env`, `context.secrets` (operator-granted values, never in the project) and `context.requestId` are also there. '
      +'Paths are relative to the example project; `urlcode examples add cookbook --out cookbook` copies it whole.'},
};
const root=(...parts:string[])=>fileURLToPath(new URL('../../../'+parts.join('/'),import.meta.url));
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
    let document:unknown;try{document=parseYaml(readFileSync(file,'utf8'));}catch{continue;}
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
/** The route's own lines from the example file, so comments and ordering are the canonical file's, not a re-serialization. */
function routeLines(text:string,route:string):string|undefined {
  const lines=text.split('\n'),start=lines.findIndex(line=>/^ {2}\S/.test(line)&&line.trim().replace(/^(['"])(.*)\1:$/,'$2:')===route+':');
  if(start<0)return undefined;
  let end=start+1;
  while(end<lines.length&&(lines[end]!.trim()===''||/^ {3,}/.test(lines[end]!)))end++;
  while(end>start+1&&lines[end-1]!.trim()==='')end--;
  return ['routes:',...lines.slice(start,end)].join('\n')+'\n';
}
/** Read as fixed package data; a missing or oversized example is a packaging defect, so it throws rather than degrading silently. */
function handlerExample(name:CapabilityName):HandlerExample|undefined {
  const pointer=handlerExamples[name];
  if(!pointer)return undefined;
  const text=readFileSync(root(pointer.project,pointer.file),'utf8');
  const document=parseYaml(text),route=object(document)&&object(document.routes)?document.routes[pointer.route]:undefined;
  const handler=object(route)?route[name]:undefined;
  const source=typeof handler==='string'?handler:object(handler)&&typeof handler.source==='string'?handler.source:undefined;
  const yaml=routeLines(text,pointer.route);
  if(source===undefined||yaml===undefined)throw new Error(`${pointer.project}/${pointer.file} no longer declares ${pointer.route} with a ${name} source`);
  const exported=object(handler)&&typeof handler.export==='string'?handler.export:'default';
  const example:HandlerExample={project:pointer.project,file:pointer.file,route:pointer.route,yaml,
    module:{file:source,export:exported,source:readFileSync(root(pointer.project,source),'utf8')},contract:pointer.contract};
  if(Buffer.byteLength(JSON.stringify(example))>handlerExampleMaxBytes)throw new Error(`${name} example exceeds ${handlerExampleMaxBytes} bytes`);
  return example;
}
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
  const example=handlerExample(capability);
  return {format:1,name:capability,...detail,schemaFragments:detail.schema.map(getSchemaFragment),targets,refused,recipes,cookbook,...(example?{example}:{})};
}
export function formatCapability(entry:CapabilityEntry):string {
  const list=(items:string[])=>items.length?items.map(item=>'  - '+item):['  (none)'];
  const indent=(text:string)=>text.replace(/\n$/,'').split('\n').map(line=>line?'    '+line:'');
  const usageLines=(items:CapabilityUsage[])=>items.length?items.map(item=>`  - ${item.file}: ${item.routes.join(', ')}`):['  (none)'];
  return [`${entry.name} (${entry.kind})`,entry.summary,'','Schema: '+entry.schema.join(', ')+'  (urlcode schema <path>)',
    ...entry.schemaFragments.map(fragment=>`  ${fragment.pointer}\n`+JSON.stringify(fragment.schema,null,2).split('\n').map(line=>'    '+line).join('\n')),
    '','Constraints:',...list(entry.constraints),'','Required grants:',...list(entry.grants),'','Targets:',
    ...capabilityTargets.map(target=>`  ${target.padEnd(12)}${entry.targets[target].support.padEnd(12)}${entry.targets[target].reason}`),
    '','Unsupported:',...(entry.refused.length?entry.refused.map(item=>`  - ${item.target}: ${item.reason}`):['  (none)']),
    ...(entry.example?['',`Example (${entry.example.project}/${entry.example.file}, ${entry.example.route}):`,...indent(entry.example.yaml),
      `  ${entry.example.module.file} (export: ${entry.example.module.export}):`,...indent(entry.example.module.source),'  '+entry.example.contract]:[]),
    '','Recipes:',...usageLines(entry.recipes),'','Cookbook routes:',...usageLines(entry.cookbook),
    '',`Provider deployments: unverified; see ${docsUrl('CAPABILITIES.md')}.`,''].join('\n');
}
export {formatCapabilities};
