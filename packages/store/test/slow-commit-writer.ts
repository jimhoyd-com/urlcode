// A busy serving process on a slow-flush disk, for operator-lock.test.ts: `slow-commit-writer.ts <database> <hold ms>
// <gap ms>`. Each commit holds SQLite's write lock for <hold> ms (as FlushFileBuffers does on a Windows runner), then
// the process idles <gap> ms (a timer, the next request's arrival) before its next commit. A writer with no gap at all
// is not modelled: it starves every waiter on some platforms, which the store documents as a limit. Prints "ready"
// after its first commit and stops, printing {"commits": n}, when stdin closes.
import { DatabaseSync } from 'node:sqlite';

const [path, hold, gap] = process.argv.slice(2) as [string, string, string];
const db = new DatabaseSync(path, { timeout: 2000 });
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS slow_commits (n INTEGER)');
const pause = new Int32Array(new SharedArrayBuffer(4));
let commits = 0, stop = false;
process.stdin.on('end', () => { stop = true; }).resume();
const turn = (): void => {
  if (stop) { db.close(); process.stdout.write(JSON.stringify({ commits }) + '\n'); return; }
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO slow_commits VALUES (?)').run(commits);
    Atomics.wait(pause, 0, 0, Number(hold));
    db.exec('COMMIT');
    if (commits++ === 0) process.stdout.write('ready\n');
  } catch { if (db.isTransaction) db.exec('ROLLBACK'); }
  setTimeout(turn, Number(gap));
};
turn();
