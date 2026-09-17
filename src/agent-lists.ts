import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { assert, ConfigError } from './errors.ts';
import { isListFile, isBundled, validatePattern } from './policies/agents.ts';
import type { AgentEntry, AgentsConfig } from './policies/agents.ts';

// Node-side loader for project-relative agent lists. The policy module itself
// has no filesystem access (it also runs in the Worker), so it delegates here
// on Node and expects the Worker build to attach the same data up front.
//
// A list file is the schema data/agents/*.json uses: either an array of
// entries or `{ entries: [...] }`, each entry `{ name?, pattern, ... }`.
export const MAX_LIST_ENTRIES = 4096;

function listPath(root: string, reference: string, routePattern: string): string {
  assert(isListFile(reference) && !isAbsolute(reference), `${routePattern}: policies.agents list ${JSON.stringify(reference)} must be a project-relative path ending in .json`);
  const path = resolve(root, reference);
  const inside = relative(root, path);
  assert(inside && !inside.startsWith('..') && !inside.split(sep).includes('..'), `${routePattern}: policies.agents list ${JSON.stringify(reference)} must stay inside the project`);
  return path;
}

export async function loadListFile(root: string, reference: string, routePattern = 'project'): Promise<AgentEntry[]> {
  const path = listPath(root, reference, routePattern);
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (error) { const failure = error as NodeJS.ErrnoException; throw new ConfigError(`${routePattern}: policies.agents list ${JSON.stringify(reference)} cannot be read (${failure.code ?? failure.message})`); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (error) { throw new ConfigError(`${routePattern}: policies.agents list ${JSON.stringify(reference)} is not valid JSON (${(error as Error).message})`); }
  const entries: unknown = Array.isArray(parsed) ? parsed : (parsed as { entries?: unknown } | null)?.entries;
  assert(Array.isArray(entries), `${routePattern}: policies.agents list ${JSON.stringify(reference)} must be an array of entries or {"entries": [...]}`);
  assert(entries.length <= MAX_LIST_ENTRIES, `${routePattern}: policies.agents list ${JSON.stringify(reference)} exceeds ${MAX_LIST_ENTRIES} entries`);
  return entries.map((entry: unknown, index): AgentEntry => {
    const record = entry as { pattern?: unknown; name?: unknown } | null;
    assert(record && typeof record === 'object' && typeof record.pattern === 'string', `${routePattern}: policies.agents list ${JSON.stringify(reference)} entry ${index} needs a string "pattern"`);
    const problem = validatePattern(record.pattern);
    assert(!problem, `${routePattern}: policies.agents list ${JSON.stringify(reference)} entry ${index} pattern ${JSON.stringify(record.pattern)} rejected (${problem})`);
    return { name: typeof record.name === 'string' ? record.name : record.pattern, pattern: record.pattern };
  });
}

// Loads every `.json` reference once; bundled names need no loading.
export async function loadListFiles(references: string[], root: string | undefined, routePattern: string): Promise<Record<string, AgentEntry[]>> {
  assert(root, `${routePattern}: policies.agents list files need a project root`);
  const loaded: Record<string, AgentEntry[]> = {};
  for (const reference of new Set(references)) {
    if (isBundled(reference) || !isListFile(reference)) continue;
    loaded[reference] = await loadListFile(root, reference, routePattern);
  }
  return loaded;
}

// For the Cloudflare build: returns the configuration with its project list
// files attached as `resolved`, so the Worker's synchronous compile finds them
// in the artifact. Bundled names are left alone; the Worker carries those.
export async function resolveLists(config: AgentsConfig | undefined, root: string, routePattern = 'project'): Promise<AgentsConfig | undefined> {
  const references = [...(config?.deny ?? []), ...(config?.allow ?? [])].filter(isListFile);
  if (!references.length) return config;
  return { ...config, resolved: await loadListFiles(references, root, routePattern) };
}
