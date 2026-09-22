import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePackJson } from './pack-json.ts';

interface PackedFile { path: string; size: number }
interface PackReport {
  name: string;
  size: number;
  unpackedSize: number;
  entryCount: number;
  files: PackedFile[];
}
interface Budget {
  packed: number;
  unpacked: number;
  entries: number;
  roots: readonly string[];
  optionalPeers?: readonly string[];
}

// These are release budgets, not targets. The allowlists keep repository-only
// material out; the headroom lets implementation grow without silently undoing
// the packaging boundary.
const budgets: Record<string, Budget> = {
  '@jimhoyd/urlcode': {
    // npm's tar/gzip implementation varies slightly across its supported
    // Node releases; keep a small cross-platform allowance while retaining
    // the existing 2.3 MiB unpacked-content ceiling.
    // The feature-planning surface and its refreshed authoring catalog add
    // about 1.2 KiB of compressed package content.
    // The env-binding host-override option (#258) adds a small amount of
    // schema and llms-full.txt content; raised by 2 KiB to keep clearance
    // above the pack-time gzip/mtime jitter documented above.
    packed: 522 * 1024,
    unpacked: 2300 * 1024,
    entries: 440,
    roots: ['.claude', 'LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'data', 'dist', 'examples', 'llms-full.txt', 'llms.txt', 'package.json', 'recipes', 'schemas', 'skills', 'starters'],
    optionalPeers: ['typescript'],
  },
  '@jimhoyd/urlcode-auth': {
    packed: 225 * 1024,
    unpacked: 900 * 1024,
    entries: 90,
    roots: ['LICENSE', 'README.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'dist', 'package.json'],
    optionalPeers: ['@aws-sdk/client-sesv2'],
  },
  '@jimhoyd/urlcode-admin': {
    packed: 75 * 1024,
    unpacked: 250 * 1024,
    entries: 55,
    roots: ['LICENSE', 'README.md', 'SECURITY.md', 'dist', 'package.json'],
  },
  '@jimhoyd/urlcode-store': {
    packed: 40 * 1024,
    unpacked: 120 * 1024,
    entries: 30,
    roots: ['LICENSE', 'README.md', 'SECURITY.md', 'dist', 'package.json'],
  },
  '@jimhoyd/urlcode-forms': {
    packed: 45 * 1024,
    unpacked: 140 * 1024,
    entries: 30,
    roots: ['LICENSE', 'README.md', 'SECURITY.md', 'dist', 'package.json'],
  },
  '@jimhoyd/urlcode-ui': {
    packed: 100 * 1024,
    unpacked: 350 * 1024,
    entries: 60,
    roots: ['LICENSE', 'README.md', 'SECURITY.md', 'THIRD-PARTY-NOTICES.md', 'dist', 'package.json', 'vendor'],
  },
};

function targets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.values(value).flatMap(targets);
}

if (process.argv[2] === '--all') {
  const directories = ['.'];
  for (const entry of await readdir(resolve('packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join('packages', entry.name);
    // Extension workspaces are private to prevent an accidental `npm publish`,
    // but their tarballs remain the signed-bundle build input. Audit every
    // package with an explicit release policy instead of treating `private` as
    // an instruction to skip its package boundary.
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name?: string };
    if (pkg.name && budgets[pkg.name]) directories.push(directory);
  }
  for (const directory of directories.sort((a, b) => a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b))) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), directory], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message || `Package audit failed for ${directory}`);
    process.stdout.write(result.stdout);
  }
  process.exit(0);
}

const directory = resolve(process.argv[2] ?? '.');
const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
  name?: string;
  exports?: unknown;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};
const budget = manifest.name ? budgets[manifest.name] : undefined;
assert(budget, `No package audit policy for ${manifest.name ?? directory}`);
const cache = await mkdtemp(join(tmpdir(), 'urlcode-pack-audit-'));
try {
  const npm = process.env.npm_execpath;
  assert(npm, 'Run the package audit through npm');
  const result = spawnSync(process.execPath, [npm, 'pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: cache },
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message || 'npm pack failed');
  const [pack] = parsePackJson<PackReport>(result.stdout, result.stderr);
  assert(pack, 'npm pack reported no package');
  assert.equal(pack.name, manifest.name);

  const allowed = new Set(budget.roots);
  const unexpected = pack.files.map(file => file.path).filter(path => !allowed.has(path.split('/')[0]!));
  assert.deepEqual(unexpected, [], `Unexpected release files:\n${unexpected.join('\n')}`);
  const unsafe = pack.files.map(file => file.path).filter(path =>
    /(?:^|\/)(?:src|test|node_modules)(?:\/|$)/.test(path) ||
    /(?:\.map|\.tsbuildinfo|package-lock\.json|(?:^|\/)\.env(?:\.|$))$/.test(path));
  assert.deepEqual(unsafe, [], `Development or sensitive files in release:\n${unsafe.join('\n')}`);

  const shipped = new Set(pack.files.map(file => file.path));
  const required = [...targets(manifest.exports), ...Object.values(manifest.bin ?? {})]
    .map(path => path.replace(/^\.\//, ''));
  const missing = required.filter(path => !shipped.has(path));
  assert.deepEqual(missing, [], `Package exports point to missing files:\n${missing.join('\n')}`);
  for (const peer of budget.optionalPeers ?? []) {
    assert(!manifest.dependencies?.[peer], `${peer} must not be a default dependency`);
    assert(manifest.peerDependencies?.[peer], `${peer} needs a declared compatibility range`);
    assert.equal(manifest.peerDependenciesMeta?.[peer]?.optional, true, `${peer} must be an optional peer`);
  }

  if (pack.size > budget.packed) {
    const largest = [...pack.files].sort((a, b) => b.size - a.size).slice(0, 10)
      .map(file => `  ${String(file.size).padStart(9)}  ${file.path}`).join('\n');
    assert.fail([
      `Packed size ${pack.size} exceeds ${budget.packed} bytes for ${pack.name}.`,
      `Budget: ${budget.packed}; actual: ${pack.size}; over by ${pack.size - budget.packed} bytes.`,
      `The budget is the "packed" value for '${pack.name}' in the budgets table in scripts/package-audit.ts; raise it there deliberately, with justification in the PR, only if the growth is intended.`,
      'Otherwise find what grew (compare against main, e.g. git diff --stat main -- dist starters skills schemas recipes examples). Largest uncompressed files in the tarball:',
      largest,
    ].join('\n'));
  }
  assert(pack.unpackedSize <= budget.unpacked, `Unpacked size ${pack.unpackedSize} exceeds ${budget.unpacked} bytes`);
  assert(pack.entryCount <= budget.entries, `Entry count ${pack.entryCount} exceeds ${budget.entries}`);
  console.log(`${pack.name}: ${pack.size} packed bytes, ${pack.unpackedSize} unpacked bytes, ${pack.entryCount} files`);
} finally {
  await rm(cache, { recursive: true, force: true });
}
