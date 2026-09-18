#!/usr/bin/env node
// Refreshes the bundled User-Agent lists under data/agents/ from pinned
// upstream revisions. Run it, review the diff, and open a pull request:
//
//   node scripts/sync-agent-lists.ts            # fetch, validate, write
//   node scripts/sync-agent-lists.ts --check    # exit 1 when files would change
//
// Behind an HTTPS proxy set NODE_USE_ENV_PROXY=1 so fetch honours HTTPS_PROXY
// and NODE_EXTRA_CA_CERTS. To move to a newer upstream, edit the pins below
// (tag plus the commit it resolves to) and rerun; the revision lands in every
// entry, in the list header, in `urlcode audit` output and in the docs table.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'data', 'agents');
const indexFile = join(dataDir, 'index.ts');
const check = process.argv.includes('--check');

/** One pinned upstream repository. */
export interface Source { repository: string; url: string; license: string; tag: string; commit: string; file: string; licenseFile: string; minimumDate?: string }
export type SourceName = 'ai-robots-txt' | 'crawler-user-agents';
/** How a bundled list derives from its source: every entry, or only those carrying `tag`. */
export interface ListSpec { source: SourceName; tag?: string; description: string }
/** One entry of data/agents/<list>.json. */
export interface AgentEntry { name: string; pattern: string; source: string; sourceRevision: string; addedAt: string }
/** The whole data/agents/<list>.json document. */
export interface AgentListFile {
  name: string; description: string;
  source: { repository: string; url: string; license: string; tag: string; commit: string; file: string; fetchedAt: string };
  entries: AgentEntry[];
}
/** One crawler-user-agents.json record, as far as the sync reads it. */
export interface CrawlerEntry { pattern: string; tags?: string[]; addition_date?: string }
/** The fetched upstream files, keyed by source. */
export interface Fetched { 'ai-robots-txt': Record<string, unknown>; 'crawler-user-agents': CrawlerEntry[] }
/** agents.ts's validatePattern: the problem with a pattern, or undefined when it fits the subset. */
export type Validate = (pattern: unknown) => string | undefined;
export interface Dropped { list: string; pattern: string; reason: string | undefined }

// Pinned upstreams. Both are MIT; crawler-user-agents was CC-SA before
// 2016-11-07, so only later revisions may be vendored (both pins are later).
export const sources: Record<SourceName, Source> = {
  'ai-robots-txt': {
    repository: 'ai-robots-txt/ai.robots.txt',
    url: 'https://github.com/ai-robots-txt/ai.robots.txt',
    license: 'MIT',
    tag: 'v1.52',
    commit: '2acefa38cce025b5cf9911a4415f26b7285c42e8',
    file: 'robots.json',
    licenseFile: 'LICENSE',
  },
  'crawler-user-agents': {
    repository: 'monperrus/crawler-user-agents',
    url: 'https://github.com/monperrus/crawler-user-agents',
    license: 'MIT',
    tag: 'v1.60.0',
    commit: '7baee040e86208bfaf24b2815fd8f322318bd2fa',
    file: 'crawler-user-agents.json',
    licenseFile: 'LICENSE',
    minimumDate: '2016-11-07',
  },
};

// The bundled list names, each with the source it derives from and how.
export const lists: Record<string, ListSpec> = {
  'ai-crawlers': { source: 'ai-robots-txt', description: 'AI training, search and assistant crawlers from ai.robots.txt (every agent in robots.json).' },
  crawlers: { source: 'crawler-user-agents', description: 'Every crawler, bot and automated client known to crawler-user-agents.' },
  seo: { source: 'crawler-user-agents', tag: 'seo', description: 'SEO and backlink crawlers: crawler-user-agents entries tagged "seo".' },
  monitoring: { source: 'crawler-user-agents', tag: 'monitoring', description: 'Uptime, performance and availability monitors: crawler-user-agents entries tagged "monitoring".' },
};

const raw = (source: Source, file: string) => `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${file}`;

