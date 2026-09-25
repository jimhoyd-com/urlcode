import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import type { ExtensionRequest, RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { createUiExtension } from '@jimhoyd/urlcode-ui/host';
import { createForms } from '@jimhoyd/urlcode-forms';
import { createStore } from '@jimhoyd/urlcode-store';
import { createFormRecordsExtension } from '../src/index.ts';

// #529. The principal provider is a synthetic "badge" extension, not auth, so the composition is proven against
// core's generic principal contract: `Badge <id>` sets the principal, `Badge-anon` is allowed without one.
const origin = 'https://records.example.test';
const form = { 'content-type': 'application/x-www-form-urlencoded' };
const profiles = {
  mount: '/api/profiles', ownership: 'owner', maxRecords: 50,
  fields: {
    name: { type: 'string', required: true, minLength: 1, maxLength: 80 },
    team: { type: 'string', enum: ['red', 'blue'], default: 'red' },
    age: { type: 'integer', minimum: 0, maximum: 150 },
    subscribed: { type: 'boolean', default: false },
    notes: { type: 'string', maxLength: 20 },
  },
};
const onboarding = {
  mount: '/onboarding', collection: 'profiles',
  form: {
    title: 'Join <us>', submitLabel: 'Join',
    confirmation: { title: 'Welcome', message: 'Saved {name}.', show: ['name', 'team', 'subscribed'] },
    fields: {
      name: { label: 'Name', maxLength: 80 },
      team: { label: 'Team', control: 'select', options: [{ value: 'red', label: 'Red team' }, { value: 'blue', label: 'Blue team' }] },
      age: { label: 'Age', type: 'number', required: false, minimum: 0 },
      subscribed: { label: 'Subscribe', control: 'checkbox', required: false },
      bio: { label: 'Bio', control: 'textarea', required: false, maxLength: 100 },
    },
  },
  fields: { name: 'name', team: 'team', age: 'age', subscribed: 'subscribed', bio: 'notes' },
  editable: ['team', 'subscribed'], editTitle: 'Edit profile',
};

function badge(projectSha256: string): RuntimeExtension {
  return {
    name: 'badge', version: '1', projectSha256, targets: ['node', 'aws', 'vercel'], providesPrincipal: true,
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

interface Boot { record?: object; collection?: object; guard?: boolean; order?: string[]; target?: 'aws' }
async function project(t: TestContext, options: Boot = {}) {
  const root = await mkdtemp(join(tmpdir(), 'form-records-')); t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'app'), data = join(root, 'data');
  await mkdir(app); await mkdir(data);
  const guard = options.guard === false ? {} : { policies: { extensions: { badge: {} } } };
  const blocks: Record<string, unknown> = {
    badge: { version: '1', config: {} }, ui: { version: '1', config: {} }, forms: { version: '1', config: { flows: {} } },
    store: { version: '1', config: { collections: { profiles: options.collection ?? profiles } } },
    'form-records': { version: '1', config: { records: { onboarding: options.record ?? onboarding } } },
  };
  const order = options.order ?? Object.keys(blocks);
  await writeFile(join(app, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: Object.fromEntries(order.map(name => [name, blocks[name]])), routes: {
    '/assets/ui/*': { extension: 'ui' },
    '/api/profiles/*': { extension: 'store', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], policies: { extensions: { badge: {} } } },
    '/onboarding/*': { extension: 'form-records', methods: ['GET', 'HEAD', 'POST'], ...guard },
  } }));
  const projectSha256 = await inspectExtensionRevision(app);
  const ui = createUiExtension({ projectRoot: app, projectSha256 });
  const forms = createForms({ ui, projectSha256, csrfSecret: 'f'.repeat(32) });
  const store = createStore({ directory: data, projectSha256 });
  const records = createFormRecordsExtension({ projectSha256, forms: forms.exports, store: store.exports });
  const extensions = [badge(projectSha256), ui.registration, forms.registration, store.registration, records];
  return { app, data, extensions };
}
async function boot(t: TestContext, options: Boot = {}) {
  const { app, data, extensions } = await project(t, options);
  const server = await startServer({ project: app, origin, port: 0, log: () => {}, extensions });
  t.after(() => server.close());
  /** One browser: its own cookie jar and badge. */
  const browser = (who: string | null) => {
    const cookies = new Map<string, string>();
    return async (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
      const headers: Record<string, string> = { ...(who === null ? {} : { authorization: who === 'anon' ? 'Badge-anon' : `Badge ${who}` }), ...(cookies.size ? { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}), ...init.headers };
      const response = await fetch(`http://127.0.0.1:${server.address.port}${path}`, { ...init, headers, redirect: 'manual' });
      for (const header of response.headers.getSetCookie()) { const first = header.split(';')[0]!, index = first.indexOf('='); cookies.set(first.slice(0, index), first.slice(index + 1)); }
      return response;
    };
  };
  const stored = async () => JSON.parse(await readFile(join(data, 'profiles.json'), 'utf8')) as { records: Record<string, unknown>[] };
  return { browser, stored };
}
type Browser = ReturnType<Awaited<ReturnType<typeof boot>>['browser']>;
async function page(call: Browser, path: string): Promise<{ status: number; html: string; csrf: string; action: string }> {
  const response = await call(path), html = await response.text();
  return { status: response.status, html, csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '', action: /<form[^>]*action="([^"]+)"/.exec(html)?.[1]?.replaceAll('&amp;', '&') ?? '' };
}
const post = (call: Browser, path: string, values: Record<string, string>, headers: Record<string, string> = { origin }) => call(path, { method: 'POST', headers: { ...form, ...headers }, body: new URLSearchParams(values).toString() });
async function created(call: Browser, values: Record<string, string> = { name: 'Ada', team: 'red', age: '36', bio: 'engines' }): Promise<string> {
  const { csrf } = await page(call, '/onboarding');
  const answer = await post(call, '/onboarding', { csrf, ...values });
  assert.equal(answer.status, 303);
  const location = answer.headers.get('location')!;
  assert.match(location, /^\/onboarding\/[0-9a-f-]{36}$/);
  return location.slice('/onboarding/'.length);
}

