import {readFile,writeFile} from 'node:fs/promises';
// The subset of JSON Schema the bundled schema uses; every field is read defensively.
interface SchemaNode {
  $ref?: string; $defs?: Record<string, SchemaNode>; type?: string | string[]; const?: unknown; enum?: unknown[]; oneOf?: SchemaNode[];
  properties?: Record<string, SchemaNode>; required?: string[]; items?: SchemaNode; additionalProperties?: boolean | SchemaNode;
  [constraint: string]: unknown;
}
// JSON boundary: the bundled schema is trusted and validated in test/.
const schema=JSON.parse(await readFile(new URL('../schemas/urlcode.schema.json',import.meta.url),'utf8')) as SchemaNode;
const rows: string[]=[];
function visit(node: SchemaNode,path: string,required=false): void {
  if(node.$ref){const resolved=schema.$defs?.[node.$ref.split('/').at(-1) ?? ''];if(!resolved)throw new Error(`unresolved $ref ${node.$ref}`);node=resolved;}
  const kinds=node.type || (node.const!==undefined?'constant':node.enum?[...new Set(node.enum.map(v=>typeof v))].join(' / '):node.oneOf?'one of the shapes below':'any JSON value');
  const rules: string[]=[];
  for(const key of ['const','enum','default','minimum','maximum','minLength','maxLength','minItems','maxItems','minProperties','maxProperties','pattern','uniqueItems'])if(node[key]!==undefined)rules.push(`${key}: ${JSON.stringify(node[key])}`);
  if(node.additionalProperties===false)rules.push('unknown keys rejected');
  if(path)rows.push(`| \`${path}\` | ${Array.isArray(kinds)?kinds.join(' / '):kinds} | ${required?'yes':'no'} | ${rules.join('; ').replaceAll('|','\\|') || '—'} |`);
  for(const [key,value] of Object.entries(node.properties||{}))visit(value,path?`${path}.${key}`:key,(node.required||[]).includes(key));
  if(node.items)visit(node.items,`${path}[]`);
  if(node.additionalProperties && typeof node.additionalProperties==='object')visit(node.additionalProperties,`${path}.*`);
  for(const [i,value] of (node.oneOf||[]).entries())if(!value.required || value.properties || value.type || value.const!==undefined)visit(value,`${path} (option ${i+1})`);
}
visit(schema,'');
const output=`# YAML field reference\n\nGenerated from the bundled JSON Schema by \`npm run docs:reference\`. Required\nmeans required within its containing object, not that the object itself must be\npresent. \`routes.*\` means a route path; other \`*\` markers mean user-selected\nkeys. \`[]\` means an array item. Option rows describe union alternatives.\n\nRead the [YAML guide](YAML-GUIDE.md) for examples and [specification](SPECIFICATION.md)\nfor semantic validation beyond JSON Schema. Exactly one handler is required per\nroute; respond.text/respond.json are mutually exclusive. Runtime defaults include\nGET/HEAD, redirect 302, respond 200, default module export, and asset no-cache.\nOnly Set-Cookie accepts response header arrays. This table does not imply all\nschema-valid combinations activate successfully.\n\n| Field | Type | Required | Schema constraints |\n|---|---|---|---|\n${rows.join('\n')}\n`;
const target=new URL('../docs/YAML-REFERENCE.md',import.meta.url);
if(process.argv.includes('--check')) {
 if(await readFile(target,'utf8')!==output)throw new Error('YAML reference is stale; run npm run docs:reference');
}else await writeFile(target,output);
