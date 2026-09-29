import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCloudflare } from '../packages/core/src/build-cloudflare.ts';
import { createFetchHandler } from '../packages/core/src/cloudflare.ts';
import { loadDocument } from '../packages/core/src/config.ts';
import { compileRoutes } from '../packages/core/src/router.ts';
import { startServer } from '../packages/core/src/server.ts';
import { bodySchemaFormatMaxLength } from '../packages/core/src/body-formats.ts';
import { project, request } from './helpers.ts';
import type { Artifact, Validators, BodyValidators } from '../packages/core/src/cloudflare.ts';

// Parameter schemas take the body schema's standard formats, checked by the same core-owned functions (#881 item 9).
// Each format gets one accepted and one refused value, as a query and as a path parameter, answered by the
// self-hosted server and by the built Worker artifact's fetch handler run in Node (workerd itself is
// scripts/workerd-parity.ts).
const samples: Record<keyof typeof bodySchemaFormatMaxLength, [ok: string, bad: string]> = {
  uuid: ['123e4567-e89b-42d3-a456-426614174000', 'not-a-uuid'],
  date: ['2024-02-29', '2023-02-29'],
  time: ['08:30:06+01:00', '24:00:00Z'],
  'date-time': ['2024-02-29T08:30:06.25Z', '2024-02-29 08:30:06Z'],
  email: ['a.b@example.com', 'a@@example.com'],
  uri: ['urn:isbn:0451450523', 'no-scheme'],
  hostname: ['api.example.com', '-bad.example'],
  ipv4: ['192.0.2.1', '256.0.0.1'],
  ipv6: ['2001:db8::1', '2001:db8:::1'],
};

test('every body-schema format is a parameter format too', () => {
  assert.deepEqual(Object.keys(samples).sort(), Object.keys(bodySchemaFormatMaxLength).sort());
});

test('query and path parameter formats accept and refuse alike on the server and the built Worker artifact', async t => {
  const routes: Record<string, object> = {};
  for (const format of Object.keys(samples)) {
    routes[`/q/${format}`] = { parameters: [{ name: 'v', in: 'query', required: true, schema: { type: 'string', format } }], respond: { json: { ok: true } } };
    routes[`/p/${format}/{v}`] = { parameters: [{ name: 'v', in: 'path', required: true, schema: { type: 'string', format } }], respond: { json: { ok: true } } };
  }
  const root = await project(t, routes);
  const out = await mkdtemp(join(tmpdir(), 'urlcode-cf-')); t.after(() => rm(out, { recursive: true, force: true }));
  await buildCloudflare(root, { out });
  const artifact = ((await import(pathToFileURL(join(out, 'artifact.js')).href)) as { default: Artifact }).default;
  const validators = (await import(pathToFileURL(join(out, 'validators.js')).href)) as Validators;
  const bodyValidators = (await import(pathToFileURL(join(out, 'body-validators.js')).href)) as BodyValidators;
  const worker = createFetchHandler(artifact, validators, bodyValidators);
  const app = await startServer({ project: root, port: 0, log: () => {} }); t.after(() => app.close());
  for (const [format, [ok, bad]] of Object.entries(samples)) {
    for (const [value, expected] of [[ok, 200], [bad, 400]] as const) {
      for (const path of [`/q/${format}?v=${encodeURIComponent(value)}`, `/p/${format}/${encodeURIComponent(value)}`]) {
        const local = await request(app, path);
        const remote = await worker(new Request('https://example.com' + path));
        assert.equal(local.status, expected, `server ${path}`);
        assert.equal(remote.status, expected, `worker ${path}`);
      }
    }
  }
  // The published cap applies before the check runs: a well-formed uri one character over 2048 fails.
  const long = 'https://a.example/' + 'a'.repeat(bodySchemaFormatMaxLength.uri - 17);
  assert.equal(long.length, bodySchemaFormatMaxLength.uri + 1);
  for (const [value, expected] of [[long.slice(0, -1), 200], [long, 400]] as const) {
    const path = `/q/uri?v=${encodeURIComponent(value)}`;
    assert.equal((await request(app, path)).status, expected, `server uri length ${value.length}`);
    assert.equal((await worker(new Request('https://example.com' + path))).status, expected, `worker uri length ${value.length}`);
  }
});

test('a parameter format outside the list fails at load, naming the supported ones', async t => {
  const root = await project(t, { '/x': { parameters: [{ name: 'v', in: 'query', schema: { type: 'string', format: 'idn-email' } }], respond: { json: {} } } });
  const loaded = await loadDocument(root).catch((error: unknown) => error);
  const failure = loaded instanceof Error ? loaded : await compileRoutes(loaded as Awaited<ReturnType<typeof loadDocument>>, {}).then(() => undefined, (error: unknown) => error);
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /format.*"uuid", "date", "time", "date-time", "email", "uri", "hostname", "ipv4", "ipv6"/);
});
