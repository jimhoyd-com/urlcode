import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('packing with ignored scripts preserves built output, while prepare still builds a checkout', async t => {
  const npm = process.env.npm_execpath;
  assert(npm, 'Run this test through npm');
  const root = await mkdtemp(join(tmpdir(), 'urlcode-prepare-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'dist'));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: { prepare: string } };
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'urlcode-prepare-fixture', version: '1.0.0', type: 'module', files: ['dist'], scripts: { prepare: pkg.scripts.prepare } }));
  await copyFile(new URL('../scripts/prepare.ts', import.meta.url), join(root, 'scripts', 'prepare.ts'));
  await writeFile(join(root, 'scripts', 'build.ts'), "import { writeFile } from 'node:fs/promises'; await writeFile('dist/addons.json', 'rebuilt');\n");
  const manifest = join(root, 'dist', 'addons.json');
  await writeFile(manifest, 'existing build');
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [npm, ...args], { cwd: root, encoding: 'utf8', timeout: 30_000, env: { ...process.env, npm_config_cache: join(root, 'cache') } });
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message || 'npm failed');
  };
  // npm 10 invokes prepare even here; newer npm versions skip the lifecycle.
  run('pack', '--ignore-scripts', '--json');
  assert.equal(await readFile(manifest, 'utf8'), 'existing build');
  run('run', 'prepare', '--ignore-scripts=false');
  assert.equal(await readFile(manifest, 'utf8'), 'rebuilt');
});