async function fetchText(url: string): Promise<string> {
  let response: Response;
  try { response = await fetch(url); } catch (error) {
    const hint = process.env.HTTPS_PROXY && !process.env.NODE_USE_ENV_PROXY ? ' (HTTPS_PROXY is set; retry with NODE_USE_ENV_PROXY=1)' : '';
    const cause = error instanceof Error ? error.cause : undefined;
    const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
    throw new Error(`fetch ${url} failed: ${code ?? (error instanceof Error ? error.message : String(error))}${hint}`, { cause: error });
  }
  if (!response.ok) throw new Error(`fetch ${url} failed: HTTP ${response.status}`);
  return response.text();
}

// The policy module owns the pattern subset; import it after making sure the
// generated index exists, since the module imports the index on load.
async function loadValidator(): Promise<Validate> {
  if (!existsSync(indexFile)) {
    await mkdir(dataDir, { recursive: true });
    await writeFile(indexFile, `${AGENT_LIST_TYPE}\nexport const lists: Record<string, AgentList> = {};\n`);
  }
  return (await import('../src/policies/agents.ts')).validatePattern;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
// A readable name for a crawler-user-agents pattern: its literal prefix.
function nameFromPattern(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? '';
    if (c === '\\') { out += pattern[++i] ?? ''; continue; }
    if (/[\^$()[\]|*+?{}.]/.test(c)) break;
    out += c;
  }
  return out.trim() || pattern;
}

