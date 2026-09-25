// Builds every file a release publishes into release/: every add-on tarball, core's tarball (carrying
// dist/addons.json that pins those exact add-on bytes by sha512 and release URL, and dist/addon-catalog.json, checked
// against those tarballs' descriptors), the CycloneDX SBOM, the
// supply-chain triage, the Homebrew formula and SHA256SUMS. Run after `npm run build` and the add-on builds.
//
//   node scripts/release-pack.ts [--out release]
//
// CI runs it twice and compares SHA256SUMS: the packer must be deterministic.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packAddons } from './pack-addons.ts';
import { buildTriage } from './supply-chain-triage.ts';
import { check } from './release-bump.ts';
import { npmCommand } from './npm-command.ts';
import { addons, repositoryRoot } from './workspaces.ts';
import { buildAddonCatalog, parseAddonCatalog } from '../packages/core/src/addon-manifest.ts';

export const releaseUrlBase = (version: string): string => `https://github.com/jimhoyd-com/urlcode/releases/download/v${version}`;

export async function releasePack(out: string): Promise<{ version: string; files: string[] }> {
  const version = await check();
  await rm(out, { recursive: true, force: true });
  const packed = await packAddons(out, { urlBase: releaseUrlBase(version), pinCore: true });
  const pinned = JSON.parse(await readFile(packed.manifest, 'utf8')) as { addons: Record<string, { integrity: string | null; url: string }> };
  for (const [name, pin] of Object.entries(pinned.addons)) assert(pin.integrity && pin.url.startsWith('https://'), `${name} is not pinned to a release URL`);
  const shipped = JSON.parse(execFileSync('tar', ['-xOzf', packed.core, 'package/dist/addons.json'], { encoding: 'utf8' })) as unknown;
  assert.deepEqual(shipped, pinned, "core's tarball must carry exactly the add-on pins of this release");
  // The agent catalog in core's tarball must be exactly what the signed add-on tarballs' own descriptors say (#721).
  const signed = (tarball: string, member: string): unknown => JSON.parse(execFileSync('tar', ['-xOzf', tarball, `package/${member}`], { encoding: 'utf8' }));
  const catalog = buildAddonCatalog(version, Object.entries(packed.tarballs).map(([name, tarball]) => {
    const pkg = signed(tarball, 'package.json') as { name: string; version: string };
    return { descriptor: signed(tarball, 'urlcode.json'), package: pkg.name, version: pkg.version, source: `${basename(tarball)} (${name})` };
  }));
  assert.deepEqual(parseAddonCatalog(signed(packed.core, 'dist/addon-catalog.json'), 'core dist/addon-catalog.json'), catalog, "core's tarball must carry the agent catalog of exactly this release's add-on descriptors");

  // Core and every extension. Artifacts are inert and have no dependencies, and naming one (or passing --workspaces)
  // overflows npm's stack on its dependency-free workspace node (npm 11.19), so each extension is named instead.
  const extensions = (await addons()).filter(addon => addon.kind === 'extension').flatMap(addon => ['--workspace', addon.packageName]);
  const npm = npmCommand(['sbom', '--omit=dev', '--sbom-format', 'cyclonedx', '--include-workspace-root', ...extensions]);
  const sbom = execFileSync(npm.command, npm.args, { cwd: repositoryRoot, maxBuffer: 64 * 1024 * 1024 });
  await writeFile(join(out, 'sbom.cdx.json'), sbom);
  const triage = buildTriage(JSON.parse(await readFile(join(repositoryRoot, 'package-lock.json'), 'utf8')), JSON.parse(await readFile(join(repositoryRoot, 'security', 'supply-chain-exceptions.json'), 'utf8')), await readFile(packed.core), sbom);
  triage.tarball.filename = basename(packed.core);
  await writeFile(join(out, 'supply-chain-triage.json'), JSON.stringify(triage, null, 2) + '\n');
  execFileSync(process.execPath, [join(repositoryRoot, 'scripts', 'render-homebrew.ts'), '--tarball', packed.core, '--out', join(out, 'urlcode.rb')], { cwd: repositoryRoot, stdio: 'ignore' });

  const files = (await readdir(out)).filter(name => name !== 'SHA256SUMS').sort();
  const sums = await Promise.all(files.map(async name => `${createHash('sha256').update(await readFile(join(out, name))).digest('hex')}  ${name}`));
  await writeFile(join(out, 'SHA256SUMS'), sums.join('\n') + '\n');
  return { version, files: [...files, 'SHA256SUMS'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = process.argv.indexOf('--out');
  const out = resolve(index >= 0 ? process.argv[index + 1]! : 'release');
  const result = await releasePack(out);
  process.stdout.write(`Packed ${result.version} into ${out}:\n${result.files.map(file => `  ${file}`).join('\n')}\n`);
}
