import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecFileOptions } from 'node:child_process';

interface RunResult { status: number; stdout: string; stderr: string }
interface PackageJson { name: string; version: string; license?: string; private?: boolean; engines: { node: string }; description?: string }

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (name: string) => readFile(join(repo,name),'utf8');
const pkg: PackageJson = JSON.parse(await read('package.json'));
// Version text becomes a pattern; escape every metacharacter, not only dots.
// npm packs a scoped name by dropping the @ and joining scope and name with a
// dash; the registry then serves it under /@scope/name/-/name-version.tgz.
const packedName = (name: string) => name.replace('@','').replace('/','-');
const pattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const run = (args: string[], options: ExecFileOptions = {}): Promise<RunResult> => new Promise(resolve => {
  execFile(process.execPath,args,{cwd:repo,encoding:'utf8',timeout:60000,...options},
    (error,stdout,stderr) => resolve({status:error?(typeof error.code === 'number' ? error.code : 1):0,stdout:String(stdout),stderr:String(stderr)}));
});

test('the released version is stated consistently across the CLI and installer', async () => {
  // A release publishes one version; a banner or floor that drifts misinforms
  // users about what they installed and which Node it needs.
  assert.match((await read('packages/core/src/cli.ts')),new RegExp(`URLCode ${pattern(pkg.version)} `),
    'packages/core/src/cli.ts usage banner does not state package.json version');
  const engines = pkg.engines.node.match(/^>=(\d+)\.(\d+)\./);
  assert.ok(engines,'engines.node must be a >=major.minor.patch range');
  const installer = await read('install.sh');
  assert.match(installer,new RegExp(`MIN_NODE_MAJOR=${engines[1]}\\b`),'install.sh major floor differs from engines.node');
  assert.match(installer,new RegExp(`MIN_NODE_MINOR=${engines[2]}\\b`),'install.sh minor floor differs from engines.node');
});

test('a release requires a declared license and a publishable package', async () => {
  assert.equal(pkg.license,'Apache-2.0');
  assert.ok(!pkg.private,'private packages cannot be released');
  assert.ok((await read('LICENSE')).includes('Apache License'));
  assert.ok((await read('packaging/homebrew/urlcode.rb.template')).includes('license "Apache-2.0"'));
});

