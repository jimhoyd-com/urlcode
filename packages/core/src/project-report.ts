// Read-only review report for a person checking a change (docs/TOOLING.md#review-report).
//
// A view, not a new analysis: it composes `explainProject`, `reviewProject` and, given an earlier version,
// `summarizeChange`, and renders their documented JSON. Route semantics stay in those contracts, so the report
// follows them as they grow. The only logic here is `attention`, a list read off fields those outputs already carry,
// a by-name comparison of an operator policy with `requestedPermissions` (what `urlcode permissions` prints), and,
// against a BEFORE directory, a by-content file comparison, since `diff` reads YAML only and code edits need a reader.
// Handler details are rendered generically, so a new handler kind or field needs no change here.
//
// Everything printed comes from those outputs: binding values, secrets and redirect destinations the change
// summary omits never reach the page. Project text (descriptions, paths, excerpts) is untrusted and always escaped;
// the page carries a CSP that allows no script, so it is safe to open from a pull request artifact.
import {createHash} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {explainProject,reviewProject} from './tooling.ts';
import type {ExtensionProvider,InspectOptions,ProjectReview,RouteExplanation} from './tooling.ts';
import {summarizeChange} from './yaml-change.ts';
import type {YamlChangeInput,YamlChangeSummary,GrantSet} from './yaml-change.ts';
import type {RuntimeExtension} from './extensions.ts';
import {loadDocument} from './config.ts';
import {prepareFunctionSnapshot,requestedPermissions} from './policy.ts';
import type {OperatorPolicy} from './policy.ts';

export interface ReportAttention {
  /** `fix`: the project will not run as intended with the supplied host file or policy. `check`: a person should look before approving. */
  level:'fix'|'check'; from:'explain'|'review'|'diff'|'policy'; message:string; route?:string;
}
export interface ProjectReport {
  format:1; projectSha256:string; routeCount:number;
  /** Whether operator registrations were supplied; without them add-on registration and its revision pin are unchecked. */
  host:boolean;
  /** Whether an operator policy was supplied; without it binding and egress grants and their revision pin are unchecked. */
  policy:boolean;
  attention:ReportAttention[];
  routes:RouteExplanation[];
  review:ProjectReview;
  /** Present when an earlier version was supplied. */
  change?:YamlChangeSummary & {before:string;files?:ReportFileChanges};
}
/**
 * Files compared by content when BEFORE is a project directory, by project-relative path. `diff` reads YAML only, so
 * this is where an edit to function code, a module it imports or an extension's handler shows. Dot-entries,
 * `node_modules` and symbolic links are skipped; nothing is parsed or run.
 */
export interface ReportFileChanges {
  added:string[]; removed:string[]; changed:string[];
  /**
   * Changed or added files a route runs, with those routes: its function or middleware, or a file named in the
   * configuration of an add-on the route mounts or requires (a tool handler, a hook). Anything else, such as an imported
   * helper, has no entry.
   */
  runBy:Record<string,string[]>;
  /** A side had more than `fileLimit` files, so the comparison stopped there. */
  truncated?:true;
  /** Set, with the lists empty, when the files could not be read. */
  error?:string;
}
export interface ProjectReportOptions {
  extensions?:RuntimeExtension[]|undefined;
  /** The operator's binding policy (`--policy`), compared with what the project requests. Its values are never read: a policy holds names only. */
  policy?:OperatorPolicy|undefined;
  before?:{input:YamlChangeInput;label:string}|undefined;
}

