/**
 * Real-browser check of the CRUD screen client script (#332). It needs no
 * dependency: it starts the browser that GitHub-hosted Linux runners already
 * carry (or CHROME_BIN), drives it over the DevTools protocol with Node's
 * built-in WebSocket, and serves the shipped page and script from a loopback
 * server exactly as `crudScreen` produces them, strict CSP included.
 *
 * Run it with `npm run test:browser`. It is deliberately not part of `npm test`
 * (the default suite stays browser-free). Without a browser it skips, unless
 * URLCODE_REQUIRE_BROWSER=1, which CI sets so a missing browser fails loudly.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crudScreen } from '../../src/crud.ts';
import type { CrudCollection } from '../../src/crud.ts';
import { createKit } from '../../src/kit.ts';
import { createPresentation } from '../../src/presentation.ts';

const collection: CrudCollection = { mount: '/api/todos', fields: { title: { type: 'string', required: true, maxLength: 200 }, done: { type: 'boolean', default: false } } };
const kit = createKit({ presentation: createPresentation({ defaults: {} }), assetsBase: '/assets/ui' });
const page = crudScreen(kit, { collection, title: 'Todos' });
const hostile = '<img src=x onerror="window.__pwned=1">';
const stamp = '2026-01-01T00:00:00.000Z';
const record = (id: string, title: string, done = false) => ({ id, title, done, createdAt: stamp, updatedAt: stamp });

function findBrowser(): string | undefined {
    const candidates = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'];
    return candidates.find((path): path is string => !!path && existsSync(path));
}
const browserPath = findBrowser();
const skip = browserPath || process.env.URLCODE_REQUIRE_BROWSER === '1' ? false : 'no Chrome/Chromium found (set CHROME_BIN)';

let server: Server | undefined, base = '', chrome: ChildProcess | undefined, profile = '', socket: WebSocket | undefined, nextId = 1;
type Reply = { result?: unknown; error?: { message: string } };
const waiting = new Map<number, (message: Reply) => void>();
let todos: ReturnType<typeof record>[] = [];
let patchFails = false;
const patches: unknown[] = [];

async function command<T = unknown>(method: string, params: object = {}): Promise<T> {
    const id = nextId++;
    const reply = new Promise<Reply>(resolve => waiting.set(id, resolve));
    socket!.send(JSON.stringify({ id, method, params }));
    const message = await reply;
    if (message.error) throw new Error(`${method}: ${message.error.message}`);
    return message.result as T;
}
async function run<T = unknown>(expression: string): Promise<T> {
    const out = await command<{ result: { value: T }; exceptionDetails?: { text: string } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) throw new Error(`evaluate failed: ${expression}: ${out.exceptionDetails.text}`);
    return out.result.value;
}
async function until(expression: string, what: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (await run<boolean>(`Boolean(${expression})`)) return;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${what}`);
}
async function open(): Promise<void> {
    await command('Page.navigate', { url: `${base}/todos` });
    // The script appends an empty `.ui-crud-list` synchronously, then loads the
    // collection over `fetch` and renders into it asynchronously. Waiting for the
    // container alone races that load: on a slow/contended runner the first
    // interaction (a click on a row's "Edit" button, or a record's checkbox) can
    // land before any row exists, throwing `Cannot read properties of undefined`.
    // `render()` always appends at least one `<li>` once the first load settles
    // (an item row or the empty-state row), so waiting for a child is the real
    // readiness signal.
    await until(`document.querySelector('.ui-crud-list') && document.querySelector('.ui-crud-list').children.length > 0`, 'the collection to finish loading');
}
function reply(response: ServerResponse, status: number, type: string, body: string | Uint8Array): void {
    response.writeHead(status, { 'content-type': type });
    response.end(body);
}

before(async () => {
    if (skip) return;
    server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://x');
        if (url.pathname === '/todos') { response.writeHead(200, Object.fromEntries(page.headers)); response.end(page.body); return; }
        const asset = kit.assets.find(candidate => url.pathname.endsWith(`/${candidate.name}`));
        if (asset) return reply(response, 200, asset.contentType, asset.body);
        if (url.pathname === '/api/todos') return reply(response, 200, 'application/json', JSON.stringify({ items: todos, total: todos.length }));
        const id = /^\/api\/todos\/([^/]+)$/.exec(url.pathname)?.[1];
        if (id && request.method === 'PATCH') {
            const chunks: Buffer[] = [];
            request.on('data', chunk => chunks.push(chunk as Buffer));
            request.on('end', () => {
                const body = JSON.parse(Buffer.concat(chunks).toString()) as object;
                patches.push(body);
                // Held briefly so the optimistic state is observable before the answer.
                setTimeout(() => {
                    if (patchFails) return reply(response, 500, 'application/json', JSON.stringify({ error: { code: 'internal', message: 'no' } }));
                    const found = todos.find(todo => todo.id === id)!;
                    Object.assign(found, body);
                    reply(response, 200, 'application/json', JSON.stringify(found));
                }, 300);
            });
            return;
        }
        reply(response, 404, 'text/plain', 'not found');
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    profile = await mkdtemp(join(tmpdir(), 'urlcode-crud-browser-'));
    const child = spawn(browserPath!, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    chrome = child;
    const endpoint = await new Promise<string>((resolve, reject) => {
        let seen = '';
        const timer = setTimeout(() => reject(new Error(`browser did not report a debugging endpoint: ${seen}`)), 30_000);
        child.stderr!.on('data', chunk => {
            seen += String(chunk);
            const match = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
            if (match) { clearTimeout(timer); resolve(match[1]!); }
        });
        child.on('exit', code => reject(new Error(`browser exited early (${code}): ${seen}`)));
    });
    const origin = new URL(endpoint).origin.replace('ws:', 'http:');
    const target = await (await fetch(`${origin}/json/new?about:blank`, { method: 'PUT' })).json() as { webSocketDebuggerUrl: string };
    const opened = new WebSocket(target.webSocketDebuggerUrl);
    socket = opened;
    await new Promise<void>((resolve, reject) => { opened.onopen = () => resolve(); opened.onerror = () => reject(new Error('debugging socket failed')); });
    opened.onmessage = event => {
        const message = JSON.parse(String(event.data)) as Reply & { id?: number };
        const id = message.id;
        const resolve = typeof id === 'number' && Number.isSafeInteger(id) ? waiting.get(id) : undefined;
        if (typeof resolve === 'function') resolve(message);
    };
    await command('Page.enable');
    // Recorded from inside the page; injected through the protocol, so the page's own CSP does not apply to it.
    await command('Page.addScriptToEvaluateOnNewDocument', { source: `window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective+' '+e.blockedURI));window.addEventListener('error',e=>(window.__errors=window.__errors||[]).push(String(e.message)));` });
});
after(async () => {
    if (skip) return;
    try { socket?.close(); } catch { /* already closed */ }
    chrome?.kill();
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    // The browser may hold profile files briefly on Windows; a leftover temp directory must not fail the run.
    if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
});

