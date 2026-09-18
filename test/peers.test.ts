import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
test('peers.json names one exact 40-hex revision per peer', async () => {
    const peers = JSON.parse(await readFile(new URL('peers.json', root), 'utf8')) as Record<string, unknown>;
    for (const name of ['urlcode', 'urlcode-auth', 'urlcode-ui'])
        assert.match(String(peers[name]), /^[a-f0-9]{40}$/, name);
    assert.deepEqual(Object.keys(peers).filter((key) => !key.startsWith('$')).sort(), ['urlcode', 'urlcode-auth', 'urlcode-ui']);
});
test('verify workflow checks peers out through the peers step outputs, never literal SHAs', async () => {
    const workflow = await readFile(new URL('.github/workflows/verify.yml', root), 'utf8');
    assert.match(workflow, /id: peers/);
    assert.match(workflow, /run: node scripts\/peer-revisions\.mjs/);
    for (const name of ['urlcode', 'urlcode-auth', 'urlcode-ui'])
        assert.ok(workflow.includes(`ref: \${{ steps.peers.outputs.${name} }}`), name);
    assert.ok(!/ref: [a-f0-9]{40}/.test(workflow), 'no literal peer revision');
});
test('peer-revisions script emits one output line per peer', async () => {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('scripts/peer-revisions.mjs', root))], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.stdout.trim().split('\n').map((line) => line.split('=')[0]), ['urlcode', 'urlcode-auth', 'urlcode-ui']);
});
test('pack script defaults --core-revision from peers.json', async () => {
    const script = await readFile(new URL('scripts/pack-sources.mjs', root), 'utf8');
    assert.match(script, /peers\.json/);
    assert.match(script, /\.urlcode/);
});
