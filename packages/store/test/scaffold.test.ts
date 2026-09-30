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
import { cleanup } from './cleanup.ts';

const PROJECT_SHA256 = 'a'.repeat(64);
const request = { site: '/tmp/site', project: '/tmp/site/app', installed: ['store'], acknowledgements: ['store:public-write'] } as const;
/** The store's `--example` output (#711); the capability scaffold alone is checked separately below. */
const scaffold = (overrides: Partial<{ installed: readonly string[]; acknowledgements: readonly string[] }> = {}) => store.definition.example!({ ...request, ...overrides });

test('the definition names the store, requires nothing and shares the runtime schema', () => {
  assert.equal(store.definition.name, 'store');
  assert.deepEqual(store.definition.requires, []);
  // The audit log is the store's own (#1052): it uses no other extension.
  assert.equal(store.definition.uses, undefined);
  assert.equal(store.definition.schema, storeConfigSchema);
});

test('a blank install declares no collection, no route and needs no acknowledgement (#711)', async () => {
  for (const installed of [['store'], ['audit', 'store'], ['auth', 'store']]) {
    const blank = await store.definition.scaffold!({ ...request, installed, acknowledgements: [] });
    assert.deepEqual(blank.config, { collections: {} });
    assert.deepEqual(blank.routes, {});
    assert.equal(blank.acknowledged, undefined);
    assert.ok(blank.notes!.some(note => note.includes('--example')));
    const document = validateDocument({ version: '1', extensions: { store: { version: '1', config: blank.config } }, routes: {} });
    assert.deepEqual(document.routes, {});
  }
});

// #931: what `urlcode extensions add store` prints must point at a page the site has installed, not a docs/ page of
// this repository that the site does not have.
test('the add output points at the installed store README, never at an uninstalled docs/ page', async () => {
  const blank = await store.definition.scaffold!({ ...request, acknowledgements: [] });
  const text = [...(blank.notes ?? []), ...Object.values(blank.env ?? {}), ...((await scaffold()).notes ?? [])].join('\n');
  assert.doesNotMatch(text, /docs\/[A-Z-]+\.md/);
  assert.match(text, /node_modules\/@jimhoyd\/urlcode-store\/README\.md/);
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

test('scaffold protects the JSON mount with auth: true when auth is installed, and needs no acknowledgement', async () => {
  const result = await scaffold({ installed: ['auth', 'store'], acknowledgements: [] });
  // The API takes JSON only, so auth admits its writes on same-origin provenance rather than a token header (decision 0.1).
  assert.deepEqual((result.routes['/api/todos/*'] as { auth?: unknown }).auth, true);
  // Behind auth the example collection is per-user (#331): the safer pattern to copy.
  assert.equal((result.config as { collections: { todos: { ownership?: string } } }).collections.todos.ownership, 'owner');
  assert.ok(result.notes!.some(note => note.includes('ownership: owner')));
  assert.equal(result.acknowledged, undefined);
  assert.equal(result.routeNotes, undefined);
  // The example is API only (#883): the JSON mount and nothing else.
  assert.deepEqual(Object.keys(result.routes), ['/api/todos/*']);
  assert.deepEqual(Object.keys(result.config), ['collections']);
});


test('scaffold refuses a writable mount nothing protects unless store:public-write is acknowledged', async () => {
  for (const installed of [['store'], ['audit', 'store']]) {
    for (const acknowledgements of [[], ['other:public-write']]) {
      await assert.rejects(async () => scaffold({ installed, acknowledgements }), (error: Error & { acknowledgement?: string }) => error.acknowledgement === 'store:public-write' && /anyone could write/.test(error.message) && /not rate limiting/.test(error.message));
    }
  }
  const open = await scaffold();
  assert.deepEqual(open.acknowledged, ['store:public-write']);
  assert.equal((open.routes['/api/todos/*'] as { auth?: boolean }).auth, undefined);
  // Without auth there is no principal, so the example stays shared.
  assert.equal('ownership' in (open.config as { collections: { todos: object } }).collections.todos, false);
  assert.match(open.routeNotes!.join(' '), /public write/i);
});

test('host() registers the store through composeHost with the operator database', async t => {
  const site = await mkdtemp(join(tmpdir(), 'store-host-'));
  cleanup(t, () => rm(site, { recursive: true, force: true }));
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = PROJECT_SHA256;
  cleanup(t, () => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
  const host = await composeHost(pathToFileURL(join(site, 'host.mjs')), [store({ database: join(site, 'records', 'store.sqlite') })]);
  assert.equal(host.extensions!.length, 1);
  assert.equal(host.extensions![0]!.name, 'store');
  assert.equal(host.extensions![0]!.projectSha256, PROJECT_SHA256);
  await host.close?.();
  // Without options the default is data/store.sqlite beside host.mjs, which is absolute and so accepted.
  const defaulted = await composeHost(pathToFileURL(join(site, 'host.mjs')), [store()]);
  assert.equal(defaulted.extensions![0]!.name, 'store');
  await assert.rejects(composeHost(pathToFileURL(join(site, 'host.mjs')), [store({ database: 'relative/store.sqlite' })]), /absolute path/);
});

test('with auth the example collection records its writes in the store\'s audit log, and says so', async () => {
  const audited = await scaffold({ installed: ['auth', 'store'], acknowledgements: [] });
  assert.equal((audited.config as { collections: { todos: { audit?: boolean } } }).collections.todos.audit, true);
  assert.ok(audited.notes!.some(note => note.includes('audit: true') && note.includes('urlcode-store audit')));
  const plain = await scaffold({ installed: ['store'], acknowledgements: ['store:public-write'] });
  assert.equal('audit' in (plain.config as { collections: { todos: object } }).collections.todos, false, 'an audited collection needs a principal on its mount');
  assert.ok(plain.notes!.every(note => !note.includes('audit')));
});
