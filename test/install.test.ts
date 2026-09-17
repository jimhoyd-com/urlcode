import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync, execFile } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';

const installer = fileURLToPath(new URL('../install.sh', import.meta.url));
const windows = process.platform === 'win32';

// Serve a packed release the way the GitHub release assets are laid out, so the
// installer's download, checksum and install path are exercised for real.
async function release(t: TestContext, { corrupt = false } = {}) {
  const root = await mkdtemp(join(tmpdir(),'urlcode-install-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const version = (JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')) as { version: string }).version;
  const packDir = join(root,'assets'); await mkdir(packDir);
  // The package ships dist/, which a fresh checkout does not have: build it
  // here so this test does not depend on what an earlier command left behind.
  const repo = fileURLToPath(new URL('..',import.meta.url));
  const build = spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','scripts/build.ts'],{cwd:repo,encoding:'utf8',timeout:120000});
  assert.equal(build.status,0,build.stderr);
  const pack = spawnSync(process.env.npm_execpath ? process.execPath : 'npm',
    [...(process.env.npm_execpath ? [process.env.npm_execpath] : []),'pack','--ignore-scripts','--pack-destination',packDir],
    {cwd:repo,encoding:'utf8',timeout:120000});
  assert.equal(pack.status,0,pack.stderr);
  const name = `urlcode-${version}.tgz`;
  const bytes = await readFile(join(packDir,name));
  const sum = createHash('sha256').update(corrupt ? Buffer.concat([bytes,Buffer.from('x')]) : bytes).digest('hex');
  await writeFile(join(packDir,'SHA256SUMS'),`${sum}  ${name}\n`);
  const files: Record<string, Buffer> = { [`/${name}`]: bytes, '/SHA256SUMS': await readFile(join(packDir,'SHA256SUMS')) };
  const server = http.createServer((req,res) => {
    const body = files[req.url ?? ''];
    if (!body) { res.writeHead(404); res.end(); return; }
    res.writeHead(200,{'content-length':body.length}); res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  // close() alone waits for the downloader's keep-alive socket to go idle.
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { root, version, base: `http://127.0.0.1:${address.port}` };
}

// Must not be spawnSync: the installer downloads from a server running in this
// process, and a blocking child would deadlock against its own event loop.
interface RunResult { status: number | string; stdout: string; stderr: string }
function run(base: string, args: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return new Promise(resolve => {
    execFile('sh',[installer,...args],
      {encoding:'utf8',timeout:180000,env:{...process.env,URLCODE_DOWNLOAD_BASE:base,...extraEnv}},
      (error,stdout,stderr) => resolve({status:error?(error.code ?? 1):0,stdout,stderr}));
  });
}

test('installer verifies the published checksum before installing',{skip:windows && 'POSIX shell installer'},async t => {
  const { root, version, base } = await release(t);
  const prefix = join(root,'prefix');
  const result = await run(base,['--version',version,'--prefix',prefix]);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/checksum verified/);
  const cli = join(prefix,'lib','node_modules','urlcode','dist','cli.js');
  const doctor = spawnSync(process.execPath,[cli,'doctor'],{encoding:'utf8',timeout:60000});
  assert.equal(doctor.status,0,doctor.stderr);
  assert.equal((JSON.parse(doctor.stdout) as { license?: unknown }).license,'Apache-2.0');
});

test('installer refuses a tarball that does not match SHA256SUMS',{skip:windows && 'POSIX shell installer'},async t => {
  const { root, version, base } = await release(t,{corrupt:true});
  const result = await run(base,['--version',version,'--prefix',join(root,'prefix')]);
  assert.equal(result.status,1);
  assert.match(result.stderr,/checksum mismatch/);
  assert.doesNotMatch(result.stdout,/installed/);
});

test('installer rejects unusable versions and unknown options',{skip:windows && 'POSIX shell installer'},async t => {
  const { base } = await release(t);
  for (const args of [['--version','../../etc/passwd'],['--version','a;rm -rf /'],['--version'],['--frobnicate']]) {
    const result = await run(base,args);
    assert.equal(result.status,2,`expected ${args.join(' ')} to be rejected: ${result.stdout}`);
  }
  assert.equal((await run(base,['--help'])).status,0);
});

test('installer works where a slim image provides no curl, wget or awk',{skip:windows && 'POSIX shell installer'},async t => {
  const { root, version, base } = await release(t);
  // The release build runs inside node:*-slim, which ships none of these. The
  // first real release run failed here, so the installer must not need them.
  const bin = join(root,'minimal'); await mkdir(bin,{recursive:true});
  for (const tool of ['sh','node','npm','sha256sum','mktemp','rm','cut','env','cat']) {
    const found = spawnSync('sh',['-c',`command -v ${tool}`],{encoding:'utf8'}).stdout.trim();
    if (found) await symlink(found,join(bin,tool)).catch(() => {});
  }
  const minimal = {PATH:bin};
  assert.equal(spawnSync('sh',['-c','command -v curl || true'],{encoding:'utf8',env:minimal}).stdout.trim(),'');
  const result = await run(base,['--version',version,'--prefix',join(root,'slim')],minimal);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/checksum verified/);
  // Digest parsing without awk must still reject a tarball that does not match.
  const corrupt = await release(t,{corrupt:true});
  const rejected = await run(corrupt.base,['--version',corrupt.version,'--prefix',join(root,'slim-bad')],minimal);
  assert.equal(rejected.status,1);
  assert.match(rejected.stderr,/checksum mismatch/);
});

test('installer requires a supported Node version',{skip:windows && 'POSIX shell installer'},async t => {
  const { root, version, base } = await release(t);
  // A stub `node` that reports an unsupported version must stop the install.
  const stub = join(root,'stub'); await mkdir(stub,{recursive:true});
  await writeFile(join(stub,'node'),'#!/bin/sh\nif [ "$1" = "-p" ]; then echo "20.11.0"; else exit 1; fi\n',{mode:0o755});
  const result = await run(base,['--version',version,'--prefix',join(root,'prefix')],{PATH:`${stub}:${process.env.PATH}`});
  assert.equal(result.status,1);
  assert.match(result.stderr,/Node 22\.13 or newer is required; found 20\.11\.0/);
});
