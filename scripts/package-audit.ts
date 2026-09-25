import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parsePackJson } from './pack-json.ts';
import { addons, repositoryRoot } from './workspaces.ts';

interface PackedFile { path: string; size: number }
interface PackReport {
  name: string;
  size: number;
  unpackedSize: number;
  entryCount: number;
  files: PackedFile[];
}
export type PackageKind = 'core' | 'extension' | 'artifact';
export interface Budget {
  packed: number;
  unpacked: number;
  entries: number;
  roots: readonly string[];
  optionalPeers?: readonly string[];
}

// These are release budgets, not targets, keyed by package name. The allowlists
// keep repository-only material out; the headroom lets implementation grow
// without silently undoing the packaging boundary. Which packages are audited is
// not listed here: `--all` audits core plus every add-on scripts/workspaces.ts
// finds, and an add-on without a budget below fails rather than being skipped.
export const budgets: Record<string, Budget> = {
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
    //
    // Packed raised from 640 to 650 KiB: a batch of small, independent
    // features (mcp promoted to a distributed package; create-extension
    // scaffolding; the x-urlcode-context-* extension channel; shipped-skills consolidation) landed together and pushed
    // the compressed archive to about 641 KiB, a few hundred bytes over
    // the previous budget on its own even before gzip-implementation
    // variance across Node/OS combinations.
    //
    // Unpacked raised from 2650 to 2700 KiB: the capability-only installs
    // (#711, with an `example()` hook and the `--example` docs sweep), the
    // store-contributed CRUD screen (#709), text-level YAML edits for
    // `extensions add`/`remove` (#715), library-mode listing (#718) and the
    // generic add-on authoring rules (#712) together pushed the unpacked
    // content to about 2653 KiB, about 3 KiB over. The same batch leaves the
    // packed archive at about 646 KiB (661714 bytes on Node 26), under 4 KiB
    // from the 650 KiB budget and inside the ~2 KiB npm gzip variance noted
    // above, so packed is raised to 660 KiB as well.
    //
    // Entries raised from 450 to 460: the operator alias-origin list (#717)
    // adds one runtime module (dist/site-origins.js), taking the archive to
    // 451 files; the other ten keep headroom for the next small module
    // without loosening the allowlist or size checks.
    //
    // Unpacked raised from 2700 to 2720 KiB: per-record store ownership
    // (#331) adds the core request-principal contract (RIM-EXT-PRINCIPAL-001:
    // dist/extensions.js and its declarations), the "Request principal" and
    // "Per-record ownership" sections of docs/EXTENSIONS.md and docs/STORE.md,
    // and their copies in llms-full.txt, taking the unpacked content to
    // 2765326 bytes (about 2700.5 KiB, 526 bytes over). Packed stays at 660
    // KiB: the same tree packs to 674409 bytes on Node 26, about 1.4 KiB under.
    packed: 660 * 1024,
    unpacked: 2720 * 1024,
    entries: 460,
    roots: ['.claude', 'LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'data', 'dist', 'docs', 'examples', 'llms-full.txt', 'llms.txt', 'package.json', 'recipes', 'schemas', 'skills', 'starters'],
    optionalPeers: ['typescript'],
  },
  '@jimhoyd/urlcode-auth': {
    packed: 225 * 1024,
    unpacked: 900 * 1024,
    entries: 90,
    roots: ['LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'dist', 'package.json', 'urlcode.json'],
    optionalPeers: ['@aws-sdk/client-sesv2'],
  },
  '@jimhoyd/urlcode-admin': {
    packed: 75 * 1024,
    unpacked: 250 * 1024,
    entries: 56,
    roots: ['LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'dist', 'package.json', 'urlcode.json'],
  },
  '@jimhoyd/urlcode-store': {
    packed: 40 * 1024,
    // Unpacked raised from 120 to 140 KiB: per-record ownership (#331) adds
    // the owner scoping in dist/collection.js and dist/store.js, the operator
    // step for legacy records (dist/ownership.js, the urlcode-store bin
    // dist/cli.js, with declarations) and the ownership contract in
    // SECURITY.md and README.md, taking the unpacked content to 138043 bytes
    // (about 134.8 KiB). It still packs to 35306 bytes, under 40 KiB.
    unpacked: 140 * 1024,
    entries: 31,
    roots: ['LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'dist', 'package.json', 'urlcode.json'],
  },
  '@jimhoyd/urlcode-forms': {
    packed: 45 * 1024,
    unpacked: 140 * 1024,
    entries: 31,
    roots: ['LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'dist', 'package.json', 'urlcode.json'],
  },
  '@jimhoyd/urlcode-mcp': {
    packed: 45 * 1024,
    unpacked: 140 * 1024,
    entries: 31,
    roots: ['LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'dist', 'package.json', 'urlcode.json'],
  },
  '@jimhoyd/urlcode-ui': {
    packed: 100 * 1024,
    unpacked: 350 * 1024,
    // Raised from 61: the extension definition adds dist/extension.js,
    // dist/extension.d.ts and urlcode.json to every extension package, which
    // took ui to 64.
    entries: 68,
    roots: ['LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'dist', 'package.json', 'urlcode.json', 'vendor'],
  },
  // Artifacts are inert JSON: a few KiB, and the exact file shape below.
  '@jimhoyd/urlcode-store-schema': {
    packed: 16 * 1024,
    unpacked: 64 * 1024,
    entries: 12,
    roots: ['LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'config', 'package.json', 'schemas', 'urlcode.json'],
  },
};

/** The only files an artifact package may carry: its descriptor, docs and legal files, and JSON data. */
const artifactFile = /^(?:package\.json|urlcode\.json|README\.md|LICENSE|NOTICE|SECURITY\.md|(?:schemas|config)\/[A-Za-z0-9._-]+\.json)$/;

/**
 * Checks a package's `npm pack --dry-run` file list beyond its root allowlist: no installed dependency tree
 * (a `node_modules/` path) and no copy of core (`@jimhoyd/urlcode`) may ship inside any package, and an artifact
 * carries only the files `artifactFile` names. Returns one line per offending path.
 */
export function packFileProblems(kind: PackageKind, paths: readonly string[]): string[] {
  const problems: string[] = [];
  for (const path of paths) {
    if (/(?:^|\/)node_modules(?:\/|$)/.test(path)) problems.push(`${path}: node_modules/ must never ship`);
    else if (/(?:^|\/)@jimhoyd\/urlcode(?:[/-]|$)/.test(path)) problems.push(`${path}: a copy of @jimhoyd/urlcode (core or a sibling add-on) must never ship inside a package`);
    else if (kind === 'artifact' && !artifactFile.test(path)) problems.push(`${path}: an artifact carries only package.json, urlcode.json, README.md, LICENSE, NOTICE, SECURITY.md, schemas/*.json and config/*.json`);
  }
  return problems;
}

/** Core (`.`) plus every add-on, in dependency order, as directories relative to `root`. */
export async function auditedPackages(root = repositoryRoot): Promise<{ directory: string; kind: PackageKind }[]> {
  return [{ directory: '.', kind: 'core' }, ...(await addons(root)).map(addon => ({ directory: relative(root, addon.directory), kind: addon.kind }))];
}

function targets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.values(value).flatMap(targets);
}

async function auditAll(): Promise<void> {
  // Every add-on is private (so a stray `npm publish` refuses), but its tarball is still a release asset that
  // core's addons.json pins, so `private` is never a reason to skip its package boundary.
  for (const { directory } of await auditedPackages()) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), directory], { cwd: repositoryRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message || `Package audit failed for ${directory}`);
    process.stdout.write(result.stdout);
  }
}

async function auditOne(target: string): Promise<void> {
  const directory = resolve(target);
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
    name?: string;
    exports?: unknown;
    bin?: Record<string, string>;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  const budget = manifest.name ? budgets[manifest.name] : undefined;
  assert(budget, `No package audit policy for ${manifest.name ?? directory}: add a budget for it in scripts/package-audit.ts`);
  const kind: PackageKind = resolve(directory) === resolve(repositoryRoot) ? 'core' : (await auditedPackages()).find(item => resolve(repositoryRoot, item.directory) === resolve(directory))?.kind ?? 'extension';
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
    const shapeProblems = packFileProblems(kind, pack.files.map(file => file.path));
    assert.deepEqual(shapeProblems, [], `Files that must not ship in ${pack.name}:\n${shapeProblems.join('\n')}`);

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
    // Core also carries its add-on pins and the release-wide add-on agent catalog beside them (#721).
    const required = [...targets(manifest.exports), ...Object.values(manifest.bin ?? {}), ...(kind === 'core' ? ['dist/addons.json', 'dist/addon-catalog.json'] : [])]
      .map(path => path.replace(/^\.\//, ''));
    const missing = required.filter(path => !shipped.has(path));
    assert.deepEqual(missing, [], `Package exports or required files are missing:\n${missing.join('\n')}`);
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--all') await auditAll();
  else await auditOne(process.argv[2] ?? '.');
}
