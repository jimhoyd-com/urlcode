// RIM-EXT-HERMETIC-001 hardening. #976: a hermetic run refuses an extension built before the hermetic obligation
// (contract 1) and any host whose registrations composeHost did not confirm were composed on the run's own data
// directory, so neither can write the site's live data/. #977: the run's temporary directories are removed on SIGINT,
// SIGTERM and an unhandled rejection, and a later run sweeps the ones a killed process left behind.
import './scratch-tmpdir.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { project } from './helpers.ts';
import { loadOperatorHost } from '../packages/core/src/operator-host.ts';
import { inspectExtensionRevision } from '../packages/core/src/extensions.ts';
import { createRunDirectory, removeRunDirectory, runDirectoryPattern, staleRunDirectoryScan, sweepStaleRunDirectories } from '../packages/core/src/temp-dirs.ts';

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);
const core = (file: string): string => JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'packages', 'core', 'src', file)).href);
const declarations = { extensions: { legacy: { version: '1', config: {} } } };
const routes = { '/demo/*': { extension: 'legacy', methods: ['GET'] } };
// The generated host files spell the schema as literal source: no value is serialized into code (CodeQL js/bad-code-sanitization).
const schema = "{ type: 'object', additionalProperties: false }";

/**
 * The child's environment with its temporary directory redirected to `scratch`: TMPDIR on POSIX, TEMP and TMP on
 * Windows (which also needs its system variables to start Node), and never the parent's revision pin.
 */
