import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The scaffold unit tests call scaffold() directly, so they pass against any core. This drives the
// installed core's own `init --with store`, the way a user does. Against the workspace it proves the
// contract today; `release:peers` runs it against the published core at the declared peer floor, so
// a floor that lacks --ack (#346) fails here instead of after a release.
const cli = join(dirname(fileURLToPath(import.meta.resolve('@jimhoyd/urlcode'))), 'cli.js');
const store = fileURLToPath(new URL('..', import.meta.url));

async function site(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-store-core-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'node_modules', '@jimhoyd'), { recursive: true });
  await symlink(store, join(root, 'node_modules', '@jimhoyd', 'urlcode-store'), process.platform === 'win32' ? 'junction' : 'dir');
  return root;
}
const init = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [cli, 'init', 'site', '--with', 'store', '--no-manifest', ...args], { cwd, encoding: 'utf8', timeout: 60000 });

test('the installed core scaffolds a public store when acknowledged, so the peer floor includes --ack', async t => {
  const created = init(await site(t), '--ack', 'store:public-write');
  assert.equal(created.status, 0, `the core this store peers on must accept --ack store:public-write: ${created.stderr}`);
  assert.deepEqual(JSON.parse(created.stdout.trim().split('\n').at(-1)!).extensions, ['store']);
});

test('without auth or the acknowledgement, the refusal prints the command the installed core accepts', async t => {
  const refused = init(await site(t));
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /--ack store:public-write/);
});
