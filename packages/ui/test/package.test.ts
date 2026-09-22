import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// A published version can never be replaced, so the one failure that cannot be
// undone is shipping a tarball that resolves to nothing. `files` lists `dist`,
// but `dist` is generated: pack before building and npm publishes a package
// whose every export is a missing file, with no error at publish time.
test('the packed tarball carries every file the exports map resolves to', () => {
  // On Windows npm is a .cmd shim, which execFileSync cannot resolve without a
  // shell -- and since the CVE-2024-27980 fix, spawning a .cmd without
  // `shell: true` throws EINVAL rather than running it. Passing `shell: true`
  // would mean quoting arguments for cmd.exe. Run npm's own JS entry point
  // under this Node instead, which is what scripts/pack-sources.mjs does.
  const [command, prefix] = process.platform === 'win32'
    ? [process.execPath, [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]]
    : ['npm', []];
  const output = execFileSync(command, [...prefix, 'pack', '--dry-run', '--ignore-scripts', '--json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const [packed] = JSON.parse(output) as { files: { path: string }[] }[];
  assert.ok(packed, 'npm pack reported no package');
  const shipped = new Set(packed.files.map(file => file.path));

  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    exports: Record<string, Record<string, string> | string>;
    bin?: Record<string, string>;
  };

  // Every non-development target, plus each bin: the development condition
  // points at TypeScript sources, which deliberately do not ship.
  const required = new Set<string>();
  for (const entry of Object.values(pkg.exports))
    for (const [condition, target] of Object.entries(typeof entry === 'string' ? { default: entry } : entry))
      if (condition !== 'development') required.add(target.replace(/^\.\//, ''));
  for (const target of Object.values(pkg.bin ?? {})) required.add(target.replace(/^\.\//, ''));

  assert.ok(required.size > 0, 'expected the exports map to name at least one target');
  const missing = [...required].filter(file => !shipped.has(file)).sort();
  assert.deepEqual(missing, [],
    `these exports resolve to files the tarball does not contain: ${missing.join(', ')}`);
});

test('the workspace is packable but protected from npm publication', () => {
  // Bundles are assembled from `npm pack` archives, while `private: true`
  // makes a direct `npm publish` fail before it can recreate the retired
  // registry distribution.
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, unknown>;
  assert.equal(pkg.private, true, 'package.json must block direct npm publication');
  assert.equal(pkg.publishConfig, undefined, 'a retired npm package must not retain publication settings');
});

test('package.json is already in the form npm normalizes it to', () => {
  // npm rewrites some fields at publish time and warns that it "auto-corrected
  // errors". The rewrite is harmless, but the warning is alarming — one npm
  // version reports a bin path losing its leading "./" as the script name being
  // "invalid and removed", which reads like the command was dropped. Storing
  // the canonical form means a real problem is never hidden behind an expected
  // warning.
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    bin?: Record<string, string>;
    repository?: { url?: string };
  };
  for (const [name, target] of Object.entries(pkg.bin ?? {}))
    assert.ok(!target.startsWith('./'),
      `bin[${name}] is "${target}"; npm stores it without the leading "./"`);
  const url = pkg.repository?.url;
  if (url !== undefined)
    assert.match(url, /^git\+https:\/\//,
      `repository.url is "${url}"; npm normalizes it to a git+https: URL`);
});
