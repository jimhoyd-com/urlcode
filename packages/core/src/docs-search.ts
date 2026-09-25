import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDescriptor, readAddonCatalog, readAddonManifest } from './addon-manifest.ts';
import type { AddonCatalog, AddonDescriptor, AddonKind, AddonManifest } from './addon-manifest.ts';
import { lockPackages, pinProblem, readJson } from './addon-install.ts';
import type { PackageJson } from './addon-install.ts';
import { isCode, isRecord } from './object-guards.ts';
import { getSchemaFragment } from './schema-query.ts';

/**
 * Bounded documentation search for agents (`searchDocs`, MCP `search_docs`, `urlcode docs search`; #759).
 *
 * Three kinds of source, kept apart in the result:
 * - core: a fixed list of documents packaged with this runtime;
 * - installed: the guides and static `urlcode.json` descriptors of add-ons installed in the project's site
 *   (`<site>/node_modules/@jimhoyd/urlcode-<name>`), only for add-ons core's own manifest pins and whose lock entry
 *   matches that pin. Each file is read as text or JSON data; no add-on module is imported or activated, no host file
 *   is loaded and no binding or secret is read;
 * - catalog: this release's add-on catalog, which says an add-on exists, never that the project has it.
 *
 * Every answer states which sources were searched and which were not, and a focused next step. An empty answer means
 * no match in the searched sources, never that a feature is unsupported.
 */

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const coreDocs = [
  { id: 'llms', title: 'URLCode agent index', file: 'llms.txt', summary: 'Compact map of the framework, its declarative primitives and the minimum reference to load next.' },
  { id: 'authoring', title: 'AI authoring', file: 'docs/AI-AUTHORING.md', summary: 'Declarative-first authoring workflow, retrieval order and framework constraints.' },
  { id: 'yaml-reference', title: 'YAML reference', file: 'docs/YAML-REFERENCE.md', summary: 'Generated inventory of accepted URLCode YAML fields.' },
  { id: 'tooling', title: 'Tooling and local MCP', file: 'docs/TOOLING.md', summary: 'Bounded local project inspection, validation and MCP tool behavior.' },
  { id: 'security', title: 'Function security', file: 'docs/FUNCTION-SECURITY.md', summary: 'Trusted versus sandboxed function behavior, bindings and operator grants.' },
] as const;
/** What the search can read, for scripts/check-agent-facts.ts and the docs; derived facts, not prose. */
export const docsSearchScope = {
  core: coreDocs.map(doc => doc.file),
  installed: ['urlcode.json', 'README.md', 'descriptor agent references (.md/.json)'],
  catalog: 'dist/addon-catalog.json',
  maxResults: 3,
  maxCatalogMatches: 5,
  maxExcerpt: 1800,
} as const;

const maxResults = docsSearchScope.maxResults, maxCatalog = docsSearchScope.maxCatalogMatches, maxExcerpt = docsSearchScope.maxExcerpt;
/** Per-file read limit and per-add-on file limit: a larger file is reported as not searched rather than read. */
const maxFileBytes = 256 * 1024, maxFilesPerAddon = 6;

export interface DocsSearchOptions {
  /** The route project (MCP's operator-selected root, the CLI's `--project`). Its parent directory is the site whose installed add-ons are searched. */
  project?: string;
}
export type DocsSource = 'core' | 'installed';
export interface DocsSearchResult {
  id: string; title: string; source: DocsSource; path: string; summary: string; matched: string[]; excerpt: string;
  section?: string; package?: string; version?: string | null; kind?: AddonKind; configPath?: string; next: string;
}
export interface DocsCatalogMatch {
  name: string; kind: AddonKind; package: string; description: string; matched: string[];
  availability: 'release-catalog'; installedInProject: boolean | null; next: string;
}
export interface DocsCoverageGap { source: string; reason: string; names?: string[] }
export interface DocsSearch {
  query: string;
  results: DocsSearchResult[];
  catalog: DocsCatalogMatch[];
  coverage: {
    searched: { core: string[]; installed: { package: string; version: string | null; files: string[] }[]; catalog: string | null };
    notSearched: DocsCoverageGap[];
  };
  next: string[];
  note?: string;
}

