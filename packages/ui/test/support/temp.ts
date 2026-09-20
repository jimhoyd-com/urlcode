import { rmSync } from 'node:fs';

// Remove a test's temporary directory when the process exits, not when the
// test's `after` hooks run.
//
// The obvious `t.after(() => rm(root, {recursive: true, force: true}))`
// registered next to `mkdtemp` is wrong on Windows, and was silently wrong
// everywhere. Node runs `after` hooks in registration order, so that hook runs
// *before* the `t.after(() => service.close())` registered a line later, while
// the SQLite file is still open. POSIX allows unlinking an open file, so Linux
// and macOS never noticed; Windows returns EBUSY. Worse, a throwing hook stops
// the hooks after it, so `close()` never ran, the handle stayed open, and the
// test runner hung until CI killed it -- one bug producing both the failure
// and the twenty minutes of silence after it.
//
// Registering at exit removes the ordering dependency rather than reversing
// it: by then every close hook has run, whatever order they were registered
// in, and whatever a future test opens after calling this.
const pending = new Set<string>();
let installed = false;

export function removeAtExit(directory: string): void {
  pending.add(directory);
  if (installed) return;
  installed = true;
  // Synchronous: `exit` listeners cannot await, and a queued async unlink
  // would never run.
  process.on('exit', () => {
    for (const entry of pending) {
      try { rmSync(entry, { recursive: true, force: true }); } catch { /* a directory we cannot remove is not worth failing a passing run over */ }
    }
  });
}
