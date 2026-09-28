// The generated stateful composition hot reloads (#777, core RIM-EXT-HANDOFF-001): what `urlcode init --with
// admin,form-records --example` writes for audit, ui, forms, store and form-records, composed through composeHost
// and served by `urlcode dev`'s reload path. A stand-in auth sets the principal (admin and auth hold no exclusive
// per-activation resource; their own suites cover them).
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import type { ExtensionRequest, RuntimeExtension, ScaffoldResult } from '@jimhoyd/urlcode/extensions';
import { composeHost } from '@jimhoyd/urlcode/host';
import audit from '@jimhoyd/urlcode-audit/extension';
import ui from '@jimhoyd/urlcode-ui/extension';
import forms from '@jimhoyd/urlcode-forms/extension';
import store from '@jimhoyd/urlcode-store/extension';
import formRecords from '../src/extension.ts';
import { cleanup } from './cleanup.ts';
import { storedRecords } from './store-rows.ts';

const origin = 'https://reload.example.test';

function withSha(t: TestContext, sha: string): void {
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = sha;
  cleanup(t, () => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
}
/** A stand-in `auth` for the `auth: true` short form: `Badge <id>` sets the principal. */
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

test('the generated admin/form-records example reloads a contact title edit and keeps its data (#777)', async t => {
  // Close the server and host-owned audit database before removing their files (also on assertion failure).
  const root = await mkdtemp(join(tmpdir(), 'form-records-reload-')); cleanup(t, () => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app'); await mkdir(project);
  // What `init --with admin,form-records --example` installs, minus the account screens (admin, auth, mail).
  const installed = ['admin', 'audit', 'auth', 'form-records', 'forms', 'mail', 'store', 'ui'];
  const add = { site: root, project, installed, acknowledgements: [] };
  const merge = async (definition: { scaffold?: typeof store.definition.scaffold; example?: typeof store.definition.example }): Promise<ScaffoldResult> => {
    const capability = await definition.scaffold!(add);
    if (!definition.example) return capability;
    const extra = await definition.example(add);
    return { ...capability, config: { ...capability.config, ...extra.config }, routes: { ...capability.routes, ...extra.routes } };
  };
  const results: Record<string, ScaffoldResult> = {
    audit: await merge(audit.definition), ui: await merge(ui.definition), auth: { config: {}, routes: {} }, forms: await merge(forms.definition),
    store: await merge(store.definition), 'form-records': await merge(formRecords.definition),
  };
  for (const result of Object.values(results)) for (const file of result.files ?? []) {
    await mkdir(join(root, file.path, '..'), { recursive: true });
    await writeFile(join(root, file.path), file.content, { flag: 'wx', ...(file.mode === undefined ? {} : { mode: file.mode }) });
  }
  const document = { version: '1', extensions: Object.fromEntries(Object.entries(results).map(([name, result]) => [name, { version: '1', config: result.config }])) as Record<string, { version: string; config: Record<string, unknown> }>, routes: Object.assign({}, ...Object.values(results).map(result => result.routes)) as Record<string, unknown> };
  const flows = (document.extensions.forms!.config as { flows: Record<string, { title: string }> }).flows;
  assert.equal(flows.contact!.title, 'Contact us', 'the forms example declares the contact form');
  assert.equal((document.extensions.store!.config as { collections: Record<string, { audit?: boolean }> }).collections.todos!.audit, true, 'with audit installed the todos collection is audited');
  const save = () => writeFile(join(project, 'urlcode.yaml'), JSON.stringify(document));
  await save();
  const sha = await inspectExtensionRevision(project); withSha(t, sha);
  const host = await composeHost(pathToFileURL(join(root, 'host.mjs')), [audit(), store(), ui(), forms(), formRecords()]);
  cleanup(t, () => host.close?.());
  const events: Record<string, unknown>[] = [], diagnostics: string[] = [];
  // `urlcode dev`: the watcher's reload() with the startup pin followed.
  const app = await startServer({ project, origin, port: 0, followExtensionPinOnReload: true, log: event => { events.push(event as Record<string, unknown>); },
    debugErrors: true, diagnostics: line => { diagnostics.push(line); }, extensions: [...host.extensions!, badgeAuth(sha)] });
  let open = true;
  cleanup(t, async () => { if (open) await app.close(); });
  const cookies = new Map<string, string>();
  const call = async (path: string, init: { method?: string; body?: string; json?: boolean } = {}) => {
    const response = await fetch(`http://127.0.0.1:${app.address.port}${path}`, { method: init.method ?? 'GET', ...(init.body === undefined ? {} : { body: init.body }), redirect: 'manual', headers: { authorization: 'Badge ada', origin, 'content-type': init.json ? 'application/json' : 'application/x-www-form-urlencoded', ...(cookies.size ? { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}) } });
    for (const header of response.headers.getSetCookie()) { const first = header.split(';')[0]!, index = first.indexOf('='); cookies.set(first.slice(0, index), first.slice(index + 1)); }
    return response;
  };
  const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const todos = async () => ((await (await call('/api/todos')).json()) as { items: { title: string }[] }).items.map(item => item.title);
  // Data written before the reload, through the form and through the API.
  const form = await (await call('/todo-form')).text();
  const saved = await call('/todo-form', { method: 'POST', body: new URLSearchParams({ csrf: csrfOf(form), title: 'Before the reload' }).toString() });
  assert.equal(saved.status, 303);
  const location = saved.headers.get('location')!;
  assert.equal((await call('/api/todos', { method: 'POST', json: true, body: JSON.stringify({ title: 'API before' }) })).status, 201);
  assert.match(await (await call('/contact')).text(), /Contact us/);

  flows.contact!.title = 'Changed contact title';
  await save();
  assert.equal(await app.reload(), true, diagnostics.at(-1) ?? 'reload rejected');
  assert.equal(events.filter(event => event.event === 'reload').at(-1)?.status, 'ok');
  const contact = await call('/contact');
  assert.equal(contact.status, 200);
  assert.match(await contact.text(), /Changed contact title/, 'the new title is served');
  assert.match(await (await call(location)).text(), /Before the reload/, 'data written before the reload is still readable');
  assert.deepEqual(await todos(), ['Before the reload', 'API before']);
  const again = await (await call('/todo-form')).text();
  assert.equal((await call('/todo-form', { method: 'POST', body: new URLSearchParams({ csrf: csrfOf(again), title: 'After the reload' }).toString() })).status, 303);
  assert.deepEqual(await todos(), ['Before the reload', 'API before', 'After the reload']);

  // A reload that fails in form-records, after the store activated its view, keeps the last good site serving.
  const records = (document.extensions['form-records']!.config as { records: Record<string, { collection: string }> }).records;
  const collection = records.todo!.collection;
  records.todo!.collection = 'missing';
  flows.contact!.title = 'Never served';
  await save();
  assert.equal(await app.reload(), false);
  assert.match(JSON.parse(diagnostics.at(-1)!).message, /Extension "form-records" failed to activate/);
  assert.match(await (await call('/contact')).text(), /Changed contact title/);
  const kept = await (await call('/todo-form')).text();
  assert.equal((await call('/todo-form', { method: 'POST', body: new URLSearchParams({ csrf: csrfOf(kept), title: 'After the failure' }).toString() })).status, 303, 'the serving store, forms and ui still work');
  assert.deepEqual(await todos(), ['Before the reload', 'API before', 'After the reload', 'After the failure']);

  records.todo!.collection = collection;
  flows.contact!.title = 'Fixed contact title';
  await save();
  assert.equal(await app.reload(), true);
  assert.match(await (await call('/contact')).text(), /Fixed contact title/);
  assert.equal((await todos()).length, 4);
  open = false; await app.close();
  assert.deepEqual(await readdir(join(root, 'data')).then(names => names.filter(name => name.startsWith('store.sqlite'))), ['store.sqlite'], 'closing the server closed the store database');
  const file = { records: storedRecords(join(root, 'data', 'store.sqlite'), 'todos') };
  assert.deepEqual(file.records.map(record => record.title), ['Before the reload', 'API before', 'After the reload', 'After the failure']);
  assert.ok(file.records.every(record => record._owner === 'ada'));
});
