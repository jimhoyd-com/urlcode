import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crudFields, crudMarkup, crudScreen, fieldLabel } from '../src/crud.ts';
import type { CrudCollection } from '../src/crud.ts';
import { crudScript } from '../src/crud-script.ts';
import { createKit } from '../src/kit.ts';
import { createPresentation } from '../src/presentation.ts';
import { createUiExtension, uiConfigSchema } from '../src/host/extension.ts';
import type { ExtensionRequest, UiScreen, UiScreenContribution, UiScreenSource } from '../src/host/extension.ts';
import { FakeDocument, fakeFetch, json, settle } from './support/fake-dom.ts';
import type { FakeElement } from './support/fake-dom.ts';

const todos: CrudCollection = { mount: '/api/todos', fields: { title: { type: 'string', required: true, minLength: 1, maxLength: 200 }, done: { type: 'boolean', default: false } } };
const presentation = createPresentation({ defaults: {} });
const kit = createKit({ presentation, assetsBase: '/assets/ui' });
const context = kit.resolveContext();
const record = (id: string, title: string, done = false) => ({ id, title, done, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });

/** Boots the shipped script against a fake DOM and a scripted server. */
async function boot(collection: CrudCollection, answers: Parameters<typeof fakeFetch>[0], readOnly = false) {
    const document = new FakeDocument();
    const root = document.createElement('div');
    root.setAttribute('data-ui-crud', '');
    // The attributes the server renders, decoded the way a browser decodes them.
    const html = crudMarkup(context, { collection: { ...collection, readOnly }, title: 'Todos' }).html;
    const attribute = (name: string) => new RegExp(` ${name}="([^"]*)"`).exec(html)![1]!.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    root.setAttribute('data-api', attribute('data-api'));
    root.setAttribute('data-fields', attribute('data-fields'));
    root.setAttribute('data-copy', attribute('data-copy'));
    if (html.includes(' data-query=')) root.setAttribute('data-query', attribute('data-query'));
    if (readOnly) root.setAttribute('data-readonly', 'true');
    document.roots.push(root);
    const server = fakeFetch(answers);
    new Function('document', 'fetch', crudScript)(document, server.fetch);
    await settle();
    return { document, root, ...server };
}
const rows = (root: FakeElement) => root.findAll(element => element.tagName === 'LI' && element.getAttribute('data-id') !== null);
const status = (root: FakeElement) => root.find(element => element.className === 'ui-crud-status').textContent;

test('the shell is escaped: declaration, title and mount reach markup only as attribute or text data', () => {
    const hostile: CrudCollection = { mount: '/api/todos', fields: { title: { type: 'string', maxLength: 100, enum: ['<script>alert(1)</script>', 'a"b'] } } };
    const html = crudMarkup(context, { collection: hostile, title: '<img src=x onerror=alert(1)>' }).html;
    assert.ok(!html.includes('<img'), html);
    assert.ok(!html.includes('<script'), html);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /data-ui-crud data-api="\/api\/todos"/);
    assert.throws(() => crudMarkup(context, { collection: { mount: '/api/"><b>', fields: todos.fields }, title: 'x' }), /mount path/);
    assert.throws(() => crudFields({ mount: '/api/x', fields: { 'bad name': { type: 'string' } } }), /field name/);
    assert.throws(() => crudFields({ mount: '/api/x', fields: {} }), /between 1 and 64/);
    assert.throws(() => crudFields({ mount: '/api/x', fields: { a: { type: 'date' as 'string' } } }), /unsupported type/);
});

test('fields declared once become controls: booleans check, enums select, numbers step, long strings get a textarea', () => {
    const fields = crudFields({ mount: '/api/x', fields: { title: { type: 'string', maxLength: 80, required: true }, notes: { type: 'string' }, done: { type: 'boolean' }, status: { type: 'string', enum: ['open', 'closed'] }, points: { type: 'integer' }, dueDate: { type: 'string', maxLength: 10 } } });
    assert.deepEqual(fields.map(field => [field.n, field.k, field.l]), [['title', 'text', 'Title'], ['notes', 'textarea', 'Notes'], ['done', 'checkbox', 'Done'], ['status', 'select', 'Status'], ['points', 'number', 'Points'], ['dueDate', 'text', 'Due date']]);
    assert.equal(fieldLabel('due_date'), 'Due date');
});

