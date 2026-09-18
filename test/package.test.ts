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

test('the release publishes a prerelease under its own dist-tag', async () => {
  // npm refuses to publish a prerelease without --tag, so a workflow that omits
  // it fails at the publish step — after the tag has been pushed, which is the
  // expensive place to find out. Defaulting would be worse than failing: the
  // default is `latest`, so every plain `npm install` would resolve to the
  // prerelease.
  const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
  const commands = workflow.split('\n').filter(line => (line.split('#')[0] ?? '').includes('npm publish'));
  assert.equal(commands.length, 1, 'expected exactly one npm publish command');
  assert.match(commands[0]!, /--tag "\$DIST_TAG"/,
    'npm publish does not pass a dist-tag; a prerelease version cannot publish');
  assert.match(workflow, /echo "dist=\$dist" >> "\$GITHUB_OUTPUT"/,
    'the workflow does not derive a dist-tag from the version');
});

test('the release creates any pack destination before packing into it', () => {
  // npm does not create --pack-destination. It fails ENOENT on a missing
  // directory, and only when a tag has already been pushed, which is where the
  // first release of this package died. The guard above packs with --dry-run
  // and no destination, so it could not have caught this.
  const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
  const lines = workflow.split('\n').map(line => line.split('#')[0] ?? '');
  const packIndex = lines.findIndex(line => /npm pack\b/.test(line));
  assert.notEqual(packIndex, -1, 'expected the release to pack the candidate');

  const destination = /--pack-destination\s+(\S+)/.exec(lines[packIndex]!)?.[1];
  if (destination === undefined) return; // packing into the working directory needs nothing

  const created = lines
    .slice(0, packIndex)
    .some(line => new RegExp(`mkdir\\s+(-\\S+\\s+)*${destination}\\b`).test(line));
  assert.ok(created,
    `npm pack writes into "${destination}" but nothing creates it first; npm fails ENOENT`);
});
