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
// path is wrong for the package (no `.github/` there) and the file name is
// wrong for the monorepo (the active workflow is `release-admin.yml`). Neither
// target has existed since the fold-in, and nothing noticed.
//
// Both failures are invisible to lint, typecheck and the test suites, which is
// why this is a check rather than a review habit. It FAILS (exit 1); three rules:
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

// The retired repository for each folded-in package, read from disk.
const packageDirectories = (await readdir(new URL('packages/', root), { withFileTypes: true }).catch(() => []))
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name);
const RETIRED = new RegExp(`jimhoyd-com/urlcode-(${packageDirectories.join('|')})\\b`, 'g');

// A Markdown inline link target. Reference definitions (`[label]: target`) are
// matched separately below.
const INLINE_LINK = /\[[^\]]*\]\(([^()\s]+)\)/g;
const REFERENCE_LINK = /^\s*\[[^\]]+\]:\s+(\S+)/;

const exists = async (path: URL): Promise<boolean> => stat(path).then(() => true, () => false);

interface Failure { file: string; line: number; rule: string; detail: string }
const failures: Failure[] = [];
let scanned = 0;
let links = 0;

for (const file of await markdownFiles()) {
  const source = await readFile(new URL(file, root), 'utf8');
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
      // Absolute URLs, protocol-relative URLs, mail links and pure anchors are
      // somebody else's to resolve.
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) continue;
      const path = target.replace(/[#?].*$/, '');
      if (path === '') continue;
      links += 1;
      if (await exists(new URL(path, directory))) continue;
      failures.push({
        ...where,
        rule: 'dead-relative-link',
        detail: `links \`${target}\`, which does not exist relative to this file.`,
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

console.log(`Local-link check: ${scanned} Markdown file(s), ${links} relative link(s), no retired-repository or dead targets.`);
