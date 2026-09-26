import {readFile,writeFile} from 'node:fs/promises';
// The subset of JSON Schema the bundled schema uses; every field is read defensively.
interface SchemaNode {
  $ref?: string; $defs?: Record<string, SchemaNode>; type?: string | string[]; const?: unknown; enum?: unknown[]; oneOf?: SchemaNode[];
  properties?: Record<string, SchemaNode>; required?: string[]; items?: SchemaNode; additionalProperties?: boolean | SchemaNode;
  description?: string;
  [constraint: string]: unknown;
}
interface Row { path: string; kind: string; required: boolean; rules: string; description: string }
// JSON boundary: the bundled schema is trusted and validated in test/.
const schema=JSON.parse(await readFile(new URL('../schemas/urlcode.schema.json',import.meta.url),'utf8')) as SchemaNode;

// Every property the schema declares must say what it does for a request or a
// project (#750): editors show the description on hover, schema-query and the
// generated table below print it, and a key without one leaves authors to guess.
// Walk every subschema keyword, so properties inside $defs, patternProperties
// values, array items and oneOf branches are covered too. Pointers are RFC 6901.
const MAP_KEYWORDS=['properties','patternProperties','$defs'],ONE_KEYWORDS=['items','additionalProperties','not','if','then','else','contains','propertyNames','unevaluatedProperties','unevaluatedItems'],LIST_KEYWORDS=['oneOf','anyOf','allOf','prefixItems'];
function undescribed(node: unknown,pointer: string,missing: string[]): string[] {
  if(!node || typeof node!=='object' || Array.isArray(node))return missing;
  const record=node as Record<string,unknown>;
  for(const keyword of MAP_KEYWORDS){
    const map=record[keyword];
    if(!map || typeof map!=='object')continue;
    for(const [name,child] of Object.entries(map as Record<string,unknown>)){
      const at=`${pointer}/${keyword}/${name.replaceAll('~','~0').replaceAll('/','~1')}`;
      const description=(child as SchemaNode | undefined)?.description;
      if(keyword!=='$defs' && (typeof description!=='string' || !description.trim()))missing.push(at);
      undescribed(child,at,missing);
    }
  }
  for(const keyword of ONE_KEYWORDS)undescribed(record[keyword],`${pointer}/${keyword}`,missing);
  for(const keyword of LIST_KEYWORDS){
    const list=record[keyword];
    if(Array.isArray(list))for(const [index,child] of list.entries())undescribed(child,`${pointer}/${keyword}/${index}`,missing);
  }
  return missing;
}
const missingDescriptions=undescribed(schema,'',[]);
if(missingDescriptions.length)throw new Error(`${missingDescriptions.length} schema propert${missingDescriptions.length===1?'y has':'ies have'} no description in schemas/urlcode.schema.json; give each one a sentence saying what it does:\n${missingDescriptions.map(pointer=>`  ${pointer}`).join('\n')}`);
const rows: Row[]=[];
function visit(node: SchemaNode,path: string,required=false): void {
  if(node.$ref){const resolved=schema.$defs?.[node.$ref.split('/').at(-1) ?? ''];if(!resolved)throw new Error(`unresolved $ref ${node.$ref}`);const description=node.description ?? resolved.description;node=description===undefined?resolved:{...resolved,description};}
  const kinds=node.type || (node.const!==undefined?'constant':node.enum?[...new Set(node.enum.map(v=>typeof v))].join(' / '):node.oneOf?'one of the shapes below':'any JSON value');
  const rules: string[]=[];
  for(const key of ['const','enum','default','minimum','maximum','minLength','maxLength','minItems','maxItems','minProperties','maxProperties','pattern','uniqueItems'])if(node[key]!==undefined)rules.push(`${key}: ${JSON.stringify(node[key])}`);
  if(node.additionalProperties===false)rules.push('unknown keys rejected');
  if(path)rows.push({path,kind:Array.isArray(kinds)?kinds.join(' / '):kinds,required,rules:rules.join('; ').replaceAll('|','\\|') || '—',description:(node.description || '').replaceAll('|','\\|').replaceAll('\n',' ')});
  for(const [key,value] of Object.entries(node.properties||{}))visit(value,path?`${path}.${key}`:key,(node.required||[]).includes(key));
  if(node.items)visit(node.items,`${path}[]`);
  if(node.additionalProperties && typeof node.additionalProperties==='object')visit(node.additionalProperties,`${path}.*`);
  for(const [i,value] of (node.oneOf||[]).entries())if(!value.required || value.properties || value.type || value.const!==undefined)visit(value,`${path} (option ${i+1})`);
}
visit(schema,'');

