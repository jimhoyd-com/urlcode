import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// A published version can never be replaced, so the one failure that cannot be
// undone is shipping a tarball that resolves to nothing. `files` lists `dist`,
// but `dist` is generated: pack before building and npm publishes a package
// whose every export is a missing file, with no error at publish time.
test('the packed tarball carries every file the exports map resolves to', () => {
  const output = execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'],
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

test('the package is publishable rather than marked private', () => {
  // `private: true` makes npm publish refuse. Removing it is what makes this
  // package publishable at all, so the removal is asserted rather than assumed.
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, unknown>;
  assert.equal(pkg.private, undefined, 'package.json is marked private and cannot be published');
  // A scoped package defaults to a restricted (paid) publish without this.
  assert.equal((pkg.publishConfig as { access?: string } | undefined)?.access, 'public',
    'a scoped package needs publishConfig.access=public to publish publicly');
});
