import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {parseYaml,validateDocument} from './config.ts';
import {listExamples} from './examples.ts';
import {shippedSkillFiles as skills} from './shipped-skills.ts';

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

// Ordered: the first rule whose pattern matches the supplied text wins, so
// specific messages come before the families that contain them. Patterns
// follow the runtime's own error text; keep them in step when a message changes.
const errorRules:readonly {id:string;pattern:RegExp;guidance:string;nextTools:readonly string[]}[]=[
  {id:'duplicate-key',pattern:/duplicate yaml|duplicate key/,guidance:'Give every mapping key one value. URLCode rejects duplicate YAML keys rather than choosing one silently.',nextTools:['validate_yaml']},
  {id:'yaml-subset',pattern:/aliases|anchors|explicit tags/,guidance:'Rewrite YAML anchors, aliases and tags as ordinary repeated YAML values; URLCode accepts a JSON-compatible YAML subset.',nextTools:['validate_yaml']},
  {id:'yaml-syntax',pattern:/invalid yaml|non-json yaml|yaml mapping keys/,guidance:'The file is not valid URLCode YAML: check indentation, quoting and that every key is a plain string. validate_yaml checks supplied text without reading the project.',nextTools:['validate_yaml']},
  {id:'route-handler',pattern:/invalid configuration at \/routes\/[^ ]+ \(required\): missing required key/,guidance:'A route needs exactly one handler (redirect, respond, function, proxy, static, page, download and so on). The schema names the first handler it tried, so "missing required key" on a route usually means the route declares two handlers or misspells the one it has. Keep one handler and check its fields with get_capability.',nextTools:['get_capability','get_schema','validate']},
  {id:'schema',pattern:/invalid configuration at/,guidance:'The named location does not match the versioned URLCode schema. Ask get_schema for that field or get_capability for the handler before editing it.',nextTools:['get_schema','get_capability','validate']},
  {id:'function-initialization',pattern:/function initialization failed/,guidance:'The named module failed to load before any request: fix the syntax error at the named line, install or correct the imported package or path, or make the route\'s `export` name one the module exports (default when omitted). Validate again after the edit.',nextTools:['validate']},
  {id:'function-deadline',pattern:/function deadline exceeded/,guidance:'The function did not return within its deadline. Look for an unresolved promise or a slow upstream call; the deadline is the operator\'s --function-timeout-ms. `urlcode dev` prints the route behind the 504 on stderr.',nextTools:['explain']},
  {id:'function-execution',pattern:/function execution failed/,guidance:'A 502 "Function execution failed" deliberately hides the function\'s error from the client. Run `urlcode dev` (or `urlcode serve --debug-errors`): stderr gets a function_error line with the route, source file, export, message and stack.',nextTools:['explain']},
  {id:'revision-pin',pattern:/pinned to project revision/,guidance:'The operator policy grants bindings for an older project revision, and any change to routes, policies or function sources changes the revision. Run `urlcode permissions` to print the grants this revision requests, review them, and update the policy file (outside the project) with the new projectSha256.',nextTools:['get_manifest']},
  {id:'operator-grant',pattern:/denied by (revision-pinned )?operator policy/,guidance:'Bindings and egress need an operator grant; project YAML cannot grant itself access. Run `urlcode permissions` to print what the project requests, put the reviewed grants in a policy file outside the project, and pass it with --policy.',nextTools:['get_manifest']},
  {id:'missing-binding',pattern:/missing required (environment|secret) binding/,guidance:'The granted variable is not set. Set it in the host environment; `urlcode dev` also reads .env.local. An env binding can declare a `default` instead.',nextTools:['explain']},
  {id:'undeclared-input',pattern:/path placeholder requires an input|undeclared input|placeholder must reference a declared path input|proxy placeholder requires/,guidance:'Every {name} in a route path or destination needs a matching declaration under the route\'s inputs. Ask get_schema for route.inputs.',nextTools:['get_schema']},
  {id:'route-path',pattern:/route must be a literal absolute path|terminal \/\* wildcard|terminal \/\*\*/,guidance:'Route keys are literal absolute paths with whole-segment {parameters}; only static and extension routes end in /*, and a wildcard redirect ends in /**. Ask get_capability for the handler you are routing to.',nextTools:['get_capability','get_schema']},
  {id:'route-conflict',pattern:/overlap|duplicate route/,guidance:'Two routes claim the same requests. Remove or rename one, then use explain on the path to confirm which route now selects it.',nextTools:['explain','inspect']},
  {id:'project-file',pattern:/project file|referenced|file reference|reference must point to a file/,guidance:'This needs local project validation: confirm the referenced path is project-relative, exists, and is allowed by the selected route type.',nextTools:['validate']},
  {id:'unknown-name',pattern:/unknown (capability|schema path)/,guidance:'The name is not in the bundled catalog; the message lists the valid names. Pick one of those exactly.',nextTools:['capabilities','get_schema']},
  {id:'sandbox',pattern:/sandbox/,guidance:'Sandboxed routes cannot use Node or network APIs. Prefer a declarative handler or proxy; otherwise remove sandboxing only after a deliberate trust review.',nextTools:['get_capability']},
  {id:'port-in-use',pattern:/already in use/,guidance:'Another process holds the port. Pass --port with a free port, or stop the other process.',nextTools:[]},
];
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
