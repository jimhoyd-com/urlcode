import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { assertNpmSucceeded, describeNpmRun, npmCommand, npmSpawn, quietNpmEnv, runNpmSync } from '../scripts/npm-command.ts';
import type { NpmRun } from '../scripts/npm-command.ts';

test('npm helper preserves arguments with spaces without invoking a shell', () => {
  assert.deepEqual(npmCommand(['install', '--cache=C:/a b/cache'], { platform: 'win32', execPath: 'C:/Node/node.exe', npmExecPath: 'C:/Node/npm-cli.js' }), {
    command: 'C:/Node/node.exe', args: ['C:/Node/npm-cli.js', 'install', '--cache=C:/a b/cache'],
  });
});

test('direct Windows invocation locates npm JavaScript instead of executing npm.cmd', () => {
  const result = npmCommand(['ci'], { platform: 'win32', execPath: '/node/node.exe', npmExecPath: '', exists: () => true });
  assert.equal(result.command, '/node/node.exe');
  assert.deepEqual(result.args, [join('/node', 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'ci']);
  assert.throws(() => npmCommand(['ci'], { platform: 'win32', npmExecPath: '', exists: () => false }), /Run this helper through npm run/);
});

test('a synchronous npm run gets no stdin, no shell, no window, and quiet settings layered over the given env (#1130)', () => {
  const spawn = npmSpawn(['pack', '--json'], {
    cwd: 'C:/fixture', timeoutMs: 30_000, platform: 'win32', execPath: 'C:/Node/node.exe', npmExecPath: 'C:/Node/npm-cli.js',
    env: { PATH: 'C:/bin', npm_config_cache: 'C:/cache', npm_config_update_notifier: 'true' },
  });
  assert.equal(spawn.command, 'C:/Node/node.exe');
  assert.deepEqual(spawn.args, ['C:/Node/npm-cli.js', 'pack', '--json']);
  assert.deepEqual(spawn.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(spawn.options.shell, undefined);
  assert.equal(spawn.options.windowsHide, true);
  assert.equal(spawn.options.timeout, 30_000);
  assert.equal(spawn.options.cwd, 'C:/fixture');
  assert.deepEqual(spawn.options.env, {
    PATH: 'C:/bin', npm_config_cache: 'C:/cache',
    npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false', npm_config_progress: 'false',
  });
  assert.deepEqual(quietNpmEnv, { npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false', npm_config_progress: 'false' });
});

test('a timed-out npm run names its signal, timeout, elapsed time and the tail of both streams (#1130)', () => {
  const stdout = Array.from({ length: 30 }, (_, index) => `out ${index}`).join('\n');
  const run: NpmRun = {
    command: 'node', args: ['npm-cli.js', 'pack', '--json'], cwd: '/fixture', status: null, signal: 'SIGTERM', timedOut: true,
    elapsedMs: 30_037, timeoutMs: 30_000, stdout, stderr: '', error: 'spawnSync node ETIMEDOUT',
  };
  const message = describeNpmRun(run);
  assert.match(message, /\["node","npm-cli\.js","pack","--json"\] in \/fixture/);
  assert.match(message, /status null, signal SIGTERM, timedOut true after 30037 ms \(timeout 30000 ms\)/);
  assert.match(message, /spawn error: spawnSync node ETIMEDOUT/);
  assert.match(message, /stderr \(tail\):\n\(empty\)/);
  assert.match(message, /\.\.\. \[10 earlier lines\]\nout 10\n/);
  assert.match(message, /out 29$/);
  assert.doesNotMatch(message, /out 9\n/);
  assert.throws(() => assertNpmSucceeded(run), (error: Error) => error.message.includes('timedOut true after 30037 ms'));
});

test('runNpmSync records status, signal and elapsed time for a real npm run', { skip: !process.env.npm_execpath && 'needs npm_execpath' }, () => {
  const run = runNpmSync(['--version'], { cwd: process.cwd(), timeoutMs: 60_000 });
  assertNpmSucceeded(run);
  assert.equal(run.timedOut, false);
  assert.equal(run.signal, null);
  assert.match(run.stdout.trim(), /^\d+\.\d+\.\d+/);
  assert.ok(run.elapsedMs >= 0);
});
