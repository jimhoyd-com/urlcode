import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCloudflare } from '../src/build-cloudflare.ts';
import { createFetchHandler } from '../src/cloudflare.ts';
import { startServer } from '../src/server.ts';
import { project, request, param } from './helpers.ts';
import type { Artifact, Validators } from '../src/cloudflare.ts';

// Runs the built Worker artifact's fetch handler in Node (not workerd): it proves
// the artifact carries the body schema and the compiled uuid/pattern validators, and
// answers exactly as the self-hosted server does. It is not a real Worker run.
test('the built Worker artifact enforces body schemas and uuid/pattern parameters like the server', async t => {
  const uuid = '123e4567-e89b-42d3-a456-426614174000';
  const routes = {
    '/todos': { methods: ['POST'], request: { body: { format: 'json', contentTypes: ['application/json'], maxBytes: 4096,
      schema: { type: 'object', required: ['title'], additionalProperties: false, properties: { title: { type: 'string', minLength: 1, maxLength: 20 } } } } }, respond: { status: 201, json: { ok: true } } },
    '/items/{id}': { parameters: [{ ...param('id'), schema: { type: 'string', format: 'uuid' } }], respond: { json: { ok: true } } },
    '/tags': { parameters: [{ ...param('slug', 'string', 'query'), required: true, schema: { type: 'string', pattern: '^[a-z0-9-]+$', maxLength: 8 } }], respond: { json: { ok: true } } },
  };
  const root = await project(t, routes);
  const out = await mkdtemp(join(tmpdir(), 'urlcode-cf-')); t.after(() => rm(out, { recursive: true, force: true }));
  await buildCloudflare(root, { out });
  const artifact = ((await import(pathToFileURL(join(out, 'artifact.js')).href)) as { default: Artifact }).default;
  const validators = (await import(pathToFileURL(join(out, 'validators.js')).href)) as Validators;
  const worker = createFetchHandler(artifact, validators);
  const app = await startServer({ project: root, port: 0, log: () => {} }); t.after(() => app.close());
  const headers = { 'content-type': 'application/json' };
  const cases: [string, string, string?][] = [
    ['/todos', 'POST', '{"title":"ok"}'], ['/todos', 'POST', '{"title":5}'], ['/todos', 'POST', '{"title":"' + 'x'.repeat(30) + '"}'], ['/todos', 'POST', '{bad'],
    [`/items/${uuid}`, 'GET'], ['/items/not-a-uuid', 'GET'], ['/tags?slug=ok-1', 'GET'], ['/tags?slug=Bad_1', 'GET'], ['/tags?slug=aaaaaaaaa', 'GET'],
  ];
  const statuses: number[] = [];
  for (const [path, method, body] of cases) {
    const local = await request(app, path, { method, headers, body });
    const remote = await worker(new Request('https://example.com' + path, { method, headers, ...(body ? { body } : {}) }));
    assert.equal(remote.status, local.status, `${method} ${path} ${body ?? ''}`);
    if (local.status === 422) assert.equal(await remote.text(), local.body);
    statuses.push(remote.status);
  }
  assert.deepEqual(statuses, [201, 422, 422, 400, 200, 400, 200, 400, 400]);
});
