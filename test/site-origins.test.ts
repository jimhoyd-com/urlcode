import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../packages/core/src/errors.ts';
import { isSiteOrigin, maxAliasOrigins, siteOrigins } from '../packages/core/src/site-origins.ts';
import { createRuntime } from '../packages/core/src/runtime.ts';
import { prepareFunctionSnapshot } from '../packages/core/src/policy.ts';
import { loadDocument } from '../packages/core/src/config.ts';
import { loopbackHostCheck } from '../packages/core/src/client-address.ts';
import { resolveAliasOrigins } from '../packages/core/src/adapters.ts';
import type { ExtensionActivation, RuntimeExtension } from '../packages/core/src/extensions.ts';
import { project } from './helpers.ts';

const cli = fileURLToPath(new URL('../packages/core/src/cli.ts', import.meta.url));
const canonical = 'https://site.example';

test('alias origins are validated, serialized and deduplicated after the canonical origin', () => {
  assert.deepEqual(siteOrigins(canonical, undefined), [canonical]);
  assert.deepEqual(siteOrigins(undefined, []), []);
  assert.deepEqual(siteOrigins(canonical, [
    'https://www.site.example', 'https://WWW.Site.Example:443/', 'https://site.example', 'https://site.example:8443',
    'http://localhost:3000', 'http://127.0.0.1:8080', 'http://[::1]:3000', 'https://xn--bcher-kva.example',
  ]), [canonical, 'https://www.site.example', 'https://site.example:8443', 'http://localhost:3000', 'http://127.0.0.1:8080', 'http://[::1]:3000', 'https://xn--bcher-kva.example']);
});

test('invalid alias origins are refused with a ConfigError that names the entry', () => {
  const refused: [string, RegExp][] = [
    ['http://www.site.example', /must use https:/],
    ['ftp://site.example', /must use https:/],
    ['https://*.site.example', /wildcard/],
    ['*', /wildcard/],
    ['https://site.example/path', /no path, query, fragment or credentials/],
    ['https://site.example?x=1', /no path, query, fragment or credentials/],
    ['https://site.example#frag', /no path, query, fragment or credentials/],
    ['https://user:pass@site.example', /no path, query, fragment or credentials/],
    ['site.example', /not an absolute URL/],
    ['', /non-empty origin string/],
  ];
  for (const [entry, message] of refused) {
    assert.throws(() => siteOrigins(canonical, [entry]), (error: unknown) => error instanceof ConfigError && message.test(error.message) && error.details.code === 'invalid-alias-origin', entry);
  }
  assert.throws(() => siteOrigins(undefined, ['https://www.site.example']), /need a canonical origin; pass --origin/);
});

test('at most 16 alias origins are accepted', () => {
  const list = (count: number) => Array.from({ length: count }, (_, index) => `https://a${index}.site.example`);
  assert.equal(maxAliasOrigins, 16);
  assert.equal(siteOrigins(canonical, list(16)).length, 17);
  assert.throws(() => siteOrigins(canonical, list(17)), /At most 16 alias origins are allowed; got 17/);
});

test('isSiteOrigin matches a bare origin exactly against the list, normalizing case and default ports', () => {
  const context = { origin: canonical, origins: [canonical, 'https://www.site.example', 'https://site.example:8443'] };
  for (const value of [canonical, 'https://www.site.example', 'https://WWW.SITE.EXAMPLE', 'https://site.example:443', 'HTTPS://site.example', 'https://site.example:8443', 'https://site.example/'])
    assert.equal(isSiteOrigin(context, value), true, value);
  for (const value of [null, undefined, '', 'null', 'https://evil.example', 'http://site.example', 'https://api.site.example', 'https://site.example:8444',
    'https://site.example.evil.example', 'https://site.example/path', 'https://user@site.example', 'site.example', ' https://site.example'])
    assert.equal(isSiteOrigin(context, value), false, String(value));
  // An activation built without the list (a hand-built test context) means the canonical origin alone.
  assert.equal(isSiteOrigin({ origin: canonical }, canonical), true);
  assert.equal(isSiteOrigin({ origin: canonical }, 'https://www.site.example'), false);
});

