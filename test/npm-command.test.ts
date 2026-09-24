import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { npmCommand } from '../scripts/npm-command.ts';

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