test('crudScreen is a strict-CSP page: the crud kit script carries the page nonce, the CSP allows same-origin fetch and no inline script is added', () => {
    const page = crudScreen(kit, { collection: todos, title: 'Todos' });
    const html = new TextDecoder().decode(page.body);
    const nonce = /<script nonce="([^"]+)" src="\/assets\/ui\/crud\.[0-9a-f]{12}\.js" defer><\/script>/.exec(html)?.[1];
    assert.ok(nonce);
    const csp = new Headers(page.headers).get('content-security-policy')!;
    assert.match(csp, new RegExp(`script-src 'nonce-${nonce.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}'`));
    assert.match(csp, /connect-src 'self'/);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(csp), csp);
    assert.ok(!/<script(?![^>]* nonce=")/.test(html));
    assert.ok(kit.assets.some(asset => asset.name.startsWith('crud.') && asset.body === crudScript));
});

test('the client script never assigns markup and cannot evaluate strings', () => {
    for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'setTimeout(\'', 'srcdoc']) assert.ok(!crudScript.includes(forbidden), forbidden);
});

test('client: records render as text, never as markup', async () => {
    const hostile = record('a', '<img src=x onerror=alert(1)>');
    const { root } = await boot(todos, [json({ items: [hostile], total: 1 })]);
    const [row] = rows(root);
    assert.equal(row!.findAll(element => element.tagName === 'IMG').length, 0);
    assert.match(row!.textContent, /<img src=x onerror=alert\(1\)>/);
});

test('client: an edit in progress survives a re-render (defect 1), including focus and caret', async () => {
    const { root, document, calls } = await boot(todos, [json({ items: [record('a', 'Buy milk')], total: 1 }), json({ items: [record('a', 'Buy milk')], total: 1 })]);
    rows(root)[0]!.button('Edit').dispatch('click');
    let input = root.keyed('a:title');
    assert.equal(input.value, 'Buy milk');
    input.value = 'Buy oat milk and a longer title';
    input.dispatch('input');
    input.focus();
    input.selectionStart = 4; input.selectionEnd = 4;
    // Anything that re-renders the list (here a reload from the server, which returns the stored text) must keep the draft.
    root.button('Refresh').dispatch('click');
    await settle();
    assert.equal(calls.length, 2);
    input = root.keyed('a:title');
    assert.equal(input.value, 'Buy oat milk and a longer title');
    assert.equal(document.activeElement, input);
    assert.deepEqual([input.selectionStart, input.selectionEnd], [4, 4]);
    // Cancel discards the draft and shows the stored text again.
    rows(root)[0]!.button('Cancel').dispatch('click');
    assert.match(rows(root)[0]!.textContent, /Buy milk/);
});

test('client: a saved edit sends only the draft, replaces the record and leaves edit mode', async () => {
    const { root, calls } = await boot(todos, [json({ items: [record('a', 'Buy milk')], total: 1 }), (call) => json({ ...record('a', String((call.body as { title: string }).title)), updatedAt: 'later' })]);
    rows(root)[0]!.button('Edit').dispatch('click');
    const input = root.keyed('a:title');
    input.value = 'Buy oats'; input.dispatch('input');
    rows(root)[0]!.button('Save').dispatch('click');
    await settle();
    assert.deepEqual(calls[1], { method: 'PATCH', url: '/api/todos/a', body: { title: 'Buy oats', done: false } });
    assert.equal(rows(root)[0]!.findAll(element => element.tagName === 'INPUT' && element.type !== 'checkbox').length, 0);
    assert.match(rows(root)[0]!.textContent, /Buy oats/);
});

test('client: a refused save keeps the draft and shows the server\'s field message', async () => {
    const { root } = await boot(todos, [json({ items: [record('a', 'Buy milk')], total: 1 }), json({ error: { code: 'invalid', message: 'x', fields: { title: 'must be at most 200 characters' } } }, 400)]);
    rows(root)[0]!.button('Edit').dispatch('click');
    const input = root.keyed('a:title');
    input.value = 'still typing'; input.dispatch('input');
    rows(root)[0]!.button('Save').dispatch('click');
    await settle();
    assert.equal(root.keyed('a:title').value, 'still typing');
    assert.match(rows(root)[0]!.textContent, /must be at most 200 characters/);
    assert.match(status(root), /highlighted fields/);
});