interface Query { raw: string; phrase: string; words: string[]; tokens: string[] }
function parseQuery(query: string): Query {
  const phrase = query.trim().toLowerCase().slice(0, 256);
  const tokens = [...new Set(query.trim().split(/\s+/).map(token => token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')).filter(token => token.length > 1))].slice(0, 16);
  const words = [...new Set(phrase.split(/[^a-z0-9]+/).filter(term => term.length > 1))].slice(0, 16);
  return { raw: query, phrase, words, tokens };
}

interface Candidate { id: string; title: string; source: DocsSource; path: string; summary: string; text: string; json?: unknown; package?: string; version?: string | null; kind?: AddonKind; addon?: string; descriptorFile?: boolean }
interface Scored { candidate: Candidate; matched: string[]; score: number }

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at >= 0 && count < 20; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}
function score(candidate: Candidate, query: Query): Scored | undefined {
  const haystack = `${candidate.title} ${candidate.summary} ${candidate.text}`.toLowerCase();
  const matched = query.words.filter(word => haystack.includes(word));
  if (!matched.length) return undefined;
  const phrase = query.phrase.length > 1 && haystack.includes(query.phrase);
  // An add-on named by the whole query (for example "form-records") is the authoritative page for it.
  const named = candidate.addon !== undefined && query.tokens.some(token => token.toLowerCase() === candidate.addon);
  const value = (phrase ? 100 : 0) + (named ? 60 : 0) + matched.length * 10 + Math.min(9, occurrences(haystack, phrase ? query.phrase : matched[0]!));
  return { candidate, matched, score: value };
}

/** The nearest Markdown heading starting at or before `position`. */
function sectionAt(text: string, position: number): { title: string; index: number } | undefined {
  let found: { title: string; index: number } | undefined;
  for (const heading of text.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)) { if (heading.index > position) break; found = { title: heading[1]!, index: heading.index }; }
  return found;
}
/**
 * Where an excerpt starts: an occurrence of the whole phrase when there is one, else of the rarest matched word
 * (common words such as "form" say little about where the answer is). Among the first twenty occurrences, one that
 * opens a section (in or just below a heading) or a line wins over a passing mention.
 */
function focus(text: string, query: Query): number {
  const lower = text.toLowerCase();
  const needle = query.phrase.length > 1 && lower.includes(query.phrase) ? query.phrase
    : query.words.filter(word => lower.includes(word)).sort((a, b) => occurrences(lower, a) - occurrences(lower, b) || lower.indexOf(a) - lower.indexOf(b))[0];
  if (needle === undefined) return 0;
  let best = lower.indexOf(needle), bestRank = -1;
  for (let at = best, seen = 0; at >= 0 && seen < 20; at = lower.indexOf(needle, at + needle.length), seen++) {
    const lineStart = lower.lastIndexOf('\n', at - 1) + 1, line = lower.slice(lineStart, at);
    const recentHeading = /(?:^|\n)#{1,6}[ \t][^\n]*\n(?:[ \t]*\n)?[^\n]*$/.test(lower.slice(Math.max(0, lineStart - 200), at));
    const rank = (/^#{1,6}[ \t]/.test(line) ? 3 : 0) + (recentHeading ? 2 : 0) + (/^[\s`*_-]*$/.test(line) ? 1 : 0);
    if (rank > bestRank) { best = at; bestRank = rank; }
  }
  return best;
}
function textExcerpt(text: string, query: Query): { excerpt: string; section?: string } {
  const at = focus(text, query), heading = sectionAt(text, at);
  // Start at the section heading when it is close, so the excerpt reads from where the reader would; else a line
  // boundary about 300 characters before the match.
  const start = heading && at - heading.index <= 600 ? heading.index : at < 300 ? 0 : text.lastIndexOf('\n', at - 300) + 1;
  return { excerpt: text.slice(start, start + maxExcerpt), ...(heading === undefined ? {} : { section: heading.title }) };
}

/** The first key (else string value) in `value` that contains the phrase or a query word, as a JSON pointer. */
function jsonHit(value: unknown, query: Query): { pointer: string[]; node: unknown } | undefined {
  const needles = [query.phrase, ...[...query.words].sort((a, b) => b.length - a.length)].filter(needle => needle.length > 1);
  for (const needle of needles) {
    const stack: { pointer: string[]; node: unknown }[] = [{ pointer: [], node: value }];
    let valueHit: { pointer: string[]; node: unknown } | undefined;
    for (let visited = 0; stack.length && visited < 20000; visited++) {
      const { pointer, node } = stack.shift()!;
      if (Array.isArray(node)) node.forEach((item, index) => stack.push({ pointer: [...pointer, String(index)], node: item }));
      else if (isRecord(node)) {
        for (const [key, child] of Object.entries(node)) {
          if (key.toLowerCase().includes(needle)) return { pointer: [...pointer, key], node: child };
          stack.push({ pointer: [...pointer, key], node: child });
        }
      } else if (valueHit === undefined && typeof node === 'string' && node.toLowerCase().includes(needle)) valueHit = { pointer, node };
    }
    if (valueHit) return valueHit;
  }
  return undefined;
}
/** A JSON Schema pointer inside a descriptor's `schema`/`policySchema`, as the YAML path it validates. */
function configPathOf(addon: string, pointer: string[]): string | undefined {
  const [root, ...rest] = pointer;
  let path = root === 'schema' ? `extensions.${addon}.config` : root === 'policySchema' ? `policies.extensions.${addon}` : undefined;
  if (path === undefined) return undefined;
  for (let index = 0; index < rest.length; index++) {
    const segment = rest[index]!;
    if (segment === 'properties' && rest[index + 1] !== undefined) { path += `.${rest[++index]!}`; continue; }
    if (segment === 'additionalProperties') { path += '.*'; continue; }
    if (segment === 'patternProperties' && rest[index + 1] !== undefined) { index++; path += '.*'; continue; }
    if (segment === 'items') { path += '[]'; continue; }
    if ((segment === 'oneOf' || segment === 'anyOf' || segment === 'allOf') && /^\d+$/.test(rest[index + 1] ?? '')) { index++; continue; }
    break;
  }
  return path;
}
function jsonExcerpt(candidate: Candidate, query: Query): { excerpt: string; section?: string; configPath?: string } {
  const descriptor = candidate.descriptorFile && isRecord(candidate.json) ? candidate.json : undefined;
  if (descriptor && candidate.addon !== undefined && query.tokens.some(token => token.toLowerCase() === candidate.addon)) {
    // The query names this add-on: its contract summary, not the first key that happens to contain the name.
    const schema = isRecord(descriptor.schema) && isRecord(descriptor.schema.properties) ? Object.keys(descriptor.schema.properties) : [];
    const summary = { description: descriptor.description, requires: descriptor.requires, ...(descriptor.uses ? { uses: descriptor.uses } : {}), ...(descriptor.contributes ? { contributes: descriptor.contributes } : {}), ...(candidate.kind === 'extension' ? { configProperties: schema } : {}) };
    return { excerpt: JSON.stringify(summary, null, 1).slice(0, maxExcerpt), section: candidate.kind === 'extension' ? '/schema' : '/', ...(candidate.kind === 'extension' ? { configPath: `extensions.${candidate.addon}.config` } : {}) };
  }
  const hit = jsonHit(candidate.json, query);
  if (!hit) return { excerpt: candidate.text.slice(0, maxExcerpt) };
  const key = hit.pointer.at(-1), body = JSON.stringify(hit.node, null, 1) ?? '';
  const configPath = candidate.descriptorFile && candidate.addon ? configPathOf(candidate.addon, hit.pointer) : undefined;
  return { excerpt: `${key === undefined ? '' : `${JSON.stringify(key)}: `}${body}`.slice(0, maxExcerpt), section: '/' + hit.pointer.map(part => part.replaceAll('~', '~0').replaceAll('/', '~1')).join('/'), ...(configPath === undefined ? {} : { configPath }) };
}

function nextFor(candidate: Candidate, section: string | undefined, configPath: string | undefined): string {
  if (candidate.source === 'core') return section ? `Read only the "${section}" section of ${candidate.path} (packaged with @jimhoyd/urlcode).` : `Read only the matching part of ${candidate.path} (packaged with @jimhoyd/urlcode).`;
  const location = `node_modules/${candidate.package}/${candidate.path}`;
  if (candidate.descriptorFile) return `${configPath ? `The schema for ${configPath} is at ${section} in ${location}. ` : `See ${section ?? 'the descriptor'} in ${location}. `}With the operator host file, get_extensions (or urlcode extensions --host-file host.mjs --json) returns the registered schema and checks; then validate the project.`;
  if (candidate.kind === 'artifact') return `Read ${candidate.path} of the installed artifact with get_extension_artifact {name: "${candidate.addon}", path: "${candidate.path}"}.`;
  return section ? `Read only the "${section}" section of ${location} (this site's installed, pin-verified copy).` : `Read only the matching part of ${location} (this site's installed, pin-verified copy).`;
}

async function readBounded(directory: string, path: string): Promise<{ text: string } | { problem: string }> {
  const root = await realpath(directory), file = await realpath(join(directory, path)).catch(() => undefined);
  if (file === undefined) return { problem: `${path} is missing` };
  const inside = relative(root, file);
  if (inside.startsWith('..') || inside.includes(`..${sep}`) || resolve(root, inside) !== file) return { problem: `${path} resolves outside the package` };
  const stats = await lstat(file);
  if (!stats.isFile()) return { problem: `${path} is not a regular file` };
  if (stats.size > maxFileBytes) return { problem: `${path} is larger than the ${maxFileBytes / 1024} KiB search limit` };
  return { text: await readFile(file, 'utf8') };
}

interface Installed { candidates: Candidate[]; searched: DocsSearch['coverage']['searched']['installed']; gaps: DocsCoverageGap[]; names: Set<string> }
/** Guides and descriptors of add-ons installed, and pinned by core, in the site around `project`. Reads data only. */
async function installedSources(project: string, manifest: AddonManifest): Promise<Installed> {
  const site = dirname(resolve(project)), result: Installed = { candidates: [], searched: [], gaps: [], names: new Set() };
  let pkg: PackageJson;
  try { pkg = await readJson<PackageJson>(join(site, 'package.json')); }
  catch (error) { if (isCode(error, 'ENOENT') || error instanceof SyntaxError) { result.gaps.push({ source: 'installed add-on guides and descriptors', reason: `${site} has no readable package.json, so no installed add-on was found` }); return result; } throw error; }
  const lock = await lockPackages(site), dependencies = pkg.dependencies ?? {};
  for (const [name, pin] of Object.entries(manifest.addons).sort(([left], [right]) => left.localeCompare(right))) {
    if (!Object.hasOwn(dependencies, pin.package)) continue;
    const problem = pinProblem(lock, pin);
    if (problem) { result.gaps.push({ source: pin.package, reason: `installed but not pin-verified (${problem}); not read` }); continue; }
    const directory = join(site, 'node_modules', pin.package);
    let descriptor: AddonDescriptor;
    try {
      const read = await readBounded(directory, 'urlcode.json');
      if ('problem' in read) { result.gaps.push({ source: pin.package, reason: read.problem }); continue; }
      descriptor = parseDescriptor(JSON.parse(read.text), `${pin.package}/urlcode.json`);
      if (descriptor.name !== name) { result.gaps.push({ source: pin.package, reason: `its urlcode.json names ${descriptor.name}, not ${name}` }); continue; }
      const manifestFile = await readBounded(directory, 'package.json');
      let installedVersion: string | null = null;
      if ('text' in manifestFile) { try { const parsedPackage: unknown = JSON.parse(manifestFile.text); if (isRecord(parsedPackage) && typeof parsedPackage.version === 'string') installedVersion = parsedPackage.version.slice(0, 64); } catch { /* version stays unknown */ } }
      const version = lock[`node_modules/${pin.package}`]?.version ?? installedVersion, files: string[] = [];
      const references = new Map((descriptor.agent?.references ?? []).map(reference => [reference.path, reference]));
      const paths = [...new Set(['urlcode.json', 'README.md', ...references.keys()])].slice(0, maxFilesPerAddon);
      for (const path of paths) {
        const content = path === 'urlcode.json' ? read : await readBounded(directory, path);
        if ('problem' in content) { if (!(path === 'README.md' && content.problem.endsWith('is missing'))) result.gaps.push({ source: `${pin.package}/${path}`, reason: content.problem }); continue; }
        const reference = references.get(path), isJson = path.endsWith('.json');
        let json: unknown;
        if (isJson) { try { json = JSON.parse(content.text); } catch { result.gaps.push({ source: `${pin.package}/${path}`, reason: 'not valid JSON' }); continue; } }
        result.candidates.push({
          id: `${name}:${path}`, source: 'installed', path, package: pin.package, version, kind: descriptor.kind, addon: name,
          title: reference?.name ?? (path === 'urlcode.json' ? `${name} ${descriptor.kind} descriptor and schema` : `${name} ${path}`),
          summary: reference?.description ?? (path === 'urlcode.json' ? descriptor.description : `${pin.package} ${path}`),
          text: content.text, ...(isJson ? { json } : {}), ...(path === 'urlcode.json' ? { descriptorFile: true } : {}),
        });
        files.push(path);
      }
      result.names.add(name);
      result.searched.push({ package: pin.package, version, files });
    } catch (error) { result.gaps.push({ source: pin.package, reason: `descriptor unreadable: ${error instanceof Error ? error.message : String(error)}` }); }
  }
  return result;
}

function schemaSuggestions(query: Query): string[] {
  const found: string[] = [];
  for (const token of query.tokens) {
    if (!/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(token)) continue;
    try { getSchemaFragment(token); found.push(`get_schema {path: "${token}"} (urlcode schema ${token}) returns the exact YAML schema for ${token}.`); } catch { /* not a schema path */ }
    if (found.length >= 2) break;
  }
  return found;
}

/**
 * Deterministic lexical search over a bounded, agent-facing corpus: the fixed core documents, and, when `project` is
 * given, the guides and descriptors of add-ons installed and pin-verified in its site. At most three excerpts of at
 * most 1800 characters, at most five catalog matches, plus the coverage of what was and was not searched.
 */
export async function searchDocs(query: string, options: DocsSearchOptions = {}): Promise<DocsSearch> {
  const parsed = parseQuery(query);
  if (!parsed.words.length) throw new Error('Search text must contain a word');
  const notSearched: DocsCoverageGap[] = [];
  const candidates: Candidate[] = await Promise.all(coreDocs.map(async doc => ({ id: doc.id, title: doc.title, source: 'core' as const, path: doc.file, summary: doc.summary, text: await readFile(packageRoot + doc.file, 'utf8') })));

  const manifest = await readAddonManifest().catch((error: unknown) => { notSearched.push({ source: 'installed add-on guides and descriptors', reason: `this core has no add-on manifest to verify installed add-ons against (${error instanceof Error ? error.message : String(error)})` }); return undefined; });
  const catalog: AddonCatalog | undefined = await readAddonCatalog().catch((error: unknown) => { notSearched.push({ source: 'release add-on catalog', reason: error instanceof Error ? error.message : String(error) }); return undefined; });
  let installed: Installed = { candidates: [], searched: [], gaps: [], names: new Set() };
  if (options.project === undefined) notSearched.push({ source: 'installed add-on guides and descriptors', reason: 'no project was given, so no site was inspected; MCP search_docs and urlcode docs search --project DIR pass one' });
  else if (manifest) installed = await installedSources(options.project, manifest);
  candidates.push(...installed.candidates);
  notSearched.push(...installed.gaps);

  const hits = candidates.map(candidate => score(candidate, parsed)).filter((hit): hit is Scored => hit !== undefined)
    .sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id)).slice(0, maxResults);
  const results: DocsSearchResult[] = hits.map(({ candidate, matched }) => {
    const { excerpt, section, configPath } = candidate.json !== undefined ? jsonExcerpt(candidate, parsed) : { ...textExcerpt(candidate.text, parsed), configPath: undefined };
    return {
      id: candidate.id, title: candidate.title, source: candidate.source, path: candidate.path, summary: candidate.summary, matched, excerpt,
      ...(section === undefined ? {} : { section }),
      ...(candidate.package === undefined ? {} : { package: candidate.package, version: candidate.version ?? null, kind: candidate.kind! }),
      ...(configPath === undefined ? {} : { configPath }),
      next: nextFor(candidate, section, configPath),
    };
  });

  const catalogMatches: DocsCatalogMatch[] = (catalog?.addons ?? []).map(entry => {
    const haystack = `${entry.name} ${entry.description} ${entry.agent?.description ?? ''} ${(entry.agent?.references ?? []).map(reference => `${reference.name} ${reference.description}`).join(' ')}`.toLowerCase();
    const matched = parsed.words.filter(word => haystack.includes(word));
    const named = parsed.tokens.some(token => token.toLowerCase() === entry.name);
    return { entry, matched, rank: (named ? 100 : 0) + matched.length };
  }).filter(hit => hit.matched.length > 0).sort((a, b) => b.rank - a.rank || a.entry.name.localeCompare(b.entry.name)).slice(0, maxCatalog).map(({ entry, matched }) => {
    const installedInProject = options.project === undefined || !manifest ? null : installed.names.has(entry.name);
    const add = `urlcode ${entry.kind === 'artifact' ? 'artifacts' : 'extensions'} add ${entry.name}`;
    return {
      name: entry.name, kind: entry.kind, package: entry.package, description: entry.description, matched, availability: 'release-catalog' as const, installedInProject,
      next: installedInProject === true ? `Installed in this site: its guide and descriptor are among the searched sources; search a specific field or section name.`
        : `Listed in this release's catalog, which is not evidence this project has it. Only if the task needs it, install it (${add}); its guide and descriptor are then searched here.`,
    };
  });

  const notInstalled = (catalog?.addons ?? []).map(entry => entry.name).filter(name => !installed.names.has(name));
  if (options.project !== undefined && manifest && notInstalled.length) notSearched.push({ source: 'guides of release-catalog add-ons not installed in this site', names: notInstalled, reason: 'only installed, pin-verified add-ons are read; the catalog records availability, not installation' });
  notSearched.push(
    { source: 'llms-full.txt and docs pages outside the core list', reason: 'not part of the bounded corpus; follow a result\'s section or the links in llms.txt' },
    { source: 'project files and add-on source code', reason: 'never read by this search; use get_context, inspect, explain or validate' },
    { source: 'operator host registrations', reason: 'registered state needs the operator host file: get_extensions (MCP with --host-file) or urlcode extensions --host-file host.mjs --json' },
  );

  const next = [...new Set([...results.slice(0, 2).map(result => result.next), ...schemaSuggestions(parsed)])];
  const answer: DocsSearch = {
    query,
    results,
    catalog: catalogMatches,
    coverage: { searched: { core: coreDocs.map(doc => doc.file), installed: installed.searched, catalog: catalog ? `dist/addon-catalog.json (${catalog.addons.length} add-ons, release ${catalog.version})` : null }, notSearched },
    next: [],
  };
  if (!results.length) {
    answer.note = 'No match in the searched sources. That is not evidence the feature is unsupported: the sources listed under coverage.notSearched were not read.';
    next.push('Try one exact field or capability name; get_capability NAME and search_recipes TEXT cover capabilities and recipes this search does not.');
    if (catalogMatches.some(match => match.installedInProject !== true)) next.push('A matching add-on is in the release catalog but not searched here; see catalog[].next.');
    if (options.project === undefined) next.push('Installed add-on guides were not searched: pass the project (urlcode docs search TEXT --project app; MCP search_docs always does).');
  }
  answer.next = next.slice(0, 4);
  return answer;
}
