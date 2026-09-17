import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = name => readFile(join(repo,name),'utf8');
const pkg = JSON.parse(await read('package.json'));
const run = (args, options = {}) => new Promise(resolve => {
  execFile(process.execPath,args,{cwd:repo,encoding:'utf8',timeout:60000,...options},
    (error,stdout,stderr) => resolve({status:error?(error.code ?? 1):0,stdout,stderr}));
});

test('the released version is stated consistently across the CLI and installer', async () => {
  // A release publishes one version; a banner or floor that drifts misinforms
  // users about what they installed and which Node it needs.
  assert.match((await read('src/cli.js')),new RegExp(`URLCode ${pkg.version.replace(/\./g,'\\.')} `),
    'src/cli.js usage banner does not state package.json version');
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
  assert.equal((await run(['scripts/render-homebrew.js','--sha256',sha,'--out',out])).status,0);
  const formula = await readFile(out,'utf8');
  assert.match(formula,new RegExp(`urlcode-${pkg.version.replace(/\./g,'\\.')}\\.tgz`));
  assert.match(formula,new RegExp(`sha256 "${sha}"`));
  assert.doesNotMatch(formula,/__[A-Z0-9_]+__/,'template placeholder survived rendering');

  // A checksum that was not measured from the named file must be refused.
  const mismatch = await run(['scripts/render-homebrew.js','--tarball','package.json','--sha256',sha,'--out',out]);
  assert.equal(mismatch.status,1);
  assert.match(mismatch.stderr,/does not match/);
  for (const args of [[],['--sha256','short']]) {
    assert.equal((await run(['scripts/render-homebrew.js',...args,'--out',out])).status,1);
  }
});

test('the release build refuses a tag that disagrees with package.json', async t => {
  const root = await mkdtemp(join(tmpdir(),'urlcode-release-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const env = {...process.env,URLCODE_SOURCE_SHA:'0'.repeat(40),URLCODE_CHANNEL:'release'};
  const wrong = await run(['scripts/build-candidate.js'],{env:{...env,URLCODE_RELEASE_VERSION:'9.9.9'}});
  assert.equal(wrong.status,1);
  assert.match(wrong.stderr,/does not match package\.json/);
  const badChannel = await run(['scripts/build-candidate.js'],{env:{...env,URLCODE_CHANNEL:'nightly'}});
  assert.equal(badChannel.status,1);
  assert.match(badChannel.stderr,/alpha-candidate or release/);
  const noCommit = await run(['scripts/build-candidate.js'],{env:{...process.env,URLCODE_SOURCE_SHA:''}});
  assert.equal(noCommit.status,1);
  assert.match(noCommit.stderr,/URLCODE_SOURCE_SHA/);
});
