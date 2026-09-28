import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCloudflare } from '../packages/core/src/build-cloudflare.ts';
import { createFetchHandler } from '../packages/core/src/cloudflare.ts';
import { startServer } from '../packages/core/src/server.ts';
import { project, request, param } from './helpers.ts';
import type { Artifact, Validators, BodyValidators } from '../packages/core/src/cloudflare.ts';

// Runs the built Worker artifact's fetch handler in Node (not workerd): it proves
// the artifact carries the body schema and the compiled uuid/pattern validators, and
// answers exactly as the self-hosted server does. It is not a real Worker run.
test('the built Worker artifact enforces body schemas and uuid/pattern parameters like the server', async t => {
  const uuid = '123e4567-e89b-42d3-a456-426614174000';
  const routes = {
    '/todos': { methods: ['POST'], request: { body: { POST: { format: 'json', contentTypes: ['application/json'], maxBytes: 4096,
      schema: { type: 'object', required: ['title'], additionalProperties: false, properties: { title: { type: 'string', minLength: 1, maxLength: 20 } } } } } }, respond: { status: 201, json: { ok: true } } },
    '/items/{id}': { parameters: [{ ...param('id'), schema: { type: 'string', format: 'uuid' } }], respond: { json: { ok: true } } },
    '/tags': { parameters: [{ ...param('slug', 'string', 'query'), required: true, schema: { type: 'string', pattern: '^[a-z0-9-]+$', maxLength: 8 } }], respond: { json: { ok: true } } },
  };
  const root = await project(t, routes);
  const out = await mkdtemp(join(tmpdir(), 'urlcode-cf-')); t.after(() => rm(out, { recursive: true, force: true }));
  await buildCloudflare(root, { out });
  const artifact = ((await import(pathToFileURL(join(out, 'artifact.js')).href)) as { default: Artifact }).default;
  const validators = (await import(pathToFileURL(join(out, 'validators.js')).href)) as Validators; const bodyValidators = (await import(pathToFileURL(join(out, 'body-validators.js')).href)) as BodyValidators;
  const worker = createFetchHandler(artifact, validators, bodyValidators);
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

// GET and POST on one path with their own body rules (#861): the build writes one standalone validator per route and
// method that declares a schema, the artifact maps each method to its export, and the Worker applies only that
// method's policy, exactly as the server does.
test('the built Worker artifact keys body validators per route and method', async t => {
  const schema = { type: 'object', required: ['title'], additionalProperties: false, properties: { title: { type: 'string', minLength: 1, maxLength: 20 } } };
  const routes = {
    '/requests': { methods: ['GET', 'POST'], request: { body: { GET: { maxBytes: 0 }, POST: { required: true, format: 'json', contentTypes: ['application/json'], maxBytes: 4096, schema } } }, respond: { json: { ok: true } } },
    '/notes': { methods: ['PUT', 'PATCH'], request: { body: { PUT: { format: 'json', schema: structuredClone(schema) }, PATCH: { format: 'json', schema: { type: 'object', maxProperties: 1 } } } }, respond: { json: { ok: true } } },
  };
  const root = await project(t, routes);
  const out = await mkdtemp(join(tmpdir(), 'urlcode-cf-')); t.after(() => rm(out, { recursive: true, force: true }));
  await buildCloudflare(root, { out });
  const artifact = ((await import(pathToFileURL(join(out, 'artifact.js')).href)) as { default: Artifact }).default;
  const byPattern = Object.fromEntries(artifact.routes.map(route => [route.pattern, route]));
  assert.deepEqual(byPattern['/requests']!.bodyValidators, { POST: 'b0' }, 'GET declares no schema, so it has no validator');
  assert.deepEqual(byPattern['/notes']!.bodyValidators, { PUT: 'b1', PATCH: 'b2' });
  const bodyValidators = (await import(pathToFileURL(join(out, 'body-validators.js')).href)) as BodyValidators;
  assert.deepEqual(Object.keys(bodyValidators).sort(), ['b0', 'b1', 'b2']);
  const worker = createFetchHandler(artifact, {}, bodyValidators);
  const app = await startServer({ project: root, port: 0, log: () => {} }); t.after(() => app.close());
  const headers = { 'content-type': 'application/json' };
  const cases: [string, string, string?][] = [
    ['/requests', 'GET'], ['/requests', 'POST'], ['/requests', 'POST', '{"title":"ok"}'], ['/requests', 'POST', '{"title":""}'],
    ['/notes', 'PUT', '{"title":"ok"}'], ['/notes', 'PUT', '{"a":1}'], ['/notes', 'PATCH', '{"a":1}'], ['/notes', 'PATCH', '{"a":1,"b":2}'],
  ];
  const statuses: number[] = [];
  for (const [path, method, body] of cases) {
    const local = await request(app, path, { method, headers, body });
    const remote = await worker(new Request('https://example.com' + path, { method, headers, ...(body ? { body } : {}) }));
    assert.equal(remote.status, local.status, `${method} ${path} ${body ?? ''}`);
    if (local.status === 422) assert.equal(await remote.text(), local.body);
    statuses.push(remote.status);
  }
  assert.deepEqual(statuses, [200, 400, 200, 422, 200, 422, 200, 422]);
  // A GET body is refused by its declared length before a byte is read (a Web Request cannot carry a GET body itself).
  const local = await request(app, '/requests', { method: 'GET', headers: { ...headers, 'content-length': '2' }, body: '{}' });
  const remote = await worker(new Request('https://example.com/requests', { method: 'GET', headers: { ...headers, 'content-length': '2' } }));
  assert.deepEqual([remote.status, local.status], [413, 413]);
  assert.throws(() => createFetchHandler({ ...artifact, routes: artifact.routes.map(route => route.pattern === '/notes' ? { ...route, bodyValidators: { PUT: 'b1' } } : route) }, {}, bodyValidators),
    /missing the request\.body\.PATCH\.schema validator for \/notes/);
});
