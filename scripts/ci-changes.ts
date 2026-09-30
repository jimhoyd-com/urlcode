// The changed paths of a pull request or push, matched against .github/ci-filters.yml for ci.yml's plan job
// (docs/CI.md). The lane logic itself is the plan's `if:` expressions; this only answers which filters matched.
//
//   node scripts/ci-changes.ts <base>...<head>   pull request (merge base); <before>..<after> for a push
//
// Writes `<filter>=true|false` for each lane filter and `packages=<JSON list>` to $GITHUB_OUTPUT. It exits nonzero
// on a malformed range or history git cannot read, and the plan treats that failed step as unclassified: full.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

type Matcher = ((path: string) => boolean) & { state: { negated: boolean } };
const picomatch = createRequire(import.meta.url)('picomatch') as (pattern: string, options: { dot: boolean }, returnState: boolean) => Matcher;
export type Filters = Record<string, string[]>;

export const filters = (): { lanes: Filters; packages: Filters } =>
  parse(readFileSync(new URL('../.github/ci-filters.yml', import.meta.url), 'utf8')) as { lanes: Filters; packages: Filters };

/** Each filter matches when one path is included by a pattern and excluded by no `!` pattern. */
export function match(set: Filters, paths: string[]): Record<string, boolean> {
  return Object.fromEntries(Object.entries(set).map(([name, patterns]) => {
    const matchers = patterns.map(pattern => picomatch(pattern, { dot: true }, true));
    const includes = matchers.filter(matcher => !matcher.state.negated), excludes = matchers.filter(matcher => matcher.state.negated);
    return [name, paths.some(path => excludes.every(matcher => matcher(path)) && includes.some(matcher => matcher(path)))];
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const range = process.argv[2] ?? '';
  if (!/^[0-9a-f]{40}\.\.\.?[0-9a-f]{40}$/.test(range) || /^0{40}\./.test(range)) throw new Error(`Not a commit range: ${range}`);
  // No rename detection: both the removed and the added path count.
  const paths = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', range, '--'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const { lanes, packages } = filters(), matched = match(packages, paths);
  const outputs = [...Object.entries(match(lanes, paths)).map(([name, value]) => `${name}=${value}`), `packages=${JSON.stringify(Object.keys(matched).filter(name => matched[name]))}`];
  process.stdout.write(`${paths.length} changed paths\n${outputs.join('\n')}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputs.join('\n') + '\n');
}
