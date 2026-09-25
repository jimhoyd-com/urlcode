// Read-only review report for a person checking a change (docs/TOOLING.md#review-report).
//
// A view, not a new analysis: it composes `explainProject`, `reviewProject` and, given an earlier version,
// `summarizeChange`, and renders their documented JSON. Route semantics stay in those contracts, so the report
// follows them as they grow. The only logic here is `attention`, a list read off fields those outputs already carry,
// plus a by-name comparison of an operator policy with `requestedPermissions` (what `urlcode permissions` prints).
// Handler details are rendered generically, so a new handler kind or field needs no change here.
//
// Everything printed comes from those outputs: binding values, secrets and redirect destinations the change
// summary omits never reach the page. Project text (descriptions, paths, excerpts) is untrusted and always escaped;
// the page carries a CSP that allows no script, so it is safe to open from a pull request artifact.
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
  change?:YamlChangeSummary & {before:string};
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
  const change=options.before?{...await summarizeChange(options.before.input,{project}),before:options.before.label}:undefined;
  const attention=attentionOf(explained.routes,review,change);
  if(options.policy){
    const loaded=await loadDocument(project);
    attention.unshift(...policyAttention(requestedPermissions(loaded,await prepareFunctionSnapshot(loaded)),options.policy));
  }
  return {format:1,projectSha256:explained.projectSha256,routeCount:explained.routeCount,host:options.extensions!==undefined,policy:options.policy!==undefined,
    attention,routes:explained.routes,review,...(change?{change}:{})};
}
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

