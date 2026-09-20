import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDocument } from '@jimhoyd/urlcode';
import { scaffold } from '../src/index.ts';

const request = { directory: '/tmp/site', project: '/tmp/site/app', hostFile: '/tmp/site/host.mjs', names: ['store'] as const, allowPublicWrite: true };

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

test('scaffold is order independent: it reads the pin under its own identifier and protects the route with auth', () => {
  const result = scaffold({ ...request, names: ['ui', 'auth', 'store'] });
  assert.match(result.hostSetup.join('\n'), /const storeProjectSha256 = process\.env\.PROJECT_SHA256/);
  assert.deepEqual(scaffold({ ...request, names: ['store', 'auth', 'ui'] }), result, 'the spelling of names does not change the fragments');
  assert.deepEqual((result.routes['/api/todos/*'] as { auth?: boolean }).auth, true);
  assert.throws(() => scaffold({ ...request, project: '' }), /project/);
});

test('scaffold refuses a writable mount no auth protects unless the public-write acknowledgement is present', () => {
  for (const names of [['store'], ['store', 'ui'], ['ui', 'store']]) {
    const { allowPublicWrite: _, ...bare } = request;
    assert.throws(() => scaffold({ ...bare, names }), /--allow-public-write[\s\S]*add auth to --with|add auth to --with[\s\S]*--allow-public-write/i);
  }
  const open = scaffold(request);
  assert.equal(open.publicWrite, true);
  assert.match(open.readme, /Access model: public write/); assert.match(open.readme, /not rate limiting, abuse protection or multi-tenant isolation/);
  assert.match(open.routeNotes!.join(' '), /public write/i);
  const signedIn = scaffold({ ...request, names: ['auth', 'store'], allowPublicWrite: false });
  assert.equal(signedIn.publicWrite, undefined); assert.equal(signedIn.routeNotes, undefined);
  assert.match(signedIn.readme, /Access model: signed-in callers only/);
});
