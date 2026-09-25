import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer, validateDocument } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import type { ExtensionRequest, RuntimeExtension, ScaffoldResult } from '@jimhoyd/urlcode/extensions';
import { composeHost } from '@jimhoyd/urlcode/host';
import ui from '@jimhoyd/urlcode-ui/extension';
import forms from '@jimhoyd/urlcode-forms/extension';
import store from '@jimhoyd/urlcode-store/extension';
import formRecords from '../src/extension.ts';
import { formRecordsConfigSchema } from '../src/index.ts';

const origin = 'https://records.example.test';
const request = (site: string, installed: string[]) => ({ site, project: join(site, 'app'), installed, acknowledgements: [] });

function withSha(t: TestContext, sha: string): void {
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = sha;
  t.after(() => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
}
/** A stand-in `auth` for the `auth: true` short form: `Badge <id>` sets the principal. */
function badgeAuth(projectSha256: string): RuntimeExtension {
  return {
    name: 'auth', version: '1', projectSha256, targets: ['node'], providesPrincipal: true,
    schema: { type: 'object', additionalProperties: false }, policySchema: { type: 'object', additionalProperties: false },
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

test('the definition requires forms, store and ui and carries the runtime schema', () => {
  assert.equal(formRecords.definition.name, 'form-records');
  assert.deepEqual(formRecords.definition.requires, ['forms', 'store', 'ui']);
  assert.equal(formRecords.definition.schema, formRecordsConfigSchema);
  assert.equal(formRecords.definition.contributes, undefined);
});

test('a blank install declares no record flow and no route (#711)', async () => {
  const blank = await formRecords.definition.scaffold!(request('/srv/site', ['form-records', 'forms', 'store', 'ui']));
  assert.deepEqual(blank.config, { records: {} });
  assert.deepEqual(blank.routes, {});
  assert.equal(blank.files, undefined);
  const document = validateDocument({ version: '1', extensions: { 'form-records': { version: '1', config: blank.config } }, routes: {} });
  assert.deepEqual(document.routes, {});
});

test('--example needs auth, and then mounts a signed-in todo form', async () => {
  assert.throws(() => formRecords.definition.example!(request('/srv/site', ['form-records', 'forms', 'store', 'ui'])), /needs auth/);
  const example = await formRecords.definition.example!(request('/srv/site', ['auth', 'form-records', 'forms', 'store', 'ui']));
  assert.deepEqual(example.routes, { '/todo-form/*': { extension: 'form-records', methods: ['GET', 'HEAD', 'POST'], auth: true } });
  assert.deepEqual(Object.keys((example.config as { records: object }).records), ['todo']);
  assert.ok(example.notes!.every(note => !note.includes('\n')));
});

test('host() receives the forms and store exports through composeHost and refuses without them', async t => {
  const root = await mkdtemp(join(tmpdir(), 'form-records-host-')); t.after(() => rm(root, { recursive: true, force: true }));
  withSha(t, 'a'.repeat(64));
  const hostUrl = pathToFileURL(join(root, 'host.mjs'));
  await assert.rejects(composeHost(hostUrl, [ui(), forms({ csrfSecret: 'b'.repeat(32) }), formRecords()]), /form-records requires store/);
  await assert.rejects(composeHost(hostUrl, [ui(), store({ directory: join(root, 'data') }), formRecords()]), /form-records requires forms/);
  const host = await composeHost(hostUrl, [formRecords(), store({ directory: join(root, 'data') }), forms({ csrfSecret: 'b'.repeat(32) }), ui()]);
  assert.deepEqual(host.extensions!.map(extension => extension.name), ['store', 'ui', 'forms', 'form-records']);
  await host.close?.();
});

/** What `urlcode extensions add auth form-records --example` writes for ui, forms, store and form-records, run end to end. */
test('the scaffolded example works end to end: create, confirmation, and an edit limited to done', async t => {
  const root = await mkdtemp(join(tmpdir(), 'form-records-example-')); t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app'); await mkdir(project);
  const installed = ['auth', 'form-records', 'forms', 'store', 'ui'], add = request(root, installed);
  const merge = async (definition: typeof forms.definition | typeof store.definition | typeof formRecords.definition | typeof ui.definition, example: boolean): Promise<ScaffoldResult> => {
    const capability = await definition.scaffold!(add);
    if (!example || !definition.example) return capability;
    const extra = await definition.example(add);
    return { ...capability, config: { ...capability.config, ...extra.config }, routes: { ...capability.routes, ...extra.routes } };
  };
  const results: Record<string, ScaffoldResult> = {
    ui: await merge(ui.definition, true), auth: { config: {}, routes: {} }, forms: await merge(forms.definition, true),
    store: await merge(store.definition, true), 'form-records': await merge(formRecords.definition, true),
  };
  for (const result of Object.values(results)) for (const file of result.files ?? []) {
    await mkdir(join(root, file.path, '..'), { recursive: true });
    await writeFile(join(root, file.path), file.content, { flag: 'wx', ...(file.mode === undefined ? {} : { mode: file.mode }) });
  }
  const extensions = Object.fromEntries(Object.entries(results).map(([name, result]) => [name, { version: '1', config: result.config }]));
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions, routes: Object.assign({}, ...Object.values(results).map(result => result.routes)) }));
  const sha = await inspectExtensionRevision(project); withSha(t, sha);
  const host = await composeHost(pathToFileURL(join(root, 'host.mjs')), [ui(), forms(), store(), formRecords()]);
  t.after(() => host.close?.());
  const app = await startServer({ project, origin, port: 0, log: () => {}, extensions: [...host.extensions!, badgeAuth(sha)] });
  t.after(() => app.close());
  const cookies = new Map<string, string>();
  const call = async (path: string, init: { method?: string; body?: string } = {}) => {
    const response = await fetch(`http://127.0.0.1:${app.address.port}${path}`, { ...init, redirect: 'manual', headers: { authorization: 'Badge ada', origin, 'content-type': 'application/x-www-form-urlencoded', ...(cookies.size ? { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}) } });
    for (const header of response.headers.getSetCookie()) { const first = header.split(';')[0]!, index = first.indexOf('='); cookies.set(first.slice(0, index), first.slice(index + 1)); }
    return response;
  };
  const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const form = await (await call('/todo-form')).text();
  assert.match(form, /New todo/);
  const saved = await call('/todo-form', { method: 'POST', body: new URLSearchParams({ csrf: csrfOf(form), title: 'Write the docs' }).toString() });
  assert.equal(saved.status, 303);
  const location = saved.headers.get('location')!;
  const shown = await (await call(location)).text();
  assert.match(shown, /Saved Write the docs\./); assert.match(shown, /Done<\/dt><dd>No/);
  const edit = await (await call(`${location}/edit`)).text();
  assert.match(edit, /Update todo/); assert.ok(!/name="title"/.test(edit));
  const action = /<form[^>]*action="([^"]+)"/.exec(edit)![1]!.replaceAll('&amp;', '&');
  assert.equal((await call(action, { method: 'POST', body: new URLSearchParams({ csrf: csrfOf(edit), done: 'true' }).toString() })).status, 303);
  const [todo] = (JSON.parse(await readFile(join(root, 'data', 'store', 'todos.json'), 'utf8')) as { records: Record<string, unknown>[] }).records;
  assert.equal(todo!.title, 'Write the docs'); assert.equal(todo!.done, true); assert.equal(todo!._owner, 'ada');
});
