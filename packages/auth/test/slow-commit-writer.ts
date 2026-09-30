// A serving process on a slow-flush disk, for auth.test.ts: `slow-commit-writer.ts <database> <hold ms>`. Each commit
// holds SQLite's write lock for <hold> ms (as FlushFileBuffers does on a Windows runner) with only an event-loop turn
// between commits. Prints "ready" after its first commit and stops, printing {"commits": n}, when stdin closes.
import { DatabaseSync } from 'node:sqlite';

const [path, hold] = process.argv.slice(2) as [string, string];
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
  setImmediate(turn);
};
turn();
