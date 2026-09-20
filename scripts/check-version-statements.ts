// Enforcing guard that prose stating "the" URLCode version agrees with package.json.
//
// llms.txt said this revision was `0.4.0-alpha.2`, docs/YAML-GUIDE.md said it
// targeted 0.3.0 and the package was 0.4.1 (#260): an agent reading the docs
// could not tell which statements applied to the runtime it had installed.
//
// It FAILS (exit 1) when a present-tense version statement in the files below
// names a version other than the root package.json version. Patterns:
//   "this revision is `X`", "targets URLCode X", "`X` stable release target",
//   "stable release target is `X`", "`X` release line", "aligned `X` packages",
//   "aligns all four packages at `X`", installs of the four packages pinned as
//   @jimhoyd/urlcode[-ui|-auth|-admin]@X, and `--version X` / `--branch vX` /
//   `urlcode:X` in install commands.
// Historical mentions (an alpha's behaviour change, evidence about 0.3.0) do not
// match these patterns and are left alone. Bumping package.json therefore makes
// this check fail until these lines are updated.
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const FILES = ['llms.txt', 'README.md', 'docs/INSTALL.md', 'docs/FRAMEWORK.md', 'docs/YAML-GUIDE.md', 'docs/AI-AUTHORING.md'];
const V = '(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?)';
const PATTERNS = [
  new RegExp('this revision is `' + V + '`', 'g'),
  new RegExp('targets URLCode ' + V, 'g'),
  new RegExp('`' + V + '` stable release target', 'g'),
  new RegExp('stable release target is `' + V + '`', 'g'),
  new RegExp('`' + V + '` release line', 'g'),
  new RegExp('aligned `' + V + '` packages', 'g'),
  new RegExp('aligns all four packages at `' + V + '`', 'g'),
  new RegExp('@jimhoyd/urlcode(?:-ui|-auth|-admin)?@' + V, 'g'),
  new RegExp('(?:--version |--branch v|urlcode:)' + V, 'g'),
];

const expected = (JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as { version: string }).version;
const failures: string[] = [];
for (const file of FILES) {
  const lines = (await readFile(new URL(file, root), 'utf8')).split('\n');
  lines.forEach((line, i) => {
    for (const pattern of PATTERNS) {
      for (const match of line.matchAll(pattern)) {
        if (match[1] !== expected) failures.push(`${file}:${i + 1}: states ${match[1]}, package.json is ${expected}: ${match[0]}`);
      }
    }
  });
}
if (failures.length) {
  console.error(`Version statements disagree with package.json (${expected}):\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`version statements agree with package.json (${expected})`);
