// Enforcing guard that shipped Markdown links at the tree it lives in.
//
// `ui`, `auth` and `admin` used to be their own GitHub repositories. They are
// workspace packages under `packages/` now (docs/SPIKE-MONOREPO.md), and the
// former repositories are retired -- an `https://github.com/jimhoyd-com/
// urlcode-auth/blob/main/...` URL no longer resolves to anything. The prose
// kept pointing at them anyway: docs/FRAMEWORK.md advertised all three as the
// packages' source homes and linked their IMPLEMENTATION-STATUS files, and
// packages/auth/IMPLEMENTATION-STATUS.md pointed its acceptance record at the
// old repository instead of the ACCEPTANCE.md sitting beside it (#200).
//
// The same migration also broke links the other way. packages/admin/README.md
// linked `.github/workflows/release.yml` twice, relative to the package: the
// path is wrong for the package (no `.github/` there) and the file name was
// wrong for the monorepo (the per-package `release-admin.yml` workflow of the
// time). Neither target has existed since the fold-in,
// and nothing noticed.
//
// Both failures are invisible to lint, typecheck and the test suites, which is
// why this is a check rather than a review habit. It FAILS (exit 1); five rules:
//
//   1. retired-repository  A link to `jimhoyd-com/urlcode-<name>` where
//                          `packages/<name>/` exists in this checkout. Derived
//                          from the directory listing, not a hand-kept list, so
//                          folding in another package covers it the same day.
//   2. dead-relative-link  A relative Markdown link target that does not exist
//                          on disk, resolved from the linking file's directory.
//   3. local-issue-tracker A local `issues/` or `backlog/` Markdown directory,
//                          or an `ISSUES.md`/`BACKLOG.md` file. Actionable work
//                          belongs in GitHub Issues; evidence may link there.
//   4. dead-fragment       A `#fragment` on a link to a Markdown file (or a
//                          bare `#fragment` within one) that names no anchor
//                          there (#781). Anchors are the GitHub heading slugs
//                          (`githubSlug`: lowercase, punctuation other than
//                          `-` and `_` removed, each space a `-`, and a
//                          repeated heading suffixed `-1`, `-2`, ...) plus any
//                          explicit `<a id="...">` / `<a name="...">`.
//                          Headings inside fenced code blocks are not anchors
//                          (fences read by packages/core/src/markdown-fences.ts).
//   5. shipped-link        A Markdown file a package ships (its README.md and
//                          any root .md its package.json `files` names) links
//                          a relative path outside the package, which an
//                          installed copy cannot follow, or this repository's
//                          `blob/main` or `tree/main`, which is not the version
//                          installed (#916). Link this repository's
//                          `blob/v<current version>/...` instead, inside a
//                          `urlcode-current-version` block so the release bump
//                          moves it.
//
// A `blob/v<current version>/<path>` or `tree/v<current version>/<path>` link
// to this repository is checked like a relative link against the checkout:
// the path must exist and a Markdown fragment must name an anchor.
//
// Links are read as CommonMark reads them (`markdownLinkTargets`, #1118):
// inline links and images with or without a title, angle-bracket destinations,
// destinations with balanced parentheses, and reference definitions. Links
// inside fenced code blocks are code, not links.
//
// What it scans: every authored Markdown file in the checkout, and the root
// llms.txt (its pinned links are checked like any other, #938). Build output,
// dependencies and dotted directories are skipped -- the latter also keeps the
// walk out of `.claude/worktrees`, where each entry is a full second copy of
// this repository (the same exclusion check-guidance-claims.ts makes).
//
// Opting out for genuine historical evidence
// ------------------------------------------
// An acceptance record naming the CI run that actually gated a release, or a
// dated spike describing the repository layout of its day, is not drift: the
// evidence really does live in the retired repository, and rewriting the link
// to a local path would claim a run happened here that did not. Label those:
//
//   <!-- local-links: historical -->      exempts the line it appears on, or
//       the paragraph immediately after it when the marker sits on its own
//       line.
//   <!-- local-links: historical-file --> exempts the whole file.
//
// Use the marker for text that is explicitly about a past release or a
// superseded layout, and say so in the surrounding sentence. Live material --
// anything a reader is meant to follow today -- gets a local link instead.
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fenceLines } from '../packages/core/src/markdown-fences.ts';

const root = new URL('../', import.meta.url);

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage']);
const LINE_MARKER = '<!-- local-links: historical -->';
const FILE_MARKER = '<!-- local-links: historical-file -->';

async function markdownFiles(prefix = ''): Promise<string[]> {
  const entries = await readdir(new URL(prefix, root), { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
      found.push(...(await markdownFiles(`${prefix}${entry.name}/`)));
    } else if (entry.name.endsWith('.md') || (prefix === '' && entry.name === 'llms.txt')) {
      found.push(`${prefix}${entry.name}`);
    }
  }
  return found;
}

