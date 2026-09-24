import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateProject } from '@jimhoyd/urlcode';
import { defineExtension } from '@jimhoyd/urlcode/extensions';
import type { ScaffoldResult } from '@jimhoyd/urlcode/extensions';
import { composeHost } from '@jimhoyd/urlcode/host';
import auth from '../src/extension.ts';
import type { AuthExports } from '../src/extension.ts';
import { authConfigSchema } from '../src/auth.ts';
import { authUiTemplates } from '../src/auth-templates.ts';
import { englishCatalogue } from '../src/presentation.ts';
import { createAuthService } from '../src/index.ts';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const request = { site: '/srv/site', project: '/srv/site/app', installed: ['auth', 'ui'], acknowledgements: [] };
const sha = 'a'.repeat(64);

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
  assert.ok(auth.definition.scaffold);
  return await auth.definition.scaffold(request);
}

/** Writes a scaffold's files into `site` with their modes, as core's installer does. */
async function writeFiles(site: string, result: ScaffoldResult): Promise<void> {
  for (const file of result.files ?? []) {
    await mkdir(dirname(join(site, file.path)), { recursive: true });
    await writeFile(join(site, file.path), file.content, { mode: file.mode ?? 0o644 });
  }
}

function withSha<T>(t: { after(fn: () => void): void }, value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.PROJECT_SHA256;
  if (value === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = value;
  t.after(() => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
  return run();
}

test('the definition declares ui as a requirement, its runtime schema and its ui contributions', async () => {
  const definition = auth.definition;
  assert.equal(definition.name, 'auth');
  assert.deepEqual(definition.requires, ['ui']);
  assert.equal(definition.schema, authConfigSchema);
  const manifest = JSON.parse(await readFile(join(packageRoot, 'urlcode.json'), 'utf8')) as Record<string, unknown>;
  // urlcode.json is generated from this definition (npm run build:addons); CI fails if it drifts.
  assert.deepEqual({ kind: manifest.kind, name: manifest.name, description: manifest.description, requires: manifest.requires, schema: manifest.schema }, { kind: 'extension', name: 'auth', description: definition.description, requires: ['ui'], schema: JSON.parse(JSON.stringify(authConfigSchema)) });
  const ui = definition.contributes?.ui as { sources: unknown[]; templates: unknown[] };
  assert.deepEqual(ui.sources, [englishCatalogue]);
  assert.deepEqual(ui.templates, [authUiTemplates]);
});

test('scaffold returns config, routes, private operator files, env and notes', async () => {
  const result = await scaffoldResult();
  assert.deepEqual(Object.keys(result).sort(), ['config', 'env', 'files', 'notes', 'routes']);
  assert.deepEqual(result.config, { registration: 'off' });
  assert.deepEqual(result.routes, {
    '/account/*': { extension: 'auth', methods: ['GET', 'HEAD', 'POST'] },
    '/private': { respond: { text: 'Signed in' }, auth: true },
  });
  assert.deepEqual(result.files!.map(file => file.path).sort(), ['data/csrf.key', 'data/encryption.key', 'operator-service.mjs']);
  for (const file of result.files!) {
    assert.equal(file.mode, 0o600, file.path);
    assert.ok(!file.path.startsWith('/') && !file.path.includes('..') && !file.path.startsWith('app/') && !file.path.startsWith('node_modules/'));
  }
  const operator = result.files!.find(file => file.path === 'operator-service.mjs')!.content as string;
  assert.ok(operator.includes("import {createAuthService} from '@jimhoyd/urlcode-auth';"));
  assert.ok(!operator.includes('loadExtensionBundle'));
  assert.ok(operator.includes("'./data/encryption.key'") && operator.includes("'./data/auth.sqlite'"));
  assert.ok(result.env && 'AUTH_ORIGIN' in result.env && 'AUTH_CONFIG_FROM' in result.env);
  assert.ok(result.notes!.some(note => note.includes('npx urlcode-auth bootstrap --operator-file "$PWD/operator-service.mjs"')));
});

test('scaffold routes merged into a version 1 project validate with core', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-scaffold-'));
  cleanup(t, () => rm(root, { recursive: true, force: true }));
  const result = await scaffoldResult();
  await writeFile(join(root, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { auth: { version: '1', config: result.config } }, routes: result.routes }));
  const report = await validateProject(root);
  assert.equal(report.valid, true);
  assert.equal(report.routeCount, 2);
});

