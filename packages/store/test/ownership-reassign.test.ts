import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { reassignOwner } from '../src/index.ts';
import { boot, legacy, notes, running } from './ownership-support.ts';
import { execute, records, seed } from './rows.ts';

// urlcode#732: moving every record one principal owns to another (a rotated API key's records to its replacement).
const tasks = { mount: '/api/tasks', ownership: 'owner', maxRecords: 20, maxRecordsPerOwner: 3, fields: { title: { type: 'string', required: true, maxLength: 40 } } };
const board = { mount: '/api/board', fields: { title: { type: 'string', required: true, maxLength: 40 } } };
const owned = (title: string, owner: string) => ({ ...legacy(title), _owner: owner });
async function reassignFixture(t: TestContext) {
  const booted = await boot(t, { seed: [owned('n1', 'apikey:old'), owned('n2', 'apikey:old'), owned('n3', 'alice'), legacy('orphan')], extraCollections: { tasks, board } });
  const collections = { notes, tasks, board } as never;
  /** Replaces a collection's rows, as the JSON-file suites replaced a whole file. */
  const write = async (name: string, rows: Record<string, unknown>[]) => { execute(booted.database, `DELETE FROM store_records WHERE collection = '${name}'`); await seed(booted.database, name, rows); };
  const read = async (name: string) => records(booted.database, name);
  await write('board', [legacy('shared')]);
  return { ...booted, collections, write, read };
}
const cliPath = join(import.meta.dirname, '..', 'src', 'cli.ts');
const runCli = (...args: string[]) => promisify(execFile)(process.execPath, ['--conditions=development', cliPath, ...args]);
const cliFailure = (...args: string[]) => runCli(...args).then(() => null, (error: { code: number; stderr: string }) => error);

test('reassign reports first on --dry-run, then moves only the --from records in owned collections', async t => {
  const { database: data, collections, write, read } = await reassignFixture(t);
  await write('tasks', [owned('t1', 'apikey:old'), owned('t2', 'bob')]);
  const before = { notes: await read('notes'), tasks: await read('tasks'), board: await read('board') };
  const dry = await reassignOwner(data, { from: 'apikey:old', to: 'alice', collections, dryRun: true });
  assert.deepEqual(dry, { from: 'apikey:old', to: 'alice', dryRun: true, moved: 3, auditEvents: 0, collections: [
    { collection: 'notes', moved: 2, toBefore: 1, toAfter: 3, maxRecordsPerOwner: null },
    { collection: 'tasks', moved: 1, toBefore: 0, toAfter: 1, maxRecordsPerOwner: 3 },
  ], memberships: [] });
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
  const { database: data, collections, write, read } = await reassignFixture(t);
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

test('reassign validates both principal ids, the collection and the database', async t => {
  const { database: data, collections } = await reassignFixture(t);
  for (const [from, to, pattern] of [['not an id', 'alice', /--from must be a principal id/], ['apikey:old', 'alice@example.com', /--to must be a principal id/], ['', 'alice', /--from must be/], ['alice', 'alice', /same principal/]] as const)
    await assert.rejects(reassignOwner(data, { from, to, collections }), pattern);
  await assert.rejects(reassignOwner(data, { from: 'apikey:old', to: 'alice', collections, collection: 'board' }), /Collection board is not declared with ownership: owner/);
  await assert.rejects(reassignOwner(data, { from: 'apikey:old', to: 'alice', collections, collection: 'missing' }), /Collection missing is not declared/);
  await assert.rejects(reassignOwner(data, { from: 'apikey:old', to: 'alice', collections: { board } as never }), /no collection with ownership: owner/);
  // A declared owned collection that holds no records yet has nothing to move.
  assert.deepEqual((await reassignOwner(data, { from: 'apikey:old', to: 'alice', collections, dryRun: true })).collections.map(report => report.collection), ['notes']);
  await assert.rejects(reassignOwner(`${data}.missing`, { from: 'apikey:old', to: 'alice', collections }), /does not exist/);
});

test('reassign runs beside the serving process and moves every collection in one transaction or none', async t => {
  // tasks declares only a title, so its seeded row carries no votes.
  const { votes: _votes, ...task } = legacy('t1');
  const tasksSeed = [{ ...task, _owner: 'apikey:old' }];
  const live = await running(t, { seed: [owned('n1', 'apikey:old')], extraCollections: { tasks }, extraRoutes: { '/api/tasks/*': { extension: 'store', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], policies: { extensions: { badge: {} } } } } });
  await seed(live.database, 'tasks', tasksSeed);
  const collections = { notes, tasks } as never;
  // A failure after the first collection moved (injected as a trigger on the second one's update) rolls both back.
  execute(live.database, "CREATE TRIGGER fail_tasks BEFORE UPDATE OF owner ON store_records WHEN NEW.collection = 'tasks' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
  await assert.rejects(reassignOwner(live.database, { from: 'apikey:old', to: 'alice', collections }), /injected failure/);
  assert.deepEqual(records(live.database, 'notes').map(record => record._owner), ['apikey:old'], 'notes, updated first, was rolled back');
  assert.deepEqual(records(live.database, 'tasks').map(record => record._owner), ['apikey:old']);
  execute(live.database, 'DROP TRIGGER fail_tasks');
  assert.equal((await reassignOwner(live.database, { from: 'apikey:old', to: 'alice', collections })).moved, 2);
  const response = await live.as('alice')('/api/tasks');
  const list = await response.json() as { total: number };
  assert.equal(list.total, 1, `the running server serves the moved records at once: ${response.status} ${JSON.stringify(list)}`);
});

test('the reassign CLI reads the owned collections and limits from the project', async t => {
  const { database: data, project, write, read } = await reassignFixture(t);
  await write('tasks', [owned('t1', 'apikey:old'), owned('t2', 'alice'), owned('t3', 'alice'), owned('t4', 'alice')]);
  const dry = await runCli('reassign', '--database', data, '--project', project, '--from', 'apikey:old', '--to', 'apikey:new', '--dry-run');
  const report = JSON.parse(dry.stdout) as { dryRun: boolean; moved: number };
  assert.equal(report.dryRun, true); assert.equal(report.moved, 3);
  assert.deepEqual((await read('notes')).map(record => record._owner), ['apikey:old', 'apikey:old', 'alice', undefined]);
  const refused = await cliFailure('reassign', '--database', data, '--project', project, '--from', 'apikey:old', '--to', 'alice');
  assert.equal(refused?.code, 1); assert.match(refused!.stderr, /collection tasks would give alice 4 records/);
  const moved = await runCli('reassign', '--database', data, '--project', project, '--from', 'apikey:old', '--to', 'alice', '--collection', 'notes');
  assert.equal((JSON.parse(moved.stdout) as { moved: number }).moved, 2);
  assert.deepEqual((await read('tasks')).map(record => record._owner), ['apikey:old', 'alice', 'alice', 'alice']);
  for (const args of [['--from', 'bad id', '--to', 'alice'], ['--from', 'apikey:old'], ['--from', 'apikey:old', '--to', 'alice', '--owner', 'x'], ['--from', 'apikey:old', '--to', 'alice', '--project', 'relative/app']])
    assert.equal((await cliFailure('reassign', '--database', data, '--project', project, ...args))?.code, 1, args.join(' '));
  assert.match((await cliFailure('ownerless', '--database', data, '--collection', 'notes', '--dry-run'))!.stderr, /apply to reassign only/);
});