export async function buildProjectReport(project:string,options:ProjectReportOptions={}):Promise<ProjectReport> {
  const inspect:InspectOptions=options.extensions?{extensions:options.extensions}:{};
  // One load at a time: loadDocument admits two per process (config.ts), and a parallel sibling left running after
  // the other failed would hold a slot past this call.
  const explained=await explainProject(project,inspect),review=await reviewProject(project,inspect);
  const beforeInput=options.before?.input,compareFiles=beforeInput!==undefined&&'project' in beforeInput;
  const loaded=options.policy||compareFiles?await loadDocument(project):undefined;
  const files=compareFiles&&loaded?await fileChanges(beforeInput.project,project,explained.routes,loaded.document.extensions??{}):undefined;
  const change=options.before?{...await summarizeChange(options.before.input,{project}),before:options.before.label,...(files?{files}:{})}:undefined;
  const attention=attentionOf(explained.routes,review,change);
  if(options.policy&&loaded)attention.unshift(...policyAttention(requestedPermissions(loaded,await prepareFunctionSnapshot(loaded)),options.policy));
  return {format:1,projectSha256:explained.projectSha256,routeCount:explained.routeCount,host:options.extensions!==undefined,policy:options.policy!==undefined,
    attention,routes:explained.routes,review,...(change?{change}:{})};
}
/** Files per side the comparison reads before it stops: a report is for a project, not a whole checkout. */
export const fileLimit=5000;
async function fileHashes(root:string):Promise<{files:Map<string,string>;truncated:boolean}> {
  const files=new Map<string,string>();
  let truncated=false;
  const walk=async(dir:string,prefix:string):Promise<void>=>{
    for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
      if(truncated)return;
      if(entry.name.startsWith('.')||entry.name==='node_modules')continue;
      if(entry.isDirectory())await walk(join(dir,entry.name),`${prefix}${entry.name}/`);
      else if(entry.isFile()){
        if(files.size>=fileLimit){truncated=true;return;}
        files.set(prefix+entry.name,createHash('sha256').update(await readFile(join(dir,entry.name))).digest('hex'));
      }
    }
  };
  await walk(root,'');
  return {files,truncated};
}
async function fileChanges(before:string,after:string,routes:RouteExplanation[],extensions:Record<string,{config?:unknown}>):Promise<ReportFileChanges> {
  let previous:Awaited<ReturnType<typeof fileHashes>>,current:Awaited<ReturnType<typeof fileHashes>>;
  try{previous=await fileHashes(before);current=await fileHashes(after);}
  catch(error){return {added:[],removed:[],changed:[],runBy:{},error:error instanceof Error?error.message:String(error)};}
  const [was,now]=[previous.files,current.files];
  const added=[...now.keys()].filter(path=>!was.has(path)),changed=[...now.keys()].filter(path=>was.has(path)&&was.get(path)!==now.get(path));
  // Strings in an add-on's configuration that name a project file; the add-on, not core, decides what they mean.
  const named=new Map<string,Set<string>>();
  const collect=(extension:string,value:unknown):void=>{
    if(typeof value==='string'){const path=value.replace(/^\.\//,'');if(now.has(path))named.set(path,(named.get(path)??new Set()).add(extension));}
    else if(value&&typeof value==='object')for(const item of Object.values(value))collect(extension,item);
  };
  for(const [name,declaration] of Object.entries(extensions))collect(name,declaration.config);
  const runBy:Record<string,string[]>={};
  for(const file of [...changed,...added]){
    const users=routes.filter(route=>routeSources(route).includes(file)||[...named.get(file)??[]].some(extension=>routeExtensions(route).includes(extension))).map(route=>route.path);
    if(users.length)runBy[file]=users;
  }
  return {added,removed:[...was.keys()].filter(path=>!now.has(path)),changed,runBy,...(previous.truncated||current.truncated?{truncated:true as const}:{})};
}
/** Add-ons a route mounts or requires. */
const routeExtensions=(route:RouteExplanation):string[]=>[...route.handler.kind==='extension'?[String(route.handler.name)]:[],...Object.keys(route.policies.extensions)];
const isCode=(path:string)=>/\.(?:[cm]?js|[cm]?ts)$/.test(path);
/** Project-relative sources each route runs: its function and its middleware entries. */
const routeSources=(route:RouteExplanation):string[]=>[...route.handler.kind==='function'?[String(route.handler.source)]:[],...route.middleware.map(item=>item.source)];

/** What the project requests (the `urlcode permissions` projection) against what the operator policy grants. */
function policyAttention(requested:OperatorPolicy,policy:OperatorPolicy):ReportAttention[] {
  const items:ReportAttention[]=[];
  if(policy.projectSha256!==requested.projectSha256)items.push({level:'fix',from:'policy',message:'The operator policy is pinned to a different project revision, so no route receives its env, secrets or outbound access. Review this version, then re-pin the policy (urlcode permissions prints what it requests).'});
  for(const [route,want] of Object.entries(requested.routes)){
    const have=policy.routes[route];
    const missing=[...(want.env??[]).filter(name=>!have?.env?.includes(name)).map(name=>`env ${name}`),...(want.secrets??[]).filter(name=>!have?.secrets?.includes(name)).map(name=>`secret ${name}`),
      ...(['proxy','signals'] as const).flatMap(purpose=>(want.egress?.[purpose]??[]).filter(origin=>!have?.egress?.[purpose]?.includes(origin)).map(origin=>`${purpose} access to ${origin}`))];
    if(missing.length)items.push({level:'fix',from:'policy',route,message:`The operator policy does not grant ${missing.join(', ')}.`});
  }
  return items;
}

function attentionOf(routes:RouteExplanation[],review:ProjectReview,change:ProjectReport['change']):ReportAttention[] {
  const items:ReportAttention[]=[],seen=new Set<string>();
  const add=(item:ReportAttention)=>{const key=`${item.level}|${item.route??''}|${item.message}`;if(!seen.has(key)){seen.add(key);items.push(item);}};
  for(const route of routes){
    const providers:[string,ExtensionProvider|undefined][]=Object.entries(route.policies.extensions).map(([name,entry])=>[name,entry.provider]);
    // explain sets `provider` on an extension mount's handler; ExplainedHandler types its details as unknown.
    if(route.handler.kind==='extension')providers.push([String(route.handler.name),route.handler.provider as ExtensionProvider|undefined]);
    for(const [name,provider] of providers){
      if(provider?.registered===false)add({level:'fix',from:'explain',message:`Add-on "${name}" is not registered in the host file.`});
      else if(provider?.revisionMatch===false)add({level:'fix',from:'explain',message:`The host file registers "${name}" for a different project revision. Review this version, then re-pin.`});
    }
    for(const [name,entry] of Object.entries(route.policies.extensions))
      if(entry.provider?.requirementValid===false)add({level:'fix',from:'explain',route:route.path,message:`The requirement for "${name}" does not match that add-on's policy schema.`});
    if(route.state!=='active')add({level:'check',from:'explain',route:route.path,message:`Route is ${route.state}.`});
  }
  for(const item of review.observations)
    for(const route of item.routes)add({level:'check',from:'review',route,message:`${item.reason} (${item.source}:${item.line})`});
  if(change){
    for(const seam of change.code.added)add({level:'check',from:'diff',route:seam.route,message:`New ${seam.mode} ${seam.kind} ${seam.source}.`});
    for(const flip of change.code.modeChanged)add({level:'check',from:'diff',route:flip.route,message:`Code now runs ${flip.after} (was ${flip.before}).`});
    for(const [label,{route}] of grantLines(change.grants.requested))add({level:'check',from:'diff',route,message:`Asks the operator for ${label}.`});
    for(const removed of change.routes.removed)add({level:'check',from:'diff',route:removed.route,message:'Route removed.'});
    // Project code a person must read: a changed module can change what a route does without any YAML change.
    for(const file of (change.files?.changed??[]).filter(isCode)){
      const users=change.files?.runBy[file]??[];
      add({level:'check',from:'diff',...(users.length===1?{route:users[0]!}:{}),message:`Code changed in ${file}${users.length>1?` (run by ${users.length} routes)`:users.length?'':' (no route names it)'}.`});
    }
    if(change.files?.error)add({level:'check',from:'diff',message:`Files were not compared with BEFORE: ${change.files.error}`});
  }
  return [...items.filter(item=>item.level==='fix'),...items.filter(item=>item.level==='check')];
}
/** One entry per grant name, with the routes that named it, so a project-wide change reads as one line. */
function grouped(lines:[string,{route:string}][]):[string,string[]][] {
  const map=new Map<string,string[]>();
  for(const [label,{route}] of lines)map.set(label,[...map.get(label)??[],route]);
  return [...map];
}
function grantLines(set:GrantSet):[string,{route:string}][] {
  return [
    ...set.env.map(item=>[`env ${item.name}`,{route:item.route}] as [string,{route:string}]),
    ...set.secrets.map(item=>[`secret ${item.name}`,{route:item.route}] as [string,{route:string}]),
    ...set.egress.map(item=>[`${item.purpose} access to ${item.origin}`,{route:item.route}] as [string,{route:string}]),
    ...set.extensions.map(item=>[`add-on ${item.extension} (${item.via})`,{route:item.route}] as [string,{route:string}]),
  ];
}

// ---- HTML ----
const esc=(value:unknown):string=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!);
const code=(value:unknown):string=>`<code>${esc(value)}</code>`;
/** Compact, generic rendering of any explain value: new fields show up without a change here. */
function text(value:unknown):string {
  if(value===undefined||value===null)return '';
  if(Array.isArray(value))return value.map(text).join(', ');
  if(typeof value==='object')return Object.entries(value).map(([key,item])=>item!==null&&typeof item==='object'?`${key} {${text(item)}}`:`${key}: ${text(item)}`).join('; ');
  return String(value);
}
const runsCode=(route:RouteExplanation)=>route.handler.kind==='function'||route.middleware.length>0;
function routeNeeds(route:RouteExplanation):string[] {
  const list=Object.keys(route.policies.extensions).map(name=>`add-on ${name}`);
  if(route.handler.kind==='extension')list.unshift(`add-on ${String(route.handler.name)}`);
  for(const ref of Object.values(route.bindings.env))if('env' in ref)list.push(`env ${ref.env}`);
  for(const ref of Object.values(route.bindings.secrets))list.push(`secret ${ref.secret}`);
  if(route.egress.proxy)list.push(`proxy ${route.egress.proxy}`);
  for(const origin of route.egress.signals??[])list.push(`signal ${origin}`);
  return [...new Set(list)];
}
function steps(route:RouteExplanation):[string,string][] {
  const {kind,provider:_provider,...detail}=route.handler;
  const inputs=[...route.inputs.parameters.map(p=>`${p.in} ${p.name}${p.required?'':' (optional)'}`),...(route.inputs.body?['request body checked']:[])];
  const incompatible=Object.entries(route.targets).filter(([,support])=>!support.compatible).map(([target,support])=>`${target}: ${support.issues.map(issue=>issue.capability).join(', ')}`);
  return [
    ['Match',`${esc(route.methods.join(' '))}${inputs.length?` · ${esc(inputs.join(', '))}`:''}`],
    ['Policies',route.policies.names.length?Object.entries(route.policies.inventory).map(([name,entry])=>`${code(name)} ${esc(text(entry))}`).join('<br>')||esc(route.policies.names.join(', ')):'none'],
    ...Object.entries(route.policies.extensions).map(([name,entry]):[string,string]=>[`Add-on ${esc(name)}`,esc(text(entry.requirement))]),
    ...route.middleware.map((item):[string,string]=>['Middleware',`${code(`${item.source}#${item.export}`)} ${route.sandbox?'sandboxed':'trusted'}`]),
    ['Handler',`<b>${esc(kind)}</b> ${esc(text(detail))}`],
    ['Response',`cache ${esc(route.cache.outcome)}${route.cache.cacheControl?` (${code(route.cache.cacheControl)})`:''} · ${esc(route.cache.reason??'')}${route.responseHeaders.length?`<br>headers ${esc(route.responseHeaders.map(([name])=>name).join(', '))}`:''}`],
    ...(incompatible.length?[['Not on',esc(incompatible.join(' · '))] as [string,string]]:[]),
  ];
}
const anchor=(route:string)=>esc(encodeURIComponent(route));
const routeLink=(route:string)=>`<a href="#${anchor(route)}">${code(route)}</a>`;
const plural=(count:number,word:string)=>`${count} ${word}${count===1?'':'s'}`;
/** What the change did to one route, for its row in the table. */
interface RouteMarks { added:boolean; changed?:string[]; codeChanged:string[] }
function marksOf(report:ProjectReport):Map<string,RouteMarks> {
  const marks=new Map<string,RouteMarks>(),change=report.change;
  if(!change)return marks;
  const mark=(route:string)=>{let entry=marks.get(route);if(!entry)marks.set(route,entry={added:false,codeChanged:[]});return entry;};
  for(const item of change.routes.added)mark(item.route).added=true;
  for(const item of change.routes.changed)mark(item.route).changed=item.keys;
  for(const item of change.code.argsChanged)mark(item.route).changed??=[];
  for(const file of change.files?.changed??[])for(const route of change.files?.runBy[file]??[])mark(route).codeChanged.push(file);
  return marks;
}
function routeRow(route:RouteExplanation,marks:RouteMarks|undefined,attention:ReportAttention[]):string {
  const needed=routeNeeds(route),fixes=attention.filter(item=>item.level==='fix').length,checks=attention.length-fixes;
  const classes=['route',...attention.length?['attention']:[],...marks?['changed']:[],...runsCode(route)?['code']:[]];
  const badges=[
    ...marks?.added?['<span class="pill new">new</span>']:[],
    ...marks?.changed?[`<span class="pill new">changed</span>`]:[],
    ...marks?.codeChanged.length?['<span class="pill new">code changed</span>']:[],
    ...route.state==='active'?[]:[`<span class="pill warn">${esc(route.state)}</span>`],
    ...fixes?[`<span class="pill fix">${fixes} to fix</span>`]:[],
    ...checks?[`<span class="pill warn">${checks} to check</span>`]:[],
  ];
  const notes=attention.map(item=>`<li class="${item.level}">${esc(item.message)}</li>`).join('');
  const changed=[...marks?.changed?.length?[esc(marks.changed.join(', '))]:[],...marks?.codeChanged.length?[`code in ${marks.codeChanged.map(code).join(', ')}`]:[]];
  return `<tr id="${anchor(route.path)}" class="${classes.join(' ')}"><td><details><summary>${code(route.path)}${badges.length?` ${badges.join(' ')}`:''}</summary>
<ol class="steps">${steps(route).map(([label,body])=>`<li><b>${label}</b><span>${body}</span></li>`).join('')}${changed.length?`<li><b>Changed</b><span>${changed.join('; ')}</span></li>`:''}</ol></details>${route.description?`<p class="muted">${esc(route.description)}</p>`:''}${notes?`<ul class="notes">${notes}</ul>`:''}</td>
<td><span class="pill">${esc(route.handler.kind)}</span></td><td>${esc(route.methods.join(' '))}</td>
<td>${runsCode(route)?`<span class="pill ${route.sandbox?'ok':''}">${route.sandbox?'sandboxed':'trusted'}</span>`:'<span class="muted">no code</span>'}</td>
<td>${esc(route.policies.names.join(', '))||'<span class="muted">none</span>'}</td><td>${needed.map(item=>esc(item)).join('<br>')||'<span class="muted">nothing</span>'}</td></tr>`;
}
function removedRow(item:{route:string;handler:string}):string {
  return `<tr id="${anchor(item.route)}" class="route changed removed attention"><td><s>${code(item.route)}</s> <span class="pill warn">removed</span></td><td><span class="pill">${esc(item.handler)}</span></td><td colspan="4" class="muted">Not in this version.</td></tr>`;
}
function changeSection(change:NonNullable<ProjectReport['change']>):string {
  // A long list folds away so the route changes above it stay readable.
  const fileList=(verb:string,paths:string[])=>paths.length===0?[]:paths.length<=8?[`${verb} ${plural(paths.length,'file')}: ${paths.map(code).join(', ')}.`]
    :[`<details><summary>${verb} ${plural(paths.length,'file')}</summary><ul>${paths.map(path=>`<li>${code(path)}</li>`).join('')}</ul></details>`];
  const files=change.files,fileLines=files&&!files.error?[...fileList('Changes',files.changed),...fileList('Adds',files.added),...fileList('Removes',files.removed)]:[];
  const fileNote=!files?'<p class="muted">BEFORE is a YAML file, so only YAML was compared; pass a project directory to compare its files too.</p>'
    :files.error?`<p class="muted">Files were not compared: ${esc(files.error)}</p>`
    :files.truncated?`<p class="muted">The file comparison stopped at ${fileLimit} files per side.</p>`:'';
  if(!change.changed&&!fileLines.length)return `<section><h2>Changes since ${code(change.before)}</h2><p class="muted">No changes.</p>${fileNote}</section>`;
  const r=change.routes,gone=new Set(r.removed.map(item=>item.route)),list=(items:string[])=>items.length?`<ul>${items.map(item=>`<li>${item}</li>`).join('')}</ul>`:'';
  const lines=[
    ...r.added.map(item=>`Adds ${routeLink(item.route)} (${esc(item.handler)}${item.file?`, ${esc(item.file)}`:''}).`),
    ...r.removed.map(item=>`Removes ${routeLink(item.route)} (${esc(item.handler)}).`),
    ...r.changed.map(item=>`Changes ${routeLink(item.route)}${item.handler.before!==item.handler.after?`: ${esc(item.handler.before)} → ${esc(item.handler.after)}`:''}${item.keys.length?` (${esc(item.keys.join(', '))})`:''}${item.movedFrom?`, moved from ${esc(item.movedFrom)}`:''}.`),
    ...change.code.argsChanged.map(item=>`Changes the arguments of ${code(item.source)} on ${routeLink(item.route)}.`),
    ...change.code.removed.filter(item=>!gone.has(item.route)).map(item=>`Removes ${esc(item.kind)} ${code(item.source)} from ${routeLink(item.route)}.`),
    ...fileLines,
    ...(change.capabilities.added.length?[`Starts using ${esc(change.capabilities.added.join(', '))}.`]:[]),
    ...(change.capabilities.removed.length?[`Stops using ${esc(change.capabilities.removed.join(', '))}.`]:[]),
    ...(change.project.changed.length?[`Changes project settings: ${esc(change.project.changed.join(', '))}.`]:[]),
    ...grouped(grantLines(change.grants.released)).map(([label,routes])=>`No longer asks for ${esc(label)} on ${routes.length===1?routeLink(routes[0]!):`${routes.length} routes`}.`),
  ];
  const cut=Object.entries(change.truncated);
  return `<section><h2>Changes since ${code(change.before)}</h2>${list(lines)}${cut.length?`<p class="muted">Lists stop at ${change.limits.maxEntries} entries (${esc(cut.map(([name,count])=>`${count} more ${name}`).join(', '))}); urlcode diff prints the rest.</p>`:''}${fileNote}<p class="muted">${esc(change.grants.note)}</p></section>`;
}
function findingsSection(review:ProjectReview):string {
  if(!review.observations.length)return '';
  const items=review.observations.map((item,index)=>`<article class="finding" id="finding-${index+1}"><p><span class="pill">${esc(item.category)}</span> <span class="pill">${esc(item.confidence)} confidence</span> ${code(`${item.source}:${item.line}`)} on ${item.routes.map(routeLink).join(', ')}</p>
<p>${esc(item.reason)}</p><pre><code>${esc(item.excerpt)}</code></pre><p class="muted">${esc(item.note)}</p></article>`).join('\n');
  return `<section id="findings"><h2>Code review findings (${review.observations.length})</h2><p class="muted">What <code>urlcode review</code> read in project code: patterns URLCode may express declaratively, or that a person should look at. A static reading, so a finding is a prompt to look, not a verdict.</p>${items}</section>`;
}
/** The headline: whether anything must be fixed, then the numbers a reviewer weighs a change by. */
function summary(report:ProjectReport):string {
  const fixes=report.attention.filter(item=>item.level==='fix').length,checks=report.attention.length-fixes;
  const verdict=fixes?`<div class="verdict fix"><b>${plural(fixes,'item')} to fix</b>${checks?` · ${checks} to check`:''} before this runs as intended.</div>`
    :checks?`<div class="verdict check"><b>Nothing to fix</b> · ${plural(checks,'item')} to check before approving.</div>`
    :'<div class="verdict ok"><b>Nothing needs attention.</b></div>';
  const running=report.routes.filter(runsCode),sandboxed=running.filter(route=>route.sandbox).length;
  const needs=new Set(report.routes.flatMap(routeNeeds)),change=report.change;
  const delta=change?[[change.routes.added.length,'new'],[change.routes.changed.length,'changed'],[change.routes.removed.length,'removed']].filter(([count])=>count).map(([count,label])=>`${count} ${label}`).join(' · '):'';
  const stat=(value:number,label:string,detail='')=>`<div class="stat"><b>${value}</b><span>${label}</span>${detail?`<span class="muted">${detail}</span>`:''}</div>`;
  const findings=report.review.observations.length;
  return `${verdict}<div class="stats">${stat(report.routeCount,report.routeCount===1?'route':'routes',delta)}${stat(running.length,'run project code',running.length?`${running.length-sandboxed} trusted · ${sandboxed} sandboxed`:'')}${stat(needs.size,'needs from the host')}${stat(findings,findings===1?'review finding':'review findings',findings?'<a href="#findings">read them</a>':'')}</div>`;
}
function filters(report:ProjectReport):string {
  const count=(name:string,test:(route:RouteExplanation)=>boolean,extra=0)=>[name,report.routes.filter(test).length+extra] as const;
  const attention=new Set(report.attention.flatMap(item=>item.route?[item.route]:[])),marks=marksOf(report),removed=report.change?.routes.removed.length??0;
  const options=[count('all',()=>true),count('attention',route=>attention.has(route.path),removed),...report.change?[count('changed',route=>marks.has(route.path),removed)]:[],count('code',runsCode)];
  const label={all:'All',attention:'Needs attention',changed:'Changed',code:'Runs code'} as Record<string,string>;
  return `<div class="filters" role="radiogroup" aria-label="Show routes">${options.map(([name,total])=>`<input type="radio" name="show" id="show-${name}"${name==='all'?' checked':''}><label for="show-${name}">${label[name]} (${total})</label>`).join('')}</div>`;
}
const style=`:root{color-scheme:light;--bg:#fff;--fg:#18181b;--muted:#71717a;--line:#e4e4e7;--soft:#f4f4f5;--fix:#b91c1c;--fix-bg:#fef2f2;--check:#a16207;--check-bg:#fefce8;--ok:#15803d;--ok-bg:#f0fdf4;--new:#1d4ed8;--new-bg:#eff6ff;--target:#fef9c3}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#09090b;--fg:#fafafa;--muted:#a1a1aa;--line:#27272a;--soft:#18181b;--fix:#f87171;--fix-bg:#2a0a0a;--check:#facc15;--check-bg:#261f05;--ok:#4ade80;--ok-bg:#052e16;--new:#93c5fd;--new-bg:#172554;--target:#3a3005}}
*{box-sizing:border-box}html{scroll-padding-top:16px}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 48px;display:flex;flex-direction:column;gap:28px}
h1{font-size:22px;margin:0}h2{font-size:16px;margin:0 0 10px}p{margin:4px 0}ul{margin:0;padding-left:20px}li{margin:3px 0}a{color:inherit}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);padding:1px 4px;border-radius:4px;overflow-wrap:anywhere}
pre{margin:6px 0;padding:8px 10px;background:var(--soft);border-radius:6px;overflow-x:auto}pre code{padding:0;white-space:pre-wrap}
.muted{color:var(--muted)}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:760px}
th,td{text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid var(--line)}th{font-weight:500;color:var(--muted);font-size:12px}
tr:target,.finding:target{background:var(--target)}tr.removed td{color:var(--muted)}
summary{cursor:pointer}.pill{display:inline-block;padding:0 8px;border-radius:999px;border:1px solid var(--line);font-size:12px;white-space:nowrap}
.pill.ok{color:var(--ok);background:var(--ok-bg);border-color:transparent}.pill.warn{color:var(--check);background:var(--check-bg);border-color:transparent}
.pill.fix{color:var(--fix);background:var(--fix-bg);border-color:transparent}.pill.new{color:var(--new);background:var(--new-bg);border-color:transparent}
.item{display:flex;gap:10px;padding:8px 10px;border-radius:6px;margin-bottom:6px}.item.fix{background:var(--fix-bg)}.item.check{background:var(--check-bg)}
.item .lvl{font-weight:600;min-width:44px}.item.fix .lvl{color:var(--fix)}.item.check .lvl{color:var(--check)}
.verdict{padding:10px 12px;border-radius:6px;margin:14px 0 10px}.verdict.fix{background:var(--fix-bg)}.verdict.check{background:var(--check-bg)}.verdict.ok{background:var(--ok-bg)}
.verdict.fix b{color:var(--fix)}.verdict.check b{color:var(--check)}.verdict.ok b{color:var(--ok)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:8px}.stat{border:1px solid var(--line);border-radius:6px;padding:8px 10px;display:flex;flex-direction:column}.stat b{font-size:20px;font-weight:600}
.notes{list-style:none;padding:0;margin:6px 0 0}.notes li{padding-left:8px;border-left:2px solid var(--check)}.notes li.fix{border-color:var(--fix)}
.filters{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.filters input{position:absolute;opacity:0;pointer-events:none}
.filters label{padding:2px 10px;border:1px solid var(--line);border-radius:999px;cursor:pointer;font-size:13px}.filters input:checked+label{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.filters input:focus-visible+label{outline:2px solid var(--new);outline-offset:2px}
main:has(#show-attention:checked) tr.route:not(.attention),main:has(#show-changed:checked) tr.route:not(.changed),main:has(#show-code:checked) tr.route:not(.code){display:none}
.finding{border:1px solid var(--line);border-radius:6px;padding:10px 12px;margin-bottom:8px}
.steps{list-style:none;padding:8px 0 4px 12px;margin:6px 0;border-left:2px solid var(--line);display:flex;flex-direction:column;gap:4px}
.steps li{display:grid;grid-template-columns:90px 1fr;gap:8px}.steps b{font-weight:500}`;

/** Says what was not checked, only when the project needs it: an add-on without `--host-file`, a grant without `--policy`. */
function unchecked(report:ProjectReport):string[] {
  const lines:string[]=[];
  const wanted=report.routes.flatMap(routeNeeds);
  if(!report.host&&wanted.some(item=>item.startsWith('add-on ')))lines.push('No host file: add-on registration and its revision pin are not checked (pass --host-file).');
  if(!report.policy&&wanted.some(item=>!item.startsWith('add-on ')))lines.push('No operator policy: env, secret and outbound grants and their revision pin are not checked (pass --policy).');
  return lines;
}
/** The page's Content-Security-Policy: no script, no external fetch. `urlcode studio` sends it as a header too. */
export const reportContentSecurityPolicy="default-src 'none'; style-src 'unsafe-inline'";
function page(title:string,body:string):string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${reportContentSecurityPolicy}">
<title>${esc(title)}</title><style>${style}</style></head>
<body><main>
${body}
</main></body></html>
`;
}
export interface RenderReportOptions {
  /** When the page was built. `urlcode studio` passes it; `urlcode report` leaves it out so its page is deterministic. */
  builtAt?:Date|undefined;
}
export function renderProjectReport(report:ProjectReport,options:RenderReportOptions={}):string {
  const attention=report.attention.length
    ?report.attention.map(item=>`<div class="item ${item.level}"><span class="lvl">${item.level==='fix'?'Fix':'Check'}</span><span>${item.route?`${routeLink(item.route)} `:''}${esc(item.message)}</span></div>`).join('')
    :'<p class="muted">Nothing needs attention.</p>';
  const byRoute=new Map<string,ReportAttention[]>(),marks=marksOf(report);
  for(const item of report.attention)if(item.route)byRoute.set(item.route,[...byRoute.get(item.route)??[],item]);
  const built=options.builtAt?` · built ${esc(options.builtAt.toLocaleTimeString())}, reload to rebuild`:'';
  return page(`URLCode report ${report.projectSha256.slice(0,12)}`,`<header><h1>URLCode report</h1><p class="muted">Revision ${code(report.projectSha256)}${built}</p>
${summary(report)}${unchecked(report).map(line=>`<p class="muted">${line}</p>`).join('')}</header>
<section><h2>Needs attention (${report.attention.length})</h2>${attention}</section>
${report.change?changeSection(report.change):''}
<section><h2>Routes</h2><p class="muted">Open a route to see what happens to a request.</p>${filters(report)}<div class="scroll"><table><thead><tr><th>Route</th><th>Handler</th><th>Methods</th><th>Code</th><th>Policies</th><th>Needs from the host</th></tr></thead><tbody>
${report.routes.map(route=>routeRow(route,marks.get(route.path),byRoute.get(route.path)??[])).join('\n')}
${(report.change?.routes.removed??[]).map(removedRow).join('\n')}
</tbody></table></div></section>
${findingsSection(report.review)}
<footer class="muted"><p>Read-only. Derived from the compiled configuration by <code>urlcode explain</code>, <code>review</code> and <code>diff</code>: no request was evaluated, no project code ran and no binding value was read. Grants remain operator decisions.</p></footer>`);
}
/** The page shown when the project does not load, for example while `urlcode.yaml` is mid-edit. */
export function renderReportError(message:string):string {
  return page('URLCode report: project does not load',`<header><h1>URLCode report</h1></header>
<section><h2>The project does not load</h2><div class="item fix"><span class="lvl">Fix</span><span>${esc(message)}</span></div><p class="muted">Fix it, then reload this page.</p></section>`);
}
