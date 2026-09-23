import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {parseYaml,validateDocument} from './config.ts';
import {listExamples} from './examples.ts';

/**
 * Fixed, package-owned agent material. This is intentionally a manifest rather
 * than an arbitrary file reader: MCP clients cannot use it to enumerate or
 * exfiltrate a local project.
 *
 * Every export here is public API, published as `@jimhoyd/urlcode/agent-context`
 * (see docs/TOOLING.md and docs/TYPESCRIPT.md) so a host building its own MCP
 * server or agent-tooling surface can reuse the same deterministic docs
 * search, YAML validation and error-remediation guidance this package's own
 * `serveMcp` (mcp.ts) uses, rather than re-implementing it or reaching into
 * `dist/` directly. Signatures take only plain strings and return plain data;
 * keep them that way so the subpath stays stable independent of internal
 * types like `validateDocument`'s return shape.
 */
const packageRoot=fileURLToPath(new URL('../../../',import.meta.url));
const docs=[
  {id:'llms',title:'URLCode agent index',file:'llms.txt',summary:'Compact map of the framework, its declarative primitives and the minimum reference to load next.'},
  {id:'authoring',title:'AI authoring',file:'docs/AI-AUTHORING.md',summary:'Declarative-first authoring workflow, retrieval order and framework constraints.'},
  {id:'yaml-reference',title:'YAML reference',file:'docs/YAML-REFERENCE.md',summary:'Generated inventory of accepted URLCode YAML fields.'},
  {id:'tooling',title:'Tooling and local MCP',file:'docs/TOOLING.md',summary:'Bounded local project inspection, validation and MCP tool behavior.'},
  {id:'security',title:'Function security',file:'docs/FUNCTION-SECURITY.md',summary:'Trusted versus sandboxed function behavior, bindings and operator grants.'},
] as const;
const skills=[
  {name:'urlcode',description:'Author URLCode projects declaratively, retrieve only the required contract, and validate the result.',file:'skills/urlcode/SKILL.md'},
] as const;
const maxExcerpt=1800;

function terms(query:string):string[] {return [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(term=>term.length>1))].slice(0,16);}
function excerpt(text:string, query:string):string {
  const words=terms(query),lower=text.toLowerCase();
  const positions=words.map(word=>lower.indexOf(word)).filter(position=>position>=0);
  const start=Math.max(0,(positions.length?Math.min(...positions):0)-300);
  return text.slice(start,start+maxExcerpt);
}
async function content(file:string):Promise<string> {return readFile(packageRoot+file,'utf8');}

export function listSkills() {return skills.map(({name,description})=>({name,description}));}
export async function getSkill(name:string) {
  const skill=skills.find(candidate=>candidate.name===name);
  if(!skill)throw new Error('Unknown bundled skill');
  return {name:skill.name,description:skill.description,content:await content(skill.file)};
}

/** Deterministic lexical search over a deliberately small, agent-facing corpus. */
export async function searchDocs(query:string) {
  const words=terms(query);
  if(!words.length)throw new Error('Search text must contain a word');
  const hits=(await Promise.all(docs.map(async doc=>{
    const text=await content(doc.file),haystack=`${doc.title} ${doc.summary} ${text}`.toLowerCase();
    const matched=words.filter(word=>haystack.includes(word));
    return {doc,text,matched,score:matched.length};
  }))).filter(hit=>hit.score>0).sort((a,b)=>b.score-a.score||a.doc.id.localeCompare(b.doc.id)).slice(0,3);
  return {query,results:hits.map(({doc,text,matched})=>({id:doc.id,title:doc.title,summary:doc.summary,matched,excerpt:excerpt(text,query)}))};
}

/** Returns the two smallest high-value files of a fixed packaged example. */
export async function getExample(name:string) {
  const example=(await listExamples()).find(candidate=>candidate.name===name);
  if(!example)throw new Error('Unknown bundled example');
  const files=example.files.filter(file=>file==='urlcode.yaml'||file==='README.md');
  const content:Record<string,string>=Object.create(null);
  for(const file of files)content[file]=await readFile(`${packageRoot}examples/${name}/${file}`,'utf8');
  return {metadata:example,content};
}

/** Validates only supplied YAML syntax and the versioned document schema. It never resolves includes or reads source files. */
export function validateYaml(text:string) {
  try {
    const document=validateDocument(parseYaml(text));
    return {valid:true,scope:'syntax-and-schema-only',version:document.version,routeCount:Object.keys(document.routes).length};
  }catch(error){
    return {valid:false,scope:'syntax-and-schema-only',error:error instanceof Error?error.message:'Invalid URLCode YAML'};
  }
}

/** Short deterministic remediation for common validator output; no model call or project read occurs. */
export function explainError(error:string) {
  const lower=error.toLowerCase();
  let guidance='Use validate_yaml for YAML syntax/schema feedback, then use local validate for project files, includes and route semantics.';
  if(lower.includes('duplicate yaml')||lower.includes('duplicate key'))guidance='Give every mapping key one value. URLCode rejects duplicate YAML keys rather than choosing one silently.';
  else if(lower.includes('aliases')||lower.includes('anchors')||lower.includes('explicit tags'))guidance='Rewrite YAML anchors, aliases and tags as ordinary repeated YAML values; URLCode accepts a JSON-compatible YAML subset.';
  else if(lower.includes('invalid configuration at'))guidance='The named location does not match the versioned URLCode schema. Ask get_schema for that field or get_capability for the handler before editing it.';
  else if(lower.includes('project file')||lower.includes('referenced'))guidance='This needs local project validation: confirm the referenced path is project-relative, exists, and is allowed by the selected route type.';
  else if(lower.includes('sandbox'))guidance='Sandboxed routes cannot use Node or network APIs. Prefer a declarative handler or proxy; otherwise remove sandboxing only after a deliberate trust review.';
  return {guidance,nextTools:['get_schema','get_capability','validate']};
}