test('client: an optimistic checkbox is rolled back when the update fails (defect 2)', async () => {
    let release!: (response: Response) => void;
    const held = new Promise<Response>(resolve => { release = resolve; });
    const { root, calls } = await boot(todos, [json({ items: [record('a', 'Buy milk')], total: 1 }), () => held]);
    let box = root.keyed('a:done');
    assert.equal(box.checked, false);
    box.checked = true; box.dispatch('change');
    // In flight: the screen already shows the new value and refuses a second toggle.
    box = root.keyed('a:done');
    assert.equal(box.checked, true);
    assert.equal(box.disabled, true);
    assert.deepEqual(calls[1], { method: 'PATCH', url: '/api/todos/a', body: { done: true } });
    release(json({ error: { code: 'internal', message: 'no' } }, 500));
    await settle();
    box = root.keyed('a:done');
    assert.equal(box.checked, false, 'the checkbox must not stay flipped after a failed update');
    assert.equal(box.disabled, false);
    assert.match(status(root), /not saved/);
});

test('client: a network failure also rolls back, and a successful toggle keeps the server\'s record', async () => {
    const failing = await boot(todos, [json({ items: [record('a', 'x')], total: 1 }), () => Promise.reject(new TypeError('offline'))]);
    failing.root.keyed('a:done').checked = true; failing.root.keyed('a:done').dispatch('change');
    await settle();
    assert.equal(failing.root.keyed('a:done').checked, false);
    const working = await boot(todos, [json({ items: [record('a', 'x')], total: 1 }), json(record('a', 'x', true))]);
    working.root.keyed('a:done').checked = true; working.root.keyed('a:done').dispatch('change');
    await settle();
    assert.equal(working.root.keyed('a:done').checked, true);
});

test('client: create posts typed values, shows field errors from the server and clears the form on success', async () => {
    const { root, calls } = await boot(todos, [json({ items: [], total: 0 }), json({ error: { code: 'invalid', message: 'x', fields: { title: 'must be at least 1 characters' } } }, 400), json(record('n', 'Walk dog'), 201)]);
    assert.match(root.textContent, /Nothing here yet/);
    const form = root.find(element => element.tagName === 'FORM');
    assert.equal(form.dispatch('submit').defaultPrevented, true);
    await settle();
    assert.deepEqual(calls[1], { method: 'POST', url: '/api/todos', body: { title: '', done: false } });
    assert.match(root.textContent, /must be at least 1 characters/);
    const title = root.find(element => element.getAttribute('name') === 'title' && element.tagName === 'INPUT');
    title.value = 'Walk dog';
    form.dispatch('submit');
    await settle();
    assert.equal(calls[2]!.body && (calls[2]!.body as { title: string }).title, 'Walk dog');
    assert.equal(rows(root).length, 1);
    assert.equal(title.value, '');
});

test('client: delete removes the row on 204 and keeps it with a message on failure', async () => {
    const { root, calls } = await boot(todos, [json({ items: [record('a', 'one'), record('b', 'two')], total: 2 }), new Response(null, { status: 204 }), json({ error: { code: 'internal', message: 'no' } }, 500)]);
    rows(root)[0]!.button('Delete').dispatch('click');
    await settle();
    assert.equal(calls[1]!.method, 'DELETE');
    assert.equal(rows(root).length, 1);
    rows(root)[0]!.button('Delete').dispatch('click');
    await settle();
    assert.equal(rows(root).length, 1);
    assert.match(status(root), /not deleted/);
});

test('client: pages follow the cursor and a read-only collection offers no write controls', async () => {
    const { root, calls } = await boot(todos, [json({ items: [record('a', 'one')], total: 2, next: '1' }), json({ items: [record('b', 'two')], total: 2 })], true);
    assert.equal(root.findAll(element => element.tagName === 'FORM').length, 0);
    assert.equal(root.findAll(element => element.tagName === 'BUTTON' && element.textContent === 'Edit').length, 0);
    root.button('Load more').dispatch('click');
    await settle();
    assert.equal(calls[1]!.url, '/api/todos?cursor=1');
    assert.equal(rows(root).length, 2);
});

test('client: a failed load says so and a wrong shape is ignored', async () => {
    const { root } = await boot(todos, [json({ error: { code: 'internal', message: 'x' } }, 500)]);
    assert.match(status(root), /could not be loaded/);
    const document = new FakeDocument();
    const bad = document.createElement('div'); bad.setAttribute('data-ui-crud', ''); bad.setAttribute('data-api', '//evil.example/x'); bad.setAttribute('data-fields', '[]'); bad.setAttribute('data-copy', '{}');
    document.roots.push(bad);
    const server = fakeFetch([]);
    new Function('document', 'fetch', crudScript)(document, server.fetch);
    await settle();
    assert.equal(server.calls.length, 0, 'a protocol-relative api base is never fetched');
});

