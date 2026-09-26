import { cleanup } from './cleanup.ts';
// The definition end to end: the key file the scaffold writes, composeHost, activation through the real runtime,
// and a synthetic consumer extension that reads AbuseExports from the host and answers 429 with Retry-After over
// real HTTP. The real consumers (auth, forms) are proven in their own packages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createRuntime, startServer } from '@jimhoyd/urlcode';
import { defineExtension, inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import type { HandlerResult } from '@jimhoyd/urlcode/extensions';
import { composeHost } from '@jimhoyd/urlcode/host';
import abuse from '../src/extension.ts';
import { abuseConfigSchema } from '../src/index.ts';
import type { AbuseBudget, AbuseExports, AbuseNamespace } from '../src/index.ts';

const origin = 'https://abuse.example.test';

/** A second extension that only knows AbuseExports v1: one budget, one admit per POST. */
const consumer = defineExtension({
  name: 'consumer', description: 'Synthetic AbuseExports consumer for tests', requires: ['abuse'],
  schema: { type: 'object', additionalProperties: false, properties: {} },
  host(context) {
    const exports = context.get<AbuseExports>('abuse');
    return {
      registration: {
        name: 'consumer', version: '1', projectSha256: context.projectSha256, targets: ['node'], schema: { type: 'object', additionalProperties: false, properties: {} },
        activate() {
          if (!exports.active) throw new Error('consumer needs extensions.abuse declared and active');
          const ns: AbuseNamespace = exports.namespace('consumer'), budget: AbuseBudget = ns.budget({ scope: 'client', limit: 2, windowMs: 60000 });
          return {
            async handle(request): Promise<HandlerResult> {
              if (!request.client) return { status: 503, headers: [], body: 'trusted client required' };
              let admission;
              try { admission = await ns.admit([{ budget, value: request.client }]); }
              catch { return { status: 503, headers: [], body: 'unavailable' }; }
              if (!admission.allowed) return { status: admission.status, headers: admission.status === 429 ? [['retry-after', String(admission.retryAfterSeconds)]] : [], body: admission.code };
              return { status: 200, headers: [['content-type', 'text/plain; charset=utf-8']], body: 'accepted' };
            },
          };
        },
      },
    };
  },
});

async function site(t: test.TestContext, key: Uint8Array | null = randomBytes(32)) {
  const dir = await mkdtemp(join(tmpdir(), 'abuse-site-'));
  cleanup(t, () => rm(dir, { recursive: true, force: true }));
  const project = join(dir, 'app');
  await mkdir(project);
  await mkdir(join(dir, 'data'), { mode: 0o700 });
  if (key) await writeFile(join(dir, 'data', 'abuse.key'), key, { mode: 0o600 });
  return { dir, project };
}
async function pinned(t: test.TestContext, project: string, document: unknown) {
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify(document));
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = await inspectExtensionRevision(project);
  cleanup(t, () => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
}

test('the definition declares node-only, route-free abuse with its config schema', async () => {
  assert.equal(abuse.definition.name, 'abuse');
  assert.equal(abuse.definition.schema, abuseConfigSchema);
  assert.deepEqual(abuse.definition.requires, []);
  assert.equal(abuse.definition.example, undefined);
});

test('scaffold writes config, no routes, and a private 32-byte key', async () => {
  const first = await abuse.definition.scaffold!({ site: '/tmp/site', project: '/tmp/site/app', installed: ['abuse'], acknowledgements: [] });
  const second = await abuse.definition.scaffold!({ site: '/tmp/site', project: '/tmp/site/app', installed: ['abuse'], acknowledgements: [] });
  assert.deepEqual(first.config, { maxKeys: 100000 });
  assert.deepEqual(first.routes, {});
  assert.equal(first.files?.length, 1);
  const file = first.files![0]!;
  assert.equal(file.path, 'data/abuse.key');
  assert.equal(file.mode, 0o600);
  assert.ok(file.content instanceof Uint8Array && file.content.byteLength === 32);
  assert.notDeepEqual(file.content, second.files![0]!.content);
  assert.deepEqual(Object.keys(first.env ?? {}), ['TURNSTILE_SECRET']);
  assert.ok(first.notes?.some(note => note.includes('policies.throttle')));
});

test('composeHost reads the key file and opens a private database; a consumer gets 429 with Retry-After over HTTP', async t => {
  const { dir, project } = await site(t);
  await pinned(t, project, { version: '1', extensions: { abuse: { version: '1', config: { maxKeys: 1000 } }, consumer: { version: '1', config: {} } }, routes: { '/limited/*': { extension: 'consumer', methods: ['POST'] } } });
  const host = await composeHost(pathToFileURL(join(dir, 'host.mjs')), [abuse(), consumer()]);
  cleanup(t, () => host.close?.());
  const app = await startServer({ project, origin, port: 0, log: () => {}, extensions: host.extensions ?? [] });
  cleanup(t, () => app.close());
  const info = await stat(join(dir, 'data', 'abuse.sqlite'));
  assert.ok(info.isFile());
  assert.equal(info.nlink, 1);
  // Windows permissions are ACL-based; only POSIX exposes the mode enforced by the store.
  if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600);
  const post = () => fetch(`http://127.0.0.1:${app.address.port}/limited/submit`, { method: 'POST' });
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 200);
  const refused = await post();
  assert.equal(refused.status, 429);
  assert.equal(await refused.text(), 'rate_limited');
  const retry = Number(refused.headers.get('retry-after'));
  assert.ok(retry >= 59 && retry <= 60, String(retry));
});

