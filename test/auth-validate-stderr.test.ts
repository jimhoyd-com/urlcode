// jimhoyd-com/urlcode#1013 through the real CLI and auth extension: a passing local-review validate prints nothing that
// reads as a failure (Better Auth's unawaited schema check used to outlive the run's database connection and report
// "Could not validate the database schema"), while a pinned validate against a database without Better Auth's tables
// still fails and says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stringify } from 'yaml';
import { inspectExtensionRevision } from '../packages/core/src/extensions.ts';

const cli = fileURLToPath(new URL('../packages/core/src/cli.ts', import.meta.url));
const module = (path: string) => JSON.stringify(pathToFileURL(fileURLToPath(new URL(path, import.meta.url))).href);

test('local-review validate on an auth site is quiet on success; a pinned validate still reports missing tables (#1013)', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'urlcode-auth-validate-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const app = join(dir, 'app');
  await mkdir(app, { recursive: true });
  await writeFile(join(app, 'urlcode.yaml'), stringify({ version: '1', extensions: { auth: { version: '1', config: {} } }, routes: { '/api/auth/*': { extension: 'auth', methods: ['GET', 'POST'] } } }));
  await writeFile(join(dir, 'host.mjs'), `import { composeHost } from ${module('../packages/core/src/host.ts')};
import auth from ${module('../packages/auth/src/extension.ts')};
export default await composeHost(import.meta.url, [auth()]);
`);
  const env = { ...process.env };
  delete env.PROJECT_SHA256; delete env.BETTER_AUTH_SECRET;
  const validate = (extra: string[], more: Record<string, string> = {}) => spawnSync(process.execPath, ['--conditions=development', cli, 'validate', '--project', app, '--host-file', join(dir, 'host.mjs'), '--local', ...extra], { encoding: 'utf8', env: { ...env, ...more } });

  const review = validate(['--local-review']);
  assert.equal(review.status, 0, review.stderr);
  assert.match(review.stdout, /"event":"valid"/);
  assert.doesNotMatch(review.stderr, /ERROR|Could not validate|schema/i, 'a passing local-review validate prints no failure');

  // The pinned run checks the site's own data/, where no one has run urlcode-auth migrate.
  const pinned = validate(['--origin', 'http://localhost'], { PROJECT_SHA256: await inspectExtensionRevision(app), BETTER_AUTH_SECRET: 's'.repeat(40) });
  assert.equal(pinned.status, 1, pinned.stdout + pinned.stderr);
  assert.match(pinned.stdout + pinned.stderr, /Better Auth's tables are not initialized \(user, session, account, verification, rateLimit\); run npx urlcode-auth migrate/);
});