// Rewrites a pattern into the subset where a mechanical fix exists, else
// returns undefined so the caller drops and reports it.
function fit(pattern: string, validate: Validate): string | undefined {
  const attempts = [pattern, pattern.replace(/\{(\d+),\}/g, '{$1,64}'), pattern.replace(/\((?!\?)/g, '(?:')];
  for (const attempt of attempts) if (!validate(attempt)) return attempt;
  return undefined;
}

async function previousEntries(list: string): Promise<Record<string, AgentEntry>> {
  // JSON boundary: the file was written by an earlier run of this script.
  try { return Object.fromEntries((JSON.parse(await readFile(join(dataDir, `${list}.json`), 'utf8')) as AgentListFile).entries.map(entry => [entry.pattern, entry])); }
  catch { return {}; }
}

export async function buildLists({ validate, fetched, today }: { validate: Validate; fetched: Fetched; today: string }): Promise<{ output: Record<string, AgentListFile>; dropped: Dropped[] }> {
  const output: Record<string, AgentListFile> = {}, dropped: Dropped[] = [];
  const revision = (source: Source) => `${source.tag}@${source.commit.slice(0, 12)}`;
  for (const [name, spec] of Object.entries(lists)) {
    const source = sources[spec.source];
    const previous = await previousEntries(name);
    const seen = new Map<string, string>();
    const entries: AgentEntry[] = [];
    const push = (entryName: string, pattern: string, addedAt?: string) => {
      const fitted = fit(pattern, validate);
      if (fitted === undefined) { dropped.push({ list: name, pattern, reason: validate(pattern) }); return; }
      if (seen.has(fitted)) return;
      let unique = entryName; for (let n = 2; [...seen.values()].includes(unique); n++) unique = `${entryName} (${n})`;
      seen.set(fitted, unique);
      entries.push({ name: unique, pattern: fitted, source: source.repository, sourceRevision: revision(source),
        addedAt: previous[fitted]?.addedAt ?? addedAt ?? today });
    };
    if (spec.source === 'ai-robots-txt') {
      for (const agent of Object.keys(fetched['ai-robots-txt'])) push(agent, escapeRegex(agent));
    } else {
      for (const entry of fetched['crawler-user-agents']) {
        if (spec.tag && !(entry.tags ?? []).includes(spec.tag)) continue;
        push(nameFromPattern(entry.pattern), entry.pattern, entry.addition_date?.replace(/\//g, '-'));
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    output[name] = { name, description: spec.description,
      source: { repository: source.repository, url: source.url, license: source.license, tag: source.tag, commit: source.commit, file: source.file, fetchedAt: today },
      entries };
  }
  return { output, dropped };
}

// The shape of one bundled list, as data/agents/index.ts exports it.
const AGENT_LIST_TYPE = 'export interface AgentList { source: string; revision: string; license: string; patterns: [string, string][] }';

export function renderIndex(output: Record<string, AgentListFile>): string {
  const compact = Object.fromEntries(Object.entries(output).map(([name, list]) => [name, {
    source: list.source.repository, revision: `${list.source.tag}@${list.source.commit.slice(0, 12)}`, license: list.source.license,
    patterns: list.entries.map(entry => [entry.name, entry.pattern]) }]));
  // One pattern per line keeps diffs reviewable without pretty-printing the
  // pairs themselves; the file ships inside the Worker bundle.
  const body = Object.entries(compact).map(([name, list]) => `  ${JSON.stringify(name)}: { source: ${JSON.stringify(list.source)}, revision: ${JSON.stringify(list.revision)}, license: ${JSON.stringify(list.license)}, patterns: [\n${list.patterns.map(pair => `    ${JSON.stringify(pair)},`).join('\n')}\n  ] },`).join('\n');
  return `// Generated by scripts/sync-agent-lists.ts. Do not edit; rerun the script.\n// Bundled User-Agent lists as [name, pattern] pairs; data/agents/<list>.json\n// carries the full entries and data/agents/LICENSES/ the upstream licences.\n${AGENT_LIST_TYPE}\nexport const lists: Record<string, AgentList> = {\n${body}\n};\n`;
}

async function main() {
  const validate = await loadValidator();
  const today = new Date().toISOString().slice(0, 10);
  const licenses: Record<string, string> = {};
  // JSON boundary: the pinned upstream files, validated per entry by `fit` below.
  const fetched: Fetched = {
    'ai-robots-txt': JSON.parse(await fetchText(raw(sources['ai-robots-txt'], sources['ai-robots-txt'].file))) as Fetched['ai-robots-txt'],
    'crawler-user-agents': JSON.parse(await fetchText(raw(sources['crawler-user-agents'], sources['crawler-user-agents'].file))) as Fetched['crawler-user-agents'],
  };
  for (const [key, source] of Object.entries(sources)) {
    licenses[key] = await fetchText(raw(source, source.licenseFile));
  }
  const { output, dropped } = await buildLists({ validate, fetched, today });
  const files: Record<string, string> = {};
  for (const [name, list] of Object.entries(output)) files[join(dataDir, `${name}.json`)] = JSON.stringify(list, null, 2) + '\n';
  files[indexFile] = renderIndex(output);
  for (const [key, source] of Object.entries(sources)) {
    files[join(dataDir, 'LICENSES', `${key}.txt`)] = `${source.url} at ${source.tag} (${source.commit})\nReproduced verbatim as Apache-2.0 section 4(d) requires; see NOTICE.\n\n${licenses[key]}`;
  }
  let changed = 0;
  for (const [path, content] of Object.entries(files)) {
    let current: string | undefined; try { current = await readFile(path, 'utf8'); } catch { current = undefined; }
    // fetchedAt alone must not make every run a diff.
    const same = current !== undefined && current.replace(/"fetchedAt": "[^"]+"/, '') === content.replace(/"fetchedAt": "[^"]+"/, '');
    if (same) continue;
    changed++;
    if (check) { console.log(`would change ${path}`); continue; }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  for (const [name, list] of Object.entries(output)) console.log(`${name}: ${list.entries.length} patterns from ${list.source.repository} ${list.source.tag}`);
  for (const drop of dropped) console.log(`dropped from ${drop.list}: ${JSON.stringify(drop.pattern)} (${drop.reason})`);
  if (check && changed) { console.error(`${changed} file(s) out of date; run node scripts/sync-agent-lists.ts`); process.exit(1); }
  console.log(check ? 'bundled agent lists are up to date' : `${changed} file(s) written`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
