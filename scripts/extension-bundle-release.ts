import { createHash } from 'node:crypto';
import { appendFile, readFile, readdir } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const tagPattern = /^extension-bundles@v[0-9][0-9A-Za-z._-]{0,100}$/;
const versionPattern = /^[0-9][0-9A-Za-z._-]{0,100}$/;
type Command = (program: string, args: string[]) => Promise<string>;

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function command(program: string, args: string[]): Promise<string> {
  const { stdout } = await execFile(program, args, { encoding: 'utf8' });
  return stdout.trim();
}

export function bundleTag(version: string): string {
  assert(versionPattern.test(version), 'Use a version beginning with a digit and only letters, digits, dots, underscores and hyphens, such as 0.5.2');
  return `extension-bundles@v${version}`;
}

/** Creates an immutable tag once, or resumes a tag whose release was not published. */
export async function createOrResumeBundleTag(input: { version: string; refType: string; ref: string; sha: string; repository: string }, run: Command = command): Promise<{ tag: string; commit: string; resumed: boolean }> {
  assert(input.refType === 'branch' && input.ref === 'refs/heads/main', 'Extension bundle tag dispatches must run from refs/heads/main');
  const tag = bundleTag(input.version);
  let commit: string | undefined;
  try { commit = await run('gh', ['api', '--jq', '.object.sha', `repos/${input.repository}/git/ref/tags/${tag}`]); }
  catch { /* A missing tag is the normal new-release case. */ }
  if (commit) {
    try { await run('gh', ['release', 'view', tag]); }
    catch { return { tag, commit, resumed: true }; }
    throw new Error(`Release already exists: ${tag}`);
  }
  await run('gh', ['api', '--method', 'POST', `repos/${input.repository}/git/refs`, '-f', `ref=refs/tags/${tag}`, '-f', `sha=${input.sha}`]);
  return { tag, commit: input.sha, resumed: false };
}

export function selectBundleSource(input: { refType: string; refName: string; eventName: string; version?: string; sha: string }): { tag: string; commit: string } {
  assert(input.refType === 'tag', 'Extension bundle publication must run on a tag ref');
  assert(tagPattern.test(input.refName), `Not an extension bundle release tag: ${input.refName}`);
  if (input.eventName === 'workflow_dispatch') assert(input.refName === bundleTag(input.version ?? ''), 'Dispatched version does not match the tagged release source');
  assert(/^[a-f0-9]{40}$/.test(input.sha), 'Use the exact 40-character tagged source commit');
  return { tag: input.refName, commit: input.sha };
}

export async function verifyBundleInventory(directory: string, tag: string, commit: string): Promise<void> {
  const catalog = JSON.parse(await readFile(`${directory}/extension-bundles-catalog.json`, 'utf8')) as { format?: unknown; tag?: unknown; commit?: unknown; bundles?: unknown; revoked?: unknown };
  assert(catalog.format === 1 && catalog.tag === tag && catalog.commit === commit && Array.isArray(catalog.bundles) && Array.isArray(catalog.revoked), 'Generated extension bundle catalog is incomplete or does not pin the tagged source');
  const names = new Set<string>(), assets = new Set<string>();
  for (const item of catalog.bundles as { name?: unknown; sha256?: unknown; asset?: unknown }[]) {
    assert(typeof item.name === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(item.name) && !names.has(item.name), 'Generated extension bundle catalog has an invalid or duplicate name');
    assert(typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256), 'Generated extension bundle catalog has an invalid digest');
    assert(typeof item.asset === 'string' && /^[A-Za-z0-9._-]+\.tgz$/.test(item.asset) && !assets.has(item.asset), 'Generated extension bundle catalog has an invalid or duplicate asset');
    names.add(item.name); assets.add(item.asset);
    const bytes = await readFile(`${directory}/${item.asset}`);
    assert(createHash('sha256').update(bytes).digest('hex') === item.sha256, `Generated extension bundle digest differs for ${item.asset}`);
  }
  const present = (await readdir(directory)).filter(file => file.endsWith('.tgz'));
  assert(present.length === assets.size && present.every(asset => assets.has(asset)), 'Generated extension bundle files differ from the catalog inventory');
}

