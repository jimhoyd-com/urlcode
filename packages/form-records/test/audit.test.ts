// The transitive proof: form-records writes through StoreExports, so a submission into an audited collection is
// recorded by a real audit with the request principal as actor, with no audit code in form-records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '@jimhoyd/urlcode';
import { defineExtension, inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import type { ExtensionRequest, RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { composeHost } from '@jimhoyd/urlcode/host';
import ui from '@jimhoyd/urlcode-ui/extension';
import forms from '@jimhoyd/urlcode-forms/extension';
import store from '@jimhoyd/urlcode-store/extension';
import audit from '@jimhoyd/urlcode-audit/extension';
import type { AuditExports } from '@jimhoyd/urlcode-audit';
import formRecords from '../src/extension.ts';

const origin = 'https://records-audit.example.test';
/** A stand-in `auth` for the `auth:` short form (with the csrf key): `Badge <id>` sets the principal. */
function badgeAuth(projectSha256: string): RuntimeExtension {
  return {
    name: 'auth', version: '1', projectSha256, targets: ['node'], providesPrincipal: true,
    schema: { type: 'object', additionalProperties: false }, policySchema: { type: 'object', additionalProperties: false, properties: { csrf: { enum: ['token', 'origin'] } } },
    activate() {
      return {
        handle() { return { status: 404, headers: [] }; },
        authorize(_policy: unknown, incoming: ExtensionRequest) {
          const match = /^Badge (\S+)$/.exec(incoming.headers.get('authorization') ?? '');
          if (!match) return { status: 401, headers: [['content-type', 'text/plain']], body: 'sign in' };
          incoming.setPrincipal!({ id: match[1]! });
          return undefined;
        },
      };
    },
  };
}
/** Reads the audit exports like any extension that `uses` audit, so the test can query the log. */
function probe(seen: { audit?: AuditExports | undefined }) {
  return defineExtension({
    name: 'probe', description: 'Reads the audit exports for the test', uses: ['audit'], schema: { type: 'object' },
    host(ctx) {
      seen.audit = ctx.get<AuditExports | undefined>('audit');
      return { registration: { name: 'probe', version: '1', projectSha256: ctx.projectSha256, targets: ['node'], schema: { type: 'object' }, activate: () => ({ handle: () => ({ status: 404, headers: [] }) }) } };
    },
  });
}

test('a form-records submission into an audit: true collection is audited once, with the principal as actor', async t => {
  const root = await mkdtemp(join(tmpdir(), 'form-records-audit-')); t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app'); await mkdir(project);
  await writeFile(join(root, 'forms-csrf.key'), 'k'.repeat(32));
  const todos = { mount: '/api/todos', ownership: 'owner', audit: true, fields: { title: { type: 'string', required: true, maxLength: 200 }, done: { type: 'boolean', default: false } } };
  const record = { mount: '/todo-form', collection: 'todos', editable: ['done'], form: { title: 'New todo', submitLabel: 'Save', confirmation: { title: 'Saved', message: 'Saved.' }, fields: { title: { label: 'Title', maxLength: 200 }, done: { label: 'Done', control: 'checkbox', required: false } } } };
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1',
    extensions: { ui: { version: '1', config: {} }, auth: { version: '1', config: {} }, audit: { version: '1', config: { retention: 1000 } }, forms: { version: '1', config: { flows: {} } }, store: { version: '1', config: { collections: { todos } } }, 'form-records': { version: '1', config: { records: { todo: record } } } },
    routes: { '/assets/ui/*': { extension: 'ui' }, '/api/todos/*': { extension: 'store', methods: ['GET', 'POST'], auth: { csrf: 'origin' } }, '/todo-form/*': { extension: 'form-records', methods: ['GET', 'HEAD', 'POST'], auth: { csrf: 'origin' } } } }));
  const sha = await inspectExtensionRevision(project);
  const previous = process.env.PROJECT_SHA256; process.env.PROJECT_SHA256 = sha;
  t.after(() => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
  const seen: { audit?: AuditExports | undefined } = {};
  const host = await composeHost(pathToFileURL(join(root, 'host.mjs')), [formRecords(), store(), forms({ csrfSecretFile: join(root, 'forms-csrf.key') }), ui(), audit(), probe(seen)()]);
  t.after(() => host.close?.());
  const app = await startServer({ project, origin, port: 0, log: () => {}, extensions: [...host.extensions!, badgeAuth(sha)] });
  t.after(() => app.close());
  const cookies = new Map<string, string>();
  const call = async (path: string, body?: URLSearchParams) => {
    const response = await fetch(`http://127.0.0.1:${app.address.port}${path}`, { method: body ? 'POST' : 'GET', redirect: 'manual', headers: { authorization: 'Badge ada', origin, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(cookies.size ? { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}) }, ...(body ? { body } : {}) });
    for (const header of response.headers.getSetCookie()) { const first = header.split(';')[0]!, index = first.indexOf('='); cookies.set(first.slice(0, index), first.slice(index + 1)); }
    return response;
  };
  const page = await (await call('/todo-form')).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
  const saved = await call('/todo-form', new URLSearchParams({ csrf, title: 'Audit this todo' }));
  assert.equal(saved.status, 303);
  const id = saved.headers.get('location')!.split('/').pop()!;
  await seen.audit!.flush();
  const { events } = await seen.audit!.query({ source: 'store' });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.action, 'store.record.created');
  assert.equal(events[0]!.actor, 'ada', 'the request principal, passed through StoreExports');
  assert.equal(events[0]!.subject, `todos/${id}`);
  assert.deepEqual(events[0]!.metadata, { collection: 'todos', fields: ['title', 'done'] });
  assert.ok(!JSON.stringify(events).includes('Audit this todo'), 'no submitted value reaches the log');
});
