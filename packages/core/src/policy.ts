import { egressUrl } from './egress.ts';
import { readFile, realpath, stat } from 'node:fs/promises';
import { relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { functionFile } from './config.ts';
import { collectFunctionSources, collectTrustedSources, routeFunctions } from './function-sources.ts';
import type { FunctionDefinition, FunctionRoute, FunctionSources } from './function-sources.ts';
import { assert, routeError } from './errors.ts';
import type { LoadedDocument } from './types.ts';

interface EgressGrants { proxy?:string[]; signals?:string[] }
interface RouteGrant { env?:string[]; secrets?:string[]; egress?:EgressGrants }
/** The operator's binding grants: which env and secret names each route may read, pinned to a project hash. */
export interface OperatorPolicy { version: 1; projectSha256: string; routes: Record<string, RouteGrant> }
/** The function snapshot plus the hash operator grants are pinned to. */
interface FunctionSnapshot extends FunctionSources { projectSha256: string }

export async function prepareFunctionSnapshot(loaded: LoadedDocument): Promise<FunctionSnapshot> {
  // Only `sandbox: true` routes are bundled into the QuickJS module snapshot
  // FunctionPool loads (docs/SPIKE-DEFAULT-TRUST-MODEL.md): a trusted route's
  // module never needs to satisfy the sandbox's relative-static-import-only
  // rule or its per-module/total byte budgets, since it runs through Node's
  // own module resolution, not the WASM guest.
  const sandboxed: { pattern: string; function: FunctionDefinition }[] = [];
  const trusted: FunctionRoute[] = [];
  const resolveOne = async (definition: { source: string; export?: string }): Promise<FunctionDefinition> =>
    ({source:await functionFile(loaded.root,definition.source),export:definition.export || 'default'});
  for (const [pattern,route] of Object.entries(loaded.routes)) {
    if (!routeFunctions(route).length) continue;
    let middleware: FunctionDefinition[], fn: FunctionDefinition | undefined;
    try {
      middleware = await Promise.all((route.middleware || []).map(resolveOne));
      fn = route.function ? await resolveOne(route.function) : undefined;
    } catch (error) { throw routeError(error, pattern); }
    if (route.sandbox) { for (const definition of [...middleware, ...(fn ? [fn] : [])]) sandboxed.push({pattern,function:definition}); }
    else trusted.push({middleware, function: fn});
  }
  // Extension hooks are a core primitive even though their names and payloads
  // belong to each extension. Include every declared entry module in the
  // reviewed project revision, so editing trusted hook code invalidates the
  // operator's extension pin just like editing a trusted route function.
  for(const [extension,declaration] of Object.entries(loaded.document.extensions??{})){
    const hooks=declaration.config.hooks;
    if(hooks===undefined)continue;
    assert(hooks&&typeof hooks==='object'&&!Array.isArray(hooks),`Extension ${extension} hooks must be an object`);
    for(const [name,raw] of Object.entries(hooks as Record<string,unknown>)){
      assert(typeof raw==='string'||raw&&typeof raw==='object'&&!Array.isArray(raw),`Invalid extension hook: ${extension}.${name}`);
      const reference=typeof raw==='string'?{source:raw}:raw as {source?:unknown;export?:unknown};
      assert(typeof reference.source==='string',`Invalid extension hook: ${extension}.${name}`);
      assert(reference.export===undefined||typeof reference.export==='string',`Invalid extension hook: ${extension}.${name}`);
      trusted.push({function:await resolveOne({source:reference.source,...(reference.export===undefined?{}:{export:reference.export as string})})});
    }
  }
  const collected = await collectFunctionSources(sandboxed,loaded.root);
  const trustedSources = await collectTrustedSources(trusted,loaded.root);
  // The hash operator grants pin to still covers trusted routes' own source, so
  // an env/secret grant is invalidated when the trusted code that could use it
  // changes, even though that code never enters collectFunctionSources's
  // sandbox-shaped snapshot (see collectTrustedSources for what this does not
  // catch: changes to a helper module a trusted entry imports but does not
  // itself change).
  const sources = Object.fromEntries(Object.entries({...collected.sources,...trustedSources}).sort(([a],[b])=>a < b ? -1 : a > b ? 1 : 0));
  // Generated site routes carry no bindings and depend on the origin, so they
  // stay out of the hash that operator grants are pinned to. Declared site and
  // inherited policy/profile behavior are included: changing a pre-egress
  // restriction must require a fresh operator review even if routes are unchanged.
  const declared = Object.fromEntries(Object.entries(loaded.routes).filter(([,route])=>!route.generated));
  const snapshot: FunctionSnapshot = { ...collected, projectSha256: createHash('sha256').update(JSON.stringify({...(loaded.document.extensions?{extensions:loaded.document.extensions}:{}),routes:declared,...(loaded.document.policies?{policies:loaded.document.policies}:{}),...(loaded.document.profiles?{profiles:loaded.document.profiles}:{}),...(loaded.document.site?{site:loaded.document.site}:{}),sources})).digest('hex') };
  return snapshot;
}
export function validatePolicy(value: unknown): OperatorPolicy {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Invalid operator policy');
  const policy = value as Record<string, unknown>; // trust boundary: operator JSON, checked field by field below
  assert(Object.keys(policy).every(k=>['version','projectSha256','routes'].includes(k)) && policy.version === 1 && typeof policy.projectSha256 === 'string' && /^[a-f0-9]{64}$/.test(policy.projectSha256), 'Policy requires version 1 and projectSha256');
  const routes = policy.routes;
  assert(routes && typeof routes === 'object' && !Array.isArray(routes), 'Policy requires route grants');
  for (const [path,grant] of Object.entries(routes)) {
    assert(path.startsWith('/') && grant && typeof grant === 'object' && !Array.isArray(grant), 'Invalid route grant');
    assert(Object.keys(grant).every(k=>['env','secrets','egress'].includes(k)), 'Unsupported policy capability');
    const record=grant as RouteGrant;
    if(record.egress!==undefined) {
      assert(record.egress&&typeof record.egress==='object'&&!Array.isArray(record.egress)&&Object.keys(record.egress).every(key=>['proxy','signals'].includes(key)),'Invalid egress grant');
      for(const origins of Object.values(record.egress)){assert(Array.isArray(origins)&&origins.length<=64,'Invalid egress origins');for(const origin of origins){const url=egressUrl(origin);assert(url.origin===origin,'Egress grants must be exact HTTPS origins');}}
    }
    for (const list of [record.env,record.secrets].filter(value=>value!==undefined)) assert(Array.isArray(list) && list.length <= 64 && list.every(n=>typeof n === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)), 'Invalid binding grant');
  }
  return value as OperatorPolicy; // every field was just checked
}
export async function loadOperatorPolicy(file: string | undefined, project: string): Promise<OperatorPolicy | undefined> {
  if (!file) return undefined;
  const root = await realpath(project), path = await realpath(file);
  const rel = relative(root,path);
  assert(isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep), 'Operator policy must be outside the application project');
  assert((await stat(path)).size <= 65536, 'Policy exceeds 64 KiB');
  return validatePolicy(JSON.parse(await readFile(path,'utf8')));
}
export function requestedPermissions(loaded: LoadedDocument, snapshot: { projectSha256: string }): OperatorPolicy {
  return {version:1,projectSha256:snapshot.projectSha256,routes:Object.fromEntries(Object.entries(loaded.routes).flatMap(([path,route]): [string, RouteGrant][] => {
    const env = Object.values(route.env || {}).flatMap(ref=>ref.env ? [ref.env] : []);
    const secrets = Object.values(route.secrets || {}).map(ref=>ref.secret);
    const egress:EgressGrants={...(route.proxy?{proxy:[egressUrl(route.proxy.url).origin]}:{}),...(route.signals?.length?{signals:[...new Set(route.signals.map(signal=>egressUrl(signal.url).origin))]}:{})};
    return env.length || secrets.length || Object.keys(egress).length ? [[path,{env:[...new Set(env)],secrets:[...new Set(secrets)],...(Object.keys(egress).length?{egress}:{})}]] : [];
  }))};
}

/** Called before resources or credentials are activated. Grants never come from YAML. */
export function authorizeEgress(loaded:LoadedDocument,projectSha256:string,policy:OperatorPolicy|undefined):{proxy:string[];signals:string[]} {
 const proxy=new Set<string>(),signals=new Set<string>();
 for(const [path,route] of Object.entries(loaded.routes))for(const [purpose,urls]of [['proxy',route.proxy?[route.proxy.url]:[]],['signals',route.signals?.map(signal=>signal.url)||[]]] as const)for(const destination of urls){
  const origin=egressUrl(destination).origin;
  assert(policy?.projectSha256===projectSha256&&policy.routes[path]?.egress?.[purpose]?.includes(origin),'Egress denied by revision-pinned operator policy');
  (purpose==='proxy'?proxy:signals).add(origin);
 }
 assert(proxy.size<=64&&signals.size<=64,'Runtime egress origins exceed limit');return {proxy:[...proxy],signals:[...signals]};
}