test('create, confirmation, pre-filled edit and a constrained partial update', async t => {
  const { browser, stored } = await boot(t);
  const alice = browser('alice');
  const blank = await page(alice, '/onboarding');
  assert.equal(blank.status, 200); assert.match(blank.html, /Join &lt;us&gt;/); assert.equal(blank.action, '/onboarding');
  const id = await created(alice);
  // The confirmation reads the saved record back, showing only the opted-in fields.
  const confirmation = await (await alice(`/onboarding/${id}`)).text();
  assert.match(confirmation, /Saved Ada\./); assert.match(confirmation, /Red team/); assert.match(confirmation, /Subscribe<\/dt><dd>No/);
  assert.ok(!confirmation.includes('engines'), 'a field outside confirmation.show is not shown');
  assert.match(confirmation, new RegExp(`href="/onboarding/${id}/edit"`));
  const [record] = (await stored()).records;
  assert.deepEqual({ ...record, id: undefined, createdAt: undefined, updatedAt: undefined }, { id: undefined, createdAt: undefined, updatedAt: undefined, _owner: 'alice', name: 'Ada', team: 'red', age: 36, subscribed: false, notes: 'engines' });
  // The edit page offers only the editable fields, pre-filled, and shows the rest read-only.
  const edit = await page(alice, `/onboarding/${id}/edit`);
  assert.equal(edit.status, 200); assert.match(edit.html, /Edit profile/);
  assert.match(edit.html, /name="team"/); assert.match(edit.html, /name="subscribed"/); assert.match(edit.html, /<option value="red" selected/);
  assert.ok(!/name="name"/.test(edit.html) && !/name="bio"/.test(edit.html), 'read-only fields have no input');
  assert.match(edit.html, /<dt>Name<\/dt><dd>Ada<\/dd>/); assert.match(edit.html, /<dt>Bio<\/dt><dd>engines<\/dd>/);
  assert.match(edit.action, new RegExp(`^/onboarding/${id}/edit\\?v=[0-9a-f]{32}$`));
  const saved = await post(alice, edit.action, { csrf: edit.csrf, team: 'blue', subscribed: 'true' });
  assert.equal(saved.status, 303); assert.equal(saved.headers.get('location'), `/onboarding/${id}`);
  const after = (await stored()).records[0]!;
  assert.equal(after.team, 'blue'); assert.equal(after.subscribed, true);
  assert.equal(after.name, 'Ada'); assert.equal(after.notes, 'engines'); assert.equal(after.age, 36); assert.equal(after._owner, 'alice');
  assert.match(await (await alice(`/onboarding/${id}`)).text(), /Blue team/);
  // The store's own JSON API still serves the same owned record to its owner.
  const api = await (await alice(`/api/profiles/${id}`)).json() as Record<string, unknown>;
  assert.equal(api.team, 'blue'); assert.equal(Object.hasOwn(api, '_owner'), false);
});