function childEnv(scratch: string): NodeJS.ProcessEnv {
  const { PROJECT_SHA256: _pin, URLCODE_POLICY: _policy, URLCODE_ORIGIN: _origin, ...inherited } = process.env;
  return { ...inherited, TMPDIR: scratch, TEMP: scratch, TMP: scratch };
}
async function temp(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function pinned(t: TestContext, revision: string): void {
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = revision;
  t.after(() => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
}
/** The registration the issue's legacy store builds: its database under the site's data/, whatever the run. */
const legacyRegistration = `(site, projectSha256) => ({ name: 'legacy', version: '1', projectSha256, targets: ['node'], schema: ${schema},
  activate() { return { handle() { mkdirSync(join(site, 'data'), { recursive: true }); appendFileSync(join(site, 'data', 'store.sqlite'), 'WRITE\\n'); return { status: 200, headers: [] }; } }; } })`;
const preamble = `import { appendFileSync, mkdirSync } from 'node:fs';\nimport { dirname, join } from 'node:path';\nimport { fileURLToPath } from 'node:url';\nconst site = dirname(fileURLToPath(import.meta.url));\nconst legacyRegistration = ${legacyRegistration};\n`;

test('a hermetic run refuses an extension built for contract 1 before its host() runs (#976)', async t => {
  const app = await project(t, routes, {}, declarations), site = await temp(t, 'urlcode-hardening-site-');
  pinned(t, await inspectExtensionRevision(app));
  await writeFile(join(site, 'host.mjs'), `${preamble}import { composeHost } from ${core('host.ts')};
const legacy = { definition: { name: 'legacy', description: 'Pre-#947 store', contract: 1, targets: ['node'], schema: ${schema},
  host(ctx) { mkdirSync(join(ctx.site, 'data'), { recursive: true }); appendFileSync(join(ctx.site, 'data', 'store.sqlite'), 'HOST\\n'); return { registration: legacyRegistration(ctx.site, ctx.projectSha256) }; } }, options: {} };
export default await composeHost(import.meta.url, [legacy]);
`);
  for (const hermetic of [true, false]) await assert.rejects(loadOperatorHost(join(site, 'host.mjs'), app, { hermetic }), /Extension legacy is built for URLCode extension contract 1, but this core implements extension contract 2/);
  assert.equal(await exists(join(site, 'data')), false, 'the site\'s data/ is never created');
});

test('a hermetic run refuses registrations composeHost did not confirm, and closes them (#976)', async t => {
  const app = await project(t, routes, {}, declarations), site = await temp(t, 'urlcode-hardening-site-');
  pinned(t, await inspectExtensionRevision(app));
  // What an older copy of core's composeHost, or a hand-made registration list, hands back: no confirmation.
  await writeFile(join(site, 'host.mjs'), `${preamble}globalThis.__hardeningClosed = 0;
export default { extensions: [legacyRegistration(site, process.env.PROJECT_SHA256)], close() { globalThis.__hardeningClosed++; } };
`);
  const closed = (): number => (globalThis as Record<string, unknown>).__hardeningClosed as number;
  const before = await readdir(tmpdir());
  await assert.rejects(loadOperatorHost(join(site, 'host.mjs'), app, { hermetic: true }), (error: Error & { details?: { code?: string } }) => {
    assert.match(error.message, /^A hermetic run \(test, audit, benchmark, MCP run_tests, or validate and routes with --local-review\) needs every extension the host file exports composed on its fresh temporary data directory, and at least one was not/);
    assert.equal(error.details?.code, 'hermetic-host-unconfirmed');
    return true;
  });
  assert.equal(closed(), 1, 'the refused host is released');
  const left = (await readdir(tmpdir())).filter(name => runDirectoryPattern.test(name) && name.includes(`-${process.pid}-`) && !before.includes(name));
  assert.deepEqual(left, [], 'the run directory is removed with the refusal');
  // Serving (and a pinned validate) never compose on a temporary directory, so there is nothing to confirm.
  const serving = await loadOperatorHost(join(site, 'host.mjs'), app);
  assert.equal(serving.extensions?.length, 1);
  assert.equal(await exists(join(site, 'data')), false);
});

test('a composed host confirms its data directory, also when host.mjs spreads it into its own export (#976)', async t => {
  const app = await project(t, routes, {}, declarations), site = await temp(t, 'urlcode-hardening-site-');
  pinned(t, await inspectExtensionRevision(app));
  await writeFile(join(site, 'host.mjs'), `import { composeHost } from ${core('host.ts')};
import { defineExtension } from ${core('extensions.ts')};
const schema = ${schema};
const legacy = defineExtension({ name: 'legacy', description: 'A contract-2 extension', contract: 2, targets: ['node'], schema, host(ctx) {
  globalThis.__hardeningData = ctx.data;
  return { registration: { name: 'legacy', version: '1', projectSha256: ctx.projectSha256, targets: ['node'], schema, activate: () => ({ handle: () => ({ status: 200, headers: [] }) }) } };
} });
const composed = await composeHost(import.meta.url, [legacy()]);
export default { ...composed, plugins: [] };
`);
  const host = await loadOperatorHost(join(site, 'host.mjs'), app, { hermetic: true });
  const data = (globalThis as Record<string, unknown>).__hardeningData as string;
  assert.match(basename(data), runDirectoryPattern);
  assert.ok(basename(data).startsWith(`urlcode-hermetic-${process.pid}-`), 'named for the process that owns it');
  assert.equal(await exists(data), true);
  await host.close!();
  assert.equal(await exists(data), false);
});

test('a hermetic run refuses a hand-made registration spread or pushed beside composed ones (#976)', async t => {
  const app = await project(t, routes, {}, declarations);
  pinned(t, await inspectExtensionRevision(app));
  const hosts = {
    // The reviewer's host: an empty compose spread, with a hand-written registration as its extensions.
    spread: `const c = await composeHost(import.meta.url, []);\nexport default { ...c, extensions: [legacyRegistration(site, process.env.PROJECT_SHA256)] };`,
    // A composed host whose extensions array gains a hand-written registration.
    pushed: `const c = await composeHost(import.meta.url, [confirmed()]);\nc.extensions.push(legacyRegistration(site, process.env.PROJECT_SHA256));\nexport default c;`,
    // Composed registrations reused in a hand-built export, beside a hand-written one.
    mixed: `const c = await composeHost(import.meta.url, [confirmed()]);\nexport default { extensions: [...c.extensions, legacyRegistration(site, process.env.PROJECT_SHA256)], close: c.close };`,
  };
  for (const [label, body] of Object.entries(hosts)) await t.test(label, async t => {
    const site = await temp(t, 'urlcode-hardening-site-');
    await writeFile(join(site, 'host.mjs'), `${preamble}import { composeHost } from ${core('host.ts')};
import { defineExtension } from ${core('extensions.ts')};
const schema = ${schema};
const confirmed = defineExtension({ name: 'other', description: 'A contract-2 extension', contract: 2, targets: ['node'], schema, host(ctx) {
  return { registration: { name: 'other', version: '1', projectSha256: ctx.projectSha256, targets: ['node'], schema, activate: () => ({ handle: () => ({ status: 200, headers: [] }) }) } };
} });
${body}
`);
    await assert.rejects(loadOperatorHost(join(site, 'host.mjs'), app, { hermetic: true }), (error: Error & { details?: { code?: string } }) => error.details?.code === 'hermetic-host-unconfirmed');
    assert.equal(await exists(join(site, 'data')), false, 'the site\'s data/ is never created');
  });
});

test('a stale run directory is swept only when it is ours, old, unlinked and its process is gone (#977)', async t => {
  const root = await temp(t, 'urlcode-sweep-root-');
  // Sweep as if three hours from now: everything written below is then three hours old unless dated `recent`.
  const hour = 60 * 60 * 1000, now = Date.now() + 3 * hour, recent = new Date(now - 60 * 1000);
  const dirs = { dead: 'urlcode-hermetic-4000001-abcDEF', alive: 'urlcode-data-4000002-abcDEF', young: 'urlcode-hermetic-4000003-abcDEF', open: 'urlcode-data-4000004-abcDEF', foreign: 'urlcode-hermetic-abcDEF', mine: `urlcode-data-${process.pid}-abcDEF`, written: 'urlcode-data-4000006-abcDEF', nested: 'urlcode-hermetic-4000007-abcDEF', crowded: 'urlcode-data-4000008-abcDEF' };
  for (const name of Object.values(dirs)) { await mkdir(join(root, name), { mode: 0o700 }); await chmod(join(root, name), 0o700); }
  await chmod(join(root, dirs.open), 0o755);
  // A link inside a swept directory is removed, never followed.
  const outside = await temp(t, 'urlcode-sweep-outside-');
  await writeFile(join(outside, 'keep.txt'), 'keep');
  await symlink(outside, join(root, dirs.dead, 'link'));
  await writeFile(join(root, dirs.dead, 'seed.db'), 'seeded');
  // A link named like a run directory is never followed or removed.
  await symlink(outside, join(root, 'urlcode-hermetic-4000005-abcDEF'));
  await utimes(join(root, dirs.young), recent, recent);
  // A live run from another pid namespace looks dead, and writing its database leaves the directory's own mtime old.
  await writeFile(join(root, dirs.written, 'db.sqlite'), 'old');
  await writeFile(join(root, dirs.written, 'db.sqlite'), 'rewritten');
  await utimes(join(root, dirs.written, 'db.sqlite'), recent, recent);
  await mkdir(join(root, dirs.nested, 'a', 'b'), { recursive: true });
  await writeFile(join(root, dirs.nested, 'a', 'b', 'db.sqlite-wal'), 'wal');
  await utimes(join(root, dirs.nested, 'a', 'b', 'db.sqlite-wal'), recent, recent);
  // More entries than the age check looks at: it cannot tell, so the directory is kept.
  for (let index = 0; index <= staleRunDirectoryScan.entries; index++) await writeFile(join(root, dirs.crowded, `f${index}`), '');
  assert.equal(await sweepStaleRunDirectories({ root, now: now - 2.5 * hour, exists: () => false }).then(removed => removed.length), 0, 'nothing is an hour old yet');
  const removed = await sweepStaleRunDirectories({ root, now, exists: pid => pid === 4000002 });
  // Windows has no uid or POSIX mode to check, so there the 0755 directory is swept like any other stale one.
  const windows = process.platform === 'win32';
  assert.deepEqual(removed.sort(), (windows ? [dirs.dead, dirs.open] : [dirs.dead]).map(name => join(root, name)).sort());
  assert.deepEqual((await readdir(root)).sort(), [dirs.alive, ...(windows ? [] : [dirs.open]), dirs.foreign, dirs.mine, 'urlcode-hermetic-4000005-abcDEF', dirs.young, dirs.written, dirs.nested, dirs.crowded].sort());
  assert.equal(await exists(join(outside, 'keep.txt')), true);
  // Once its database is an hour old too, the dead run's directory goes.
  assert.deepEqual(await sweepStaleRunDirectories({ root, now: now + hour, exists: pid => pid === 4000002 }).then(paths => paths.filter(path => path.endsWith(dirs.written))), [join(root, dirs.written)]);
});

test('the sweep and run directories of this suite stay inside its scratch temporary directory (#977)', () => {
  const scratch = process.env.URLCODE_TEST_TMPDIR;
  assert.ok(scratch !== undefined && tmpdir() === scratch, 'test/scratch-tmpdir.ts redirected the OS temporary directory');
});

test('every test script of the root and workspace packages preloads test/scratch-tmpdir.ts (#1030)', async () => {
  const root = join(import.meta.dirname, '..');
  const preload = join(root, 'test', 'scratch-tmpdir.ts');
  const manifests = [root, ...(await readdir(join(root, 'packages'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => join(root, 'packages', entry.name))];
  let checked = 0;
  for (const dir of manifests) {
    const manifest = await readFile(join(dir, 'package.json'), 'utf8').catch(() => null);
    if (manifest === null) continue;
    const scripts = (JSON.parse(manifest) as { scripts?: Record<string, string> }).scripts ?? {};
    for (const [name, script] of Object.entries(scripts)) {
      if (name !== 'test' && !name.startsWith('test:')) continue;
      for (const step of script.split('&&').map(part => part.trim())) {
        const where = `${join(dir, 'package.json')} ${name}: ${step}`;
        const npmRun = /^npm run ([\w:-]+)$/.exec(step);
        if (npmRun) {
          // Another test script (checked in its own right) or the build, which runs no test.
          assert.ok(npmRun[1] === 'build' || npmRun[1]!.startsWith('test:'), where);
          continue;
        }
        assert.match(step, /^node /, `${where}: every test step is a node process that can preload the scratch directory`);
        const flag = /(?:^|\s)--import (\S+)/.exec(step);
        assert.ok(flag && resolve(dir, flag[1]!) === preload, `${where}: add --import <path to test/scratch-tmpdir.ts> so it never writes the real temporary directory`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 10, `checked ${checked} test steps`);
});

test('createRunDirectory names the directory for this process and removeRunDirectory deletes it (#977)', async () => {
  const dir = await createRunDirectory('data');
  assert.match(basename(dir), new RegExp(`^urlcode-data-${process.pid}-[A-Za-z0-9]{6}$`));
  await writeFile(join(dir, 'x.db'), 'x');
  await removeRunDirectory(dir);
  assert.equal(await exists(dir), false);
});

test('an interrupted or crashing urlcode test removes its run directories (#977)', { timeout: 60000 }, async t => {
  // On Windows, child.kill('SIGINT' | 'SIGTERM') terminates the process without running its handlers, so there is
  // nothing to clean up in-process; the next run's sweep covers it. The unhandled-rejection path runs everywhere.
  const noSignals = process.platform === 'win32' ? 'Windows ends the process on kill() without running signal handlers; the sweep covers it' : false;
  const cases: [string, NodeJS.Signals | undefined, number, string][] = [
    ['SIGINT', 'SIGINT', 130, 'export default async () => { await new Promise(resolve => setTimeout(resolve, 60000)); return new Response(\'late\'); };'],
    ['SIGTERM', 'SIGTERM', 143, 'export default async () => { await new Promise(resolve => setTimeout(resolve, 60000)); return new Response(\'late\'); };'],
    ['an unhandled rejection', undefined, 1, 'export default () => { Promise.reject(new Error(\'synthetic unhandled\')); return new Promise(() => {}); };'],
  ];
  for (const [label, signal, code, source] of cases) await t.test(label, { skip: signal ? noSignals : false }, async t => {
    const scratch = await temp(t, 'urlcode-hardening-tmp-');
    const app = await project(t, { ...routes, '/slow': { function: 'slow.mjs' } }, { 'slow.mjs': source, 'tests/requests.json': JSON.stringify([{ path: '/slow', status: 200 }]) }, declarations);
    const site = await temp(t, 'urlcode-hardening-site-');
    await writeFile(join(site, 'host.mjs'), `import { composeHost } from ${core('host.ts')};
import { defineExtension } from ${core('extensions.ts')};
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const schema = ${schema};
const legacy = defineExtension({ name: 'legacy', description: 'A contract-2 extension', contract: 2, targets: ['node'], schema, host(ctx) {
  writeFileSync(join(ctx.data, 'marker.db'), 'seeded');
  return { registration: { name: 'legacy', version: '1', projectSha256: ctx.projectSha256, targets: ['node'], schema, activate: () => ({ handle: () => ({ status: 200, headers: [] }) }) } };
} });
export default await composeHost(import.meta.url, [legacy()]);
`);
    const cli = join(import.meta.dirname, '..', 'packages', 'core', 'src', 'cli.ts');
    const child = spawn(process.execPath, [cli, 'test', '--project', app, '--host-file', join(site, 'host.mjs'), '--local-review'], { env: childEnv(scratch), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const exit = new Promise<number | null>(resolve => child.once('close', resolve));
    // Wait until the run holds both of its directories and the seeded file.
    const deadline = Date.now() + 30000;
    for (;;) {
      const names = await readdir(scratch);
      const hermetic = names.find(name => name.startsWith('urlcode-hermetic-'));
      if (hermetic && names.some(name => name.startsWith('urlcode-data-')) && await exists(join(scratch, hermetic, 'marker.db'))) break;
      assert.ok(Date.now() < deadline, `the run never created its directories: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (signal) { await new Promise(resolve => setTimeout(resolve, 300)); child.kill(signal); }
    assert.equal(await exit, code, stderr);
    assert.deepEqual((await readdir(scratch)).filter(name => name.startsWith('urlcode-')), [], stderr);
  });
});
