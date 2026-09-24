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
    // review_project (a new opt-in, read-only static review tool: packages/core/src/review.ts,
    // its MCP/CLI wiring, no data/schema/example growth) adds a few hundred bytes
    // of genuinely new compressed content, already trimmed to a minimal
    // implementation. Measured PR #437 CI packed sizes for the identical commit
    // were 532179-532180 bytes on Node 22/26 (ubuntu) but 534333 bytes on Node 24
    // (ubuntu) -- a ~2.1 KiB swing from npm's own tar/gzip output alone, not from
    // this change, which the previous 520 KiB budget had no headroom left to
    // absorb. Raised to keep every supported Node release comfortably under
    // budget rather than chasing gzip-implementation noise byte by byte.
    // Shipping the four docs/*.md files searchDocs (urlcode docs search /
    // MCP search_docs) reads at runtime -- plus docs/README.md, which npm
    // always includes once anything under docs/ is packed -- adds about
    // 30 KiB of compressed content, 110 KiB unpacked and 5 more entries.
    // The env-binding host-override option (#258) also adds a small amount
    // of schema and llms-full.txt content. Keep 640 KiB of compressed
    // capacity: the current archive is about 553 KiB, so routine, reviewed
    // package growth and npm gzip variation do not turn into unrelated PR
    // failures. The deterministic unpacked-size, file-count and allowlist
    // boundaries below still catch unexpected package expansion.
    //
    // Raised from 2450 KiB for the fixture schema, structured error fields
    // and docs added for #581/#583/#584 (JSON 422 responses, did-you-mean
    // messages, schemas/requests.schema.json). Some of that headroom (about
    // 9.5 KiB) covered examples/cloudflare/dist/*, a gitignored build
    // artifact that `npm run test:examples:built` left behind and that
    // `npm pack` picked up whenever it sat under the wholesale-listed
    // `examples` root. #608 excludes that artifact from `files` (and this
    // script now asserts no gitignored path ships, dist/ itself excepted
    // since that is the package's deliberate, always-regenerated build
    // output), so that headroom is no longer spent on a leak.
    //
    // Raised from 2550 KiB for the onboarding-docs sweep (#591):
    // docs/YAML-REFERENCE.md is now split into per-area sections with the
    // schema's `description` fields included (about +13.5 KiB), which also
    // grows the consolidated `llms-full.txt` (about +21 KiB), both shipped
    // files. `docs/CONCEPTS.md` itself is not in `files` and does not ship.
    // Kept at 2650 KiB rather than lowered by the reclaimed 9.5 KiB: the
    // #591 growth alone needs most of that headroom back.
    packed: 640 * 1024,
    unpacked: 2650 * 1024,
    entries: 450,
    roots: ['.claude', 'LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'data', 'dist', 'docs', 'examples', 'llms-full.txt', 'llms.txt', 'package.json', 'recipes', 'schemas', 'skills', 'starters'],
    optionalPeers: ['typescript'],
  },
  '@jimhoyd/urlcode-auth': {
    packed: 225 * 1024,
    unpacked: 900 * 1024,
    entries: 90,
    roots: ['LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'dist', 'package.json'],
    optionalPeers: ['@aws-sdk/client-sesv2'],
  },
  '@jimhoyd/urlcode-admin': {
    packed: 75 * 1024,
    unpacked: 250 * 1024,
    entries: 56,
    roots: ['LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'dist', 'package.json'],
  },
  '@jimhoyd/urlcode-store': {
    packed: 40 * 1024,
    unpacked: 120 * 1024,
    entries: 31,
    roots: ['LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'dist', 'package.json'],
  },
  '@jimhoyd/urlcode-forms': {
    packed: 45 * 1024,
    unpacked: 140 * 1024,
    entries: 31,
    roots: ['LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'dist', 'package.json'],
  },
  '@jimhoyd/urlcode-ui': {
    packed: 100 * 1024,
    unpacked: 350 * 1024,
    entries: 61,
    roots: ['LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'dist', 'package.json', 'vendor'],
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
    let pkg: { name?: string };
    try { pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name?: string }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
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

  // A path the working tree happens to have locally (an uncommitted build
  // artifact under a wholesale-listed `files` root, e.g. examples/*/dist/)
  // must never ship just because it exists on disk when `npm pack` runs:
  // that makes the tarball's contents depend on build order/history instead
  // of the committed source (see #608). Reject any packed path git would
  // ignore, except the package's own `dist` root: that build output is
  // deliberately gitignored (never committed) yet always the intended
  // shipped content, generated fresh by `npm run build` right before
  // packing.
  const candidates = pack.files.map(file => file.path).filter(path => path.split('/')[0] !== 'dist');
  const repoPaths = candidates.map(path => join(directory, path));
  const ignoreCheck = repoPaths.length > 0
    ? spawnSync('git', ['check-ignore', '--stdin', '-z'], {
      cwd: directory,
      input: repoPaths.join('\0') + '\0',
      encoding: 'utf8',
    })
    : undefined;
  // git check-ignore exits 1 when none of the paths are ignored, which is
  // the expected case; only treat spawn failure (missing git) as fatal.
  assert(!ignoreCheck || ignoreCheck.error === undefined, `Failed to run git check-ignore: ${ignoreCheck?.error?.message}`);
  const ignored = ignoreCheck ? ignoreCheck.stdout.split('\0').map(entry => entry.trim()).filter(Boolean) : [];
  assert.deepEqual(ignored, [], `Gitignored paths present in packed release (nondeterministic local build artifacts, see #608):\n${ignored.join('\n')}`);

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
