import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {parseYaml,validateDocument} from './config.ts';
import {listExamples} from './examples.ts';
import {shippedSkillFiles as skills} from './shipped-skills.ts';
import {readAddonManifest} from './addon-manifest.ts';
import {errorRules} from './explain-error-rules.ts';

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
// `skills` (imported above as the canonical inventory from shipped-skills.ts, #590/#639) lists
// only name and file; each entry's `description` is read from its own SKILL.md frontmatter at
// call time rather than duplicated here, so this inventory cannot drift from the skill it
// describes the way the single-skill, hand-written description once did.
const maxExcerpt=1800;

function terms(query:string):string[] {return [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(term=>term.length>1))].slice(0,16);}
function excerpt(text:string, query:string):string {
  const words=terms(query),lower=text.toLowerCase();
  const positions=words.map(word=>lower.indexOf(word)).filter(position=>position>=0);
  const start=Math.max(0,(positions.length?Math.min(...positions):0)-300);
  return text.slice(start,start+maxExcerpt);
}
async function content(file:string):Promise<string> {return readFile(packageRoot+file,'utf8');}
/** The `description:` line from a SKILL.md's YAML frontmatter, the same text Claude Code itself
 * reads to decide whether to load the skill. */
function frontmatterDescription(text:string):string {
  const frontmatter=/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]??'';
  return /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim()??'';
}

export async function listSkills() {
  return Promise.all(skills.map(async skill=>({name:skill.name,description:frontmatterDescription(await content(skill.file))})));
}
export async function getSkill(name:string) {
  const skill=skills.find(candidate=>candidate.name===name);
  if(!skill)throw new Error('Unknown bundled skill');
  const text=await content(skill.file);
  return {name:skill.name,description:frontmatterDescription(text),content:text};
}

/**
 * The package-owned routing index for agent tooling. Behaviour stays owned by
 * the schema and topic documentation; this compact catalog owns only discovery
 * and composition. Add-ons are listed from core's signed manifest, while an
 * installed project's local MCP exposes its extension authoring contracts and
 * inert artifact members. A hosted service can therefore present the same
 * revision without copying extension facts into its own source tree.
 */
export async function listAgentCatalog() {
  const pkg=JSON.parse(await content('package.json')) as {name:string;version:string};
  const manifest=await readAddonManifest();
  return {
    format:1,
    runtime:{package:pkg.name,version:pkg.version},
    core:{
      skills:await listSkills(),
      references:docs.map(({id,title,file,summary})=>({id,title,path:file,summary})),
    },
    addons:Object.entries(manifest.addons).sort(([left],[right])=>left.localeCompare(right)).map(([name,addon])=>({
      name,kind:addon.kind,description:addon.description,requires:[...addon.requires],
      localTooling:addon.kind==='extension'
        ? {tool:'get_extensions',note:'Use local project MCP with the operator host to inspect this extension\'s revision-pinned authoring surfaces, schemas and checks.'}
        : {tool:'get_extension_artifacts',note:'Use local project MCP to inspect this inert artifact only after it is installed and pin-verified.'},
    })),
  };
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

/**
 * Deterministic remediation for URLCode error text: the first known message
 * family the text matches, with its guidance and the tools to call next.
 * `matched` is null when nothing matched; no model call or project read occurs.
 */
export function explainError(error:string) {
  const lower=error.toLowerCase(),rule=errorRules.find(candidate=>candidate.pattern.test(lower));
  const pointer=/invalid configuration at (\/\S*)/i.exec(error)?.[1];
  const location=pointer===undefined?{}:{location:pointer.split('/').slice(1).map(part=>part.replaceAll('~1','/').replaceAll('~0','~'))};
  if(!rule)return {matched:null,guidance:'No known URLCode error family matches this text. Search it with search_docs; for YAML use validate_yaml, and for a project use validate, which prints the exact failing field or file.',nextTools:['search_docs','validate_yaml','validate']};
  return {matched:rule.id,guidance:rule.guidance,...location,nextTools:[...rule.nextTools]};
}
