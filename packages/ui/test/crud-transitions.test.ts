// Transition controls on data-bound screens (#863 item 2): transitionOnly fields are shown read-only, and each
// declared transition the screen offers is a button on the rows whose values match its `from`. A click posts no
// body, with the listed ETag as If-Match and (when the API retains keys) a fresh Idempotency-Key; a refusal is a
// page message. The shipped script runs against the fake DOM and a scripted server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crudFields, crudMarkup, crudTransitions } from '../src/crud.ts';
import type { CrudCollection } from '../src/crud.ts';
import { crudScript } from '../src/crud-script.ts';
import { createKit } from '../src/kit.ts';
import { createPresentation } from '../src/presentation.ts';
import { kitCatalogueFr } from '../src/catalogue.ts';
import { FakeDocument, fakeFetch, json, settle } from './support/fake-dom.ts';
import type { FakeElement } from './support/fake-dom.ts';

const kit = createKit({ presentation: createPresentation({ defaults: {} }), assetsBase: '/assets/ui' });
const context = kit.resolveContext();
const requests: CrudCollection = {
    mount: '/api/requests', idempotency: true,
    fields: { title: { type: 'string', required: true, maxLength: 120 }, status: { type: 'string', enum: ['pending', 'approved', 'withdrawn'], default: 'pending', transitionOnly: true }, flagged: { type: 'boolean', transitionOnly: true } },
    transitions: [{ name: 'withdraw', from: { status: 'pending' } }, { name: 'mark_flagged', from: { status: 'pending', flagged: false } }],
};
const request = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, title: `request ${id}`, status, flagged: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra });
const etag = (n: number) => `"${String(n).padStart(32, '0')}"`;

/** Boots the shipped script on the attributes the server renders, decoded the way a browser decodes them. */
async function boot(collection: CrudCollection, answers: Parameters<typeof fakeFetch>[0], readOnly = false) {
    const document = new FakeDocument();
    const root = document.createElement('div');
    root.setAttribute('data-ui-crud', '');
    const html = crudMarkup(context, { collection: { ...collection, readOnly }, title: 'Requests' }).html;
    for (const [, name, value] of html.matchAll(/ (data-[a-z]+)="([^"]*)"/g)) root.setAttribute(name!, value!.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    document.roots.push(root);
    const server = fakeFetch(answers);
    new Function('document', 'fetch', crudScript)(document, server.fetch);
    await settle();
    return { root, ...server };
}
const rows = (root: FakeElement) => root.findAll(element => element.tagName === 'LI' && element.getAttribute('data-id') !== null);
const status = (root: FakeElement) => root.find(element => element.className === 'ui-crud-status').textContent;
const buttons = (row: FakeElement) => row.findAll(element => element.tagName === 'BUTTON' && element.getAttribute('data-transition') !== null).map(element => element.getAttribute('data-transition'));
const titleInput = (root: FakeElement) => root.find(element => element.getAttribute('name') === 'title' && element.tagName === 'INPUT');