/** Rejects archive member types and paths the frozen module-tree format cannot represent safely. */
export async function verifyBundleArchives(directory: string, run: Command = command): Promise<void> {
  for (const asset of (await readdir(directory)).filter(file => file.endsWith('.tgz')).sort()) {
    const archive = `${directory}/${asset}`;
    const names = (await run('tar', ['-tzf', archive])).split('\n').filter(Boolean);
    assert(names.includes('bundle.json'), `Bundle is missing bundle.json: ${archive}`);
    assert(names.every(name => name === 'bundle.json' || name.startsWith('node_modules/')), `Bundle contains a member outside its frozen module tree: ${archive}`);
    // BSD/GNU tar both begin regular entries with '-'. Directories, links and
    // device entries are deliberately unsupported in executable bundles.
    const detail = (await run('tar', ['-tvzf', archive])).split('\n').filter(Boolean);
    assert(detail.every(line => line.startsWith('-')), `Bundle contains a non-regular member: ${archive}`);
  }
}

async function main(): Promise<void> {
  const [operation] = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  if (operation === 'tag') {
    const version = process.env.VERSION ?? '', result = await createOrResumeBundleTag({ version, refType: process.env.GITHUB_REF_TYPE ?? '', ref: process.env.GITHUB_REF ?? '', sha: process.env.GITHUB_SHA ?? '', repository });
    await command('gh', ['workflow', 'run', 'extension-bundles.yml', '--ref', result.tag, '-f', `version=${version}`]);
    console.log(result.resumed ? `Resuming incomplete release ${result.tag} at ${result.commit}` : `Created ${result.tag} at ${result.commit}`);
    console.log(`Dispatched the build of ${result.tag} on refs/tags/${result.tag}; approve that run to publish.`);
    return;
  }
  if (operation === 'source') {
    const source = selectBundleSource({ refType: process.env.GITHUB_REF_TYPE ?? '', refName: process.env.GITHUB_REF_NAME ?? '', eventName: process.env.GITHUB_EVENT_NAME ?? '', ...(process.env.VERSION === undefined ? {} : { version: process.env.VERSION }), sha: process.env.GITHUB_SHA ?? '' });
    assert(process.env.GITHUB_OUTPUT, 'GITHUB_OUTPUT is required');
    await appendFile(process.env.GITHUB_OUTPUT, `tag=${source.tag}\ncommit=${source.commit}\n`);
    return;
  }
  const directory = `${process.env.RUNNER_TEMP}/urlcode-extension-bundles`, tag = process.env.RELEASE_TAG ?? '', commit = process.env.RELEASE_COMMIT ?? '';
  if (operation === 'build') {
    assert(await command('git', ['rev-parse', `${tag}^{commit}`]) === commit, 'Release tag does not resolve to the selected source commit');
    await command('git', ['merge-base', '--is-ancestor', commit, 'origin/main']);
    await command(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/prepare-extension-bundles.ts', '--tag', tag, '--commit', commit, '--output', directory]);
    return;
  }
  if (operation === 'inventory') { await verifyBundleInventory(directory, tag, commit); return; }
  if (operation === 'archives') { await verifyBundleArchives(directory); return; }
  if (operation === 'verify-local') { await command(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/verify-extension-bundles.ts', '--tag', tag, '--dir', directory]); return; }
  if (operation === 'publish') {
    const assets = (await readdir(directory)).filter(file => file.endsWith('.tgz')).sort().map(file => `${directory}/${file}`);
    await command('gh', ['release', 'create', tag, `${directory}/extension-bundles-catalog.json`, ...assets, '--title', tag, '--verify-tag']);
    return;
  }
  if (operation === 'verify-published') {
    const published = `${process.env.RUNNER_TEMP}/urlcode-extension-bundles-published`;
    await command('gh', ['release', 'download', tag, '--repo', repository, '--dir', published]);
    await command(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/verify-extension-bundles.ts', '--tag', tag, '--dir', published]);
    return;
  }
  throw new Error('Use tag, source, build, inventory, archives, verify-local, publish or verify-published');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
