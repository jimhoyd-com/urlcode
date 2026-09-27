// The README's short-link example (#822) is executable documentation: its YAML, taken verbatim from "Short links",
// activates the store and answers the redirect it describes, counting a GET and not a HEAD.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseYaml } from '@jimhoyd/urlcode';
import type { ExtensionActivation, ExtensionRequest } from '@jimhoyd/urlcode/extensions';
import { createStore } from '../src/store.ts';

const heading = '## Short links';

function request(method: string, path: string, mount: string): ExtensionRequest {
  return { method, target: path, path, query: new URLSearchParams(), headers: new Headers(), headerCounts: {}, body: new Uint8Array(), origin: 'https://links.example.test', route: `${mount}/*`, mount, client: null, requestId: 'readme', principal: null } as unknown as ExtensionRequest;
}

test('the README short-link YAML activates and redirects as described', async t => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const start = readme.indexOf(heading);
  assert.ok(start >= 0, 'the README keeps the short-link section');
  const section = readme.slice(start, readme.indexOf('\n## ', start + heading.length));
  const yaml = /```yaml\n([\s\S]*?)\n```/.exec(section)?.[1];
  assert.ok(yaml, 'the section has a yaml block');
  const document = parseYaml(yaml) as { extensions: { store: { config: Record<string, unknown> } }; routes: Record<string, { extension?: string }> };
  const mounts = Object.entries(document.routes).filter(([, route]) => route.extension === 'store').map(([path]) => path.replace(/\/\*$/, ''));
  assert.deepEqual(mounts.sort(), ['/api/links', '/go']);

  const root = await mkdtemp(join(tmpdir(), 'store-readme-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createStore({ directory: join(root, 'data'), projectSha256: 'a'.repeat(64) });
  const context = { origin: 'https://links.example.test', target: 'node', projectSha256: 'a'.repeat(64), mounts, root: join(root, 'app'), principalMounts: ['/api/links'] } as unknown as ExtensionActivation;
  const instance = await store.registration.activate(document.extensions.store.config, context);
  t.after(async () => { await instance.close?.(); await store.close(); });

  const links = store.exports.records('links');
  const { record } = await links.create(null, { code: 'docs', destination: 'https://example.test/docs' });
  const head = await instance.handle(request('HEAD', '/go/docs', '/go'));
  assert.equal(head.status, 302);
  assert.equal(links.get(null, String(record.id)).record.clicks, 0, 'HEAD does not count');
  const hit = await instance.handle(request('GET', '/go/docs', '/go'));
  assert.equal(hit.status, 302);
  assert.equal(new Map(hit.headers ?? []).get('location'), 'https://example.test/docs');
  assert.equal(links.get(null, String(record.id)).record.clicks, 1, 'GET counts the click');
  assert.equal((await instance.handle(request('GET', '/go/missing', '/go'))).status, 404);
});
