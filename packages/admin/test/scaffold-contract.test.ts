import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateDocument } from '@jimhoyd/urlcode';
import { defineExtension } from '@jimhoyd/urlcode/extensions';
import type { ScaffoldResult } from '@jimhoyd/urlcode/extensions';
import { composeHost } from '@jimhoyd/urlcode/host';
import { createAuthService } from '@jimhoyd/urlcode-auth';
import auth from '@jimhoyd/urlcode-auth/extension';
import admin from '../src/extension.ts';
import { adminConfigSchema } from '../src/admin.ts';
import { adminUiTemplates } from '../src/admin-templates.ts';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const request = { site: '/srv/site', project: '/srv/site/app', installed: ['admin', 'auth', 'ui'], acknowledgements: [] };
const sha = 'b'.repeat(64);

/** A stand-in for the ui extension: it records what the others contributed and exposes a kit-shaped export. */
function fakeUi() {
  const seen: unknown[][] = [];
  const definition = defineExtension({
    name: 'ui', description: 'Test kit', schema: { type: 'object' },
    host(ctx) {
      seen.push(ctx.contributions('ui'));
      return { registration: { name: 'ui', version: '1', projectSha256: ctx.projectSha256, targets: ['node'], schema: { type: 'object' }, activate: () => ({ handle: () => ({ status: 404, headers: [] }) }) }, exports: { registration: null, kit: null, active: false } };
    },
  });
  return { definition, seen };
}

async function scaffoldResult(): Promise<ScaffoldResult> {
  assert.ok(admin.definition.scaffold);
  return await admin.definition.scaffold(request);
}

function withSha<T>(t: { after(fn: () => void): void }, run: () => Promise<T>): Promise<T> {
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = sha;
  t.after(() => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
  return run();
}

test('the definition requires auth and ui, and contributes its templates to ui', async () => {
  const definition = admin.definition;
  assert.equal(definition.name, 'admin');
  assert.deepEqual(definition.requires, ['auth', 'ui']);
  assert.equal(definition.schema, adminConfigSchema);
  const manifest = JSON.parse(await readFile(join(packageRoot, 'urlcode.json'), 'utf8')) as Record<string, unknown>;
  // urlcode.json is generated from this definition (npm run build:addons); CI fails if it drifts.
  assert.deepEqual({ kind: manifest.kind, name: manifest.name, description: manifest.description, requires: manifest.requires }, { kind: 'extension', name: 'admin', description: definition.description, requires: ['auth', 'ui'] });
  assert.deepEqual(definition.contributes, { ui: { templates: [adminUiTemplates] } });
});

test('scaffold returns an empty config, the /admin mount and notes, and no files or env', async () => {
  const result = await scaffoldResult();
  assert.deepEqual(Object.keys(result).sort(), ['config', 'notes', 'routes']);
  assert.deepEqual(result.config, {});
  assert.deepEqual(result.routes, { '/admin/*': { extension: 'admin', methods: ['GET', 'HEAD', 'POST'] } });
  assert.ok(result.notes!.length > 0 && result.notes!.every(note => typeof note === 'string' && !note.includes('\n')));
  // The console is the capability; admin ships no example, and names auth's mount as a configurable default.
  assert.equal(admin.definition.example, undefined);
  assert.ok(result.notes!.some(note => note.includes('authMount')));
});

test('merged with auth, the routes validate with core', async () => {
  const result = await scaffoldResult(), authResult = await auth.definition.scaffold!({ ...request });
  for (const file of authResult.files ?? []) if (file.content instanceof Uint8Array) file.content.fill(0);
  const document = validateDocument({
    version: '1',
    extensions: { auth: { version: '1', config: authResult.config }, admin: { version: '1', config: result.config } },
    routes: { ...authResult.routes, ...result.routes },
  });
  assert.equal(document.routes['/admin/*']?.extension, 'admin');
});

test('host() builds the console from auth\'s shared service and key, after auth and ui', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-admin-host-'));
  cleanup(t, () => rm(root, { recursive: true, force: true }));
  const service = await createAuthService({ database: join(root, 'auth.sqlite'), encryptionKey: randomBytes(32), roles: { member: [], admin: ['*'] }, defaultRole: 'member' });
  cleanup(t, () => service.close());
  const ui = fakeUi();
  const host = await withSha(t, () => composeHost(pathToFileURL(join(root, 'host.mjs')), [admin(), auth({ service, csrfKey: randomBytes(32) }), ui.definition()]));
  assert.deepEqual(host.extensions!.map(extension => extension.name), ['ui', 'auth', 'admin']);
  const registration = host.extensions![2]!;
  assert.equal(registration.projectSha256, sha);
  assert.equal(registration.schema, adminConfigSchema);
  // ui runs first and still receives both contributions.
  assert.equal(ui.seen.length, 1);
  assert.ok(ui.seen[0]!.includes(admin.definition.contributes!.ui));
  assert.ok(ui.seen[0]!.includes(auth.definition.contributes!.ui));
  await host.close!();
});

test('host() refuses without auth', async (t) => {
  await withSha(t, async () => {
    await assert.rejects(composeHost(pathToFileURL(join(tmpdir(), 'host.mjs')), [fakeUi().definition(), admin()]), /admin requires auth/);
  });
});