test('transitionOnly fields are read-only: never in the create or edit form, never sent, a boolean one is a disabled checkbox', async () => {
    const { root, calls } = await boot(requests, [json({ items: [request('a', 'pending')], total: 1, etags: { a: etag(1) } }), json(request('n', 'pending'), 201), json(request('a', 'pending'))]);
    const form = root.find(element => element.tagName === 'FORM');
    assert.deepEqual(form.findAll(element => element.getAttribute('name') !== null).map(element => element.getAttribute('name')), ['title']);
    titleInput(root).value = 'new';
    form.dispatch('submit');
    await settle();
    assert.deepEqual(calls[1]!.body, { title: 'new' }, 'the create body names no transitionOnly field');
    assert.match(rows(root)[0]!.textContent, /pending/);
    assert.equal(root.keyed('a:flagged').disabled, true);
    rows(root)[0]!.button('Edit').dispatch('click');
    const editing = rows(root)[0]!;
    assert.deepEqual(editing.findAll(element => ['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName)).map(element => element.getAttribute('name')), ['title']);
    assert.match(editing.textContent, /Statuspending/, 'the edit row shows the value as text beside its label');
    editing.button('Save').dispatch('click');
    await settle();
    assert.deepEqual(calls[2]!.body, { title: 'request a' }, 'the edit body names no transitionOnly field');
});

test('buttons appear only for transitions whose from values the record holds, on read-only screens too', async () => {
    const items = [request('a', 'pending'), request('b', 'approved'), request('c', 'pending', { flagged: true })];
    const { root } = await boot(requests, [json({ items, total: 3, etags: {} })]);
    assert.deepEqual(rows(root).map(buttons), [['withdraw', 'mark_flagged'], [], ['withdraw']]);
    assert.equal(rows(root)[0]!.button('Mark flagged').getAttribute('data-transition'), 'mark_flagged', 'the label comes from the name');
    const readOnly = await boot(requests, [json({ items, total: 3 })], true);
    assert.deepEqual(rows(readOnly.root).map(buttons), [['withdraw', 'mark_flagged'], [], ['withdraw']]);
    assert.equal(readOnly.root.findAll(element => element.tagName === 'BUTTON' && ['Edit', 'Delete'].includes(element.textContent)).length, 0);
    assert.equal(readOnly.root.findAll(element => element.tagName === 'FORM').length, 0);
    const none = await boot({ ...requests, transitions: [] }, [json({ items, total: 3 })]);
    assert.deepEqual(rows(none.root).map(buttons), [[], [], []]);
});

test('a transition posts no body with the listed ETag as If-Match and a fresh Idempotency-Key, then shows the record it returns', async () => {
    const both: CrudCollection = { ...requests, transitions: [{ name: 'withdraw', from: { status: 'pending' } }, { name: 'approve', from: { status: 'pending' }, mount: '/api/approvals' }] };
    const { root, calls, headers } = await boot(both, [
        json({ items: [request('a', 'pending'), request('b', 'pending')], total: 2, etags: { a: etag(1), b: etag(2) } }),
        json(request('a', 'withdrawn'), 200, { etag: etag(3) }),
        json(request('b', 'approved'), 200, { etag: etag(4) }),
    ]);
    rows(root)[0]!.button('Withdraw').dispatch('click');
    await settle();
    rows(root)[1]!.button('Approve').dispatch('click');
    await settle();
    assert.deepEqual(calls.slice(1), [{ method: 'POST', url: '/api/requests/a/withdraw', body: undefined }, { method: 'POST', url: '/api/approvals/b', body: undefined }]);
    assert.equal(headers[1]!['if-match'], etag(1));
    assert.equal(headers[2]!['if-match'], etag(2));
    assert.equal(headers[1]!['content-type'], undefined, 'no body, so no content type');
    assert.match(headers[1]!['idempotency-key']!, /^[0-9a-f]{32}$/);
    assert.notEqual(headers[1]!['idempotency-key'], headers[2]!['idempotency-key']);
    assert.deepEqual(rows(root).map(buttons), [[], []], 'neither record is pending any more');
    assert.match(rows(root)[0]!.textContent, /withdrawn/);
    assert.equal(status(root), '');
});

test('a record the screen created carries its response ETag to a later transition; no idempotency, no key; no ETag, no If-Match', async () => {
    const { root, headers } = await boot({ ...requests, idempotency: false }, [
        json({ items: [request('old', 'pending')], total: 1 }),
        json(request('n', 'pending'), 201, { etag: etag(7) }),
        json(request('n', 'withdrawn'), 200, { etag: etag(8) }),
        json(request('old', 'withdrawn'), 200, { etag: etag(9) }),
    ]);
    titleInput(root).value = 'new';
    root.find(element => element.tagName === 'FORM').dispatch('submit');
    await settle();
    rows(root)[1]!.button('Withdraw').dispatch('click');
    await settle();
    assert.equal(headers[2]!['if-match'], etag(7));
    assert.equal(headers[2]!['idempotency-key'], undefined);
    rows(root)[0]!.button('Withdraw').dispatch('click');
    await settle();
    assert.equal(headers[3]!['if-match'], undefined, 'a list without etags sends no If-Match, so the server checks from alone');
});

test('409, 412 and 403 refusals are page messages; the row keeps its state and its button', async () => {
    const refusals: [number, string, RegExp][] = [
        [409, 'transition_conflict', /no longer applies/],
        [412, 'precondition_failed', /changed since the list was loaded/],
        [403, 'membership_required', /not allowed/],
        [500, 'internal_error', /did not complete/],
    ];
    for (const [code, name, message] of refusals) {
        const { root } = await boot(requests, [json({ items: [request('a', 'pending')], total: 1, etags: { a: etag(1) } }), json({ error: { code: name, message: 'x' } }, code)]);
        rows(root)[0]!.button('Withdraw').dispatch('click');
        await settle();
        assert.match(status(root), message, String(code));
        assert.equal(root.find(element => element.getAttribute('role') === 'alert').textContent, status(root));
        assert.deepEqual(rows(root).map(buttons), [['withdraw', 'mark_flagged']]);
        assert.match(rows(root)[0]!.textContent, /pending/);
    }
    const offline = await boot(requests, [json({ items: [request('a', 'pending')], total: 1 }), () => Promise.reject(new TypeError('offline'))]);
    rows(offline.root)[0]!.button('Withdraw').dispatch('click');
    await settle();
    assert.match(status(offline.root), /did not complete/);
});

test('transitions are escaped: values and labels are text, and a hostile name or mount never reaches markup', async () => {
    const payload = '"><img src=x onerror=alert(1)>';
    const hostile: CrudCollection = { mount: '/api/requests', fields: { title: { type: 'string', maxLength: 100 }, status: { type: 'string', enum: ['<script>alert(1)</script>', payload], transitionOnly: true } }, transitions: [{ name: 'go', from: { status: payload } }] };
    const html = crudMarkup(context, { collection: hostile, title: 'T' }).html;
    assert.ok(!html.includes('<img') && !html.includes('<script'), html);
    assert.match(html, /data-transitions="\[\{&quot;n&quot;:&quot;go&quot;/);
    const { root } = await boot(hostile, [json({ items: [{ id: 'a', title: '<img src=x onerror=alert(1)>', status: payload }], total: 1 })]);
    const row = rows(root)[0]!;
    assert.equal(row.findAll(element => element.tagName === 'IMG' || element.tagName === 'SCRIPT').length, 0);
    assert.ok(row.textContent.includes(payload));
    assert.deepEqual(buttons(row), ['go'], 'a hostile from value still matches as data');
    for (const name of ['<b>x</b>', 'Approve', 'a b', '"x"', '']) assert.throws(() => crudTransitions({ ...hostile, transitions: [{ name, from: { status: 'x' } }] }), /needs a name/, name);
    assert.throws(() => crudMarkup(context, { collection: { ...hostile, transitions: [{ name: 'go', from: { status: 'x' }, mount: '/api/"><b>' }] }, title: 'T' }), /mount must be a path/);
    assert.throws(() => crudTransitions({ ...hostile, transitions: [{ name: 'go', from: { nope: 'x' } }] }), /does not declare: nope/);
    assert.throws(() => crudTransitions({ ...hostile, transitions: [{ name: 'go', from: {} }] }), /1 to 8 fields/);
    assert.throws(() => crudTransitions({ ...hostile, transitions: [{ name: 'go', from: { status: { x: 1 } as never } }] }), /string, number or boolean/);
    assert.throws(() => crudTransitions({ ...hostile, transitions: [{ name: 'go', from: { status: 'x' } }, { name: 'go', from: { status: 'y' } }] }), /twice/);
    assert.throws(() => crudTransitions({ ...hostile, transitions: [{ name: 'go', from: { status: 'x' }, script: 'y' } as never] }), /unsupported key: script/);
    assert.throws(() => crudFields({ ...hostile, transitions: 'go' as never }), /at most 16/);
});

test('a screen without transitions renders exactly the shell it did before', () => {
    const todos: CrudCollection = { mount: '/api/todos', fields: { title: { type: 'string', required: true } } };
    const plain = crudMarkup(context, { collection: todos, title: 'Todos' }).html;
    assert.equal(plain, crudMarkup(context, { collection: { ...todos, transitions: [], idempotency: true }, title: 'Todos' }).html);
    assert.ok(!plain.includes('data-transitions') && !plain.includes('data-idempotency') && !plain.includes('no longer applies'));
});

// #873 item 1: edits, toggles and deletes are guarded the same way transitions are.
const todos: CrudCollection = { mount: '/api/todos', fields: { title: { type: 'string', required: true, maxLength: 120 }, done: { type: 'boolean', default: false } } };
const todo = (id: string, title: string, done = false) => ({ id, title, done, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
const editTitle = (root: FakeElement, value: string) => {
    rows(root)[0]!.button('Edit').dispatch('click');
    const input = rows(root)[0]!.find(element => element.getAttribute('name') === 'title' && element.tagName === 'INPUT');
    input.value = value;
    input.dispatch('input');
    rows(root)[0]!.button('Save').dispatch('click');
};

test('an edit, a toggle and a delete send If-Match with the listed ETag, and each write moves the row to the ETag it returns', async () => {
    const { root, calls, headers } = await boot(todos, [
        json({ items: [todo('a', 'first')], total: 1, etags: { a: etag(1) } }),
        json(todo('a', 'renamed'), 200, { etag: etag(2) }),
        json(todo('a', 'renamed', true), 200, { etag: etag(3) }),
        new Response(null, { status: 204 }),
    ]);
    editTitle(root, 'renamed');
    await settle();
    root.keyed('a:done').checked = true;
    root.keyed('a:done').dispatch('change');
    await settle();
    rows(root)[0]!.button('Delete').dispatch('click');
    await settle();
    assert.deepEqual(calls.slice(1), [
        { method: 'PATCH', url: '/api/todos/a', body: { title: 'renamed', done: false } },
        { method: 'PATCH', url: '/api/todos/a', body: { done: true } },
        { method: 'DELETE', url: '/api/todos/a', body: undefined },
    ]);
    assert.deepEqual(headers.slice(1).map(sent => sent['if-match']), [etag(1), etag(2), etag(3)]);
    assert.equal(headers[3]!['content-type'], undefined, 'a delete has no body');
    assert.equal(rows(root).length, 0);
    assert.equal(status(root), '');
});

test('a stale edit, toggle or delete gets 412: the page says so and nothing on the row changes', async () => {
    const stale = () => json({ error: { code: 'precondition_failed', message: 'x' } }, 412);
    const listed = () => json({ items: [todo('a', 'first')], total: 1, etags: { a: etag(1) } });
    const edit = await boot(todos, [listed(), stale()]);
    editTitle(edit.root, 'mine');
    await settle();
    assert.equal(edit.headers[1]!['if-match'], etag(1));
    assert.match(status(edit.root), /changed since the list was loaded/);
    assert.equal(edit.root.find(element => element.getAttribute('role') === 'alert').textContent, status(edit.root));
    const input = rows(edit.root)[0]!.find(element => element.getAttribute('name') === 'title' && element.tagName === 'INPUT');
    assert.equal(input.value, 'mine', 'the edit row stays open with what was typed');
    rows(edit.root)[0]!.button('Cancel').dispatch('click');
    assert.match(rows(edit.root)[0]!.textContent, /first/);

    const toggle = await boot(todos, [listed(), stale()]);
    toggle.root.keyed('a:done').checked = true;
    toggle.root.keyed('a:done').dispatch('change');
    await settle();
    assert.equal(toggle.headers[1]!['if-match'], etag(1));
    assert.equal(toggle.root.keyed('a:done').checked, false, 'the optimistic toggle is rolled back');
    assert.match(status(toggle.root), /changed since the list was loaded/);

    const remove = await boot(todos, [listed(), stale()]);
    rows(remove.root)[0]!.button('Delete').dispatch('click');
    await settle();
    assert.equal(remove.headers[1]!['if-match'], etag(1));
    assert.equal(rows(remove.root).length, 1, 'the row stays');
    assert.match(status(remove.root), /changed since the list was loaded/);

    const unlisted = await boot(todos, [json({ items: [todo('a', 'first')], total: 1 }), new Response(null, { status: 204 })]);
    rows(unlisted.root)[0]!.button('Delete').dispatch('click');
    await settle();
    assert.equal(unlisted.headers[1]!['if-match'], undefined, 'no listed ETag, no If-Match');
});

test('the stale message is shipped in English and French on every screen', () => {
    const french = createKit({ presentation: createPresentation({ defaults: {}, catalogues: { fr: kitCatalogueFr } }), assetsBase: '/assets/ui' });
    const html = crudMarkup(french.resolveContext({ queryLocale: 'fr' }), { collection: todos, title: 'T' }).html;
    assert.match(html, /Cet élément a changé depuis le chargement de la liste/);
    assert.match(crudMarkup(context, { collection: todos, title: 'T' }).html, /changed since the list was loaded/);
});