/**
 * GitHub's heading anchor for already-rendered heading text: lowercased,
 * every character that is not a letter, mark, number, connector punctuation
 * (`_`), space or `-` removed, then each space turned into `-`. Repeats are
 * suffixed by `markdownAnchors`, not here.
 */
export function githubSlug(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Inline HTML tags removed, repeated until none is left so a nested `<<a>b>` cannot leave a tag behind. */
function stripTags(text: string): string {
  let previous: string;
  do { previous = text; text = text.replace(/<[^<>]*>/g, ''); } while (text !== previous);
  return text;
}

/** The text GitHub renders for a heading's inline Markdown, which is what it slugs. */
export function headingText(markdown: string): string {
  // Code spans render their content literally; everything else loses its markup.
  return markdown.split(/(`+[^`]*`+)/).map((part, index) => {
    if (index % 2 === 1) return part.replace(/^`+|`+$/g, '');
    return stripTags(part)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
      .replace(/(^|[^\p{L}\p{N}])_{1,2}(?=\S)(.+?)(?<=\S)_{1,2}(?=[^\p{L}\p{N}]|$)/gu, '$1$2')
      .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity, name: string) => {
        if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1).replace(/^x/i, ''), /^#x/i.test(name) ? 16 : 10));
        return ENTITIES[name.toLowerCase()] ?? entity;
      })
      .replace(/\\(.)/g, '$1');
  }).join('');
}

const EXPLICIT_ANCHOR = /<a\s[^>]*?\b(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/**
 * Every fragment a Markdown file answers on GitHub: its heading slugs (a
 * repeated slug gets `-1`, `-2`, ... in document order) and its explicit
 * `<a id>` / `<a name>` anchors. Fenced code blocks contribute nothing.
 */
export function markdownAnchors(source: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  const addHeading = (raw: string): void => {
    const base = githubSlug(headingText(raw));
    let slug = base;
    let count = seen.get(base) ?? 0;
    while (seen.has(slug)) slug = `${base}-${++count}`;
    seen.set(base, count);
    seen.set(slug, seen.get(slug) ?? 0);
    anchors.add(slug);
  };
  const fences = fenceLines(source);
  let previous = '';
  for (const [index, line] of source.split('\n').entries()) {
    const trimmed = line.trim();
    if (fences[index]!.kind !== 'text') { previous = ''; continue; }
    for (const match of line.matchAll(EXPLICIT_ANCHOR)) anchors.add(match[1] ?? match[2] ?? match[3] ?? '');
    const atx = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) { addHeading(atx[1] ?? ''); previous = ''; continue; }
    // A setext underline turns the paragraph line above it into a heading.
    if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(line) && previous !== '' && !/^\s*(?:[|>*+-]|\d+[.)])/.test(previous)) {
      addHeading(previous.trim());
      previous = '';
      continue;
    }
    previous = trimmed === '' ? '' : line;
  }
  return anchors;
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const isSpace = (char: string | undefined): boolean => char === ' ' || char === '\t';

/**
 * The link destination starting at `start` in `text`, read as CommonMark does, with its backslash escapes removed:
 * `<...>` (spaces allowed, no `<` or line break) or a run of non-space characters whose unescaped parentheses
 * balance. Undefined when there is none; `end` is the index just past it.
 */
function destination(text: string, start: number): { target: string; end: number } | undefined {
  let target = '';
  if (text[start] === '<') {
    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index]!;
      if (char === '>') return { target, end: index + 1 };
      if (char === '<' || char === '\r') return undefined;
      if (char === '\\' && ASCII_PUNCTUATION.test(text[index + 1] ?? '')) target += text[++index];
      else target += char;
    }
    return undefined;
  }
  let depth = 0, index = start;
  for (; index < text.length; index += 1) {
    const char = text[index]!;
    if (char <= ' ' || char === '\x7f') break;
    if (char === '\\' && ASCII_PUNCTUATION.test(text[index + 1] ?? '')) { target += text[++index]; continue; }
    if (char === '(') depth += 1;
    else if (char === ')') { if (depth === 0) break; depth -= 1; }
    target += char;
  }
  return depth === 0 ? { target, end: index } : undefined;
}

/** The index just past a link title (`"t"`, `'t'` or `(t)`) starting at `start`, or undefined when there is none. */
function titleEnd(text: string, start: number): number | undefined {
  const close = ({ '"': '"', "'": "'", '(': ')' } as Record<string, string>)[text[start] ?? ''];
  if (!close) return undefined;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '\\') index += 1;
    else if (char === close) return index + 1;
    else if (close === ')' && char === '(') return undefined;
  }
  return undefined;
}

const skipSpaces = (text: string, index: number): number => { while (isSpace(text[index])) index += 1; return index; };

/**
 * The link targets a line of Markdown names, as CommonMark reads them: every inline link or image
 * `[text](destination "optional title")` -- destinations in angle brackets, with balanced parentheses or escapes, and
 * titles in double quotes, single quotes or parentheses (#1118) -- and a link reference definition
 * `[label]: destination "optional title"`. A GitHub footnote (`[^1]: ...`) is not a definition. The reading is per
 * line: a link whose text or title breaks across lines is not seen.
 */
export function markdownLinkTargets(line: string): string[] {
  const targets: string[] = [];
  const definition = /^ {0,3}\[((?:[^\\\]]|\\.)+)\]:[ \t]*/.exec(line);
  if (definition && !definition[1]!.startsWith('^')) {
    const found = destination(line, definition[0].length);
    if (found && found.target !== '' && (found.end === line.length || isSpace(line[found.end]) || line[found.end] === '\r')) targets.push(found.target);
  }
  for (let open = line.indexOf('](', 0); open >= 0; open = line.indexOf('](', open + 1)) {
    // An escaped `\]` is text, and link text needs an opening bracket before it.
    if (line[open - 1] === '\\' || !line.slice(0, open).includes('[')) continue;
    const found = destination(line, skipSpaces(line, open + 2));
    if (!found) continue;
    let end = skipSpaces(line, found.end);
    if (line[end] !== ')' && end > found.end) {
      const after = titleEnd(line, end);
      if (after !== undefined) end = skipSpaces(line, after);
    }
    if (line[end] === ')') targets.push(found.target);
  }
  return targets;
}

const exists = async (path: URL): Promise<boolean> => stat(path).then(() => true, () => false);

const REPOSITORY = 'https://github.com/jimhoyd-com/urlcode/';
/**
 * The repository path (with any `#fragment`) a link to this repository pinned at `version` names, or undefined for any
 * other target. `https://github.com/jimhoyd-com/urlcode/blob/v1.2.3/docs/STORE.md#openapi` is `docs/STORE.md#openapi`.
 */
export function pinnedRepositoryPath(target: string, version: string): string | undefined {
  for (const kind of ['blob', 'tree']) {
    const prefix = `${REPOSITORY}${kind}/v${version}/`;
    if (target.startsWith(prefix) && target.length > prefix.length) return target.slice(prefix.length);
  }
  return undefined;
}
/**
 * Why `target`, linked from `file` (a repository path such as `packages/store/README.md`) that its package ships,
 * cannot be followed from an installed copy; undefined when it can.
 */
export function shippedLinkProblem(file: string, target: string): string | undefined {
  if (/^https:\/\/github\.com\/jimhoyd-com\/urlcode\/(?:blob|tree)\/main(?:\/|$)/.test(target)) return `links \`${target}\`, this repository's main branch, from a file the package ships; an installed copy should read the docs of its own version: link \`blob/v<current version>/...\` inside a urlcode-current-version block.`;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) return undefined;
  const directory = file.slice(0, file.lastIndexOf('/') + 1), packageRoot = /^packages\/[^/]+\//.exec(file)?.[0];
  if (!packageRoot) return undefined;
  const resolved = new URL(target.replace(/[#?].*$/, ''), `file:///${directory}`).pathname.slice(1);
  return resolved.startsWith(packageRoot) ? undefined : `links \`${target}\`, outside ${packageRoot}, from a file the package ships; an installed copy has no such file: link this repository's \`blob/v<current version>/...\` inside a urlcode-current-version block.`;
}
/** The Markdown files each package ships: README.md and every root-level .md its package.json `files` names. */
async function shippedMarkdown(packages: readonly string[]): Promise<Set<string>> {
  const shipped = new Set<string>();
  for (const name of packages) {
    const manifest = await readFile(new URL(`packages/${name}/package.json`, root), 'utf8').then(text => JSON.parse(text) as { files?: unknown }, () => undefined);
    if (!manifest) continue;
    shipped.add(`packages/${name}/README.md`);
    if (Array.isArray(manifest.files)) for (const entry of manifest.files) if (typeof entry === 'string' && /^[^/]+\.md$/.test(entry)) shipped.add(`packages/${name}/${entry}`);
  }
  return shipped;
}

interface Failure { file: string; line: number; rule: string; detail: string }

async function main(): Promise<void> {
  // The retired repository for each folded-in package, read from disk.
  const packageDirectories = (await readdir(new URL('packages/', root), { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
  const RETIRED = new RegExp(`jimhoyd-com/urlcode-(${packageDirectories.join('|')})\\b`, 'g');
  const shipped = await shippedMarkdown(packageDirectories);
  const version = (JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as { version: string }).version;

  const anchorCache = new Map<string, Set<string>>();
  const anchorsOf = async (target: URL): Promise<Set<string>> => {
    let anchors = anchorCache.get(target.href);
    if (!anchors) {
      anchors = markdownAnchors(await readFile(target, 'utf8'));
      anchorCache.set(target.href, anchors);
    }
    return anchors;
  };
  const fragmentOf = (target: string): string | undefined => {
    const hash = target.indexOf('#');
    if (hash < 0 || hash === target.length - 1) return undefined;
    try { return decodeURIComponent(target.slice(hash + 1)); } catch { return target.slice(hash + 1); }
  };

  const failures: Failure[] = [];
  let scanned = 0;
  let links = 0;
  let fragments = 0;

  for (const file of await markdownFiles()) {
    const self = new URL(file, root);
    const source = await readFile(self, 'utf8');
    scanned += 1;
    if (/(?:^|\/)(?:issues?|backlog)(?:\/|$)/i.test(file) || /(?:^|\/)(?:issues?|backlog)\.md$/i.test(file)) {
      failures.push({
        file,
        line: 1,
        rule: 'local-issue-tracker',
        detail: 'repository-local issue trackers are prohibited; create or link the owning GitHub Issue instead.',
      });
    }
    if (source.includes(FILE_MARKER)) continue;
    const directory = new URL(file.includes('/') ? `${file.slice(0, file.lastIndexOf('/') + 1)}` : '', root);

    // A marker on its own line exempts the paragraph after it; a marker sharing
    // a line exempts just that line. Same shape as check-trust-model-prose.ts.
    let pending = false;
    let exemptParagraph = false;
    const fences = fenceLines(source);
    for (const [index, line] of source.split('\n').entries()) {
      const trimmed = line.trim();
      if (trimmed === LINE_MARKER) { pending = true; continue; }
      if (pending) {
        if (trimmed === '') continue;
        pending = false;
        exemptParagraph = true;
      }
      if (exemptParagraph) {
        if (trimmed === '') { exemptParagraph = false; } else continue;
      }
      if (line.includes(LINE_MARKER)) continue;

      const where = { file, line: index + 1 };
      if (packageDirectories.length > 0) {
        for (const match of line.matchAll(RETIRED)) {
          failures.push({
            ...where,
            rule: 'retired-repository',
            detail: `links \`${match[0]}\`, a retired repository. The package lives at \`packages/${match[1]}/\` in this checkout; link that instead.`,
          });
        }
      }

      // A fenced code block holds code, not links (a retired-repository URL in it still counts, above).
      const targets = fences[index]!.kind === 'text' ? markdownLinkTargets(line) : [];
      for (const rawTarget of targets) {
        if (shipped.has(file)) {
          const problem = shippedLinkProblem(file, rawTarget);
          if (problem) { failures.push({ ...where, rule: 'shipped-link', detail: problem }); continue; }
        }
        // A link to this repository at the current version is checked against the checkout.
        const pinned = pinnedRepositoryPath(rawTarget, version);
        const target = pinned ?? rawTarget;
        // Other absolute URLs, protocol-relative URLs and mail links are somebody
        // else's to resolve. A bare `#fragment` names this file.
        if (pinned === undefined && /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
        const path = target.replace(/[#?].*$/, '');
        let resolved = self;
        if (path !== '') {
          links += 1;
          resolved = new URL(path, pinned === undefined ? directory : root);
          if (!(await exists(resolved))) {
            failures.push({
              ...where,
              rule: 'dead-relative-link',
              detail: pinned === undefined ? `links \`${target}\`, which does not exist relative to this file.` : `links \`${rawTarget}\`, but \`${path}\` does not exist in this checkout.`,
            });
            continue;
          }
        }
        const fragment = fragmentOf(target);
        // Fragments into source files (`#L10`) and directories are GitHub's
        // viewer, not a heading; only a Markdown file's anchors are checked.
        if (fragment === undefined || !resolved.pathname.endsWith('.md')) continue;
        fragments += 1;
        if ((await anchorsOf(resolved)).has(fragment)) continue;
        failures.push({
          ...where,
          rule: 'dead-fragment',
          detail: `links \`${target}\`, but ${path === '' ? 'this file' : `\`${path}\``} has no heading or anchor \`#${fragment}\`.`,
        });
      }
    }
  }

  if (failures.length > 0) {
    console.error(`Local-link check: ${failures.length} link(s) point outside this checkout or at nothing\n`);
    for (const failure of failures) console.error(`  ${failure.file}:${failure.line}  ${failure.rule}: ${failure.detail}`);
    console.error(`\nFix the link, or label genuinely historical evidence with ${LINE_MARKER}.`);
    process.exit(1);
  }

  console.log(`Local-link check: ${scanned} Markdown file(s), ${links} relative link(s), ${fragments} fragment(s), no retired-repository, dead or dead-fragment targets.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
