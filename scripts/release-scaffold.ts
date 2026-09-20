import assert from 'node:assert/strict';
import { join } from 'node:path';

/** Exercise extension scaffolding in its declared dependency order. */
export function verifyReleaseScaffold(consumer: string, run: (command: string, args: string[], cwd: string) => string): void {
  const output = run(process.execPath, [join(consumer, 'node_modules/@jimhoyd/urlcode/dist/cli.js'), 'init', 'site', '--with', 'ui,auth,admin'], consumer);
  assert.deepEqual(JSON.parse(output.trim().split('\n').at(-1)!).extensions, ['ui', 'auth', 'admin']);
  // Store composes on its own (it needs no UI kit), in a second project.
  const store = run(process.execPath, [join(consumer, 'node_modules/@jimhoyd/urlcode/dist/cli.js'), 'init', 'store-site', '--with', 'store'], consumer);
  assert.deepEqual(JSON.parse(store.trim().split('\n').at(-1)!).extensions, ['store']);
}
