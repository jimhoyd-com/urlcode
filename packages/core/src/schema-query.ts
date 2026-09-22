import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {ConfigError} from './errors.ts';
import {isRecord as object} from './object-guards.ts';

type Json=Record<string,unknown>;
export interface SchemaFragment {format:1;path:string;pointer:string;schema:Json}
const maxDepth=12;
let cached:Json|undefined;
function schema():Json {
  cached??=JSON.parse(readFileSync(fileURLToPath(new URL('../../../schemas/urlcode.schema.json',import.meta.url)),'utf8')) as Json;
  return cached;
}
const properties=(node:Json):Json=>object(node.properties)?node.properties:{};
function definition(root:Json,ref:string):Json {
  const defs=object(root.$defs)?root.$defs:{};
  const name=ref.startsWith('#/$defs/')?ref.slice('#/$defs/'.length):undefined;
  const found=name===undefined?undefined:defs[name];
  if(!object(found))throw new ConfigError('Schema reference cannot be resolved');
  return found;
}
/** Definitions that are their own dotted path stay summarized when nested, so `routes` does not inline the whole route object. */
const summarized:Record<string,string>={'#/$defs/route':'route','#/$defs/policies':'policies'};
/** Inline every local `$ref` with a depth bound and a cycle guard. The bundled schema has no cycles; a cycle would surface as an annotation, not a crash. */
function inline(root:Json,node:unknown,stack:readonly string[]):unknown {
  if(Array.isArray(node))return node.map(item=>inline(root,item,stack));
  if(!object(node))return node;
  if(typeof node.$ref==='string') {
    const {$ref,...rest}=node;
    if(stack.includes($ref)||stack.length>=maxDepth)return {...rest,$comment:`unresolved reference ${$ref}: ${stack.includes($ref)?'cycle':'depth limit'}`};
    const path=summarized[$ref];
    if(path!==undefined)return {type:'object',...rest,$comment:`${path} object; see urlcode schema ${path}`};
    return {...inline(root,definition(root,$ref),[...stack,$ref]) as Json,...inline(root,rest,stack) as Json};
  }
  return Object.fromEntries(Object.entries(node).map(([key,value])=>[key,inline(root,value,stack)]));
}
const resolved=(root:Json,node:Json):Json=>typeof node.$ref==='string'?{...definition(root,node.$ref),...Object.fromEntries(Object.entries(node).filter(([key])=>key!=='$ref'))}:node;
/** Top-level document keys first, then `route` itself and every route property (`redirect`, `function`, `middleware`, ...). */
export function schemaPathNames():string[] {
  const root=schema();
  const route=definition(root,'#/$defs/route');
  return [...new Set([...Object.keys(properties(root)),'route',...Object.keys(properties(route))])];
}
/** Only the fragment for a dotted path, with references resolved inline. No validation, defaults or authority. */
export function getSchemaFragment(path:string):SchemaFragment {
  if(typeof path!=='string'||path.length>256||!/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(path))throw new ConfigError('Schema path must be dotted property names; top-level names: '+schemaPathNames().join(', '));
  const root=schema(),route=definition(root,'#/$defs/route');
  const [first,...rest]=path.split('.');
  let node:Json,pointer:string;
  if(first!==undefined&&object(properties(root)[first])){node=properties(root)[first] as Json;pointer='#/properties/'+first;}
  else if(first==='route'){node=route;pointer='#/$defs/route';}
  else if(first!==undefined&&object(properties(route)[first])){node=properties(route)[first] as Json;pointer='#/$defs/route/properties/'+first;}
  else throw new ConfigError(`Unknown schema path; top-level names: ${schemaPathNames().join(', ')}`);
  for(const segment of rest) {
    const current=resolved(root,node);
    const alternatives=[current,...(Array.isArray(current.oneOf)?current.oneOf.filter(object).map(item=>resolved(root,item)):[])];
    const next=alternatives.map(item=>properties(item)[segment]).find(object);
    if(!next)throw new ConfigError(`Unknown schema path segment; names under ${pointer}: ${[...new Set(alternatives.flatMap(item=>Object.keys(properties(item))))].join(', ')||'(none)'}`);
    node=next;pointer+='/properties/'+segment;
  }
  return {format:1,path,pointer,schema:inline(root,resolved(root,node),[]) as Json};
}
