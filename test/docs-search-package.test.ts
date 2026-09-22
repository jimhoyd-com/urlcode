import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePackJson } from '../scripts/pack-json.ts';

// agent-context.ts's searchDocs (the urlcode docs search CLI and the MCP
// search_docs tool) reads docs/*.md from the package root at runtime, but
// package.json's "files" field previously excluded docs/ entirely, so an
// installed copy of the package threw "Required file or directory not
// found" instead of returning results (found alongside #439). This test
// packs and installs the real tarball, the way a consumer would, and
// exercises the CLI against it.

interface PackReport { name: string; filename: string; version: string }

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));

test('urlcode docs search works against the published npm tarball', async t => {
  const npm = process.env.npm_execpath;
  assert(npm, 'Run this test through npm');
  const cache = await mkdtemp(join(tmpdir(), 'urlcode-docs-search-'));
  t.after(async () => { await rm(cache, { recursive: true, force: true }); });

  const pack = spawnSync(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', cache], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: cache },
    timeout: 120_000,
  });
  assert.equal(pack.status, 0, pack.stderr || pack.stdout || pack.error?.message || 'npm pack failed');
  const [report] = parsePackJson<PackReport>(pack.stdout, pack.stderr);
  assert(report, 'npm pack reported no package');

  const install = join(cache, 'install');
  await mkdir(install);
  const installResult = spawnSync(process.execPath, [npm, 'install', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', install, join(cache, report.filename)], {
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: cache },
    timeout: 120_000,
  });
  assert.equal(installResult.status, 0, installResult.stderr || installResult.stdout || installResult.error?.message || 'npm install failed');

  const cli = join(install, 'node_modules', ...report.name.split('/'), 'dist', 'cli.js');
  assert.ok(existsSync(cli), 'Installed package did not ship the built CLI');

  const search = spawnSync(process.execPath, [cli, 'docs', 'search', 'sandbox', '--json'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(search.status, 0, search.stderr || search.stdout || search.error?.message || 'docs search failed against the installed package');
  const found = JSON.parse(search.stdout) as { query: string; results: { id: string; title: string }[] };
  assert.equal(found.query, 'sandbox');
  assert.ok(found.results.length > 0, 'Expected at least one matching doc from the installed package');
});
