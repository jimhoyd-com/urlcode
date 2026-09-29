// jimhoyd-com/urlcode#930, RIM-EXT-HERMETIC-001: a check run composes the operator host on a fresh, empty data
// directory, and `tests/seed.json` reaches only a registration built for one, on the run's first activation only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { project } from './helpers.ts';
import { loadOperatorHost } from '../packages/core/src/operator-host.ts';
import { runProjectTests, startRestartable } from '../packages/core/src/project-tests.ts';
import { inspectExtensionRevision } from '../packages/core/src/extensions.ts';
import type { ExtensionActivation, RuntimeExtension } from '../packages/core/src/extensions.ts';

const origin = 'https://hermetic.example.test';
const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);
const declarations = { extensions: { vault: { version: '1', config: {} } } };
const routes = { '/vault/*': { extension: 'vault', methods: ['GET'] } };
interface Seen { data: string; hermetic: boolean; site: string }
const seen = (): Seen[] => ((globalThis as Record<string, unknown>).__hermeticSeen ??= []) as Seen[];
const seeds = (): unknown[] => ((globalThis as Record<string, unknown>).__hermeticSeeds ??= []) as unknown[];

/** A site directory holding a host.mjs whose one synthetic extension records what the host gave it. */
async function site(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'urlcode-hermetic-site-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const core = (file: string) => JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'packages', 'core', 'src', file)).href);
  await writeFile(join(dir, 'host.mjs'), `import { composeHost } from ${core('host.ts')};
import { defineExtension } from ${core('extensions.ts')};
const schema = { type: 'object', additionalProperties: false };
const vault = defineExtension({ name: 'vault', description: 'Synthetic vault', contract: 1, targets: ['node'], schema, host(ctx) {
  globalThis.__hermeticSeen.push({ data: ctx.data, hermetic: ctx.hermetic, site: ctx.site });
  return { registration: { name: 'vault', version: '1', projectSha256: ctx.projectSha256, targets: ['node'], schema,
    ...(ctx.hermetic ? { seedSchema: { type: 'object', additionalProperties: false, required: ['greeting'], properties: { greeting: { type: 'string' } } } } : {}),
    activate(_config, activation) {
      globalThis.__hermeticSeeds.push(activation.seed);
      return { handle: () => ({ status: 200, headers: [['content-type', 'application/json']], body: JSON.stringify({ seed: activation.seed ?? null }) }) };
    } } };
} });
export default await composeHost(import.meta.url, [vault()]);
`);
  return dir;
}
function pinned(t: TestContext, revision: string): void {
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = revision;
  t.after(() => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
}

test('a hermetic load composes on a fresh data directory every time and removes it on close', async t => {
  seen().length = 0;
  const app = await project(t, routes, {}, declarations), dir = await site(t);
  pinned(t, await inspectExtensionRevision(app));
  const serving = await loadOperatorHost(join(dir, 'host.mjs'), app);
  const first = await loadOperatorHost(join(dir, 'host.mjs'), app, { hermetic: true });
  const second = await loadOperatorHost(join(dir, 'host.mjs'), app, { hermetic: true });
  const [live, one, two] = seen();
  assert.equal(seen().length, 3, 'each hermetic load runs host.mjs again');
  assert.deepEqual([live!.data, live!.hermetic], [join(live!.site, 'data'), false]);
  assert.equal(one!.hermetic && two!.hermetic, true);
  assert.notEqual(one!.data, two!.data);
  for (const { data } of [one!, two!]) { assert.ok(!data.startsWith(live!.site), 'never inside the site'); assert.equal(await exists(data), true); }
  await first.close!(); await second.close!(); await serving.close?.();
  assert.deepEqual([await exists(one!.data), await exists(two!.data), await exists(join(dir, 'data'))], [false, false, false]);
});

test('the seed reaches the first activation only, never after a restart step', async t => {
  seeds().length = 0;
  const fixtures = [{ steps: [
    { path: '/vault/x', status: 200, expectJson: { '/seed/greeting': 'hi' } },
    { restart: true },
    { path: '/vault/x', status: 200, expectJson: { '/seed': null } },
  ] }];
  const app = await project(t, routes, { 'tests/requests.json': JSON.stringify(fixtures), 'tests/seed.json': JSON.stringify({ vault: { greeting: 'hi' } }) }, declarations);
  const dir = await site(t);
  pinned(t, await inspectExtensionRevision(app));
  for (let run = 0; run < 2; run++) {
    const host = await loadOperatorHost(join(dir, 'host.mjs'), app, { hermetic: true });
    try { assert.deepEqual(await runProjectTests(app, { origin, extensions: host.extensions, log: () => {} }), { total: 2, failed: 0 }); }
    finally { await host.close!(); }
  }
  assert.deepEqual(seeds(), [{ greeting: 'hi' }, undefined, { greeting: 'hi' }, undefined]);
});

test('a seed is refused for an unknown extension, one that accepts none, and one that does not match its schema', async t => {
  const registration = async (app: string, seedSchema?: object): Promise<RuntimeExtension> => ({
    name: 'vault', version: '1', projectSha256: await inspectExtensionRevision(app), targets: ['node'], schema: { type: 'object', additionalProperties: false },
    ...(seedSchema ? { seedSchema } : {}), activate: (_config: unknown, _activation: ExtensionActivation) => ({ handle: () => ({ status: 200, headers: [] }) }),
  });
  const cases: [Record<string, unknown>, object | undefined, RegExp][] = [
    [{ other: {} }, { type: 'object' }, /tests\/seed\.json seeds other, which is not a declared extension this host registers/],
    [{ vault: {} }, undefined, /tests\/seed\.json seeds vault, whose registration accepts no seed.*hermetic run/],
    [{ vault: { greeting: 1 } }, { type: 'object', properties: { greeting: { type: 'string' } } }, /tests\/seed\.json vault\.greeting: must be string/],
  ];
  for (const [seed, schema, message] of cases) {
    const app = await project(t, routes, { 'tests/seed.json': JSON.stringify(seed) }, declarations);
    await assert.rejects(startRestartable({ project: app, port: 0, origin, log: () => {}, extensions: [await registration(app, schema)] }), message);
  }
  const malformed = await project(t, routes, { 'tests/seed.json': '[]' }, declarations);
  await assert.rejects(startRestartable({ project: malformed, port: 0, origin, log: () => {} }), /must be an object keyed by extension name/);
});