test('the Homebrew formula renders only from measured bytes', async t => {
  const root = await mkdtemp(join(tmpdir(),'urlcode-formula-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const out = join(root,'urlcode.rb');
  const sha = 'a'.repeat(64);
  assert.equal((await run(['scripts/render-homebrew.ts','--sha256',sha,'--out',out])).status,0);
  const formula = await readFile(out,'utf8');
  assert.match(formula,new RegExp(`/${pattern(pkg.name.split('/').pop() as string)}-${pattern(pkg.version)}\\.tgz`));
  assert.match(formula,new RegExp(`sha256 "${sha}"`));
  assert.doesNotMatch(formula,/__[A-Z0-9_]+__/,'template placeholder survived rendering');

  // A checksum that was not measured from the named file must be refused.
  const mismatch = await run(['scripts/render-homebrew.ts','--tarball','package.json','--sha256',sha,'--out',out]);
  assert.equal(mismatch.status,1);
  assert.match(mismatch.stderr,/does not match/);
  for (const args of [[],['--sha256','short']]) {
    assert.equal((await run(['scripts/render-homebrew.ts',...args,'--out',out])).status,1);
  }
});

test('formula text from package.json cannot escape its Ruby string', async t => {
  const root = await mkdtemp(join(tmpdir(),'urlcode-escape-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  // A rendered formula is Ruby that Homebrew executes. Render from a package.json
  // whose description carries a quote, a backslash and an interpolation, and
  // require all three to arrive inert.
  const pkgPath = join(root,'package.json');
  const hostile = 'Quote " backslash \\ interpolation #{system("touch /tmp/pwned")}';
  await writeFile(pkgPath,JSON.stringify({...pkg,description:hostile}));
  await cp(fileURLToPath(new URL('../packaging',import.meta.url)),join(root,'packaging'),{recursive:true});
  const out = join(root,'urlcode.rb');
  const script = fileURLToPath(new URL('../scripts/render-homebrew.ts',import.meta.url));
  const result = await run([script,'--sha256','b'.repeat(64),'--out',out],{cwd:root});
  assert.equal(result.status,0,result.stderr);
  const desc = (await readFile(out,'utf8')).split('\n').find(line => line.includes('desc '));
  assert.ok(desc !== undefined,'no desc line was rendered');
  assert.ok(desc.includes('\\"'),'quote is not escaped');
  assert.ok(desc.includes('\\\\'),'backslash is not escaped');
  assert.ok(desc.includes('\\#{'),'Ruby interpolation is not escaped');
  assert.ok(!/[^\\]#\{/.test(desc),'an unescaped interpolation remains');
});

test('the package ships the agent skill and the starter guide', async () => {
  const files: string[] = JSON.parse(await read('package.json')).files;
  assert.ok(files.includes('skills'),'package.json files must include skills/');
  assert.ok(files.includes('starters'),'package.json files must include starters/');
  const skill = await read('skills/urlcode/SKILL.md');
  assert.match(skill,/^---\nname: urlcode\ndescription: [^\n]*urlcode\.yaml[^\n]*\n---\n/,'SKILL.md needs Agent Skills frontmatter naming urlcode and triggering on urlcode.yaml');
  assert.ok(skill.split('\n').length <= 150,'SKILL.md must stay under 150 lines');
  for (const command of ['urlcode capabilities','urlcode recipes list','urlcode validate --local','urlcode test','urlcode audit']) assert.ok(skill.includes(command),`SKILL.md lacks ${command}`);
  assert.ok((await read('starters/default/AGENTS.md')).includes('skills/urlcode/SKILL.md'));
});

test('the release build refuses a tag that disagrees with package.json', async t => {
  const root = await mkdtemp(join(tmpdir(),'urlcode-release-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const env = {...process.env,URLCODE_SOURCE_SHA:'0'.repeat(40),URLCODE_CHANNEL:'release'};
  const wrong = await run(['scripts/build-candidate.ts'],{env:{...env,URLCODE_RELEASE_VERSION:'9.9.9'}});
  assert.equal(wrong.status,1);
  assert.match(wrong.stderr,/does not match package\.json/);
  const badChannel = await run(['scripts/build-candidate.ts'],{env:{...env,URLCODE_CHANNEL:'nightly'}});
  assert.equal(badChannel.status,1);
  assert.match(badChannel.stderr,/candidate or release/);
  const noCommit = await run(['scripts/build-candidate.ts'],{env:{...process.env,URLCODE_SOURCE_SHA:''}});
  assert.equal(noCommit.status,1);
  assert.match(noCommit.stderr,/URLCODE_SOURCE_SHA/);
});

test('only core has an npm publisher with the immutable publication helpers', async () => {
  const workflow = await read('.github/workflows/release.yml');
  for (const command of ['release.ts identity', 'release.ts preflight', 'release.ts restore', 'release:publish', 'release.ts github']) assert.ok(workflow.includes(command), command);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /group: urlcode-publication/);
  assert.doesNotMatch(workflow, /--clobber|NODE_AUTH_TOKEN|NPM_TOKEN/);
  assert.ok(workflow.indexOf('name: Publish to npm') < workflow.indexOf('name: Publish the GitHub release'));
  for (const retired of ['release-ui.yml', 'release-auth.yml', 'release-admin.yml', 'release-store.yml']) {
    await assert.rejects(read(`.github/workflows/${retired}`));
  }
});

test('a core npm release synchronizes its measured formula to the Homebrew tap before GitHub publication', async () => {
  const workflow = await read('.github/workflows/release.yml');
  for (const value of [
    'HOMEBREW_TAP_TOKEN',
    'jimhoyd-com/homebrew-urlcode',
    'candidate/urlcode.rb',
    'Formula/urlcode.rb',
    'git -C .homebrew-tap push "https://x-access-token:${HOMEBREW_TAP_TOKEN}@github.com/jimhoyd-com/homebrew-urlcode.git" HEAD:main',
  ]) assert.ok(workflow.includes(value),`release workflow lacks ${value}`);
  // The tap checkout must not persist the token in git credentials for the
  // whole job; the token is supplied explicitly only on the push command.
  assert.match(workflow,/repository: jimhoyd-com\/homebrew-urlcode\n {10}token: \$\{\{ secrets\.HOMEBREW_TAP_TOKEN \}\}\n(?:.*\n)*? {10}persist-credentials: false/);

  const publishNpm = workflow.indexOf('name: Publish to npm via trusted publishing');
  const requireCredential = workflow.indexOf('name: Require Homebrew tap credential');
  const synchronizeFormula = workflow.indexOf('name: Synchronize Homebrew formula');
  const publishGitHub = workflow.indexOf('name: Publish the GitHub release');
  assert.ok(requireCredential < publishNpm,'require the tap credential before npm publication');
  assert.ok(requireCredential < synchronizeFormula,'require a credential before synchronizing the formula');
  assert.ok(synchronizeFormula < publishGitHub,'synchronize the formula before the GitHub release');
  assert.match(workflow,/name: Synchronize Homebrew formula\n {8}if: vars\.PUBLISH_NPM == 'true'/);
});

test('a published core release requests a reviewable URLCode AI runtime update', async () => {
  const workflow = await read('.github/workflows/release.yml');
  for (const value of [
    'URLCODE_AI_SYNC_APP_ID',
    'URLCODE_AI_SYNC_APP_PRIVATE_KEY',
    'actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349',
    'repos/jimhoyd-com/urlcode-ai/dispatches',
    'event_type=urlcode-core-release',
    'client_payload[source_sha]',
    'client_payload[version]'
  ]) assert.ok(workflow.includes(value), `release workflow lacks ${value}`);
  assert.ok(workflow.indexOf('name: Publish to npm via trusted publishing') < workflow.indexOf('name: Request URLCode AI runtime update'));
  assert.ok(workflow.indexOf('name: Request URLCode AI runtime update') < workflow.indexOf('name: Publish the GitHub release'));
});

test('the installer downloads the asset name npm actually packs', async () => {
  // A scope changes the packed filename but not the CLI name, so the installer
  // is the easiest place for the two to drift apart without anyone noticing.
  const installer = await read('install.sh');
  const expected = `${packedName(pkg.name)}-$VERSION.tgz`;
  assert.match(installer,new RegExp(`TARBALL="${pattern(expected)}"`),
    `install.sh does not download ${expected}`);
});

test('the formula names the package the manifest declares', async t => {
  const root = await mkdtemp(join(tmpdir(),'urlcode-url-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const out = join(root,'urlcode.rb');
  assert.equal((await run(['scripts/render-homebrew.ts','--sha256','c'.repeat(64),'--out',out])).status,0);
  const formula = await readFile(out,'utf8');
  const bare = pkg.name.split('/').pop() as string;
  assert.match(formula,
    new RegExp(`url "https://registry\\.npmjs\\.org/${pattern(pkg.name)}/-/${pattern(bare)}-${pattern(pkg.version)}\\.tgz"`),
    'the formula URL is not the registry path for this package');
});

test('only candidates build artifacts; publishers promote verified original bytes', async () => {
  assert.match(await read('.github/workflows/candidate.yml'), /bash scripts\/prepare-core-release.sh/);
  const workflow = await read('.github/workflows/release.yml');
  assert.doesNotMatch(workflow, /prepare-(core|extension)-release\.sh/);
  assert.match(workflow, /release.ts restore/);
});

// Homebrew parses a formula as Ruby before it does anything else, so a formula
// that does not parse fails every install. Skipped only where Ruby is absent;
// GitHub's runners all ship it, and so does the release image.
const rubySkip = (() => {
  const probe = spawnSync('ruby',['-e','0'],{ encoding:'utf8' });
  return probe.error ? 'ruby is not installed' : false;
})();

test('the rendered formula is valid Ruby',{ skip: rubySkip }, async t => {
  const root = await mkdtemp(join(tmpdir(),'urlcode-ruby-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const out = join(root,'urlcode.rb');
  assert.equal((await run(['scripts/render-homebrew.ts','--sha256','d'.repeat(64),'--out',out])).status,0);
  const check = spawnSync('ruby',['-c',out],{ encoding:'utf8' });
  assert.equal(check.status,0,`brew could not parse the formula:\n${check.stdout}${check.stderr}`);
});

test('formula text from package.json survives Ruby parsing, not just escaping', async t => {
  // The description is escaped for Ruby; prove the result still parses, since a
  // string that is escaped wrongly is exactly what breaks the formula.
  const root = await mkdtemp(join(tmpdir(),'urlcode-hostile-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const pkgPath = join(root,'package.json');
  await writeFile(pkgPath,JSON.stringify({...pkg,description:'Quote " backslash \\ interpolation #{exit 1}'}));
  await cp(fileURLToPath(new URL('../packaging',import.meta.url)),join(root,'packaging'),{recursive:true});
  const out = join(root,'urlcode.rb');
  const script = fileURLToPath(new URL('../scripts/render-homebrew.ts',import.meta.url));
  assert.equal((await run([script,'--sha256','e'.repeat(64),'--out',out],{cwd:root})).status,0);
  if (!rubySkip) {
    const check = spawnSync('ruby',['-c',out],{ encoding:'utf8' });
    assert.equal(check.status,0,`a hostile description produced unparsable Ruby:\n${check.stdout}${check.stderr}`);
  }
});
