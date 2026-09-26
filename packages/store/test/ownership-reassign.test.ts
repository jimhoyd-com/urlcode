import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reassignOwner } from '../src/index.ts';
import { boot, legacy, notes, running } from './ownership-support.ts';

// urlcode#732: moving every record one principal owns to another (a rotated API key's records to its replacement).
const tasks = { mount: '/api/tasks', ownership: 'owner', maxRecords: 20, maxRecordsPerOwner: 3, fields: { title: { type: 'string', required: true, maxLength: 40 } } };
const board = { mount: '/api/board', fields: { title: { type: 'string', required: true, maxLength: 40 } } };
const owned = (title: string, owner: string) => ({ ...legacy(title), _owner: owner });
async function reassignFixture(t: TestContext) {
  const booted = await boot(t, { seed: [owned('n1', 'apikey:old'), owned('n2', 'apikey:old'), owned('n3', 'alice'), legacy('orphan')], extraCollections: { tasks, board } });
  const collections = { notes, tasks, board } as never;
  const write = (name: string, records: object[]) => writeFile(join(booted.data, `${name}.json`), JSON.stringify({ version: 2, records, idempotency: [] }));
  const read = async (name: string) => (JSON.parse(await readFile(join(booted.data, `${name}.json`), 'utf8')) as { records: Record<string, unknown>[] }).records;
  await write('board', [legacy('shared')]);
  return { ...booted, collections, write, read };
}
const cliPath = join(import.meta.dirname, '..', 'src', 'cli.ts');
const runCli = (...args: string[]) => promisify(execFile)(process.execPath, ['--conditions=development', cliPath, ...args]);
const cliFailure = (...args: string[]) => runCli(...args).then(() => null, (error: { code: number; stderr: string }) => error);

test('reassign reports first on --dry-run, then moves only the --from records in owned collections', async t => {
  const { data, collections, write, read } = await reassignFixture(t);
  await write('tasks', [owned('t1', 'apikey:old'), owned('t2', 'bob')]);
  const before = { notes: await read('notes'), tasks: await read('tasks'), board: await read('board') };
  const dry = await reassignOwner(data, { from: 'apikey:old', to: 'alice', collections, dryRun: true });
  assert.deepEqual(dry, { from: 'apikey:old', to: 'alice', dryRun: true, moved: 3, collections: [
    { collection: 'notes', moved: 2, toBefore: 1, toAfter: 3, maxRecordsPerOwner: null },
    { collection: 'tasks', moved: 1, toBefore: 0, toAfter: 1, maxRecordsPerOwner: 3 },
  ] });
  assert.deepEqual({ notes: await read('notes'), tasks: await read('tasks'), board: await read('board') }, before, 'a dry run writes nothing');
  // --collection limits the move to one owned collection.
  const onlyTasks = await reassignOwner(data, { from: 'apikey:old', to: 'alice', collections, collection: 'tasks' });
  assert.equal(onlyTasks.moved, 1); assert.deepEqual(onlyTasks.collections.map(report => report.collection), ['tasks']);
  assert.deepEqual((await read('tasks')).map(record => record._owner), ['alice', 'bob']);
  assert.deepEqual((await read('notes')).map(record => record._owner), ['apikey:old', 'apikey:old', 'alice', undefined]);
  const rest = await reassignOwner(data, { from: 'apikey:old', to: 'alice', collections });
  assert.equal(rest.moved, 2);
  const notesAfter = await read('notes');
  assert.deepEqual(notesAfter.map(record => record._owner), ['alice', 'alice', 'alice', undefined], 'ownerless records stay ownerless');
  assert.deepEqual(notesAfter.map(({ _owner, ...fields }) => fields), before.notes.map(({ _owner, ...fields }) => fields), 'only the owner changes');
  assert.deepEqual(await read('board'), before.board, 'shared collections are never touched');
  // Running it again moves nothing.
  assert.equal((await reassignOwner(data, { from: 'apikey:old', to: 'alice', collections })).moved, 0);
});

