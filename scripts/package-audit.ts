import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { parsePackJson } from './pack-json.ts';
import { addons, repositoryRoot } from './workspaces.ts';
import { isArtifactFile } from '../packages/core/src/addon-install.ts';

interface PackedFile { path: string; size: number }
interface PackReport {
  name: string;
  size: number;
  unpackedSize: number;
  entryCount: number;
  files: PackedFile[];
}
export type PackageKind = 'core' | 'extension' | 'artifact';
export interface Budget {
  packed: number;
  unpacked: number;
  entries: number;
  roots: readonly string[];
  optionalPeers?: readonly string[];
}

// These are release budgets, not targets, keyed by package name. The allowlists
// keep repository-only material out; the sizes catch bloat, not routine growth.
// Which packages are audited is not listed here: `--all` audits core plus every
// add-on scripts/workspaces.ts finds, and an add-on without a budget below fails
// rather than being skipped.
//
// Policy: each limit is a Node 26 measurement (after `npm run build`, with
// `npm pack --dry-run --json --ignore-scripts`) plus a fixed margin, so ordinary
// PRs never edit this table. Core gets 24 KiB packed (about 2%), 2% unpacked and
// 2% entries; each add-on gets the larger of 10% and 6 KiB packed, of 10% and
// 24 KiB unpacked, and two entries. The margins also absorb CI's Node 24, which
// packs about 800 bytes larger. When a PR hits a limit and the growth is
// intended, re-measure every package and reset all of them by this policy
// rather than raising one by the overshoot, and say why in the PR.
// Baseline: 1060611/4192043/544 core, 27952/90551/26 audit, 21639/68688/14
// auth, 160256/624949/36 store, 33066/136737/12 mcp, 12733/50583/7
// store-schema (packed/unpacked bytes/entries), each limit rounded up to a KiB.
export const budgets: Record<string, Budget> = {
  '@jimhoyd/urlcode': {
    // #976/#977 on top of #1027: 1086691 packed / 4275527 unpacked bytes, 548 entries (Node 26); +800 bytes for Node 24, ~3 KiB headroom.
    packed: 1066 * 1024,
    // #976/#977 on top of #1027: 1086691 packed / 4275527 unpacked bytes, 548 entries (Node 26); +800 bytes for Node 24, ~3 KiB headroom.
    // #976/#977 on top of #1031: 1087004 packed / 4276331 unpacked bytes, 548 entries (Node 26); +800 bytes for Node 24, ~3 KiB headroom.
    // #1032 on top of #987: 1087622 packed / 4278186 unpacked bytes, 548 entries (Node 26); +800 bytes for Node 24, ~3 KiB headroom.
    unpacked: 4181 * 1024,
    entries: 555,
    roots: ['.claude', 'LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'data', 'dist', 'docs', 'examples', 'llms-full.txt', 'llms.txt', 'package.json', 'recipes', 'schemas', 'skills', 'starters'],
    optionalPeers: ['typescript'],
  },
  '@jimhoyd/urlcode-audit': {
    packed: 34 * 1024,
    unpacked: 113 * 1024,
    entries: 28,
    roots: ['LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'dist', 'package.json', 'urlcode.json'],
  },
  '@jimhoyd/urlcode-auth': {
    packed: 28 * 1024,
    unpacked: 92 * 1024,
    entries: 16,
    roots: ['LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'dist', 'package.json', 'urlcode.json'],
  },
  '@jimhoyd/urlcode-store': {
    packed: 173 * 1024,
    unpacked: 672 * 1024,
    entries: 38,
    roots: ['LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'dist', 'package.json', 'urlcode.json'],
  },
  '@jimhoyd/urlcode-mcp': {
    packed: 39 * 1024,
    unpacked: 158 * 1024,
    entries: 14,
    roots: ['LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'dist', 'package.json', 'urlcode.json'],
  },
  // Artifacts are inert JSON: a few KiB, and the exact file shape below.
  '@jimhoyd/urlcode-store-schema': {
    packed: 19 * 1024,
    unpacked: 74 * 1024,
    entries: 9,
    roots: ['LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'config', 'package.json', 'schemas', 'urlcode.json'],
  },
};


/**
 * Checks a package's `npm pack --dry-run` file list beyond its root allowlist: no installed dependency tree
 * (a `node_modules/` path) and no copy of core (`@jimhoyd/urlcode`) may ship inside any package, and an artifact
 * carries only the files core's `isArtifactFile` accepts. Returns one line per offending path.
 */
export function packFileProblems(kind: PackageKind, paths: readonly string[]): string[] {
  const problems: string[] = [];
  for (const path of paths) {
    if (/(?:^|\/)node_modules(?:\/|$)/.test(path)) problems.push(`${path}: node_modules/ must never ship`);
    else if (/(?:^|\/)@jimhoyd\/urlcode(?:[/-]|$)/.test(path)) problems.push(`${path}: a copy of @jimhoyd/urlcode (core or a sibling add-on) must never ship inside a package`);
    else if (kind === 'artifact' && !isArtifactFile(path)) problems.push(`${path}: an artifact carries only package.json, notices, and JSON, YAML or Markdown data`);
  }
  return problems;
}

const INLINE_LINK = /\[[^\]]*\]\(([^()\s]+)\)/g;
const REFERENCE_LINK = /^ {0,3}\[[^\]]+\]:\s+(\S+)/;

/** Whether a packed path is documentation an installed reader follows links in: Markdown and the llms indexes. */
export const isPackedDocument = (path: string): boolean => path.endsWith('.md') || path === 'llms.txt' || path === 'llms-full.txt';
/** This repository's main branch, which may already describe a later release than the one installed (#916, #938). */
const MAIN_BRANCH = /https:\/\/github\.com\/jimhoyd-com\/urlcode\/(?:blob|tree)\/main(?=[/)\s]|$)[^\s)]*/g;

/**
 * Relative link targets in one packed document (`path`, its `source`) that name nothing in the packed file list
 * (#931). An installed copy holds only what `npm pack` ships, so a link that resolves in this checkout but not in
 * the tarball is dead there: ship the target, or link this repository's `blob/v<current version>/...` inside a
 * x-release-please-start-version block. Absolute, protocol-relative, mail and bare `#fragment` links are not checked, nor
 * links inside fenced code blocks or code spans. A directory link resolves when anything under it ships. Any mention
 * of this repository's `blob/main` or `tree/main` outside a fence is a problem too, link or not (#938).
 */
export function packedLinkProblems(path: string, source: string, packed: ReadonlySet<string>): string[] {
  const directories = new Set<string>();
  for (const file of packed) for (let index = file.indexOf('/'); index > 0; index = file.indexOf('/', index + 1)) directories.add(file.slice(0, index));
  const problems: string[] = [];
  let fence: string | undefined;
  for (const [index, line] of source.split('\n').entries()) {
    const trimmed = line.trim();
    if (fence) { if (trimmed.startsWith(fence) && /^(`+|~+)$/.test(trimmed)) fence = undefined; continue; }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) { fence = opening[1]; continue; }
    const text = line.replace(/(`+)[^`]*?\1/g, '');
    for (const match of line.matchAll(MAIN_BRANCH)) problems.push(`${path}:${index + 1} names \`${match[0]}\`, this repository's main branch; link blob/v<current version>/... instead`);
    const targets = [...text.matchAll(INLINE_LINK)].map(match => match[1] ?? '');
    const reference = REFERENCE_LINK.exec(line)?.[1];
    if (reference) targets.push(reference);
    for (const target of targets) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) continue;
      const relativeTarget = target.replace(/[#?].*$/, '');
      if (relativeTarget === '') continue;
      let decoded = relativeTarget;
      try { decoded = decodeURIComponent(relativeTarget); } catch { /* keep the raw target */ }
      const resolved = posix.normalize(posix.join(posix.dirname(path), decoded)).replace(/\/$/, '');
      if (!packed.has(resolved) && !directories.has(resolved)) problems.push(`${path}:${index + 1} links \`${target}\`, but \`${resolved}\` is not in the package`);
    }
  }
  return problems;
}

/** Whether a packed path is code whose string literals reach an installed reader (CLI output, reasons, generated documents). */
export const isPackedCode = (path: string): boolean => /\.[cm]?js$/.test(path);
/** A repository-relative docs page: `docs/X.md` not preceded by a path or URL (a pinned `.../blob/v<version>/docs/X.md` is fine). */
const DOCS_PAGE = /(?<![\w/.-])docs\/[\w./-]+?\.md\b/g;

/**
 * String and template literals in one packed script (`path`, its `source`) that name a `docs/*.md` page the package
 * does not ship (#938). They are printed by the CLI or written into generated output such as an OpenAPI document, so
 * an installed reader meets a path that exists only in this checkout. Name a page that ships, a `urlcode docs search`
 * query, or this release's copy through `docsUrl` (packages/core/src/release.ts). Comments are not read: type
 * stripping keeps source comments in `dist/`, and those address maintainers, not installed readers.
 */
export function packedStringProblems(path: string, source: string, packed: ReadonlySet<string>): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const problems: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      for (const match of node.text.matchAll(DOCS_PAGE)) {
        if (packed.has(match[0])) continue;
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        problems.push(`${path}:${line} names \`${match[0]}\`, which the package does not ship`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return problems;
}

/**
 * Whether a packed path is other text an installed reader meets (#948): schemas whose descriptions an editor shows,
 * example and starter YAML, the llms indexes, templates and the rest. Markdown is read for links by
 * `packedLinkProblems` and scripts for string literals by `packedStringProblems`; TypeScript declarations are code
 * whose comments address maintainers, as in `dist/` scripts.
 */
export const isPackedText = (path: string): boolean => !path.endsWith('.md') && !isPackedCode(path) && !/\.[cm]?ts$/.test(path);
/** `MAIN_BRANCH`, ending before a quote as well, since text here includes JSON strings. */
const TEXT_MAIN_BRANCH = /https:\/\/github\.com\/jimhoyd-com\/urlcode\/(?:blob|tree)\/main(?=[/)\s"'`]|$)[^\s)"'`]*/g;
/** A docs page mention in text: `DOCS_PAGE`, also not preceded by `[` or `` [` ``, which make it a link label or reference the link check follows. */
const TEXT_DOCS_PAGE = /(?<![\w/.\-[])(?<!\[`)docs\/[\w./-]+?\.md\b/g;

/**
 * Lines of one packed text file (`path`, its `source`) that name a `docs/*.md` page the package does not ship, or
 * this repository's main branch outside a `package.json` (#948). A JSON schema description, a YAML comment or an
 * llms index is read as it is, so every line counts, fenced or not. Name a page that ships, a `urlcode docs search` query, or this release's
 * `https://github.com/jimhoyd-com/urlcode/blob/v<version>/docs/...` copy, which the release pull request moves. A file
 * holding a NUL byte is binary and not read.
 */
export function packedTextProblems(path: string, source: string, packed: ReadonlySet<string>): string[] {
  if (source.includes('\0')) return [];
  // A manifest's `homepage` names the project, which is its main branch by design; npm shows it as a link, not as docs.
  const manifest = posix.basename(path) === 'package.json';
  const problems: string[] = [];
  for (const [index, line] of source.split('\n').entries()) {
    if (!manifest) for (const match of line.matchAll(TEXT_MAIN_BRANCH)) problems.push(`${path}:${index + 1} names \`${match[0]}\`, this repository's main branch; link blob/v<current version>/... instead`);
    for (const match of line.matchAll(TEXT_DOCS_PAGE)) if (!packed.has(match[0])) problems.push(`${path}:${index + 1} names \`${match[0]}\`, which the package does not ship`);
  }
  return problems;
}

/** Core (`.`) plus every add-on, in dependency order, as directories relative to `root`. */
export async function auditedPackages(root = repositoryRoot): Promise<{ directory: string; kind: PackageKind }[]> {
  return [{ directory: '.', kind: 'core' }, ...(await addons(root)).map(addon => ({ directory: relative(root, addon.directory), kind: addon.kind }))];
}

function targets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.values(value).flatMap(targets);
}

async function auditAll(): Promise<void> {
  // Every add-on is private (so a stray `npm publish` refuses), but its tarball is still a release asset that
  // core's addons.json pins, so `private` is never a reason to skip its package boundary.
  for (const { directory } of await auditedPackages()) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), directory], { cwd: repositoryRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message || `Package audit failed for ${directory}`);
    process.stdout.write(result.stdout);
  }
}

async function auditOne(target: string): Promise<void> {
  const directory = resolve(target);
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
    name?: string;
    exports?: unknown;
    bin?: Record<string, string>;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  const budget = manifest.name ? budgets[manifest.name] : undefined;
  assert(budget, `No package audit policy for ${manifest.name ?? directory}: add a budget for it in scripts/package-audit.ts`);
  const kind: PackageKind = resolve(directory) === resolve(repositoryRoot) ? 'core' : (await auditedPackages()).find(item => resolve(repositoryRoot, item.directory) === resolve(directory))?.kind ?? 'extension';
  const cache = await mkdtemp(join(tmpdir(), 'urlcode-pack-audit-'));
  try {
    const npm = process.env.npm_execpath;
    assert(npm, 'Run the package audit through npm');
    const result = spawnSync(process.execPath, [npm, 'pack', '--dry-run', '--ignore-scripts', '--json'], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: cache },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message || 'npm pack failed');
    const [pack] = parsePackJson<PackReport>(result.stdout, result.stderr);
    assert(pack, 'npm pack reported no package');
    assert.equal(pack.name, manifest.name);

    const allowed = new Set(budget.roots);
    const unexpected = pack.files.map(file => file.path).filter(path => !allowed.has(path.split('/')[0]!));
    assert.deepEqual(unexpected, [], `Unexpected release files:\n${unexpected.join('\n')}`);
    const unsafe = pack.files.map(file => file.path).filter(path =>
      /(?:^|\/)(?:src|test|node_modules)(?:\/|$)/.test(path) ||
      /(?:\.map|\.tsbuildinfo|package-lock\.json|(?:^|\/)\.env(?:\.|$))$/.test(path));
    assert.deepEqual(unsafe, [], `Development or sensitive files in release:\n${unsafe.join('\n')}`);
    const shapeProblems = packFileProblems(kind, pack.files.map(file => file.path));
    assert.deepEqual(shapeProblems, [], `Files that must not ship in ${pack.name}:\n${shapeProblems.join('\n')}`);

    // A path the working tree happens to have locally (an uncommitted build
    // artifact under a wholesale-listed `files` root, e.g. examples/*/dist/)
    // must never ship just because it exists on disk when `npm pack` runs:
    // that makes the tarball's contents depend on build order/history instead
    // of the committed source (see #608). Reject any packed path git would
    // ignore, except the package's own `dist` root: that build output is
    // deliberately gitignored (never committed) yet always the intended
    // shipped content, generated fresh by `npm run build` right before
    // packing.
    const candidates = pack.files.map(file => file.path).filter(path => path.split('/')[0] !== 'dist');
    const repoPaths = candidates.map(path => join(directory, path));
    const ignoreCheck = repoPaths.length > 0
      ? spawnSync('git', ['check-ignore', '--stdin', '-z'], {
        cwd: directory,
        input: repoPaths.join('\0') + '\0',
        encoding: 'utf8',
      })
      : undefined;
    // git check-ignore exits 1 when none of the paths are ignored, which is
    // the expected case; only treat spawn failure (missing git) as fatal.
    assert(!ignoreCheck || ignoreCheck.error === undefined, `Failed to run git check-ignore: ${ignoreCheck?.error?.message}`);
    const ignored = ignoreCheck ? ignoreCheck.stdout.split('\0').map(entry => entry.trim()).filter(Boolean) : [];
    assert.deepEqual(ignored, [], `Gitignored paths present in packed release (nondeterministic local build artifacts, see #608):\n${ignored.join('\n')}`);

    const shipped = new Set(pack.files.map(file => file.path));
    const deadLinks: string[] = [];
    for (const path of [...shipped].filter(isPackedDocument).sort()) deadLinks.push(...packedLinkProblems(path, await readFile(join(directory, path), 'utf8'), shipped));
    assert.deepEqual(deadLinks, [], `Shipped documents link files ${pack.name} does not ship (#931); ship the target, or link this repository's blob/v<current version>/... inside a x-release-please-start-version block:\n${deadLinks.join('\n')}`);
    const deadStrings: string[] = [];
    for (const path of [...shipped].filter(isPackedCode).sort()) deadStrings.push(...packedStringProblems(path, await readFile(join(directory, path), 'utf8'), shipped));
    assert.deepEqual(deadStrings, [], `Shipped code names docs pages ${pack.name} does not ship (#938); link this release's copy with docsUrl() from packages/core/src/release.ts, name a shipped page, or a urlcode docs search query:\n${deadStrings.join('\n')}`);
    const deadText: string[] = [];
    for (const path of [...shipped].filter(isPackedText).sort()) deadText.push(...packedTextProblems(path, await readFile(join(directory, path), 'utf8'), shipped));
    assert.deepEqual(deadText, [], `Shipped text names docs pages ${pack.name} does not ship (#948); link this repository's blob/v<current version>/docs/... (the release pull request moves it), name a shipped page, or a urlcode docs search query:\n${deadText.join('\n')}`);
    // Core also carries its add-on pins and the release-wide add-on agent catalog beside them (#721).
    const required = [...targets(manifest.exports), ...Object.values(manifest.bin ?? {}), ...(kind === 'core' ? ['dist/addons.json', 'dist/addon-catalog.json'] : [])]
      .map(path => path.replace(/^\.\//, ''));
    const missing = required.filter(path => !shipped.has(path));
    assert.deepEqual(missing, [], `Package exports or required files are missing:\n${missing.join('\n')}`);
    for (const peer of budget.optionalPeers ?? []) {
      assert(!manifest.dependencies?.[peer], `${peer} must not be a default dependency`);
      assert(manifest.peerDependencies?.[peer], `${peer} needs a declared compatibility range`);
      assert.equal(manifest.peerDependenciesMeta?.[peer]?.optional, true, `${peer} must be an optional peer`);
    }

    if (pack.size > budget.packed) {
      const largest = [...pack.files].sort((a, b) => b.size - a.size).slice(0, 10)
        .map(file => `  ${String(file.size).padStart(9)}  ${file.path}`).join('\n');
      assert.fail([
        `Packed size ${pack.size} exceeds ${budget.packed} bytes for ${pack.name}.`,
        `Budget: ${budget.packed}; actual: ${pack.size}; over by ${pack.size - budget.packed} bytes.`,
        `The budget is the "packed" value for '${pack.name}' in the budgets table in scripts/package-audit.ts; if the growth is intended, re-measure every package and reset the table by the policy above it, with justification in the PR.`,
        'Otherwise find what grew (compare against main, e.g. git diff --stat main -- dist starters skills schemas recipes examples). Largest uncompressed files in the tarball:',
        largest,
      ].join('\n'));
    }
    assert(pack.unpackedSize <= budget.unpacked, `Unpacked size ${pack.unpackedSize} exceeds ${budget.unpacked} bytes`);
    assert(pack.entryCount <= budget.entries, `Entry count ${pack.entryCount} exceeds ${budget.entries}`);
    console.log(`${pack.name}: ${pack.size} packed bytes, ${pack.unpackedSize} unpacked bytes, ${pack.entryCount} files`);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--all') await auditAll();
  else await auditOne(process.argv[2] ?? '.');
}
