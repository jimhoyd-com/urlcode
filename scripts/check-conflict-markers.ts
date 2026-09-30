// Enforcing guard that no tracked file keeps a merge-conflict marker.
//
// A resolved merge once committed packages/auth/CHANGELOG.md with its `<<<<<<<` / `>>>>>>>` lines still in it, and
// nothing failed: code conflicts break the typecheck, but Markdown, JSON and YAML conflicts pass every other check.
//
// It FAILS (exit 1) when a tracked text file has a line starting with `<<<<<<< ` or `>>>>>>> `. A bare `=======` is
// not flagged: it is also a Markdown setext heading underline.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const marker = /^(?:<{7}|>{7}) /;

/** The `file:line` of every conflict marker in the given text files. */
export function conflictMarkers(files: readonly { path: string; text: string }[]): string[] {
  const found: string[] = [];
  for (const { path, text } of files)
    text.split('\n').forEach((line, index) => { if (marker.test(line)) found.push(`${path}:${index + 1}`); });
  return found;
}

function main(): number {
  const root = fileURLToPath(new URL('..', import.meta.url));
  // -I skips binary files; only files git tracks are read.
  const listed = execFileSync('git', ['grep', '-I', '-l', '-E', '^(<{7}|>{7}) ', '--', '.'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n').filter(Boolean);
  const found = conflictMarkers(listed.map(path => ({ path, text: readFileSync(`${root}/${path}`, 'utf8') })));
  if (found.length) {
    process.stderr.write(`Merge-conflict markers remain in tracked files:\n${found.map(at => `  ${at}`).join('\n')}\n`);
    return 1;
  }
  process.stdout.write('Conflict-marker check: no tracked file keeps a merge-conflict marker.\n');
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) {
    // git grep exits 1 when nothing matches: that is the passing case.
    if ((error as { status?: number }).status === 1) process.stdout.write('Conflict-marker check: no tracked file keeps a merge-conflict marker.\n');
    else throw error;
  }
}