test('reassign refuses the whole move, naming the collection, when --to would exceed maxRecordsPerOwner', async t => {
  const { data, collections, write, read } = await reassignFixture(t);
  await write('tasks', [owned('t1', 'apikey:old'), owned('t2', 'apikey:old'), owned('t3', 'alice'), owned('t4', 'alice')]);
  const notesBefore = await read('notes'), tasksBefore = await read('tasks');
  await assert.rejects(reassignOwner(data, { from: 'apikey:old', to: 'alice', collections }), /Nothing was moved: collection tasks would give alice 4 records, over its maxRecordsPerOwner of 3/);
  await assert.rejects(reassignOwner(data, { from: 'apikey:old', to: 'alice', collections, dryRun: true }), /collection tasks/);
  assert.deepEqual(await read('notes'), notesBefore, 'notes, which had room, was not moved either');
  assert.deepEqual(await read('tasks'), tasksBefore);
  // Exactly at the limit is allowed.
  await write('tasks', [owned('t1', 'apikey:old'), owned('t3', 'alice'), owned('t4', 'alice')]);
  assert.equal((await reassignOwner(data, { from: 'apikey:old', to: 'alice', collections })).moved, 3);
  assert.deepEqual((await read('tasks')).map(record => record._owner), ['alice', 'alice', 'alice']);
});

test('reassign validates both principal ids and the collection, and refuses while the server holds the directory', async t => {
  const { data, collections } = await reassignFixture(t);
  for (const [from, to, pattern] of [['not an id', 'alice', /--from must be a principal id/], ['apikey:old', 'alice@example.com', /--to must be a principal id/], ['', 'alice', /--from must be/], ['alice', 'alice', /same principal/]] as const)
    await assert.rejects(reassignOwner(data, { from, to, collections }), pattern);
  await assert.rejects(reassignOwner(data, { from: 'apikey:old', to: 'alice', collections, collection: 'board' }), /Collection board is not declared with ownership: owner/);
  await assert.rejects(reassignOwner(data, { from: 'apikey:old', to: 'alice', collections, collection: 'missing' }), /Collection missing is not declared/);
  await assert.rejects(reassignOwner(data, { from: 'apikey:old', to: 'alice', collections: { board } as never }), /no collection with ownership: owner/);
  // A declared owned collection with no data file yet has nothing to move.
  assert.deepEqual((await reassignOwner(data, { from: 'apikey:old', to: 'alice', collections, dryRun: true })).collections.map(report => report.collection), ['notes']);
  const live = await running(t, { seed: [owned('n1', 'apikey:old')] });
  await assert.rejects(reassignOwner(live.data, { from: 'apikey:old', to: 'alice', collections: { notes } as never }), /in use|already locked/);
  await live.stop();
  assert.equal((await reassignOwner(live.data, { from: 'apikey:old', to: 'alice', collections: { notes } as never })).moved, 1);
});

test('the reassign CLI reads the owned collections and limits from the project', async t => {
  const { data, project, write, read } = await reassignFixture(t);
  await write('tasks', [owned('t1', 'apikey:old'), owned('t2', 'alice'), owned('t3', 'alice'), owned('t4', 'alice')]);
  const dry = await runCli('reassign', '--directory', data, '--project', project, '--from', 'apikey:old', '--to', 'apikey:new', '--dry-run');
  const report = JSON.parse(dry.stdout) as { dryRun: boolean; moved: number };
  assert.equal(report.dryRun, true); assert.equal(report.moved, 3);
  assert.deepEqual((await read('notes')).map(record => record._owner), ['apikey:old', 'apikey:old', 'alice', undefined]);
  const refused = await cliFailure('reassign', '--directory', data, '--project', project, '--from', 'apikey:old', '--to', 'alice');
  assert.equal(refused?.code, 1); assert.match(refused!.stderr, /collection tasks would give alice 4 records/);
  const moved = await runCli('reassign', '--directory', data, '--project', project, '--from', 'apikey:old', '--to', 'alice', '--collection', 'notes');
  assert.equal((JSON.parse(moved.stdout) as { moved: number }).moved, 2);
  assert.deepEqual((await read('tasks')).map(record => record._owner), ['apikey:old', 'alice', 'alice', 'alice']);
  for (const args of [['--from', 'bad id', '--to', 'alice'], ['--from', 'apikey:old'], ['--from', 'apikey:old', '--to', 'alice', '--owner', 'x'], ['--from', 'apikey:old', '--to', 'alice', '--project', 'relative/app']])
    assert.equal((await cliFailure('reassign', '--directory', data, '--project', project, ...args))?.code, 1, args.join(' '));
  assert.match((await cliFailure('ownerless', '--directory', data, '--collection', 'notes', '--dry-run'))!.stderr, /apply to reassign only/);
});