async function extensionProject(t: test.TestContext) {
  const root = await project(t, { '/ext/*': { extension: 'probe' } }, {}, { extensions: { probe: { version: '1', config: {} } } });
  const projectSha256 = (await prepareFunctionSnapshot(await loadDocument(root))).projectSha256;
  const seen: ExtensionActivation[] = [];
  const probe: RuntimeExtension = { name: 'probe', version: '1', projectSha256, targets: ['node'], schema: { type: 'object', additionalProperties: false },
    activate(_config, context) { seen.push(context); return { handle: () => ({ status: 204, headers: [] }) }; } };
  return { root, probe, seen };
}

test('the runtime refuses invalid alias origins before activation and hands the valid list to every extension', async t => {
  const { root, probe, seen } = await extensionProject(t);
  await assert.rejects(createRuntime(root, { origin: canonical, aliasOrigins: ['http://www.site.example'], extensions: [probe], log: () => {} }), ConfigError);
  await assert.rejects(createRuntime(root, { aliasOrigins: ['https://www.site.example'], extensions: [probe], log: () => {} }), /need a canonical origin/);
  assert.equal(seen.length, 0, 'no extension activates when the operator list is invalid');
  const runtime = await createRuntime(root, { origin: canonical, aliasOrigins: ['https://www.site.example', 'https://WWW.site.example'], extensions: [probe], log: () => {} });
  t.after(() => runtime.close());
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.origin, canonical, 'origin stays the canonical origin');
  assert.deepEqual(seen[0]!.origins, [canonical, 'https://www.site.example']);
  assert.ok(Object.isFrozen(seen[0]!.origins));
  const plain = await extensionProject(t);
  const second = await createRuntime(plain.root, { origin: canonical, extensions: [plain.probe], log: () => {} });
  t.after(() => second.close());
  assert.deepEqual(plain.seen[0]!.origins, [canonical], 'without aliases the list is the canonical origin alone');
});

test('a loopback bind also admits the authority of each alias origin', () => {
  const check = loopbackHostCheck({ address: '127.0.0.1', port: 3000 }, [canonical, 'https://www.site.example', 'http://localhost:4000'])!;
  const admits = (host: string) => check(['Host', host], '/');
  for (const host of ['site.example', 'www.site.example', 'www.site.example:443', 'localhost:4000', 'localhost:3000']) assert.equal(admits(host), true, host);
  for (const host of ['evil.example', 'api.site.example', 'www.site.example:8443']) assert.equal(admits(host), false, host);
});

test('hosted adapters read URLCODE_ALIAS_ORIGINS as a comma-separated list; the handler option wins', () => {
  assert.equal(resolveAliasOrigins(undefined, {}), undefined);
  assert.deepEqual(resolveAliasOrigins(undefined, { URLCODE_ALIAS_ORIGINS: ' https://a.example , https://b.example,' }), ['https://a.example', 'https://b.example']);
  assert.deepEqual(resolveAliasOrigins(['https://c.example'], { URLCODE_ALIAS_ORIGINS: 'https://a.example' }), ['https://c.example']);
});

test('the CLI accepts a repeatable --alias-origin on validate and refuses it on other commands', async t => {
  const root = await project(t, { '/hello': { respond: { text: 'hi' } } });
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20000 });
  const ok = run('validate', '--project', root, '--origin', canonical, '--alias-origin', 'https://www.site.example', '--alias-origin', 'https://site.example:8443');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /"event":"valid"/);
  const invalid = run('validate', '--project', root, '--origin', canonical, '--alias-origin', 'https://site.example/path');
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr + invalid.stdout, /no path, query, fragment or credentials/);
  const orphan = run('validate', '--project', root, '--alias-origin', 'https://www.site.example');
  assert.notEqual(orphan.status, 0);
  assert.match(orphan.stderr + orphan.stdout, /pass --origin/);
  const elsewhere = run('permissions', '--project', root, '--alias-origin', 'https://www.site.example');
  assert.notEqual(elsewhere.status, 0);
  assert.match(elsewhere.stderr + elsewhere.stdout, /--alias-origin is only supported by dev\/serve\/validate\/test\/routes\/audit\/benchmark/);
});
