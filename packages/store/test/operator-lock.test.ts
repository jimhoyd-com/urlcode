// #1072: the operator commands take the write lock between a busy server's slow commits. SQLite's busy handler (2 s,
// sleeping up to 100 ms between roughly 30 attempts) is not a queue: beside a writer that holds the lock for most of
// each commit, those attempts mostly land on a held lock and the command failed with "database is locked". The
// operator connection tries for the lock every millisecond for up to 10 s instead, so it gets in during the idle gaps.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { CollectionSpec } from '../src/index.ts';
import { addMember, listMembers, reassignOwner, removeMember } from '../src/index.ts';
import { cleanup } from './cleanup.ts';

const reviewers = { membership: true, key: 'userId', schema: { type: 'object', additionalProperties: false, required: ['userId'], properties: { userId: { type: 'string', maxLength: 128 } } } };
const collections = { reviewers } as unknown as Record<string, CollectionSpec>;
const cliPath = join(import.meta.dirname, '..', 'src', 'cli.ts');

/**
 * A store database with one member and, beside it, a writer committing continuously that holds the write lock
 * `hold` ms per commit and idles `gap` ms between commits (the repository's test/slow-commit-writer.ts). Returns the database, the
 * project and `stop`, which ends the writer and resolves to its commit count.
 */
async function busyStore(t: TestContext, hold: number, gap: number) {
  const root = await mkdtemp(join(tmpdir(), 'store-operator-lock-'));
  cleanup(t, () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const app = join(root, 'app'), database = join(root, 'data', 'store.sqlite');
  await mkdir(app);
  await writeFile(join(app, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { store: { version: '1', config: { collections: { reviewers } } } }, routes: { '/api/review/*': { extension: 'store', methods: ['GET'] } } }));
  await addMember(database, { collections, collection: 'reviewers', principal: 'seed' });
  const writer = spawn(process.execPath, [fileURLToPath(new URL('../../../test/slow-commit-writer.ts', import.meta.url)), database, String(hold), String(gap)], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise(resolve => writer.once('exit', resolve));
  let out = '';
  writer.stdout.setEncoding('utf8').on('data', (chunk: string) => { out += chunk; });
  cleanup(t, async () => { writer.stdin.end(); await exited; });
  await new Promise<void>((resolve, reject) => { writer.stdout.on('data', () => { if (out.includes('ready')) resolve(); }); void exited.then(() => reject(new Error(`slow-commit-writer exited: ${out}`))); });
  const stop = async (): Promise<number> => { writer.stdin.end(); await exited; return (JSON.parse(out.slice(out.indexOf('{'))) as { commits: number }).commits; };
  return { database, app, stop };
}

test('the operator commands take the write lock between the slow commits of a busy server', async t => {
  // 25 ms of every commit under the write lock (a slow flush), then a 1 ms idle gap before the next: the lock is free
  // about 4% of the time. On main about one call in five failed with "database is locked" after 2 seconds.
  const { database, app, stop } = await busyStore(t, 25, 1);
  const started = Date.now();
  for (let round = 0; round < 15; round++) {
    const principal = `rev-${round}`;
    assert.equal((await addMember(database, { collections, collection: 'reviewers', principal })).changed, true);
    assert.equal((await reassignOwner(database, { collections, from: principal, to: `moved-${round}` })).memberships.length, 1);
    assert.equal((await removeMember(database, { collections, collection: 'reviewers', principal: `moved-${round}` })).changed, true);
  }
  const cli = await promisify(execFile)(process.execPath, ['--conditions=development', cliPath, 'members', 'add', '--database', database, '--project', app, '--collection', 'reviewers', '--principal', 'rita'])
    .then(result => ({ code: 0, stderr: result.stderr }), (error: { code: number; stderr: string }) => ({ code: error.code, stderr: error.stderr }));
  assert.equal(cli.code, 0, cli.stderr);
  const elapsed = Date.now() - started, commits = await stop();
  assert.ok(commits > elapsed / 100, `the writer committed throughout (${commits} commits in ${elapsed} ms)`);
  assert.deepEqual((await listMembers(database, { collections, collection: 'reviewers' })).members, ['seed', 'rita']);
});