test('browser: hostile record markup renders as text and no CSP violation occurs', { skip }, async () => {
    todos = [record('a', hostile)];
    await open();
    assert.equal(await run('document.querySelectorAll(".ui-crud-list img").length'), 0);
    assert.equal(await run('window.__pwned'), undefined);
    assert.equal(await run('document.querySelector(".ui-crud-lead").textContent'), hostile);
    assert.deepEqual(await run('window.__csp'), [], 'the strict CSP must not be violated by the screen');
    assert.equal(await run('window.__errors'), undefined);
    // Control: the policy is genuinely enforced in this browser, so the empty list above means something.
    await run(`(()=>{const s=document.createElement('script');s.textContent='window.__inline=1';document.body.appendChild(s);})()`);
    await until('window.__csp.length > 0', 'the control inline script to be reported');
    assert.equal(await run('window.__inline'), undefined);
});

test('browser: an edit in progress keeps its text, focus and caret across a re-render', { skip }, async () => {
    todos = [record('a', 'Buy milk')];
    await open();
    await run(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Edit').click()`);
    await run(`document.querySelector('[data-ui-key="a:title"]').focus()`);
    await command('Input.insertText', { text: ' and oat milk' });
    await run(`document.querySelector('[data-ui-key="a:title"]').setSelectionRange(4,4)`);
    await run(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Refresh').click()`);
    // The reload re-renders from the server's stored text; the draft must win.
    await until(`!document.querySelector('.ui-crud-bar button').disabled`, 'the reload to finish');
    const state = await run<{ value: string; focused: boolean; caret: number[] }>(`(()=>{const i=document.querySelector('[data-ui-key="a:title"]');return {value:i.value,focused:document.activeElement===i,caret:[i.selectionStart,i.selectionEnd]};})()`);
    assert.deepEqual(state, { value: 'Buy milk and oat milk', focused: true, caret: [4, 4] });
    assert.deepEqual(await run('window.__csp'), []);
});

test('browser: a failed PATCH rolls the checkbox back', { skip }, async () => {
    todos = [record('b', 'Walk dog')];
    patchFails = true;
    patches.length = 0;
    await open();
    try {
        await run(`document.querySelector('[data-ui-key="b:done"]').click()`);
        // In flight the box already shows the new value and refuses a second toggle.
        assert.deepEqual(await run(`(()=>{const c=document.querySelector('[data-ui-key="b:done"]');return [c.checked,c.disabled];})()`), [true, true]);
        await until(`document.querySelector('[data-ui-key="b:done"]').disabled === false`, 'the failed update to settle');
        assert.equal(await run(`document.querySelector('[data-ui-key="b:done"]').checked`), false);
        assert.match(await run<string>(`document.querySelector('.ui-crud-status').textContent`), /not saved/);
        assert.deepEqual(patches, [{ done: true }]);
    } finally { patchFails = false; }
    assert.deepEqual(await run('window.__csp'), []);
});