test('another user gets 404 for a record, its edit page and an edit submission; a request without a principal gets 401', async t => {
  const { browser, stored } = await boot(t);
  const alice = browser('alice'), bob = browser('bob');
  const id = await created(alice);
  assert.equal((await bob(`/onboarding/${id}`)).status, 404);
  assert.equal((await bob(`/onboarding/${id}/edit`)).status, 404);
  assert.equal((await bob(`/onboarding/${crypto.randomUUID()}`)).status, 404, 'the same answer as a missing record');
  const own = await page(bob, '/onboarding');
  assert.equal((await post(bob, `/onboarding/${id}/edit?v=${'0'.repeat(32)}`, { csrf: own.csrf, team: 'blue' })).status, 404);
  assert.equal((await stored()).records[0]!.team, 'red');
  assert.equal((await browser('anon')(`/onboarding`)).status, 401);
  assert.equal((await browser('anon')(`/onboarding/${id}`)).status, 401);
  assert.equal((await browser(null)(`/onboarding`)).status, 401, 'the provider refuses a request with no badge');
});

test('a field outside editable cannot be changed through the edit page', async t => {
  const { browser, stored } = await boot(t);
  const alice = browser('alice');
  const id = await created(alice);
  const edit = await page(alice, `/onboarding/${id}/edit`);
  const answer = await post(alice, edit.action, { csrf: edit.csrf, team: 'blue', name: 'Eve' });
  const html = await answer.text();
  assert.equal(answer.status, 422); assert.match(html, /Correct the highlighted fields/); assert.ok(!/name="name"/.test(html), 'the refused field is still not offered');
  const record = (await stored()).records[0]!;
  assert.equal(record.name, 'Ada'); assert.equal(record.team, 'red', 'a refused submission changes nothing');
});

