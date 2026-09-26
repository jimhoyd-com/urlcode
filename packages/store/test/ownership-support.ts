import { cleanup } from './cleanup.ts';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import type { ExtensionRequest, RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { storeExtension } from '../src/index.ts';

// urlcode#331: per-record ownership. The principal provider here is a synthetic "badge" extension, not auth, so the
// store is proven against core's generic principal contract rather than one first-party pair: `Badge <id>` sets the
// principal, `Badge-anon` is allowed without one, anything else is a 401 from the provider itself.
const origin = 'https://owned.example.test';
export const json = { 'content-type': 'application/json' };
export const notes = { mount: '/api/notes', fields: { title: { type: 'string', required: true, maxLength: 40 }, votes: { type: 'integer', default: 0 } }, increments: ['votes'], idempotency: { maxKeys: 10 }, maxRecords: 50, ownership: 'owner' };

async function badge(project: string, provides = true): Promise<RuntimeExtension> {
  return {
    name: 'badge', version: '1', projectSha256: await inspectExtensionRevision(project), targets: ['node'], ...(provides ? { providesPrincipal: true } : {}),
    schema: { type: 'object', additionalProperties: false }, policySchema: { type: 'object', additionalProperties: false },
    activate() {
      return {
        handle() { return { status: 404, headers: [] }; },
        authorize(_policy: unknown, request: ExtensionRequest) {
          const value = request.headers.get('authorization') ?? '';
          if (value === 'Badge-anon') return undefined;
          const match = /^Badge (\S+)$/.exec(value);
          if (!match) return { status: 401, headers: [['content-type', 'text/plain']], body: 'no badge' };
          request.setPrincipal!({ id: match[1]! });
          return undefined;
        },
      };
    },
  };
}

interface Boot { collection?: object; policy?: object | null; provides?: boolean; seed?: object[]; extraCollections?: Record<string, object>; extraRoutes?: Record<string, unknown> }
export async function boot(t: TestContext, options: Boot = {}) {
  const root = await mkdtemp(join(tmpdir(), 'store-owned-'));
  cleanup(t, () => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app'), data = join(root, 'data');
  await mkdir(project); await mkdir(data);
  if (options.seed) await writeFile(join(data, 'notes.json'), JSON.stringify({ version: 2, records: options.seed, idempotency: [] }));
  const policy = options.policy === undefined ? { policies: { extensions: { badge: {} } } } : options.policy === null ? {} : options.policy;
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1',
    extensions: { badge: { version: '1', config: {} }, store: { version: '1', config: { collections: { notes: options.collection ?? notes, ...options.extraCollections } } } },
    routes: { '/api/notes/*': { extension: 'store', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], ...policy }, ...options.extraRoutes } }));
  const projectSha256 = await inspectExtensionRevision(project);
  const start = async () => startServer({ project, origin, port: 0, log: () => {}, extensions: [await badge(project, options.provides ?? true), storeExtension({ directory: data, projectSha256 })] });
  return { root, project, data, start };
}
export async function running(t: TestContext, options: Boot = {}) {
  const booted = await boot(t, options);
  let app = await booted.start(), open = true;
  cleanup(t, async () => { if (open) await app.close(); });
  const as = (who: string | null) => (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    fetch(`http://127.0.0.1:${app.address.port}${path}`, { ...init, headers: { ...(who === null ? {} : { authorization: who === 'anon' ? 'Badge-anon' : `Badge ${who}` }), ...init.headers } });
  const create = async (who: string, title: string) => {
    const response = await as(who)('/api/notes', { method: 'POST', headers: json, body: JSON.stringify({ title }) });
    assert.equal(response.status, 201);
    return await response.json() as Record<string, unknown> & { id: string };
  };
  const stored = async () => JSON.parse(await readFile(join(booted.data, 'notes.json'), 'utf8')) as { records: Record<string, unknown>[] };
  return { ...booted, as, create, stored, stop: async () => { open = false; await app.close(); }, restart: async () => { await app.close(); app = await booted.start(); } };
}
export const legacy = (title: string) => { const now = new Date().toISOString(); return { id: randomUUID(), createdAt: now, updatedAt: now, title, votes: 0 }; };
