import {ConfigError} from './errors.ts';
import {capabilityTargets, normalizeCapabilityTarget} from './capabilities.ts';
import type {CapabilityTarget} from './capabilities.ts';
import {explainRoute,explainProject} from './tooling.ts';
import type {RouteExplanation} from './tooling.ts';
import {buildManifest,renderManifest} from './manifest.ts';
import type {RuntimeExtension} from './extensions.ts';

interface Options {project:string;target?:string|undefined;origin?:string|undefined;json?:boolean|undefined;extensions?:RuntimeExtension[]|undefined}
const table=(rows:string[][]):string=>{const widths=rows[0]!.map((_,i)=>Math.max(...rows.map(row=>row[i]!.length)));return rows.map(row=>row.map((cell,i)=>cell.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n')+'\n';};
const targetsOf=(target:string|undefined):CapabilityTarget[]=>target===undefined?[...capabilityTargets]:[normalizeCapabilityTarget(target)];
function summary(explanation:RouteExplanation,targets:CapabilityTarget[]):string {
  const handler=explanation.handler,detail=handler.kind==='function'?`${handler.source as string}#${handler.export as string}`:handler.kind==='redirect'?`${handler.status as number} ${handler.url as string}`:handler.kind==='extension'?handler.name as string:handler.kind==='page'||handler.kind==='download'?handler.file as string:handler.kind==='static'?handler.directory as string:handler.kind==='proxy'?handler.url as string:handler.kind==='respond'?String(handler.status):'';
  const support=targets.map(target=>explanation.targets[target].compatible?target:`${target}:refused`).join(',');
  return [explanation.path,explanation.methods.join(','),`${handler.kind}${detail?` ${detail}`:''}`,explanation.state,explanation.sandbox?'sandboxed':'trusted',String(explanation.middleware.length),explanation.policies.names.join(',')||'-',explanation.cache.outcome,support].join('\t');
}
function detail(explanation:RouteExplanation,targets:CapabilityTarget[]):string {
  const lines:string[]=[`route: ${explanation.path}`];
  if(explanation.description)lines.push(`description: ${explanation.description}`);
  if(explanation.generated)lines.push(`generated: site.${explanation.generated}`);
  lines.push(`state: ${explanation.state}${explanation.expires?` (expires ${explanation.expires})`:''}`,`methods: ${explanation.methods.join(', ')}`,`handler: ${JSON.stringify(explanation.handler)}`);
  lines.push(`middleware: ${explanation.middleware.length?explanation.middleware.map(item=>`${item.source}#${item.export}`).join(' -> '):'none'}`);
  // Route-level, so it is printed for a native handler with middleware too.
  lines.push(`execution: ${explanation.sandbox?'sandboxed (QuickJS)':'trusted (in-process)'}${explanation.sandboxReason?`; ${explanation.sandboxReason}`:''}`);
  lines.push(`inputs: ${explanation.inputs.parameters.length?explanation.inputs.parameters.map(p=>`${p.in}:${p.name}${p.required?'':'?'}`).join(', '):'none'}${explanation.inputs.body?`; body ${JSON.stringify(explanation.inputs.body)}`:''}`);
  lines.push(`policies: ${explanation.policies.names.length?explanation.policies.names.join(', '):'none'}`);
  for(const [name,entry] of Object.entries(explanation.policies.inventory))lines.push(`  ${name}: ${JSON.stringify(entry)}`);
  for(const [name,entry] of Object.entries(explanation.policies.extensions))lines.push(`  extensions.${name}: requires ${JSON.stringify(entry.requirement)}${entry.provider?entry.provider.registered?` (provider registered, revision ${entry.provider.revisionMatch?'matches':'differs'}, requirement ${entry.provider.requirementValid===false?'invalid':'valid'})`:' (no provider in host file)':''}`);
  lines.push(`cache: ${explanation.cache.outcome}${explanation.cache.cacheControl?` (${explanation.cache.cacheControl})`:''}${explanation.cache.forcedNoStore?' forced':''}; ${explanation.cache.reason}`);
  const env=Object.entries(explanation.bindings.env).map(([alias,ref])=>`${alias}=${'env' in ref?`$${ref.env}`:'literal'}`),secrets=Object.entries(explanation.bindings.secrets).map(([alias,ref])=>`${alias}=secret:${ref.secret}`);
  lines.push(`bindings: ${[...env,...secrets].join(', ')||'none'}`);
  if(explanation.egress.proxy||explanation.egress.signals)lines.push(`egress: ${[explanation.egress.proxy?`proxy ${explanation.egress.proxy}`:'',...(explanation.egress.signals??[]).map(item=>`signal ${item}`)].filter(Boolean).join(', ')}`);
  if(explanation.responseHeaders.length)lines.push(`response headers: ${explanation.responseHeaders.map(([name,value])=>`${name}: ${value}`).join('; ')}`);
  lines.push(`capabilities: ${explanation.capabilities.join(', ')}`);
  for(const target of targets){const support=explanation.targets[target];lines.push(`target ${target}: ${support.compatible?'supported':support.issues.map(issue=>`${issue.capability} ${issue.support} (${issue.reason})`).join('; ')}`);}
  lines.push(`note: ${explanation.note}`);
  return lines.join('\n')+'\n';
}
/** Returns the process exit code: 1 when a requested route does not exist. */
export async function runExplainCommand(command:'explain'|'manifest',route:string|undefined,options:Options,print:(value:unknown)=>unknown):Promise<number> {
  const base={...(options.origin===undefined?{}:{origin:options.origin}),...(options.extensions===undefined?{}:{extensions:options.extensions})};
  if(command==='manifest'){
    if(route!==undefined)throw new ConfigError('manifest takes no route argument');
    const manifest=await buildManifest(options.project,base);
    if(options.json){print(renderManifest(manifest));return 0;}
    const lines=[`revision: ${manifest.revision}`,`urlcode: ${manifest.urlcode}`,`files: ${manifest.files.join(', ')}`,`routes: ${manifest.routeCount}`,`capabilities: ${manifest.capabilities.join(', ')}`,
      `extensions: ${Object.keys(manifest.extensions).join(', ')||'none'}`,`recipes: ${manifest.recipes.map(recipe=>recipe.id).join(', ')||'none'}`,
      `external: env ${manifest.external.env.join(', ')||'-'}; secrets ${manifest.external.secrets.join(', ')||'-'}; proxy ${manifest.external.egress.proxy.join(', ')||'-'}; signals ${manifest.external.egress.signals.join(', ')||'-'}`,
      `functions: ${manifest.functions.map(item=>`${item.source}#${item.export}`).join(', ')||'none'}`,`middleware: ${manifest.middleware.map(item=>`${item.source}#${item.export}`).join(', ')||'none'}`,
      `targets: ${Object.entries(manifest.targets).map(([target,support])=>`${target} ${support.compatible?'supported':`${support.issues} issue${support.issues===1?'':'s'}`}`).join('; ')}`,'Use --json for the full manifest.'];
    print(lines.join('\n')+'\n');return 0;
  }
  const targets=targetsOf(options.target);
  if(route===undefined){
    const report=await explainProject(options.project,base);
    if(options.json){print(report);return 0;}
    print(table([['route','methods','handler','state','execution','mw','policies','cache','targets'],...report.routes.map(item=>summary(item,targets).split('\t'))]));return 0;
  }
  if(!route.startsWith('/'))throw new ConfigError('Provide an absolute route path such as /docs');
  const explanation=await explainRoute(options.project,route,base);
  if(!explanation.matched){
    if(options.json)print(explanation);else print(`no route selects ${route}${explanation.nearest.length?`; nearest: ${explanation.nearest.join(', ')}`:''}\n`);
    return 1;
  }
  print(options.json?explanation:detail(explanation,targets));return 0;
}