test('an edit submitted from a stale page is refused with a form error and changes nothing (If-Match/412)', async t => {
  const { browser, stored } = await boot(t);
  const alice = browser('alice');
  const id = await created(alice);
  const first = await page(alice, `/onboarding/${id}/edit`), second = await page(alice, `/onboarding/${id}/edit`);
  assert.equal(first.action, second.action);
  assert.equal((await post(alice, second.action, { csrf: second.csrf, team: 'blue' })).status, 303);
  const stale = await post(alice, first.action, { csrf: first.csrf, team: 'red', subscribed: 'true' });
  const html = await stale.text();
  assert.equal(stale.status, 412); assert.match(html, /changed since you opened it/);
  assert.match(html, /<option value="blue" selected/, 'the page shows the current values');
  const fresh = /<form[^>]*action="([^"]+)"/.exec(html)![1]!;
  assert.notEqual(fresh, first.action, 'and the current version');
  const record = (await stored()).records[0]!;
  assert.equal(record.team, 'blue'); assert.equal(record.subscribed, false);
  // A change through the JSON API also invalidates an open edit page.
  const third = await page(alice, `/onboarding/${id}/edit`);
  const etag = (await alice(`/api/profiles/${id}`)).headers.get('etag')!;
  assert.equal((await alice(`/api/profiles/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'if-match': etag, origin }, body: JSON.stringify({ subscribed: true }) })).status, 200);
  assert.equal((await post(alice, third.action, { csrf: third.csrf, team: 'red' })).status, 412);
  assert.equal((await stored()).records[0]!.team, 'blue');
  // A missing or malformed version is refused before anything else.
  assert.equal((await post(alice, `/onboarding/${id}/edit`, { csrf: third.csrf, team: 'red' })).status, 400);
});

test('forms admission and CSRF hold on both pages: scoped tokens, same-origin, media type and 422 field errors', async t => {
  const { browser, stored } = await boot(t);
  const alice = browser('alice'), bob = browser('bob');
  const create = await page(alice, '/onboarding');
  assert.equal((await post(alice, '/onboarding', { name: 'Ada', team: 'red' })).status, 403, 'no token');
  assert.equal((await post(alice, '/onboarding', { csrf: create.csrf, name: 'Ada', team: 'red' }, { origin: 'https://evil.example' })).status, 403, 'cross-origin');
  assert.equal((await post(bob, '/onboarding', { csrf: create.csrf, name: 'Ada', team: 'red' })).status, 403, 'a token bound to another browser');
  assert.equal((await alice('/onboarding', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{}' })).status, 415);
  const id = await created(alice);
  const edit = await page(alice, `/onboarding/${id}/edit`);
  assert.equal((await post(alice, '/onboarding', { csrf: edit.csrf, name: 'Mallory', team: 'red' })).status, 403, 'an edit-page token does not admit the create page');
  const otherId = await created(alice, { name: 'Grace', team: 'blue' });
  const otherEdit = await page(alice, `/onboarding/${otherId}/edit`);
  assert.equal((await post(alice, edit.action, { csrf: otherEdit.csrf, team: 'blue' })).status, 403, 'a token for one record does not admit another');
  assert.equal((await stored()).records.length, 2);
  // 422: forms' own field validation, and a store rule the form did not repeat (notes maxLength 20), mapped to the form field.
  const bad = await post(alice, '/onboarding', { csrf: (await page(alice, '/onboarding')).csrf, name: '', team: 'green', age: 'x' });
  const badHtml = await bad.text();
  assert.equal(bad.status, 422); assert.match(badHtml, /is required/); assert.match(badHtml, /is not an allowed option/); assert.match(badHtml, /must be a number/);
  const long = await post(alice, '/onboarding', { csrf: (await page(alice, '/onboarding')).csrf, name: 'Linus', team: 'red', bio: 'x'.repeat(30) });
  const longHtml = await long.text();
  assert.equal(long.status, 422); assert.match(longHtml, /must be at most 20 characters/); assert.match(longHtml, /Linus/, 'the submitted values are kept');
  const fraction = await post(alice, '/onboarding', { csrf: (await page(alice, '/onboarding')).csrf, name: 'Half', team: 'red', age: '1.5' });
  assert.equal(fraction.status, 422); assert.match(await fraction.text(), /must be a whole number/);
  assert.equal((await stored()).records.length, 2, 'no refused submission was saved');
  assert.equal((await alice(`/onboarding/${id}`, { method: 'POST' })).status, 405);
  assert.equal((await alice(`/onboarding/${id}/other`)).status, 404);
  assert.equal((await alice('/onboarding/not-an-id')).status, 404);
});

test('a full collection or per-owner limit surfaces as a page error, not a lost submission', async t => {
  const { browser } = await boot(t, { collection: { ...profiles, maxRecords: 1 } });
  const alice = browser('alice');
  await created(alice);
  const answer = await post(alice, '/onboarding', { csrf: (await page(alice, '/onboarding')).csrf, name: 'Second', team: 'red' });
  const html = await answer.text();
  assert.equal(answer.status, 409); assert.match(html, /could not be saved/); assert.match(html, /Second/);
});

test('activation refuses a shared collection, a mount without a principal provider, a bad mapping and a wrong order', async t => {
  const refuses = async (options: Boot, pattern: RegExp) => {
    const { app, extensions } = await project(t, options);
    await assert.rejects(createRuntime(app, { origin, extensions }), pattern);
  };
  await refuses({ collection: { ...profiles, ownership: 'shared' } }, /must be declared with ownership: owner/);
  await refuses({ collection: (({ ownership: _o, ...rest }) => rest)(profiles) }, /must be declared with ownership: owner/);
  await refuses({ guard: false }, /needs a principal-providing policy/);
  await refuses({ record: { ...onboarding, collection: 'missing' } }, /store declares no collection missing/);
  await refuses({ record: { ...onboarding, fields: { name: 'name', team: 'team', age: 'age', subscribed: 'subscribed' } } }, /form field bio is not mapped/);
  await refuses({ record: { ...onboarding, fields: { ...onboarding.fields, bio: 'nope' } } }, /which collection profiles does not declare/);
  await refuses({ record: { ...onboarding, fields: { ...onboarding.fields, age: 'name', name: 'notes' } } }, /cannot fill string field name|required, so a form field must be mapped/);
  await refuses({ record: { ...onboarding, fields: { ...onboarding.fields, subscribed: 'notes', bio: 'subscribed' } } }, /\(boolean\) cannot fill string field notes/);
  await refuses({ record: { ...onboarding, fields: { ...onboarding.fields, bio: 'team' } } }, /maps two form fields to team/);
  await refuses({ record: { ...onboarding, editable: ['nickname'] } }, /editable lists nickname/);
  await refuses({ record: { ...onboarding, form: { ...onboarding.form, confirmation: { title: 'x', message: '{bio}', show: ['name'] } } } }, /placeholder \{bio\} is not listed in show/);
  await refuses({ record: { ...onboarding, form: { ...onboarding.form, fields: { ...onboarding.form.fields, age: { label: 'Age', type: 'number', required: false, requiredWhen: { field: 'team', in: ['red'] } } } } } }, /declares both required and requiredWhen/);
  await refuses({ record: { ...onboarding, editable: ['age'], form: { ...onboarding.form, fields: { ...onboarding.form.fields, age: { label: 'Age', type: 'number', requiredWhen: { field: 'team', in: ['red'] } } } } } }, /team must be included with it/);
  await refuses({ order: ['badge', 'ui', 'form-records', 'forms', 'store'] }, /declare both before form-records/);
  const { app, extensions } = await project(t, { order: ['form-records', 'badge', 'ui', 'forms', 'store'] });
  assert.deepEqual(extensions.at(-1)!.targets, ['node'], 'the store is Node-only, so the composition is too');
  await assert.rejects(createRuntime(app, { origin, extensions, target: 'aws' }), /Refused by the extension's own declared targets: form-records/);
});

test('trailing slashes are trimmed in linear time: a record path still resolves, and a long run of slashes answers quickly', async t => {
  const { browser } = await boot(t);
  const alice = browser('alice');
  const id = await created(alice);
  assert.equal((await alice(`/onboarding/${id}/`)).status, 200);
  const started = performance.now();
  const response = await alice(`/onboarding${'/'.repeat(4000)}x`);
  assert.ok(response.status === 400 || response.status === 404, String(response.status)); // core refuses empty path segments first; the helper stays linear regardless
  assert.ok(performance.now() - started < 2000, 'a slash-heavy path must not backtrack');
});

test('the registration refuses exports of another contract version', () => {
  const projectSha256 = 'a'.repeat(64);
  const store = { version: 1, active: false, records() { throw new Error('unused'); } } as const;
  assert.throws(() => createFormRecordsExtension({ projectSha256, forms: { version: 2 } as never, store }), /forms export contract version 1/);
  assert.throws(() => createFormRecordsExtension({ projectSha256: 'short', forms: { version: 1 } as never, store }), /revision pin/);
});
