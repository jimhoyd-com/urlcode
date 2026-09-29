// The operator's commit durability (#859): the serving connection runs SQLite synchronous=FULL unless the site's
// host options (or STORE_DURABILITY) choose `normal`, which the activation announces on the operator's warn channel.
// Anything but full or normal is refused before anything is served, and the urlcode-store operator commands always
// commit with FULL whatever the serving process uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { composeHost } from '@jimhoyd/urlcode/host';
import type { ExtensionActivation, RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import store from '../src/extension.ts';
import { createStore } from '../src/index.ts';
import { openStoreDatabase } from '../src/database.ts';
import { cleanup } from './cleanup.ts';

const pin = 'a'.repeat(64);
const todos = { mount: '/api/todos', schema: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', maxLength: 40 } } } };
// PRAGMA synchronous reads back 0 OFF, 1 NORMAL, 2 FULL, 3 EXTRA.
const FULL = 2, NORMAL = 1;

async function site(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'store-durability-'));
  cleanup(t, () => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  await mkdir(join(root, 'app'));
  return root;
}
function environment(t: TestContext, name: string, value: string | undefined): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  cleanup(t, () => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
}
/** Activates `registration` over `root`, returning the warnings it recorded; the activation closes with the test. */
async function activate(t: TestContext, root: string, registration: RuntimeExtension): Promise<string[]> {
  const warnings: string[] = [];
  const context: ExtensionActivation = { origin: 'https://durability.example.test', target: 'node', projectSha256: pin, mounts: ['/api/todos'], principalMounts: [], root: join(root, 'app'), warn: message => { warnings.push(message); } };
  const instance = await registration.activate({ collections: { todos } }, context);
  cleanup(t, () => instance.close?.());
  return warnings;
}
async function synchronous(path: string, options: Parameters<typeof openStoreDatabase>[1]): Promise<number> {
  const db = await openStoreDatabase(path, options);
  try { return Number(db.get<{ synchronous: number }>('PRAGMA synchronous')!.synchronous); } finally { db.close(); }
}

test('the connection commits with synchronous=FULL by default and NORMAL only when asked', async t => {
  const database = join(await site(t), 'data', 'store.sqlite');
  assert.equal(await synchronous(database, {}), FULL);
  assert.equal(await synchronous(database, { durability: 'full' }), FULL);
  assert.equal(await synchronous(database, { durability: 'normal' }), NORMAL);
  // WAL is unchanged by the choice.
  const db = await openStoreDatabase(database, { durability: 'normal' });
  try { assert.equal(db.get<{ journal_mode: string }>('PRAGMA journal_mode')!.journal_mode, 'wal'); } finally { db.close(); }
  for (const value of ['off', 'extra', 'OFF', 'EXTRA', 'FULL', 'Normal', '', '1', 2])
    await assert.rejects(openStoreDatabase(database, { durability: value as never }), /Store durability must be one of full, normal/, String(value));
});

test('createStore resolves full by default, warns once per activation for normal, and refuses anything else', async t => {
  const root = await site(t);
  const plain = createStore({ database: join(root, 'data', 'full.sqlite'), projectSha256: pin });
  cleanup(t, () => plain.close());
  assert.equal(plain.durability, 'full');
  assert.deepEqual(await activate(t, root, plain.registration), [], 'FULL says nothing');
  const fast = createStore({ database: join(root, 'data', 'normal.sqlite'), projectSha256: pin, durability: 'normal' });
  cleanup(t, () => fast.close());
  assert.equal(fast.durability, 'normal');
  const warnings = await activate(t, root, fast.registration);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /durability is normal.*synchronous=NORMAL.*lost on power loss/);
  for (const value of ['off', 'extra', 'FULL', ''])
    assert.throws(() => createStore({ database: join(root, 'data', 'x.sqlite'), projectSha256: pin, durability: value as never }), /Store durability must be one of full, normal/);
});

test('host() takes durability from its options, then STORE_DURABILITY, and refuses an invalid value before serving', async t => {
  const root = await site(t), host = pathToFileURL(join(root, 'host.mjs'));
  environment(t, 'PROJECT_SHA256', pin);
  environment(t, 'STORE_DURABILITY', undefined);
  const compose = async (entry: ReturnType<typeof store>) => { const composed = await composeHost(host, [entry]); cleanup(t, () => composed.close?.()); return composed.extensions![0]!; };
  assert.deepEqual(await activate(t, root, await compose(store({ database: join(root, 'data', 'a.sqlite') }))), [], 'the default is FULL');
  assert.equal((await activate(t, root, await compose(store({ database: join(root, 'data', 'b.sqlite'), durability: 'normal' })))).length, 1);
  await assert.rejects(composeHost(host, [store({ durability: 'off' as never })]), /Store durability must be one of full, normal; got "off"/);
  await assert.rejects(composeHost(host, [store({ durability: 'extra' as never })]), /Store durability must be one of full, normal/);
  environment(t, 'STORE_DURABILITY', 'normal');
  assert.equal((await activate(t, root, await compose(store({ database: join(root, 'data', 'c.sqlite') })))).length, 1, 'STORE_DURABILITY=normal');
  assert.deepEqual(await activate(t, root, await compose(store({ database: join(root, 'data', 'd.sqlite'), durability: 'full' }))), [], 'the host option wins over the environment');
  environment(t, 'STORE_DURABILITY', 'EXTRA');
  await assert.rejects(composeHost(host, [store({ database: join(root, 'data', 'e.sqlite') })]), /Store durability must be one of full, normal; got "EXTRA"/);
});

test('the operator commands always commit with FULL, whatever STORE_DURABILITY says', async t => {
  const database = join(await site(t), 'data', 'store.sqlite');
  environment(t, 'STORE_DURABILITY', 'normal');
  // The database layer never reads the environment: only host() does.
  assert.equal(await synchronous(database, {}), FULL);
  assert.equal(await synchronous(database, { create: false }), FULL);
  // Every operator command opens its connection through openStoreDatabase without a durability, so it gets the
  // default; backup opens the live database read-only and commits nothing.
  const source = join(import.meta.dirname, '..', 'src');
  for (const module of ['membership.ts', 'ownership.ts']) {
    const text = await readFile(join(source, module), 'utf8');
    const opens = [...text.matchAll(/openStoreDatabase\(([^)]*)\)/g)].map(match => match[1]!);
    assert.ok(opens.length > 0, module);
    for (const args of opens) assert.doesNotMatch(args, /durability/, `${module}: ${args}`);
  }
  assert.doesNotMatch(await readFile(join(source, 'cli.ts'), 'utf8'), /STORE_DURABILITY|durability/);
  assert.match(await readFile(join(source, 'backup.ts'), 'utf8'), /readOnly: true/);
});
