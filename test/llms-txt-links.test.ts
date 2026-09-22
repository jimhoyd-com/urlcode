import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePackJson } from '../scripts/pack-json.ts';

// llms.txt is the package-owned AI entrypoint and ships in the npm tarball
// (#439). A relative link from it (unlike a link from a repo-only .md file,
// which scripts/check-local-links.ts already guards) is read by an agent
// working from an *installed* copy of the package, where only the files
// listed in package.json's "files" field exist on disk. A relative link to
// something that isn't shipped -- docs/STORE.md, for example -- is dead
// there even though it resolves fine in this checkout. This test packs the
// real tarball and checks every relative llms.txt link against it.

interface PackedFile { path: string }
interface PackReport { name: string; files: PackedFile[] }

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const INLINE_LINK = /\[[^\]]*\]\(([^()\s]+)\)/g;

test('every relative link in llms.txt resolves inside the published npm tarball', async () => {
  const source = await readFile(join(root, 'llms.txt'), 'utf8');
  const targets = [...source.matchAll(INLINE_LINK)]
    .map(match => match[1] ?? '')
    // Absolute URLs, protocol-relative URLs, mail links and pure anchors are
    // somebody else's to resolve -- same exemption check-local-links.ts uses.
    .filter(target => target.length > 0 && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target))
    .map(target => target.replace(/[#?].*$/, ''))
    .filter(target => target.length > 0);
  assert(targets.length > 0, 'expected llms.txt to contain at least one relative link to check');

  const cache = await mkdtemp(join(tmpdir(), 'urlcode-llms-txt-links-'));
  try {
    const npm = process.env.npm_execpath;
    assert(npm, 'Run this test through npm');
    const result = spawnSync(process.execPath, [npm, 'pack', '--dry-run', '--ignore-scripts', '--json'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: cache },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message || 'npm pack failed');
    const [pack] = parsePackJson<PackReport>(result.stdout, result.stderr);
    assert(pack, 'npm pack reported no package');

    const shipped = new Set(pack.files.map(file => file.path));
    const dead = targets.filter(target => !shipped.has(posix.normalize(target)));
    assert.deepEqual(dead, [], [
      'llms.txt links to a path that is not in the published npm tarball:',
      ...dead,
      'Either add the path to the "files" field in package.json, or point the link at',
      "something that is actually shipped (a canonical GitHub URL, 'urlcode docs search', etc).",
    ].join('\n'));
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});
