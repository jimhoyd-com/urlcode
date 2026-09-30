// Loaded with --import by every `test` and `test:*` script of the root and of each workspace package (#977, #1030;
// test/hermetic-hardening.test.ts enforces it); the one shared copy, which packages reach as ../../test/. Points the
// OS temporary directory of the test
// run at a scratch directory of its own, removed when the run ends. The runner sets TMPDIR (POSIX) and TEMP and TMP
// (Windows) before it starts any test file, so every test process and every CLI a test spawns inherits it; a run's
// directories and the stale-directory sweep a first run directory triggers then stay inside the scratch directory,
// never the developer's real temporary directory. A test that builds a child environment from scratch opts out.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.URLCODE_TEST_TMPDIR === undefined) {
  const scratch = mkdtempSync(join(tmpdir(), 'urlcode-tests-'));
  Object.assign(process.env, { URLCODE_TEST_TMPDIR: scratch, TMPDIR: scratch, TEMP: scratch, TMP: scratch });
  process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort at exit */ } });
}
