// Enforcing guard that prose stating "the" URLCode version agrees with package.json.
//
// llms.txt said this revision was `0.4.0-alpha.2`, docs/YAML-GUIDE.md said it
// targeted 0.3.0 and the package was 0.4.1 (#260): an agent reading the docs
// could not tell which statements applied to the runtime it had installed.
// Later (#562) the same drift was found in pages this guard did not read at all
// ("0.3.0 is the current baseline", `urlcode:0.3.0`, "implemented in alpha.4"),
// so it now reads every tracked Markdown file plus the llms indexes.
//
// It FAILS (exit 1) when a present-tense version statement names a version
// other than the root package.json version. Patterns:
//   "this revision is `X`", "targets URLCode X", "`X` stable release target",
//   "stable release target is `X`", "`X` release line", "aligned `X` packages",
//   "aligns all four packages at `X`", installs of the packages pinned as
//   @jimhoyd/urlcode[-ui|-auth|-admin|-store|-forms]@X, `--version X` /
//   `--branch vX` / `urlcode:X` in install commands, packed archive names
//   `jimhoyd-urlcode[-name]-X.tgz`, "version X is the current ...", "the X
//   version label", "additions since X", "implemented in X", "These are X
//   implementation limits" and a sentence opening "Alpha.N includes".
// Historical mentions (an alpha's behaviour change, evidence about 0.3.0) do not
// match these patterns and are left alone. Bumping package.json therefore makes
// this check fail until these lines are updated.
//
// Not read: release notes, changelogs, Changeset records and archived plans
// (the same exclusions release-prepare.ts uses for current-version markers),
// plus the HISTORICAL pages below, which record what was true at a past version
// on purpose. Add a page there only when it is genuinely a dated record; a live
// page names no version outside `urlcode-current-version` markers.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
// Repository-relative paths. Empty today: every live page passes once written
// with placeholders (`X.Y.Z`) or current-version markers.
const HISTORICAL = new Set<string>([]);
const V = '(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?)';
const ALPHA = '(alpha\\.\\d+)';
const PATTERNS = [
  new RegExp('this revision is `' + V + '`', 'g'),
  new RegExp('targets URLCode ' + V, 'g'),
  new RegExp('`' + V + '` stable release target', 'g'),
  new RegExp('stable release target is `' + V + '`', 'g'),
  new RegExp('`' + V + '` release line', 'g'),
  new RegExp('aligned `' + V + '` packages', 'g'),
  new RegExp('aligns all four packages at `' + V + '`', 'g'),
  new RegExp('@jimhoyd/urlcode(?:-ui|-auth|-admin|-store|-forms)?@' + V, 'g'),
  new RegExp('(?:--version |--branch v|urlcode:)' + V, 'g'),
  new RegExp('jimhoyd-urlcode(?:-ui|-auth|-admin|-store|-forms)?-' + V + '\\.tgz', 'g'),
  new RegExp('[Vv]ersion ' + V + ' is the current', 'g'),
  new RegExp('\\b' + V + ' version label', 'g'),
  new RegExp('additions since ' + V, 'g'),
  new RegExp('[Ii]mplemented in (?:' + V.slice(1, -1) + '|' + ALPHA.slice(1, -1) + ')\\b', 'g'),
  new RegExp('These are ' + V + ' implementation limits', 'g'),
  new RegExp('(?:^|\\. )(Alpha\\.\\d+) includes', 'g'),
];
// The capture group is the stated version; the alternation patterns above use a
// non-capturing group, so recover the whole version token from the match text.
function stated(match: RegExpMatchArray): string {
  if (match[1] !== undefined) return match[1];
  const token = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?|alpha\.\d+)/.exec(match[0]);
  return token ? token[1]! : match[0];
}

function files(): string[] {
  const path = fileURLToPath(root);
  return execFileSync('git', ['-c', `safe.directory=${path}`, 'ls-files'], { cwd: path, encoding: 'utf8' }).trim().split('\n').filter(file =>
    (file.endsWith('.md') || file === 'llms.txt' || file === 'llms-full.txt' || /^packages\/[^/]+\/llms\.txt$/.test(file)) &&
    !file.startsWith('.changeset/') &&
    !file.startsWith('docs/archive/') &&
    !/^docs\/RELEASE-/.test(file) &&
    !file.endsWith('CHANGELOG.md') &&
    !HISTORICAL.has(file));
}

const expected = (JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as { version: string }).version;
const failures: string[] = [];
const scanned = files();
for (const file of scanned) {
  const lines = (await readFile(new URL(file, root), 'utf8')).split('\n');
  lines.forEach((line, i) => {
    for (const pattern of PATTERNS) {
      for (const match of line.matchAll(pattern)) {
        const version = stated(match);
        if (version !== expected) failures.push(`${file}:${i + 1}: states ${version}, package.json is ${expected}: ${match[0].trim()}`);
      }
    }
  });
}
if (failures.length) {
  console.error(`Version statements disagree with package.json (${expected}):\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`version statements agree with package.json (${expected}) across ${scanned.length} files`);
