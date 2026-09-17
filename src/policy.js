import { readFile, realpath, stat } from 'node:fs/promises';
import { relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { functionFile } from './config.js';
import { collectFunctionSources, routeFunctions } from './function-sources.js';
import { assert } from './errors.js';

export async function prepareFunctionSnapshot(loaded) {
  const definitions = [];
  for (const [pattern,route] of Object.entries(loaded.routes)) for (const definition of routeFunctions(route)) definitions.push({pattern,function:{
    source:await functionFile(loaded.root,definition.source),export:definition.export || 'default',
  }});
  const snapshot = await collectFunctionSources(definitions,loaded.root);
  const sources = Object.fromEntries(Object.entries(snapshot.sources).sort(([a],[b])=>a < b ? -1 : a > b ? 1 : 0));
  // Generated site routes carry no bindings and depend on the origin, so they
  // stay out of the hash that operator grants are pinned to.
  const declared = Object.fromEntries(Object.entries(loaded.routes).filter(([,route])=>!route.generated));
  snapshot.projectSha256 = createHash('sha256').update(JSON.stringify({routes:declared,...(loaded.document.dynamicLinks===true?{dynamicLinks:true}:{}),sources})).digest('hex');
  return snapshot;
}
export function validatePolicy(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Invalid operator policy');
  assert(Object.keys(value).every(k=>['version','projectSha256','routes'].includes(k)) && value.version === 1 && /^[a-f0-9]{64}$/.test(value.projectSha256), 'Policy requires version 1 and projectSha256');
  assert(value.routes && typeof value.routes === 'object' && !Array.isArray(value.routes), 'Policy requires route grants');
  for (const [path,grant] of Object.entries(value.routes)) {
    assert(path.startsWith('/') && grant && typeof grant === 'object' && !Array.isArray(grant), 'Invalid route grant');
    assert(Object.keys(grant).every(k=>['env','secrets'].includes(k)), 'Unsupported policy capability');
    for (const list of Object.values(grant)) assert(Array.isArray(list) && list.length <= 64 && list.every(n=>typeof n === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)), 'Invalid binding grant');
  }
  return value;
}
export async function loadOperatorPolicy(file, project) {
  if (!file) return undefined;
  const root = await realpath(project), path = await realpath(file);
  const rel = relative(root,path);
  assert(isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep), 'Operator policy must be outside the application project');
  assert((await stat(path)).size <= 65536, 'Policy exceeds 64 KiB');
  return validatePolicy(JSON.parse(await readFile(path,'utf8')));
}
export function requestedPermissions(loaded,snapshot) {
  return {version:1,projectSha256:snapshot.projectSha256,routes:Object.fromEntries(Object.entries(loaded.routes).flatMap(([path,route])=> {
    const env = Object.values(route.env || {}).flatMap(ref=>ref.env ? [ref.env] : []);
    const secrets = Object.values(route.secrets || {}).map(ref=>ref.secret);
    return env.length || secrets.length ? [[path,{env:[...new Set(env)],secrets:[...new Set(secrets)]}]] : [];
  }))};
}
