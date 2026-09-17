import { readFile, realpath, stat } from 'node:fs/promises';
import { relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { functionFile } from './config.ts';
import { collectFunctionSources, routeFunctions } from './function-sources.ts';
import type { FunctionDefinition, FunctionSources } from './function-sources.ts';
import { assert } from './errors.ts';
import type { LoadedDocument } from './types.ts';

/** The operator's binding grants: which env and secret names each route may read, pinned to a project hash. */
export interface OperatorPolicy { version: 1; projectSha256: string; routes: Record<string, { env?: string[]; secrets?: string[] }> }
/** The function snapshot plus the hash operator grants are pinned to. */
export interface FunctionSnapshot extends FunctionSources { projectSha256: string }

export async function prepareFunctionSnapshot(loaded: LoadedDocument): Promise<FunctionSnapshot> {
  const definitions: { pattern: string; function: FunctionDefinition }[] = [];
  for (const [pattern,route] of Object.entries(loaded.routes)) for (const definition of routeFunctions(route)) definitions.push({pattern,function:{
    source:await functionFile(loaded.root,definition.source),export:definition.export || 'default',
  }});
  const collected = await collectFunctionSources(definitions,loaded.root);
  const sources = Object.fromEntries(Object.entries(collected.sources).sort(([a],[b])=>a < b ? -1 : a > b ? 1 : 0));
  // Generated site routes carry no bindings and depend on the origin, so they
  // stay out of the hash that operator grants are pinned to.
  const declared = Object.fromEntries(Object.entries(loaded.routes).filter(([,route])=>!route.generated));
  const snapshot: FunctionSnapshot = { ...collected, projectSha256: createHash('sha256').update(JSON.stringify({routes:declared,...(loaded.document.dynamicLinks===true?{dynamicLinks:true}:{}),sources})).digest('hex') };
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
    assert(Object.keys(grant).every(k=>['env','secrets'].includes(k)), 'Unsupported policy capability');
    for (const list of Object.values(grant)) assert(Array.isArray(list) && list.length <= 64 && list.every(n=>typeof n === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)), 'Invalid binding grant');
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
  return {version:1,projectSha256:snapshot.projectSha256,routes:Object.fromEntries(Object.entries(loaded.routes).flatMap(([path,route]): [string, { env: string[]; secrets: string[] }][] => {
    const env = Object.values(route.env || {}).flatMap(ref=>ref.env ? [ref.env] : []);
    const secrets = Object.values(route.secrets || {}).map(ref=>ref.secret);
    return env.length || secrets.length ? [[path,{env:[...new Set(env)],secrets:[...new Set(secrets)]}]] : [];
  }))};
}
