import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { assert, ConfigError } from './errors.ts';
import { isListFile, isBundled, validatePattern } from './policies/agents.ts';

// Node-side loader for project-relative agent lists. The policy module itself
// has no filesystem access (it also runs in the Worker), so it delegates here
// on Node and expects the Worker build to attach the same data up front.
//
// A list file is the schema data/agents/*.json uses: either an array of
// entries or `{ entries: [...] }`, each entry `{ name?, pattern, ... }`.
export const MAX_LIST_ENTRIES = 4096;

function listPath(root, reference, routePattern) {
  assert(isListFile(reference) && !isAbsolute(reference), `${routePattern}: policies.agents list ${JSON.stringify(reference)} must be a project-relative path ending in .json`);
  const path = resolve(root, reference);
  const inside = relative(root, path);
  assert(inside && !inside.startsWith('..') && !inside.split(sep).includes('..'), `${routePattern}: policies.agents list ${JSON.stringify(reference)} must stay inside the project`);
  return path;
}

export async function loadListFile(root, reference, routePattern = 'project') {
  const path = listPath(root, reference, routePattern);
  let text;
  try { text = await readFile(path, 'utf8'); } catch (error) { throw new ConfigError(`${routePattern}: policies.agents list ${JSON.stringify(reference)} cannot be read (${error.code ?? error.message})`); }
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { throw new ConfigError(`${routePattern}: policies.agents list ${JSON.stringify(reference)} is not valid JSON (${error.message})`); }
  const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
  assert(Array.isArray(entries), `${routePattern}: policies.agents list ${JSON.stringify(reference)} must be an array of entries or {"entries": [...]}`);
  assert(entries.length <= MAX_LIST_ENTRIES, `${routePattern}: policies.agents list ${JSON.stringify(reference)} exceeds ${MAX_LIST_ENTRIES} entries`);
  return entries.map((entry, index) => {
    assert(entry && typeof entry === 'object' && typeof entry.pattern === 'string', `${routePattern}: policies.agents list ${JSON.stringify(reference)} entry ${index} needs a string "pattern"`);
    const problem = validatePattern(entry.pattern);
    assert(!problem, `${routePattern}: policies.agents list ${JSON.stringify(reference)} entry ${index} pattern ${JSON.stringify(entry.pattern)} rejected (${problem})`);
    return { name: typeof entry.name === 'string' ? entry.name : entry.pattern, pattern: entry.pattern };
  });
}

// Loads every `.json` reference once; bundled names need no loading.
export async function loadListFiles(references, root, routePattern) {
  assert(root, `${routePattern}: policies.agents list files need a project root`);
  const loaded = {};
  for (const reference of new Set(references)) {
    if (isBundled(reference) || !isListFile(reference)) continue;
    loaded[reference] = await loadListFile(root, reference, routePattern);
  }
  return loaded;
}

// For the Cloudflare build: returns the configuration with its project list
// files attached as `resolved`, so the Worker's synchronous compile finds them
// in the artifact. Bundled names are left alone; the Worker carries those.
export async function resolveLists(config, root, routePattern = 'project') {
  const references = [...(config?.deny ?? []), ...(config?.allow ?? [])].filter(isListFile);
  if (!references.length) return config;
  return { ...config, resolved: await loadListFiles(references, root, routePattern) };
}