// Group the flat field list into the same areas the YAML guide's pages use, so each
// area links to the guide section that explains it instead of leaving readers to scan
// one 450-row table. Matchers are tried in order; the first match wins.
interface Area { title: string; guide: string; match: (path: string) => boolean }
const areas: Area[]=[
  {title:'Project entry: version, includes, shared',guide:'[organization](yaml/organization.md)',
    match:p=>p==='version'||p.startsWith('includes')||p.startsWith('shared')},
  {title:'Routes: common fields (methods, parameters, env, secrets, policies, cache)',guide:'[functions, inputs and methods](yaml/functions.md) and [bindings, split files and tests](yaml/organization.md)',
    match:p=>p==='routes'||p==='routes.*'||/^routes\.\*\.(methods|enabled|sandbox|sandboxReason|coveredElsewhere|expires|description|parameters|env|secrets|policies|auth|cache|match|use|request|response)($|\.|\[| )/.test(p)},
  {title:'Handler: redirect',guide:'[redirects](yaml/redirects.md)',match:p=>/^routes\.\*\.redirect($|\.|\[| )/.test(p)},
  {title:'Handler: respond',guide:'[declared responses, headers and cookies](yaml/responses.md)',match:p=>/^routes\.\*\.respond($|\.|\[| )/.test(p)},
  {title:'Handler: function',guide:'[functions, inputs and methods](yaml/functions.md)',match:p=>/^routes\.\*\.(function|stream)($|\.|\[| )/.test(p)},
  {title:'Handler: page, static, download',guide:'[pages, static folders and downloads](yaml/assets.md)',match:p=>/^routes\.\*\.(page|static|download)($|\.|\[)/.test(p)},
  {title:'Handler: conditional',guide:'[enable, disable and expire](yaml/conditions.md)',match:p=>/^routes\.\*\.conditional($|\.|\[| )/.test(p)},
  {title:'Handler: proxy and signals',guide:'[bounded egress](EGRESS.md)',match:p=>/^routes\.\*\.(proxy|signals)($|\.|\[| )/.test(p)},
  {title:'Handler: extension mount',guide:'[extensions](EXTENSIONS.md)',match:p=>/^routes\.\*\.extension($|\.|\[| )/.test(p)},
  {title:'Middleware',guide:'[middleware before and after a handler](yaml/middleware.md)',match:p=>/^routes\.\*\.middleware($|\.|\[)/.test(p)},
  {title:'Policies and profiles',guide:'[policies and profiles](yaml/policies.md)',match:p=>p.startsWith('policies')||p.startsWith('profiles')},
  {title:'Site conventions',guide:'[site conventions](yaml/site.md)',match:p=>p.startsWith('site')},
  {title:'Extensions (top-level)',guide:'[extensions](EXTENSIONS.md)',match:p=>p.startsWith('extensions')},
];
function areaFor(path: string): Area {
  for(const area of areas)if(area.match(path))return area;
  return {title:'Other',guide:'[YAML guide](YAML-GUIDE.md)',match:()=>true};
}
const grouped=new Map<string,{area: Area; rows: Row[]}>();
for(const row of rows){
  const area=areaFor(row.path);
  const existing=grouped.get(area.title);
  if(existing)existing.rows.push(row);else grouped.set(area.title,{area,rows:[row]});
}

function anchor(title: string): string {
  return title.toLowerCase().replaceAll(/[^a-z0-9 -]/g,'').replaceAll(/\s+/g,'-');
}
const toc=[...grouped.values()].map(({area})=>`- [${area.title}](#${anchor(area.title)})`).join('\n');
const sections=[...grouped.values()].map(({area,rows})=>{
  const body=rows.map(r=>`| \`${r.path}\` | ${r.kind} | ${r.required?'yes':'no'} | ${r.rules} | ${r.description || '—'} |`).join('\n');
  return `## ${area.title}\n\nSee ${area.guide} for examples.\n\n| Field | Type | Required | Schema constraints | Description |\n|---|---|---|---|---|\n${body}\n`;
}).join('\n');

const output=`# YAML field reference

Generated from the bundled JSON Schema by \`npm run docs:reference\`. Required
means required within its containing object, not that the object itself must be
present. \`routes.*\` means a route path; other \`*\` markers mean user-selected
keys. \`[]\` means an array item. Option rows describe union alternatives.
Every property carries a schema-level description, and the reference check
fails when one is missing; array items, map values and union options without
one show \u2014 in that column. Read the linked guide section for behavior JSON
Schema does not express.

Read the [YAML guide](YAML-GUIDE.md) for examples and [specification](SPECIFICATION.md)
for semantic validation beyond JSON Schema. Exactly one handler is required per
route; respond.text/respond.json are mutually exclusive. Runtime defaults include
GET/HEAD, redirect 302, respond 200, default module export, and asset no-cache.
Only Set-Cookie accepts response header arrays. This table does not imply all
schema-valid combinations activate successfully.

## Areas

${toc}

${sections}`;
const target=new URL('../docs/YAML-REFERENCE.md',import.meta.url);
if(process.argv.includes('--check')) {
 if(await readFile(target,'utf8')!==output)throw new Error('YAML reference is stale; run npm run docs:reference');
}else await writeFile(target,output);
