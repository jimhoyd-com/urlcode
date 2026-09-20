import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDocument } from '@jimhoyd/urlcode';
import { scaffold } from '../src/index.ts';

const request = { directory: '/tmp/site', project: '/tmp/site/app', hostFile: '/tmp/site/host.mjs', names: ['store'] as const };

test('scaffold returns the shared contract shape and validates with core', () => {
  const result = scaffold(request);
  assert.equal(result.name, 'store');
  assert.deepEqual(result.files, []);
  assert.deepEqual(Object.keys(result.routes), ['/api/todos/*']);
  assert.match(result.hostEntries[0]!, /storeExtension\(/);
  assert.match(result.hostSetup.join('\n'), /PROJECT_SHA256/);
  const document = validateDocument({ version: '1', extensions: result.extensions, routes: result.routes });
  assert.equal(document.routes['/api/todos/*']?.extension, 'store');
  assert.match(result.readme, /^## Data store/);
});

test('scaffold reuses the auth revision pin, protects the route and refuses the wrong order', () => {
  const result = scaffold({ ...request, names: ['ui', 'auth', 'store'] });
  assert.ok(!result.hostSetup.join('\n').includes('PROJECT_SHA256'), 'auth defines projectSha256');
  assert.deepEqual((result.routes['/api/todos/*'] as { auth?: boolean }).auth, true);
  assert.throws(() => scaffold({ ...request, names: ['store', 'auth'] }), /auth before store/);
  assert.throws(() => scaffold({ ...request, project: '' }), /project/);
});
