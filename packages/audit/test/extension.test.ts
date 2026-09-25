// The definition end to end: composeHost builds audit from host.mjs's list, createRuntime activates it from an
// `extensions.audit` declaration, and a synthetic consumer that requires audit reads its exports through ctx.get.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@jimhoyd/urlcode';
import { defineExtension, inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { composeHost } from '@jimhoyd/urlcode/host';
import audit, { auditConfigSchema } from '../src/extension.ts';
import type { AuditExports } from '../src/index.ts';
import { event, fakeProducer, tempDir, until } from './support.ts';

const origin = 'https://audit.example.test';

/** A consumer that requires audit and attaches a producer from host(), before activation, as auth and store do. */
function consumer(seen: { exports?: AuditExports }, producer = fakeProducer('consumer')) {
  return defineExtension({
    name: 'consumer', description: 'Synthetic audit consumer', requires: ['audit'], schema: { type: 'object' },
    host(ctx) {
      const exports = ctx.get<AuditExports>('audit');
      seen.exports = exports;
      const attachment = exports.attach(producer);
      return {
        registration: { name: 'consumer', version: '1', projectSha256: ctx.projectSha256, targets: ['node'], schema: { type: 'object' }, activate: () => ({ handle: () => ({ status: 404, headers: [] }) }) },
        exports: { notify: () => attachment.notify() },
        close: () => attachment.close(),
      };
    },
  });
}

async function site(t: TestContext, config: Record<string, unknown>, routes: Record<string, unknown> = {}) {
  const root = await tempDir(t), project = join(root, 'app');
  await mkdir(project);
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { audit: { version: '1', config } }, routes }));
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = await inspectExtensionRevision(project);
  t.after(() => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
  return { root, project, hostUrl: pathToFileURL(join(root, 'host.mjs')) };
}

test('the definition shares the runtime schema, needs nothing and scaffolds configuration only', async () => {
  const definition = audit.definition;
  assert.equal(definition.name, 'audit');
  assert.equal(definition.schema, auditConfigSchema);
  assert.deepEqual(definition.requires ?? [], []);
  assert.equal(definition.example, undefined);
  assert.equal(definition.contributes, undefined);
  const scaffolded = await definition.scaffold!({ site: '/tmp/site', project: '/tmp/site/app', installed: ['audit'], acknowledgements: [] });
  assert.deepEqual(scaffolded.config, { retention: 100000 });
  assert.deepEqual(scaffolded.routes, {});
  assert.equal(scaffolded.files, undefined, 'the database is created on open');
  const notes = scaffolded.notes!.join('\n');
  assert.match(notes, /npx urlcode-audit backup/);
  assert.match(notes, /after the auth backup/);
  assert.match(notes, /audit: true/);
  assert.match(notes, /audit\.read/);
  assert.match(notes, /audit\.export/);
});

test('composeHost and createRuntime activate audit from its declaration; a consumer records and drains through it', async t => {
  const { root, project, hostUrl } = await site(t, { retention: 1000 });
  const seen: { exports?: AuditExports } = {}, producer = fakeProducer('consumer');
  const host = await composeHost(hostUrl, [consumer(seen, producer)(), audit()]);
  t.after(() => host.close?.());
  assert.deepEqual(host.extensions!.map(item => item.name), ['audit', 'consumer']);
  const exports = seen.exports!;
  assert.equal(exports.active, false, 'inactive until the runtime activates it');
  producer.outbox.push(event({ source: 'consumer' }));
  const runtime = await createRuntime(project, { origin, extensions: host.extensions ?? [] });
  assert.equal(exports.active, true);
  await until(() => producer.outbox.length === 0);
  await exports.record([event({ source: 'admin', action: 'admin.audit_exported' })]);
  assert.deepEqual((await exports.query({ order: 'desc' })).events.map(item => item.source), ['admin', 'consumer']);
  const database = join(root, 'data', 'audit.sqlite');
  if (process.platform !== 'win32') {
    assert.equal((await stat(database)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, 'data'))).mode & 0o777, 0o700);
  }
  await runtime.close();
  assert.equal(exports.active, false, 'closing the runtime deactivates it');
});

test('activation refuses a route that mounts audit, and every target but node', async t => {
  const mounted = await site(t, {}, { '/audit/*': { extension: 'audit', methods: ['GET'] } });
  const host = await composeHost(mounted.hostUrl, [audit()]);
  t.after(() => host.close?.());
  await assert.rejects(createRuntime(mounted.project, { origin, extensions: host.extensions ?? [] }), /audit serves no routes/);
  const plain = await site(t, {});
  const second = await composeHost(plain.hostUrl, [audit()]);
  t.after(() => second.close?.());
  await assert.rejects(createRuntime(plain.project, { origin, extensions: second.extensions ?? [], target: 'aws' }), /declared targets: audit/);
});

test('the YAML config is validated against the schema', async t => {
  const { project, hostUrl } = await site(t, { retention: 10 });
  const host = await composeHost(hostUrl, [audit()]);
  t.after(() => host.close?.());
  await assert.rejects(createRuntime(project, { origin, extensions: host.extensions ?? [] }), /extensions.audit.*retention|retention.*1000/);
});

test('host() refuses a database inside app/ or a relative path', async t => {
  const { root, hostUrl } = await site(t, {});
  await assert.rejects(composeHost(hostUrl, [audit({ database: join(root, 'app', 'audit.sqlite') })]), /outside app/);
  await assert.rejects(composeHost(hostUrl, [audit({ database: 'data/audit.sqlite' })]), /absolute/);
  const custom = join(root, 'elsewhere.sqlite');
  const host = await composeHost(hostUrl, [audit({ database: custom })]);
  await host.close?.();
  assert.ok((await stat(custom)).isFile());
});
