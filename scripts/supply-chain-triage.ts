import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface LockPackage {
  version?: string;
  integrity?: string;
  license?: string;
  dev?: boolean;
  dependencies?: Record<string, string>;
}
interface Exception {
  id: string;
  package: { name: string; version: string };
  categories: string[];
  disposition: 'accepted';
  rationale: string;
  review: string;
}
interface ExceptionsFile { version: 1; exceptions: Exception[] }

function nameForPath(path: string): string | undefined {
  const marker = 'node_modules/';
  const index = path.lastIndexOf(marker);
  if (index < 0) return undefined;
  const tail = path.slice(index + marker.length);
  const parts = tail.split('/');
  return parts[0]?.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export function buildTriage(lock: { packages?: Record<string, LockPackage> }, exceptions: ExceptionsFile, tarball: Buffer, sbom: Buffer) {
  assert.equal(exceptions.version, 1, 'Unsupported supply-chain exception format');
  const packages = lock.packages;
  assert(packages && typeof packages === 'object', 'Lockfile has no packages map');
  const grouped = new Map<string, { name: string; version: string; paths: string[]; integrity?: string; license?: string }>();
  for (const [path, entry] of Object.entries(packages)) {
    if (!path || entry.dev) continue;
    const name = nameForPath(path);
    if (!name || !entry.version) continue;
    const key = `${name}@${entry.version}`;
    const component = grouped.get(key) ?? {
      name,
      version: entry.version,
      paths: [],
      ...(entry.integrity === undefined ? {} : { integrity: entry.integrity }),
      ...(entry.license === undefined ? {} : { license: entry.license }),
    };
    component.paths.push(path);
    grouped.set(key, component);
  }
  const components = [...grouped.values()].map(component => ({ ...component, paths: component.paths.sort() }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const seen = new Set<string>();
  const resolvedExceptions = exceptions.exceptions.map(exception => {
    assert.match(exception.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Exception id must be lowercase kebab-case');
    assert.equal(exception.disposition, 'accepted', `${exception.id}: unsupported disposition`);
    assert(exception.categories.length > 0 && exception.categories.every(category => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(category)), `${exception.id}: invalid categories`);
    assert(exception.rationale.trim() && exception.review.trim(), `${exception.id}: rationale and review are required`);
    assert(!seen.has(exception.id), `Duplicate exception id: ${exception.id}`);
    seen.add(exception.id);
    const component = grouped.get(`${exception.package.name}@${exception.package.version}`);
    assert(component, `${exception.id}: exception package is absent from the locked production tree`);
    return { ...exception, packagePaths: [...component.paths].sort() };
  });
  // Parsing proves the SBOM is an actual JSON document; it is retained as the
  // scanner-neutral component inventory rather than copied into this summary.
  JSON.parse(sbom.toString('utf8'));
  return {
    format: 1,
    tarball: { filename: basename('package.tgz'), sha256: createHash('sha256').update(tarball).digest('hex') },
    sbom: { format: 'CycloneDX', sha256: createHash('sha256').update(sbom).digest('hex') },
    components,
    exceptions: resolvedExceptions,
  };
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  assert(index >= 0 && args[index + 1] && !args[index + 1]!.startsWith('--'), `${name} needs a path`);
  return resolve(args[index + 1]!);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const tarballPath = option(args, '--tarball');
  const lockfilePath = option(args, '--lockfile');
  const sbomPath = option(args, '--sbom');
  const exceptionsPath = option(args, '--exceptions');
  const outputPath = option(args, '--output');
  const [tarball, lockfile, sbom, exceptions] = await Promise.all([readFile(tarballPath), readFile(lockfilePath), readFile(sbomPath), readFile(exceptionsPath, 'utf8')]);
  const report = buildTriage(JSON.parse(lockfile.toString('utf8')), JSON.parse(exceptions) as ExceptionsFile, tarball, sbom);
  report.tarball.filename = basename(tarballPath);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
