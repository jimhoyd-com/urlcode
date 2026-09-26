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
// why this is a check rather than a review habit. It FAILS (exit 1); four rules:
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
//                          Headings inside fenced code blocks are not anchors.
//
// What it scans: every authored Markdown file in the checkout. Build output,
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
    } else if (entry.name.endsWith('.md')) {
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

/** The text GitHub renders for a heading's inline Markdown, which is what it slugs. */
export function headingText(markdown: string): string {
  // Code spans render their content literally; everything else loses its markup.
  return markdown.split(/(`+[^`]*`+)/).map((part, index) => {
    if (index % 2 === 1) return part.replace(/^`+|`+$/g, '');
    return part
      .replace(/<[^>]*>/g, '')
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
  let fence: string | undefined;
  let previous = '';
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (fence) {
      if (trimmed.startsWith(fence) && /^(`+|~+)$/.test(trimmed)) fence = undefined;
      previous = '';
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) { fence = opening[1]; previous = ''; continue; }
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

// A Markdown inline link target. Reference definitions (`[label]: target`) are
// matched separately below.
const INLINE_LINK = /\[[^\]]*\]\(([^()\s]+)\)/g;
const REFERENCE_LINK = /^\s*\[[^\]]+\]:\s+(\S+)/;

const exists = async (path: URL): Promise<boolean> => stat(path).then(() => true, () => false);

interface Failure { file: string; line: number; rule: string; detail: string }

async function main(): Promise<void> {
  // The retired repository for each folded-in package, read from disk.
  const packageDirectories = (await readdir(new URL('packages/', root), { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
  const RETIRED = new RegExp(`jimhoyd-com/urlcode-(${packageDirectories.join('|')})\\b`, 'g');

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

      const targets = [...line.matchAll(INLINE_LINK)].map(match => match[1] ?? '');
      const reference = REFERENCE_LINK.exec(line);
      if (reference?.[1]) targets.push(reference[1]);
      for (const target of targets) {
        // Absolute URLs, protocol-relative URLs and mail links are somebody
        // else's to resolve. A bare `#fragment` names this file.
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
        const path = target.replace(/[#?].*$/, '');
        let resolved = self;
        if (path !== '') {
          links += 1;
          resolved = new URL(path, directory);
          if (!(await exists(resolved))) {
            failures.push({
              ...where,
              rule: 'dead-relative-link',
              detail: `links \`${target}\`, which does not exist relative to this file.`,
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
