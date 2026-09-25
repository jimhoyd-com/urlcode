import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { ConfigError, assert } from './errors.ts';
import { assertInertArtifacts, dependencyTree, lockPackages, nestedCopies, openSite, pinProblem, readJson, renderJson, rollBack, snapshot } from './addon-install.ts';
import type { PackageJson } from './addon-install.ts';
import { parseAddonManifest } from './addon-manifest.ts';
import { runNpm } from './npm.ts';

const core = '@jimhoyd/urlcode';
const exact = /^\d+\.\d+\.\d+(?:-alpha\.\d+)?$/;
const actionRef = /(jimhoyd-com\/urlcode\/action@)v[0-9A-Za-z.-]+/g;

export interface UpgradePlan { site: string; current: string; target: string; upToDate: boolean; addons: string[] }
export interface UpgradeResult extends UpgradePlan { upgraded: boolean; workflows: string[]; projectSha256: string }

/** The newest stable release: npm's `latest` dist-tag, which only a stable release moves (prereleases use `alpha`). */
async function latestStable(site: string): Promise<string> {
  const latest = JSON.parse(await runNpm(['view', core, 'dist-tags.latest', '--json'], site)) as unknown;
  assert(typeof latest === 'string' && exact.test(latest) && !latest.includes('-'), `npm reports ${String(latest)} as ${core}'s latest; expected a stable version`);
  return latest;
}
const installedAddons = (pkg: PackageJson): string[] => Object.keys(pkg.dependencies ?? {}).filter(name => name.startsWith(`${core}-`)).map(name => name.slice(core.length + 1)).sort();

/** `urlcode upgrade --check`: where the site is and where it would move, without changing anything. */
export async function planUpgrade(directory: string, { to }: { to?: string | undefined } = {}): Promise<UpgradePlan> {
  const site = await openSite(directory), pkg = await readJson<PackageJson>(site.packageFile);
  const current = pkg.dependencies?.[core];
  assert(current && exact.test(current), `package.json pins ${core} to ${current ?? 'nothing'}; upgrade moves an exact registry version (for example 1.2.3)`);
  if (to !== undefined) assert(exact.test(to), 'Use --to X.Y.Z or X.Y.Z-alpha.N');
  const target = to ?? await latestStable(site.site);
  return { site: site.site, current, target, upToDate: current === target, addons: installedAddons(pkg) };
}

function run(file: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => execFile(process.execPath, [file, ...args], { cwd, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new ConfigError(`${args.join(' ')} failed with the new runtime:\n${String(stderr || stdout || error.message).trim().split('\n').slice(-8).join('\n')}`)) : resolve(stdout)));
}

/**
 * `urlcode upgrade [--to X]`: moves core and every installed add-on to one version together. Core is installed
 * first; its own dist/addons.json then says exactly which add-on bytes belong to it, so the add-ons follow its
 * pins, never a separate lookup. The new runtime validates the project, and the site's workflow moves to the same
 * action release. Every upgraded artifact must still be inert, exactly as `artifacts add` requires. Any failure
 * restores package.json, package-lock.json and the workflows, then reinstalls node_modules from the restored lock with
 * `npm ci --ignore-scripts`; a reinstall that itself fails is reported with that command, never hidden. The lock is
 * what makes the rollback exact, so a site without one is refused before anything changes.
 */
export async function upgradeSite(directory: string, options: { to?: string | undefined } = {}): Promise<UpgradeResult> {
  const plan = await planUpgrade(directory, options), site = await openSite(directory);
  const workflowsDir = join(site.site, '.github', 'workflows');
  const workflows = (await readdir(workflowsDir).catch(() => [] as string[])).filter(name => /\.ya?ml$/.test(name)).map(name => join(workflowsDir, name));
  const newCli = join(site.site, 'node_modules', '@jimhoyd', 'urlcode', 'dist', 'cli.js');
  const revision = async (): Promise<string> => (await run(newCli, ['explain', '--project', 'app', '--json'], site.site).then(out => (JSON.parse(out.trim().split('\n').at(-1)!) as { projectSha256?: string }).projectSha256 ?? '', () => ''));
  if (plan.upToDate) return { ...plan, upgraded: false, workflows: [], projectSha256: await revision() };
  const tree = await dependencyTree(site.site);
  assert(tree.hadLock, `${site.site} has no package-lock.json, so a failed upgrade could not put node_modules back exactly; run \`npm install --ignore-scripts\` there first, then upgrade`);
  const state = await snapshot([site.packageFile, join(site.site, 'package-lock.json'), ...workflows]);
  try {
    const pkg = await readJson<PackageJson>(site.packageFile);
    pkg.dependencies = { ...pkg.dependencies, [core]: plan.target };
    await writeFile(site.packageFile, renderJson(pkg));
    await runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], site.site);
    const manifest = parseAddonManifest(await readJson(join(site.site, 'node_modules', '@jimhoyd', 'urlcode', 'dist', 'addons.json')), `${core}@${plan.target} dist/addons.json`);
    const missing = plan.addons.filter(name => !manifest.addons[name]);
    if (missing.length) throw new ConfigError(`${core}@${plan.target} does not release ${missing.join(', ')}; remove ${missing.length === 1 ? 'it' : 'them'} first or choose another version`);
    for (const name of plan.addons) pkg.dependencies[manifest.addons[name]!.package] = manifest.addons[name]!.url;
    await writeFile(site.packageFile, renderJson(pkg));
    await runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], site.site);
    const lock = await lockPackages(site.site);
    for (const name of plan.addons) { const problem = pinProblem(lock, manifest.addons[name]!); if (problem) throw new ConfigError(`Refusing ${name}: ${problem}`); }
    const nested = nestedCopies(lock);
    assert(!nested.length, `The upgrade produced nested copies (${nested.join(', ')})`);
    await assertInertArtifacts(site.site, lock, manifest, plan.addons.filter(name => manifest.addons[name]!.kind === 'artifact'));
    await run(newCli, ['validate', '--project', 'app'], site.site);
    const changed: string[] = [];
    for (const file of workflows) {
      const text = await readFile(file, 'utf8'), next = text.replace(actionRef, `$1v${plan.target}`);
      if (next !== text) { await writeFile(file, next); changed.push(relative(site.site, file).split(sep).join('/')); }
    }
    return { ...plan, upgraded: true, workflows: changed, projectSha256: await revision() };
  } catch (error) { return rollBack(state, tree, site.site, error); }
}