test('the ui configuration schema has no screens block: screens arrive from the extension that owns the collection', async () => {
    const Ajv = ((await import('ajv')) as unknown as { default: new (options: object) => { compile(schema: object): (data: unknown) => boolean } }).default;
    const { $schema: _draft, ...schema } = uiConfigSchema;
    const validate = new Ajv({ strict: true }).compile(schema);
    assert.equal(validate({}), true);
    assert.equal(validate({ screens: { '/todos': { collection: 'todos', title: 'Todos' } } }), false);
});

test('columns select, order and relabel fields; the default output is unchanged', () => {
    const wide: CrudCollection = { mount: '/api/todos', fields: { title: { type: 'string', required: true, maxLength: 200 }, notes: { type: 'string' }, done: { type: 'boolean', default: false } } };
    assert.deepEqual(crudFields(wide, undefined), crudFields(wide));
    assert.equal(crudMarkup(context, { collection: wide, title: 'T' }).html, crudMarkup(context, { collection: wide, title: 'T', columns: undefined }).html);
    const picked = crudFields(wide, ['done', { field: 'title', label: 'What <b>to</b> do' }]);
    assert.deepEqual(picked.map(f => [f.n, f.l]), [['done', 'Done'], ['title', 'What <b>to</b> do']]);
    const html = crudMarkup(context, { collection: wide, title: 'T', columns: [{ field: 'title', label: '"><script>x</script>' }, 'done'] }).html;
    assert.equal(html.includes('<script>'), false);
    assert.equal(html.includes('&lt;script&gt;'), true);
});

test('columns validation names the offending key', () => {
    const c: CrudCollection = { mount: '/api/todos', fields: { title: { type: 'string', required: true }, done: { type: 'boolean' } } };
    assert.throws(() => crudFields(c, ['nope']), /nope/);
    assert.throws(() => crudFields(c, ['title', 'title']), /twice: title/);
    assert.throws(() => crudFields(c, ['done']), /omits required field title/);
    assert.doesNotThrow(() => crudFields({ ...c, readOnly: true }, ['done']));
    assert.throws(() => crudFields(c, [{ field: 'title', label: 'a\nb' }]), /label for title/);
    assert.throws(() => crudFields(c, [{ field: 'title', label: 'x'.repeat(81) }]), /label for title/);
    assert.throws(() => crudFields(c, [{ field: 'title', lable: 'x' } as never]), /columns\[0\].*lable/);
    assert.throws(() => crudFields(c, []), /columns/);
    assert.throws(() => crudFields(c, ['__proto__']), /__proto__/);
});

/** A project whose YAML declares another extension's collections and screens; ui must never read them. */
async function projectWithForeignScreens(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-ui-crud-'));
    await writeFile(join(root, 'urlcode.yaml'), `version: "1"\nextensions:\n  ui:\n    version: "1"\n    config: {}\n  store:\n    version: "1"\n    config:\n      collections: ${JSON.stringify({ todos: { mount: '/api/todos', fields: todos.fields } })}\n      screens: {"/todos": {collection: todos}}\nroutes:\n  /assets/ui/*: {extension: ui}\n  /todos/*: {extension: ui}\n`);
    return root;
}
const sha = 'a'.repeat(64);
// A bare source is contributed by `store`, as composeHost would stamp it; a {from, source} names its own contributor.
const activate = async (root: string, mounts: string[], screens: (UiScreenSource | UiScreenContribution)[] = []) => createUiExtension({ projectSha256: sha, projectRoot: root, screens: screens.map(screen => typeof screen === 'function' ? { from: 'store', source: screen } : screen) }).registration.activate({}, { origin: 'https://example.test', target: 'node', projectSha256: sha, mounts, root });
const source = (screens: Record<string, unknown>): UiScreenSource => () => screens as Record<string, UiScreen>;
const screenRequest = (path: string, mount: string, method = 'GET'): ExtensionRequest => ({ method, target: path, path, query: new URLSearchParams(), headers: new Headers(), headerCounts: {}, body: new Uint8Array(), origin: 'https://example.test', route: `${mount}/*`, mount, client: null, requestId: 'test-request', env: {} });