test('each scaffold creates fresh 32-byte keys that never appear in config, notes, env or source', async () => {
  const first = await scaffoldResult(), second = await scaffoldResult();
  const keys = (result: ScaffoldResult) => ['data/encryption.key', 'data/csrf.key'].map(path => result.files!.find(file => file.path === path)!.content);
  const [encryption, csrf] = keys(first), [encryption2, csrf2] = keys(second);
  for (const key of [encryption, csrf, encryption2, csrf2]) { assert.ok(key instanceof Uint8Array); assert.equal(key.length, 32); }
  assert.notDeepEqual(encryption, csrf);
  assert.notDeepEqual(encryption, encryption2);
  assert.notDeepEqual(csrf, csrf2);
  const text = [JSON.stringify(first.config), JSON.stringify(first.routes), JSON.stringify(first.env), ...first.notes!, ...first.files!.filter(file => typeof file.content === 'string').map(file => file.content as string)].join('\n');
  for (const key of [encryption, csrf] as Uint8Array[])
    for (const encoding of ['hex', 'base64', 'base64url', 'latin1'] as const)
      assert.ok(!text.includes(Buffer.from(key).toString(encoding)));
});

test('host() loads the scaffolded operator service and CSRF key, and shares them with dependants', async (t) => {
  // Inside the package, so the operator module's `@jimhoyd/urlcode-auth` import resolves (to this package's dist).
  const site = await mkdtemp(join(packageRoot, '.test-site-'));
  cleanup(t, () => rm(site, { recursive: true, force: true }));
  const result = await scaffoldResult();
  const csrfBytes = Buffer.from(result.files!.find(file => file.path === 'data/csrf.key')!.content as Uint8Array);
  await writeFiles(site, result);
  const ui = fakeUi();
  let shared: AuthExports | undefined;
  const reader = defineExtension({
    name: 'reader', description: 'Reads auth', requires: ['auth'], schema: { type: 'object' },
    host(ctx) {
      shared = ctx.get<AuthExports>('auth');
      return { registration: { name: 'reader', version: '1', projectSha256: ctx.projectSha256, targets: ['node'], schema: { type: 'object' }, activate: () => ({ handle: () => ({ status: 404, headers: [] }) }) } };
    },
  });
  const host = await withSha(t, sha, () => composeHost(pathToFileURL(join(site, 'host.mjs')), [reader(), auth(), ui.definition()]));
  assert.deepEqual(host.extensions!.map(extension => extension.name), ['ui', 'auth', 'reader']);
  const registration = host.extensions![1]!;
  assert.equal(registration.projectSha256, sha);
  assert.equal(registration.schema, authConfigSchema);
  // ui ran first and still received auth's contribution.
  assert.deepEqual(ui.seen, [[auth.definition.contributes!.ui]]);
  assert.ok(shared);
  assert.deepEqual(Buffer.from(shared.csrfKey), csrfBytes);
  assert.deepEqual((await shared.service.listUsers({ limit: 10 })).users, []);
  await host.close!();
  assert.ok(shared.csrfKey.every(byte => byte === 0), 'close zeroes the CSRF key it read');
});

test('host() uses an operator-supplied service and key, and leaves them open on close', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-host-'));
  cleanup(t, () => rm(root, { recursive: true, force: true }));
  const service = await createAuthService({ database: join(root, 'auth.sqlite'), encryptionKey: randomBytes(32), roles: { member: [], admin: ['*'] }, defaultRole: 'member' });
  cleanup(t, () => service.close());
  const csrfKey = randomBytes(32), copy = Buffer.from(csrfKey);
  const host = await withSha(t, sha, () => composeHost(pathToFileURL(join(root, 'host.mjs')), [fakeUi().definition(), auth({ service, csrfKey })]));
  assert.deepEqual(host.extensions!.map(extension => extension.name), ['ui', 'auth']);
  await host.close!();
  assert.deepEqual(csrfKey, copy);
  assert.deepEqual((await service.listUsers({ limit: 10 })).users, []);
});

test('host() refuses a CSRF key that is not 32 bytes, a missing ui and a missing PROJECT_SHA256', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-host-'));
  cleanup(t, () => rm(root, { recursive: true, force: true }));
  const service = await createAuthService({ database: join(root, 'auth.sqlite'), encryptionKey: randomBytes(32), roles: { member: [], admin: ['*'] }, defaultRole: 'member' });
  cleanup(t, () => service.close());
  const hostUrl = pathToFileURL(join(root, 'host.mjs'));
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'data/csrf.key'), randomBytes(16));
  await withSha(t, sha, async () => {
    await assert.rejects(composeHost(hostUrl, [fakeUi().definition(), auth({ service })]), /32 bytes/);
    await assert.rejects(composeHost(hostUrl, [auth({ service, csrfKey: randomBytes(32) })]), /auth requires ui/);
  });
  await withSha(t, undefined, () => assert.rejects(composeHost(hostUrl, [fakeUi().definition(), auth({ service, csrfKey: randomBytes(32) })]), /PROJECT_SHA256/));
});