function attentionOf(routes:RouteExplanation[],review:ProjectReview,change:YamlChangeSummary|undefined):ReportAttention[] {
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
function routeRow(route:RouteExplanation):string {
  const needed=routeNeeds(route);
  return `<tr id="${esc(encodeURIComponent(route.path))}"><td><details><summary>${code(route.path)}${route.state==='active'?'':` <span class="pill warn">${esc(route.state)}</span>`}</summary>
<ol class="steps">${steps(route).map(([label,body])=>`<li><b>${label}</b><span>${body}</span></li>`).join('')}</ol></details>${route.description?`<p class="muted">${esc(route.description)}</p>`:''}</td>
<td><span class="pill">${esc(route.handler.kind)}</span></td><td>${esc(route.methods.join(' '))}</td>
<td>${runsCode(route)?`<span class="pill ${route.sandbox?'ok':''}">${route.sandbox?'sandboxed':'trusted'}</span>`:'<span class="muted">no code</span>'}</td>
<td>${esc(route.policies.names.join(', '))||'<span class="muted">none</span>'}</td><td>${needed.map(item=>esc(item)).join('<br>')||'<span class="muted">nothing</span>'}</td></tr>`;
}
function changeSection(change:NonNullable<ProjectReport['change']>):string {
  if(!change.changed)return `<section><h2>Changes since ${code(change.before)}</h2><p class="muted">No changes.</p></section>`;
  const r=change.routes,gone=new Set(r.removed.map(item=>item.route)),list=(items:string[])=>items.length?`<ul>${items.map(item=>`<li>${item}</li>`).join('')}</ul>`:'';
  const lines=[
    ...r.added.map(item=>`Adds ${code(item.route)} (${esc(item.handler)}${item.file?`, ${esc(item.file)}`:''}).`),
    ...r.removed.map(item=>`Removes ${code(item.route)} (${esc(item.handler)}).`),
    ...r.changed.map(item=>`Changes ${code(item.route)}${item.handler.before!==item.handler.after?`: ${esc(item.handler.before)} → ${esc(item.handler.after)}`:''}${item.keys.length?` (${esc(item.keys.join(', '))})`:''}${item.movedFrom?`, moved from ${esc(item.movedFrom)}`:''}.`),
    ...change.code.argsChanged.map(item=>`Changes the arguments of ${code(item.source)} on ${code(item.route)}.`),
    ...change.code.removed.filter(item=>!gone.has(item.route)).map(item=>`Removes ${esc(item.kind)} ${code(item.source)} from ${code(item.route)}.`),
    ...(change.capabilities.added.length?[`Starts using ${esc(change.capabilities.added.join(', '))}.`]:[]),
    ...(change.capabilities.removed.length?[`Stops using ${esc(change.capabilities.removed.join(', '))}.`]:[]),
    ...(change.project.changed.length?[`Changes project settings: ${esc(change.project.changed.join(', '))}.`]:[]),
    ...grouped(grantLines(change.grants.released)).map(([label,routes])=>`No longer asks for ${esc(label)} on ${routes.length===1?code(routes[0]):`${routes.length} routes`}.`),
  ];
  return `<section><h2>Changes since ${code(change.before)}</h2>${list(lines)}<p class="muted">${esc(change.grants.note)}</p></section>`;
}
const style=`:root{color-scheme:light;--bg:#fff;--fg:#18181b;--muted:#71717a;--line:#e4e4e7;--soft:#f4f4f5;--fix:#b91c1c;--fix-bg:#fef2f2;--check:#a16207;--check-bg:#fefce8;--ok:#15803d;--ok-bg:#f0fdf4}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#09090b;--fg:#fafafa;--muted:#a1a1aa;--line:#27272a;--soft:#18181b;--fix:#f87171;--fix-bg:#2a0a0a;--check:#facc15;--check-bg:#261f05;--ok:#4ade80;--ok-bg:#052e16}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 48px;display:flex;flex-direction:column;gap:28px}
h1{font-size:22px;margin:0}h2{font-size:16px;margin:0 0 10px}p{margin:4px 0}ul{margin:0;padding-left:20px}li{margin:3px 0}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);padding:1px 4px;border-radius:4px;overflow-wrap:anywhere}
.muted{color:var(--muted)}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:760px}
th,td{text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid var(--line)}th{font-weight:500;color:var(--muted);font-size:12px}
summary{cursor:pointer}.pill{display:inline-block;padding:0 8px;border-radius:999px;border:1px solid var(--line);font-size:12px;white-space:nowrap}
.pill.ok{color:var(--ok);background:var(--ok-bg);border-color:transparent}.pill.warn{color:var(--check);background:var(--check-bg);border-color:transparent}
.item{display:flex;gap:10px;padding:8px 10px;border-radius:6px;margin-bottom:6px}.item.fix{background:var(--fix-bg)}.item.check{background:var(--check-bg)}
.item .lvl{font-weight:600;min-width:44px}.item.fix .lvl{color:var(--fix)}.item.check .lvl{color:var(--check)}
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
export function renderProjectReport(report:ProjectReport):string {
  const attention=report.attention.length
    ?report.attention.map(item=>`<div class="item ${item.level}"><span class="lvl">${item.level==='fix'?'Fix':'Check'}</span><span>${item.route?`<a href="#${esc(encodeURIComponent(item.route))}">${code(item.route)}</a> `:''}${esc(item.message)}</span></div>`).join('')
    :'<p class="muted">Nothing needs attention.</p>';
  return page(`URLCode report ${report.projectSha256.slice(0,12)}`,`<header><h1>URLCode report</h1><p class="muted">Revision ${code(report.projectSha256)} · ${report.routeCount} route${report.routeCount===1?'':'s'}</p>${unchecked(report).map(line=>`<p class="muted">${line}</p>`).join('')}</header>
<section><h2>Needs attention (${report.attention.length})</h2>${attention}</section>
${report.change?changeSection(report.change):''}
<section><h2>Routes</h2><p class="muted">Open a route to see what happens to a request.</p><div class="scroll"><table><thead><tr><th>Route</th><th>Handler</th><th>Methods</th><th>Code</th><th>Policies</th><th>Needs from the host</th></tr></thead><tbody>
${report.routes.map(routeRow).join('\n')}
</tbody></table></div></section>
<footer class="muted"><p>Read-only. Derived from the compiled configuration by <code>urlcode explain</code>, <code>review</code> and <code>diff</code>: no request was evaluated, no project code ran and no binding value was read. Grants remain operator decisions.</p></footer>`);
}
/** The page shown when the project does not load, for example while `urlcode.yaml` is mid-edit. */
export function renderReportError(message:string):string {
  return page('URLCode report: project does not load',`<header><h1>URLCode report</h1></header>
<section><h2>The project does not load</h2><div class="item fix"><span class="lvl">Fix</span><span>${esc(message)}</span></div><p class="muted">Fix it, then reload this page.</p></section>`);
}
