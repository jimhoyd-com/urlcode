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
  assert.match((await read('src/cli.ts')),new RegExp(`URLCode ${pattern(pkg.version)} `),
    'src/cli.ts usage banner does not state package.json version');
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

test('the release publishes a tarball path npm reads as a file, not a GitHub repo', async () => {
  // npm resolves "candidate/urlcode-1.2.3.tgz" as the GitHub shorthand
  // owner/repo and tries to clone it over SSH; the v0.2.0 release failed that
  // way after the GitHub release had already been created. Only a path
  // starting with ./ ../ / or ~/ is parsed as a local tarball.
  const workflow = await read('.github/workflows/release.yml');
  // Only the command itself, never a comment that happens to mention it.
  const commands = workflow.split('\n').filter(line => (line.split('#')[0] ?? '').includes('npm publish'));
  assert.equal(commands.length,1,'expected exactly one npm publish command');
  const [publish] = commands;
  assert.ok(publish,'expected a publish command');
  // Match the start of the argument, not a quoted span: the filename is derived
  // from package.json now, so the argument legitimately contains nested quotes
  // and a naive "..." capture reads a fragment of the substitution instead.
  const flag = '--ignore-scripts';
  const spec = publish.slice(publish.indexOf(flag) + flag.length).trim();
  assert.ok(spec.endsWith('.tgz') || spec.endsWith('.tgz"'),'npm publish does not end in a .tgz argument');
  assert.match(spec,/^"?(?:\.{1,2}\/|\/|~\/)/,
    `npm publish argument ${JSON.stringify(spec)} is a package spec, not a file path`);
});

test('npm publishes with the workflow OIDC identity, never a bearer token', async () => {
  // npm prefers a bearer token over the OIDC exchange. A leftover NODE_AUTH_TOKEN
  // or _authToken does not error: it authenticates as whoever the token is, or
  // as nobody, and a correctly registered trusted publisher returns a 404 that
  // reads like a misconfiguration. The credential has to be absent, not merely
  // unused, so this asserts on absence rather than on the publish command.
  const workflow = await read('.github/workflows/release.yml');
  const step = workflow.slice(workflow.indexOf('name: Publish to npm'),
    workflow.indexOf('name: Publish the GitHub release'));
  assert.ok(step.length > 0,'the npm publish step must exist');
  for (const credential of ['NODE_AUTH_TOKEN','NPM_TOKEN','_authToken','npm_config__auth']) {
    // Comments explain why the credential is absent, so they are not evidence
    // that it is present; only real YAML and shell lines count.
    const uses = step.split('\n').filter(line => (line.split('#')[0] ?? '').includes(credential));
    assert.deepEqual(uses,[],
      `the npm publish step still references ${credential}; that overrides trusted publishing`);
  }
  // Trusted publishing needs the OIDC token the job is allowed to request.
  assert.match(workflow,/id-token: write/,'the release job cannot request an OIDC token');
});

test('trusted publishing checks the runner meets its npm and Node floors', async () => {
  // An npm older than 11.5.1 does not attempt the OIDC exchange at all; it
  // publishes anonymously and fails as a 404 indistinguishable from a wrong
  // publisher registration. Diagnosing that from a release run costs a tag.
  const workflow = await read('.github/workflows/release.yml');
  // The floors are named in a comment too, so match the call that enforces one.
  // A guard satisfied by prose is no guard at all.
  assert.match(workflow,/check\("npm", *process\.argv\[1\], *"11\.5\.1"\)/,
    'the publish step does not check npm supports trusted publishing');
  assert.match(workflow,/check\("Node", *process\.argv\[2\], *"22\.14\.0"\)/,
    'the publish step does not check the Node floor for trusted publishing');
});

test('the release publishes to npm before creating the GitHub release', async () => {
  // npm publish is the credential-dependent step and the one that fails. With
  // the release created first, a failure there leaves a published GitHub
  // release advertising a package that does not exist, and its Homebrew
  // formula points at a registry URL that 404s; recovering means deleting the
  // release and the tag. With npm first, a failure leaves nothing to undo.
  const workflow = await read('.github/workflows/release.yml');
  const npmAt = workflow.indexOf('name: Publish to npm');
  const releaseAt = workflow.indexOf('name: Publish the GitHub release');
  assert.ok(npmAt > 0 && releaseAt > 0,'both publish steps must exist');
  assert.ok(npmAt < releaseAt,'the GitHub release is created before npm publish runs');
});

test('a re-run of a partly finished release completes it instead of failing', async () => {
  // Every publishing step has to tolerate having already run, or a failure in
  // a later step can only be recovered by deleting the tag and tagging again.
  const workflow = await read('.github/workflows/release.yml');
  assert.match(workflow,/npm view "\$name@\$VERSION"/,
    'npm publish does not check whether the version is already on the registry');
  assert.match(workflow,/gh release view "\$GITHUB_REF_NAME"/,
    'the release step does not check whether the release already exists');
  assert.match(workflow,/gh release upload .*--clobber/,
    'an existing release is not updated with the rebuilt assets');
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

test('the release can parse the Dockerfile it pins the build to', async () => {
  // The release job reads the first line to prove the build image is pinned by
  // digest, and runs only on a tag push — so a Dockerfile change that the guard
  // cannot parse is invisible until a release fails. A multi-stage first line
  // ends in "AS <name>"; this is the same parse, run in CI.
  const first = (await read('Dockerfile')).split('\n')[0] ?? '';
  const [instruction, image, stage, alias, extra] = first.trim().split(/\s+/);
  assert.equal(instruction,'FROM','the Dockerfile does not start with FROM');
  assert.match(image ?? '',/^node:[a-zA-Z0-9._-]+@sha256:[a-f0-9]{64}$/,
    'the build image is not a digest-pinned node image');
  assert.ok(stage === undefined || (stage === 'AS' && alias && extra === undefined),
    `unparsable stage alias on the FROM line: ${JSON.stringify(first)}`);

  // And the workflow must use the same parse, or CI and the release disagree.
  const workflow = await read('.github/workflows/release.yml');
  assert.match(workflow,/read -r instruction image stage alias extra < Dockerfile/,
    'the release workflow reads the FROM line with a different word split');
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
