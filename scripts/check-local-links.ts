// Enforcing guard that shipped Markdown links at the tree it lives in (#200,
// #781, #916). It FAILS (exit 1). The generic part -- a relative link to a
// file that does not exist, and a `#fragment` naming no GitHub heading slug --
// is remark-validate-links, run offline (`repository: false`, so no git or
// network). This file keeps only what that tool cannot express (#1041):
//
//   retired-repository   A link to `jimhoyd-com/urlcode-<name>` where
//                        `packages/<name>/` exists: those repositories are
//                        retired, the package lives here.
//   local-issue-tracker  A local `issues/` or `backlog/` Markdown directory, or
//                        an `ISSUES.md`/`BACKLOG.md`. Work belongs in GitHub Issues.
//   shipped-link         A Markdown file a package ships (README.md and any
//                        root .md its `files` names) links a path outside the
//                        package or this repository's `blob/main`/`tree/main`.
//                        Link `blob/v<current version>/...` inside a
//                        `urlcode-current-version` block instead.
//   pinned links         `blob/v<current version>/` and `tree/v<current
//                        version>/` links to this repository are rewritten to
//                        checkout paths so the tool checks them; any other
//                        absolute URL is not checked.
//   explicit anchors     `<a id>` / `<a name>` count as fragment targets.
//   fragments            only on a Markdown target: `file.ts#L10` and a
//                        directory's fragment are GitHub's viewer, not a heading.
//
// `<!-- local-links: historical -->` exempts its line, or the paragraph after it
// when it stands alone; `<!-- local-links: historical-file -->` exempts the file.
// Use them only for text explicitly about a past release or superseded layout.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { remark } from 'remark';
import remarkValidateLinks from 'remark-validate-links';
import { engine, type Options as EngineOptions } from 'unified-engine';
import { VFile } from 'vfile';

const LINE_MARKER = '<!-- local-links: historical -->';
const FILE_MARKER = '<!-- local-links: historical-file -->';
const REPOSITORY = 'https://github.com/jimhoyd-com/urlcode/';
const RULES: Record<string, string> = { 'missing-file': 'dead-relative-link', 'missing-heading': 'dead-fragment', 'missing-heading-in-file': 'dead-fragment' };

/** The repository path (with any `#fragment`) a link to this repository pinned at `version` names, or undefined. */
export function pinnedRepositoryPath(target: string, version: string): string | undefined {
  for (const kind of ['blob', 'tree']) {
    const prefix = `${REPOSITORY}${kind}/v${version}/`;
    if (target.startsWith(prefix) && target.length > prefix.length) return target.slice(prefix.length);
  }
  return undefined;
}
/** Why `target`, linked from `file` that its package ships, cannot be followed from an installed copy; undefined when it can. */
export function shippedLinkProblem(file: string, target: string): string | undefined {
  if (/^https:\/\/github\.com\/jimhoyd-com\/urlcode\/(?:blob|tree)\/main(?:\/|$)/.test(target)) return `links \`${target}\`, this repository's main branch, from a file the package ships; an installed copy should read the docs of its own version: link \`blob/v<current version>/...\` inside a urlcode-current-version block.`;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) return undefined;
  const directory = file.slice(0, file.lastIndexOf('/') + 1), packageRoot = /^packages\/[^/]+\//.exec(file)?.[0];
  if (!packageRoot) return undefined;
  const resolved = new URL(target.replace(/[#?].*$/, ''), `file:///${directory}`).pathname.slice(1);
  return resolved.startsWith(packageRoot) ? undefined : `links \`${target}\`, outside ${packageRoot}, from a file the package ships; an installed copy has no such file: link this repository's \`blob/v<current version>/...\` inside a urlcode-current-version block.`;
}

async function markdownFiles(root: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && !['node_modules', 'dist', 'build', 'coverage'].includes(entry.name) && !entry.name.startsWith('.')) found.push(...(await markdownFiles(root, `${prefix}${entry.name}/`)));
    else if (entry.isFile() && (entry.name.endsWith('.md') || (prefix === '' && entry.name === 'llms.txt'))) found.push(`${prefix}${entry.name}`);
  }
  return found;
}

/** 1-based line numbers a historical marker exempts. */
function exemptLines(source: string): Set<number> {
  const exempt = new Set<number>();
  let state: 'none' | 'pending' | 'paragraph' = 'none';
  for (const [index, line] of source.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed === LINE_MARKER) { state = 'pending'; continue; }
    if (state === 'pending' && trimmed !== '') state = 'paragraph';
    if (state === 'paragraph' && trimmed === '') state = 'none';
    if (state === 'paragraph' || line.includes(LINE_MARKER)) exempt.add(index + 1);
  }
  return exempt;
}

interface MdNode { type: string; url?: string; value?: string; position?: { start: { line: number; column: number } }; data?: Record<string, unknown>; children?: MdNode[] }
export interface Failure { file: string; line: number; rule: string; detail: string }
interface Context { root: string; version: string; retired?: RegExp; shipped: Set<string>; counts: { links: number; fragments: number } }
const nameOf = (root: string, file: VFile): string => relative(root, resolve(file.cwd, file.path)).split(sep).join('/');
const each = (node: MdNode, visit: (node: MdNode) => void): void => { visit(node); for (const child of node.children ?? []) each(child, visit); };