test('the ui extension serves a contributed screen at its exact mount', async () => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-ui-crud-'));
    let seen: string | undefined;
    const instance = await activate(root, ['/assets/ui', '/todos'], [context => { seen = context.root; return { '/todos': { title: 'My todos', collection: todos } }; }]);
    assert.equal(seen, root, 'the source receives the route project root');
    const page = await instance.handle(screenRequest('/todos', '/todos'));
    assert.equal(page.status, 200);
    const html = new TextDecoder().decode(page.body as Uint8Array);
    assert.match(html, /<h2 class="ui-card-title" data-slot="card-title">My todos<\/h2>/);
    assert.match(html, /data-api="\/api\/todos"/);
    assert.match(html, /\/assets\/ui\/static\/crud\.[0-9a-f]{12}\.js/);
    assert.equal((await instance.handle(screenRequest('/todos/extra', '/todos'))).status, 404);
    assert.equal((await instance.handle(screenRequest('/todos', '/todos', 'POST'))).status, 405);
    assert.equal((await instance.handle(screenRequest('/todos', '/todos', 'HEAD'))).body, undefined);
    // The asset mount still serves assets.
    const css = await instance.handle({ ...screenRequest('/assets/ui/static/kit.x.css', '/assets/ui'), route: '/assets/ui/*' });
    assert.equal(css.status, 404);
});

test('ui never reads another extension\'s YAML: screens declared there are served only through a contribution (#709)', async () => {
    const root = await projectWithForeignScreens();
    // Without a contribution the /todos mount is just a second asset mount, which ui refuses; it does not go looking for store config.
    await assert.rejects(activate(root, ['/assets/ui', '/todos']), /exactly one route mount/);
    const plain = await activate(root, ['/assets/ui']);
    assert.equal((await plain.handle(screenRequest('/todos', '/assets/ui'))).status, 404);
    // The source code carries no knowledge of the store's name, package or configuration layout.
    const { readdir, readFile } = await import('node:fs/promises');
    const sources = join(import.meta.dirname, '..', 'src');
    const files = (await readdir(sources, { recursive: true })).filter(file => file.endsWith('.ts'));
    for (const file of files) {
        const text = await readFile(join(sources, file), 'utf8');
        assert.doesNotMatch(text, /urlcode-store|extensions\.store|extensions\?\.store|loadDocument|installed\.includes\('store'\)/, `${file} must not reach into the store`);
    }
});

test('the ui extension refuses a contributed screen with no route, a duplicate path, a bad title or a bad shape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-ui-crud-'));
    const good = source({ '/todos': { title: 'Todos', collection: todos } });
    await assert.rejects(activate(root, ['/assets/ui'], [good]), /needs a route \/todos\/\*/);
    await assert.rejects(activate(root, ['/todos'], [good]), /exactly one route mount/);
    await assert.rejects(activate(root, ['/assets/ui', '/todos'], [good, { from: 'notes', source: good }]), /ui screen \/todos is contributed by extension "store" and by extension "notes"/);
    await assert.rejects(activate(root, ['/assets/ui', '/todos'], [source({ '/todos': { title: '', collection: todos } })]), /plain title/);
    await assert.rejects(activate(root, ['/assets/ui', '/todos'], [source({ '/todos': { title: 'a\nb', collection: todos } })]), /plain title/);
    await assert.rejects(activate(root, ['/assets/ui', '/x'], [source({ 'x': { title: 'X', collection: todos } })]), /absolute literal path/);
    await assert.rejects(activate(root, ['/assets/ui', '/todos'], [source({ '/todos': { title: 'T', collection: { mount: 'api', fields: todos.fields } } })]), /ui screen \/todos: .*mount/);
    await assert.rejects(activate(root, ['/assets/ui'], [(() => 'nope') as unknown as UiScreenSource]), /keyed by path/);
});

test('the ui extension applies contributed columns and refuses a bad column at activation, naming the screen and key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-ui-crud-'));
    const wide = { mount: '/api/todos', fields: { ...todos.fields, notes: { type: 'string' as const } } };
    const instance = await activate(root, ['/assets/ui', '/todos'], [source({ '/todos': { title: 'Todos', collection: wide, columns: ['title', { field: 'done', label: 'Finished' }] } })]);
    const html = new TextDecoder().decode((await instance.handle(screenRequest('/todos', '/todos'))).body as Uint8Array);
    assert.match(html, /Finished/);
    assert.equal(html.includes('Notes'), false);
    await assert.rejects(activate(root, ['/assets/ui', '/todos'], [source({ '/todos': { title: 'Todos', collection: wide, columns: ['ghost'] } })]), /ui screen \/todos: .*ghost/);
});

