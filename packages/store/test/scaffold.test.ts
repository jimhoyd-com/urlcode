import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateDocument } from '@jimhoyd/urlcode';
import { composeHost } from '@jimhoyd/urlcode/host';
import store from '../src/extension.ts';
import { storeConfigSchema } from '../src/store.ts';

const PROJECT_SHA256 = 'a'.repeat(64);
const request = { site: '/tmp/site', project: '/tmp/site/app', installed: ['store'], acknowledgements: ['store:public-write'] } as const;
/** The store's `--example` output (#711); the capability scaffold alone is checked separately below. */
const scaffold = (overrides: Partial<{ installed: readonly string[]; acknowledgements: readonly string[] }> = {}) => store.definition.example!({ ...request, ...overrides });

test('the definition names the store, requires nothing and shares the runtime schema', () => {
  assert.equal(store.definition.name, 'store');
  assert.deepEqual(store.definition.requires, []);
  assert.equal(store.definition.schema, storeConfigSchema);
  // The optional store -> ui edge is declared, not required: the store contributes its screens to ui.
  assert.deepEqual(Object.keys(store.definition.contributes ?? {}), ['ui']);
  assert.equal(typeof (store.definition.contributes!.ui as { screens?: unknown }).screens, 'function');
});

test('a blank install declares no collection, no route and needs no acknowledgement (#711)', async () => {
  for (const installed of [['store'], ['store', 'ui'], ['auth', 'store', 'ui']]) {
    const blank = await store.definition.scaffold!({ ...request, installed, acknowledgements: [] });
    assert.deepEqual(blank.config, { collections: {} });
    assert.deepEqual(blank.routes, {});
    assert.equal(blank.acknowledged, undefined);
    assert.ok(blank.notes!.some(note => note.includes('--example')));
    const document = validateDocument({ version: '1', extensions: { store: { version: '1', config: blank.config } }, routes: {} });
    assert.deepEqual(document.routes, {});
  }
});

test('the example returns the todos collection and its route, and validates with core', async () => {
  const result = await scaffold();
  assert.deepEqual(Object.keys(result.config), ['collections']);
  assert.deepEqual(Object.keys(result.routes), ['/api/todos/*']);
  const document = validateDocument({ version: '1', extensions: { store: { version: '1', config: result.config } }, routes: result.routes });
  assert.equal(document.routes['/api/todos/*']?.extension, 'store');
  for (const removed of ['name', 'extensions', 'provides', 'after', 'hostImports', 'hostSetup', 'hostEntries', 'hostBundleExports', 'readme', 'nextSteps']) assert.equal(removed in result, false, `${removed} is not part of the scaffold result`);
  assert.ok(result.notes?.length);
});

test('scaffold protects the mount with auth: true when auth is installed, and needs no acknowledgement', async () => {
  const result = await scaffold({ installed: ['auth', 'store', 'ui'], acknowledgements: [] });
  assert.equal((result.routes['/api/todos/*'] as { auth?: boolean }).auth, true);
  assert.equal(result.acknowledged, undefined);
  assert.equal(result.routeNotes, undefined);
  const withoutUi = await scaffold({ installed: ['auth', 'store'], acknowledgements: [] });
  assert.deepEqual(Object.keys(withoutUi.routes), ['/api/todos/*']);
  assert.equal('screens' in withoutUi.config, false);
});

test('with ui installed the store declares its own /todos screen and the ui route that serves it (#709)', async () => {
  const signedIn = await scaffold({ installed: ['auth', 'store', 'ui'], acknowledgements: [] });
  assert.deepEqual((signedIn.config as { screens?: unknown }).screens, { '/todos': { collection: 'todos', title: 'Todos' } });
  assert.deepEqual(signedIn.routes['/todos/*'], { extension: 'ui', methods: ['GET', 'HEAD'], auth: true });
  assert.ok(signedIn.notes!.some(note => note.includes('/todos') && note.includes('extensions.store.config.screens')));
  const open = await scaffold({ installed: ['store', 'ui'] });
  assert.deepEqual(open.routes['/todos/*'], { extension: 'ui', methods: ['GET', 'HEAD'] });
  const document = validateDocument({ version: '1', extensions: { store: { version: '1', config: signedIn.config }, ui: { version: '1', config: {} } }, routes: { ...signedIn.routes, '/assets/ui/*': { extension: 'ui' } } });
  assert.equal(document.routes['/todos/*']?.extension, 'ui');
});

test('scaffold refuses a writable mount nothing protects unless store:public-write is acknowledged', async () => {
  for (const installed of [['store'], ['store', 'ui']]) {
    for (const acknowledgements of [[], ['other:public-write']]) {
      await assert.rejects(async () => scaffold({ installed, acknowledgements }), (error: Error & { acknowledgement?: string }) => error.acknowledgement === 'store:public-write' && /anyone could write/.test(error.message) && /not rate limiting/.test(error.message));
    }
  }
  const open = await scaffold();
  assert.deepEqual(open.acknowledged, ['store:public-write']);
  assert.equal((open.routes['/api/todos/*'] as { auth?: boolean }).auth, undefined);
  assert.match(open.routeNotes!.join(' '), /public write/i);
});

test('host() registers the store through composeHost with the operator directory', async t => {
  const site = await mkdtemp(join(tmpdir(), 'store-host-'));
  t.after(() => rm(site, { recursive: true, force: true }));
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = PROJECT_SHA256;
  t.after(() => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
  const host = await composeHost(pathToFileURL(join(site, 'host.mjs')), [store({ directory: join(site, 'records') })]);
  assert.equal(host.extensions!.length, 1);
  assert.equal(host.extensions![0]!.name, 'store');
  assert.equal(host.extensions![0]!.projectSha256, PROJECT_SHA256);
  await host.close?.();
  // Without options the default is data/store beside host.mjs, which is absolute and so accepted.
  const defaulted = await composeHost(pathToFileURL(join(site, 'host.mjs')), [store()]);
  assert.equal(defaulted.extensions![0]!.name, 'store');
  await assert.rejects(composeHost(pathToFileURL(join(site, 'host.mjs')), [store({ directory: 'relative/dir' })]), /absolute path/);
});
