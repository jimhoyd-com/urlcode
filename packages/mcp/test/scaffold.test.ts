import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDocument } from '@jimhoyd/urlcode';
import { scaffold } from '../src/index.ts';

const request = { directory: '/tmp/site', project: '/tmp/site/app', hostFile: '/tmp/site/host.mjs', names: ['mcp'] as const, acknowledgements: [] as readonly string[] };

test('scaffold returns the shared contract shape and validates with core', () => {
  const result = scaffold(request);
  assert.equal(result.name, 'mcp');
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.extensions, {});
  assert.deepEqual(result.routes, {});
  assert.deepEqual(result.hostBundleExports, ['createMcpExtension']);
  assert.match(result.hostEntries[0]!, /createMcpExtension\(/);
  assert.match(result.hostSetup.join('\n'), /PROJECT_SHA256/);
  // An empty extensions/routes composition still validates with core: mcp is wired into host.mjs
  // but never forces a project declaration (no scaffolded server needs a project handler that
  // init --with cannot place inside app/; see scaffold.ts).
  validateDocument({ version: '1', extensions: result.extensions, routes: result.routes });
  assert.match(result.readme, /wired into `host\.mjs`/);
  assert.match(result.readme, /app\/mcp-tools\/get-time\.mjs/);
  assert.match(result.readme, /app\/urlcode\.yaml/);
});

test('scaffold is order independent and requires the absolute request fields', () => {
  const result = scaffold(request);
  assert.deepEqual(scaffold({ ...request, names: ['mcp', 'ui'] }), result);
  assert.deepEqual(scaffold({ ...request, names: ['ui', 'mcp'] }), result, 'the spelling of names does not change the fragments');
  assert.throws(() => scaffold({ ...request, project: '' }), /project/);
  assert.throws(() => scaffold({ ...request, directory: '' }), /directory/);
  assert.throws(() => scaffold({ ...request, hostFile: '' }), /hostFile/);
});