/** Runs before remark-validate-links: reports the URLCode-only rules and turns every checkable link into a checkout path. */
function urlcodeLinks(context: Context) {
  return (tree: object, file: VFile): void => {
    const self = resolve(file.cwd, file.path), name = nameOf(context.root, file);
    const fail = (ruleId: string, reason: string, line: number): void => { file.message(reason, { place: { line, column: 1 }, ruleId, source: 'urlcode' }); };
    if (context.retired) for (const [index, line] of String(file.value).split('\n').entries()) {
      for (const match of line.matchAll(context.retired)) fail('retired-repository', `links \`${match[0]}\`, a retired repository. The package lives at \`packages/${match[1]}/\` in this checkout; link that instead.`, index + 1);
    }
    each(tree as MdNode, node => {
      const anchor = node.type === 'html' ? /^<a\s[^>]*?\b(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(node.value ?? '') : null;
      if (anchor) node.data = { ...node.data, hProperties: { id: anchor[1] ?? anchor[2] ?? anchor[3] } };
      if (typeof node.url !== 'string' || node.url === '') return;
      const line = node.position?.start.line ?? 1;
      const problem = context.shipped.has(name) ? shippedLinkProblem(name, node.url) : undefined;
      if (problem) { fail('shipped-link', problem, line); node.url = ''; return; }
      const pinned = pinnedRepositoryPath(node.url, context.version);
      if (pinned === undefined && /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(node.url)) { node.url = ''; return; }
      const [pathPart = '', fragment = ''] = (pinned ?? node.url).split(/#(.*)/s);
      const path = pathPart.replace(/\?.*$/s, '');
      const target = path === '' ? self : resolve(pinned === undefined ? dirname(self) : context.root, path);
      if (path !== '') context.counts.links += 1;
      let hash = '';
      if (fragment !== '' && target.endsWith('.md')) {
        context.counts.fragments += 1;
        try { hash = `#${decodeURIComponent(fragment)}`; } catch { hash = `#${fragment}`; }
      }
      node.url = relative(dirname(self), target) + hash;
    });
  };
}

/** Every link failure under `root`, or in `files` (virtual files are checked against `root` without being read). */
export async function checkLinks(root: string, files?: VFile[]): Promise<{ failures: Failure[]; scanned: number; links: number; fragments: number }> {
  const packages = (await readdir(join(root, 'packages'), { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory()).map(entry => entry.name);
  const shipped = new Set<string>();
  for (const name of packages) {
    const manifest = await readFile(join(root, 'packages', name, 'package.json'), 'utf8').then(text => JSON.parse(text) as { files?: unknown }, () => undefined);
    if (!manifest) continue;
    shipped.add(`packages/${name}/README.md`);
    if (Array.isArray(manifest.files)) for (const entry of manifest.files) if (typeof entry === 'string' && /^[^/]+\.md$/.test(entry)) shipped.add(`packages/${name}/${entry}`);
  }
  const version = (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string }).version;
  const context: Context = { root, version, shipped, counts: { links: 0, fragments: 0 }, ...(packages.length > 0 ? { retired: new RegExp(`jimhoyd-com/urlcode-(${packages.join('|')})\\b`, 'g') } : {}) };
  const inputs = files ?? (await markdownFiles(root)).map(file => new VFile({ path: join(root, file) }));
  const names = new Set(inputs.map(file => nameOf(root, file)));
  const failures: Failure[] = inputs.map(file => nameOf(root, file))
    .filter(file => /(?:^|\/)(?:issues?|backlog)(?:\/|\.md$)/i.test(file))
    .map(file => ({ file, line: 1, rule: 'local-issue-tracker', detail: 'repository-local issue trackers are prohibited; create or link the owning GitHub Issue instead.' }));
  const processed = await new Promise<VFile[]>((done, fail) => engine({
    processor: remark(), files: inputs, cwd: root, extensions: ['md'], output: false, out: false, silent: true, quiet: true, color: false,
    detectConfig: false, detectIgnore: false, reporter: () => '', streamError: { write: () => true } as unknown as NodeJS.WritableStream,
    // remark-validate-links needs the engine's file set, so it is an engine plugin; its own types do not fit the engine's.
    plugins: [() => urlcodeLinks(context), [remarkValidateLinks, { repository: false, root }]] as unknown as EngineOptions['plugins'],
  }, (error, _code, result) => { if (error) fail(error); else done(result?.files ?? []); }));
  for (const file of processed) {
    if (!names.has(nameOf(root, file)) || String(file.value).includes(FILE_MARKER)) continue;
    const exempt = exemptLines(String(file.value));
    for (const message of file.messages) {
      if (message.line !== undefined && exempt.has(message.line)) continue;
      failures.push({ file: nameOf(root, file), line: message.line ?? 1, rule: RULES[message.ruleId ?? ''] ?? message.ruleId ?? 'error', detail: message.reason });
    }
  }
  return { failures, scanned: inputs.length, ...context.counts };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { failures, scanned, links, fragments } = await checkLinks(fileURLToPath(new URL('../', import.meta.url)));
  if (failures.length > 0) {
    console.error(`Local-link check: ${failures.length} link(s) point outside this checkout or at nothing\n`);
    for (const failure of failures) console.error(`  ${failure.file}:${failure.line}  ${failure.rule}: ${failure.detail}`);
    console.error(`\nFix the link, or label genuinely historical evidence with ${LINE_MARKER}.`);
    process.exit(1);
  }
  console.log(`Local-link check: ${scanned} Markdown file(s), ${links} relative link(s), ${fragments} fragment(s), no retired-repository, dead or dead-fragment targets.`);
}
