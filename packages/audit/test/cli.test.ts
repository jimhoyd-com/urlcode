import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAudit } from '../src/index.ts';
import type { AuditPage } from '../src/index.ts';
import { activation, event, pin, tempDir } from './support.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function run(command: string, input: unknown): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--conditions=development', '--disable-warning=ExperimentalWarning', cli, command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

async function seeded(t: test.TestContext, count: number) {
  const root = await tempDir(t), projectRoot = join(root, 'app');
  await mkdir(projectRoot, { mode: 0o700 });
  const database = join(root, 'audit.sqlite');
  const audit = await createAudit({ projectSha256: pin, database });
  const instance = await audit.registration.activate({}, activation(root));
  const events = Array.from({ length: count }, (_, index) => event({ source: 'auth', action: index % 2 ? 'session.login' : 'admin.roles' }));
  await audit.exports.record(events);
  await instance.close?.();
  await audit.close();
  return { root, projectRoot, database, events };
}
const fingerprint = async (database: string) => {
  const info = await stat(database);
  return JSON.stringify([createHash('sha256').update(await readFile(database)).digest('hex'), info.size, info.mtimeMs]);
};

test('list prints one bounded page read-only and never writes the database', async t => {
  const { root, database, events } = await seeded(t, 5);
  const before = await fingerprint(database);
  const listed = await run('list', { database, query: { actionPrefix: 'session', order: 'desc', limit: 1 } });
  assert.equal(listed.code, 0, listed.stderr);
  const page = JSON.parse(listed.stdout) as AuditPage;
  assert.deepEqual(page.events.map(item => item.id), [events[3]!.id]);
  assert.ok(page.next);
  const all = JSON.parse((await run('list', { database })).stdout) as AuditPage;
  assert.equal(all.events.length, 5);
  // A read-only SQLite connection to a WAL database may leave empty -wal/-shm files beside it; the database itself
  // is untouched, and SQLite gives them the database file's private mode.
  assert.equal(await fingerprint(database), before, 'list leaves the database byte-identical');
  if (process.platform !== 'win32')
    for (const file of (await readdir(root)).filter(name => name.startsWith('audit.sqlite')))
      assert.equal((await stat(join(root, file))).mode & 0o077, 0, `${file} is private`);
});

test('list refuses a bad filter, a relative path, unknown input and a missing database', async t => {
  const { root, database } = await seeded(t, 1);
  for (const input of [{ database, query: { limit: 101 } }, { database: 'audit.sqlite' }, { database, extra: 1 }, { database: join(root, 'missing.sqlite') }, 'not json', []]) {
    const answer = await run('list', input);
    assert.equal(answer.code, 1, JSON.stringify(input));
    assert.match(answer.stderr, /^urlcode-audit: /);
  }
  await assert.rejects(stat(join(root, 'missing.sqlite')), { code: 'ENOENT' }, 'list never creates a database');
  assert.equal((await run('prune', {})).code, 1);
  assert.match((await run('--help', '')).stdout, /urlcode-audit list/);
});

test('backup and restore round-trip through the CLI to a new private file', async t => {
  const { root, projectRoot, database, events } = await seeded(t, 3);
  const destination = join(root, 'backup.sqlite'), restored = join(root, 'restored.sqlite');
  const backup = await run('backup', { database, destination, projectRoot });
  assert.equal(backup.code, 0, backup.stderr);
  assert.equal(JSON.parse(backup.stdout).format, 'urlcode-audit-sqlite-v1');
  if (process.platform !== 'win32') assert.equal((await stat(destination)).mode & 0o777, 0o600);
  const restore = await run('restore', { backup: destination, destination: restored, projectRoot });
  assert.equal(restore.code, 0, restore.stderr);
  const page = JSON.parse((await run('list', { database: restored })).stdout) as AuditPage;
  assert.deepEqual(page.events.map(item => item.id), events.map(item => item.id));
  assert.equal((await run('backup', { database, destination, projectRoot })).code, 1, 'an existing destination is refused');
  assert.equal((await run('backup', { database, destination: join(projectRoot, 'copy.sqlite'), projectRoot })).code, 1, 'a destination inside the project is refused');
  const reopened = await createAudit({ projectSha256: pin, database: restored });
  const instance = await reopened.registration.activate({}, activation(root));
  try {
    assert.equal((await reopened.exports.query()).events.length, 3, 'a restored file opens as a live audit log');
  } finally {
    // Close before the test's own t.after cleanup removes root: t.after hooks run in registration order, and
    // this reopened database must not still be open when that runs (#768).
    await instance.close?.();
    await reopened.close();
  }
});