test('a missing key or a key of the wrong size refuses with the scaffold hint', async t => {
  const missing = await site(t, null);
  await pinned(t, missing.project, { version: '1', extensions: { abuse: { version: '1', config: {} } }, routes: {} });
  await assert.rejects(composeHost(pathToFileURL(join(missing.dir, 'host.mjs')), [abuse()]), /urlcode extensions add abuse writes data\/abuse\.key/);
  const short = await site(t, randomBytes(31));
  await assert.rejects(composeHost(pathToFileURL(join(short.dir, 'host.mjs')), [abuse()]), /exactly 32 bytes.*urlcode extensions add abuse writes data\/abuse\.key/);
  const long = await site(t, randomBytes(33));
  await assert.rejects(composeHost(pathToFileURL(join(long.dir, 'host.mjs')), [abuse()]), /exactly 32 bytes/);
});

test('host options can supply the key and database', async t => {
  const { dir, project } = await site(t, null);
  await pinned(t, project, { version: '1', extensions: { abuse: { version: '1', config: {} } }, routes: {} });
  const database = join(dir, 'elsewhere.sqlite');
  const host = await composeHost(pathToFileURL(join(dir, 'host.mjs')), [abuse({ key: randomBytes(32), database })]);
  cleanup(t, () => host.close?.());
  assert.ok((await stat(database)).isFile());
  await host.close?.();
  await t.test('POSIX refuses a database readable by other users', { skip: process.platform === 'win32' }, async () => {
    await chmod(database, 0o644);
    await assert.rejects(composeHost(pathToFileURL(join(dir, 'host.mjs')), [abuse({ key: randomBytes(32), database })]), /must be a private regular file/);
  });
});

test('activation refuses any mount', async t => {
  const { dir, project } = await site(t);
  await pinned(t, project, { version: '1', extensions: { abuse: { version: '1', config: {} } }, routes: { '/abuse/*': { extension: 'abuse', methods: ['GET'] } } });
  const host = await composeHost(pathToFileURL(join(dir, 'host.mjs')), [abuse()]);
  cleanup(t, () => host.close?.());
  await assert.rejects(startServer({ project, origin, port: 0, log: () => {}, extensions: host.extensions ?? [] }), /abuse serves no routes/);
});

test('the runtime refuses a non-node target before serving', async t => {
  const { dir, project } = await site(t);
  await pinned(t, project, { version: '1', extensions: { abuse: { version: '1', config: {} } }, routes: {} });
  const host = await composeHost(pathToFileURL(join(dir, 'host.mjs')), [abuse()]);
  cleanup(t, () => host.close?.());
  assert.deepEqual(host.extensions?.[0]?.targets, ['node']);
  for (const target of ['aws', 'vercel'] as const)
    await assert.rejects(createRuntime(project, { origin, extensions: host.extensions ?? [], target }), /declared targets: abuse/);
});

test('config maxKeys outside 1000..1000000 is refused by the schema', async t => {
  const { dir, project } = await site(t);
  await pinned(t, project, { version: '1', extensions: { abuse: { version: '1', config: { maxKeys: 999 } } }, routes: {} });
  const host = await composeHost(pathToFileURL(join(dir, 'host.mjs')), [abuse()]);
  cleanup(t, () => host.close?.());
  await assert.rejects(startServer({ project, origin, port: 0, log: () => {}, extensions: host.extensions ?? [] }), /extensions\/abuse\/config\/maxKeys/);
});