const queried: CrudCollection = { mount: '/api/todos', sortable: ['title', 'points'], filterable: ['status', 'done', 'points'], fields: { title: { type: 'string', required: true, maxLength: 80 }, status: { type: 'string', enum: ['open', '<b>x</b>'] }, done: { type: 'boolean', default: false }, points: { type: 'integer' } } };

test('a collection with no sortable or filterable declaration renders exactly the shell it did before', () => {
    const html = crudMarkup(context, { collection: todos, title: 'T' }).html;
    assert.ok(!html.includes('data-query'), html);
    assert.ok(!html.includes('"sort"'), html);
    assert.equal(crudMarkup(context, { collection: { ...todos, sortable: [], filterable: [] }, title: 'T' }).html, html);
});

test('sort and filter controls come only from the declared lists, and hostile declarations are refused or escaped', () => {
    const html = crudMarkup(context, { collection: queried, title: 'T', columns: ['title', { field: 'points', label: '"><img src=x>' }] }).html;
    assert.ok(!html.includes('<img') && !html.includes('<b>'), html);
    assert.match(html, /data-query="/);
    assert.match(html, /&quot;s&quot;:\[\{&quot;n&quot;:&quot;title&quot;/);
    const bad = (extra: Partial<CrudCollection>, pattern: RegExp) => assert.throws(() => crudFields({ ...todos, ...extra }), pattern);
    bad({ sortable: ['nope'] }, /does not declare: nope/);
    bad({ sortable: ['__proto__'] }, /does not declare/);
    bad({ filterable: ['constructor'] }, /does not declare/);
    bad({ sortable: ['<script>'.repeat(20)] }, /does not declare/);
    bad({ sortable: ['title', 'title'] }, /cannot use title/);
    bad({ sortable: 'title' as unknown as string[] }, /at most 8/);
    bad({ sortable: [7 as unknown as string] }, /does not declare: 7/);
    bad({ filterable: Array.from({ length: 9 }, () => 'title') }, /at most 8/);
    assert.throws(() => crudFields({ mount: '/api/x', fields: { sort: { type: 'string', maxLength: 5 } }, filterable: ['sort'] }), /cannot use sort/);
});

test('client: the sort select and filters send URLSearchParams-built requests using declared fields only', async () => {
    const { root, calls } = await boot(queried, [json({ items: [record('a', 'one')], total: 3, next: 'abc' }), json({ items: [], total: 0 }), json({ items: [record('b', 'two')], total: 1, next: 'zz' }), json({ items: [], total: 0 })]);
    assert.equal(calls[0]!.url, '/api/todos');
    const box = root.find(element => element.getAttribute('id') === 'crud-sort');
    assert.deepEqual(box.children.map(option => option.getAttribute('value')), ['', 'title', '-title', 'points', '-points']);
    assert.equal(root.find(element => element.tagName === 'LABEL' && element.textContent === 'Sort by').getAttribute('for'), 'crud-sort');
    assert.deepEqual(root.findAll(element => (element.getAttribute('id') ?? '').startsWith('crud-filter-')).map(element => element.getAttribute('name')), ['status', 'done', 'points']);
    box.value = '-points';
    root.find(element => element.getAttribute('id') === 'crud-filter-status').value = '<b>x</b>&a=1';
    root.find(element => element.getAttribute('id') === 'crud-filter-done').value = 'true';
    box.dispatch('change');
    await settle();
    assert.equal(calls[1]!.url, '/api/todos?sort=-points&status=%3Cb%3Ex%3C%2Fb%3E%26a%3D1&done=true');
    root.find(element => element.getAttribute('id') === 'crud-filter-done').dispatch('change');
    await settle();
    // Load more repeats the applied sort and filters with the cursor, and never picks up a control edited since.
    root.button('Load more').dispatch('click');
    await settle();
    assert.equal(calls[3]!.url, '/api/todos?sort=-points&status=%3Cb%3Ex%3C%2Fb%3E%26a%3D1&done=true&cursor=zz');
    assert.equal(root.findAll(element => element.tagName === 'SELECT').length, 4);
});

test('client: a collection without declarations shows no sort or filter controls', async () => {
    const { root, calls } = await boot(todos, [json({ items: [], total: 0 })]);
    assert.equal(root.findAll(element => (element.getAttribute('id') ?? '').startsWith('crud-filter-') || element.getAttribute('id') === 'crud-sort').length, 0);
    assert.equal(root.findAll(element => element.className === 'ui-crud-query').length, 0);
    assert.equal(calls[0]!.url, '/api/todos');
});
