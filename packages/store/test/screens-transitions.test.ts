// Screens over collections with transitionOnly fields (#863 item 2), end to end: the store contributes an owner's
// screen and a reviewers' screen (bound to the readers mount) to ui, a synthetic principal provider signs each
// "browser" in, and ui's served crud script runs against a small fake DOM whose fetch goes to the real server with
// the page's Origin, as a same-origin browser request would. Every write below is the script's own request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import type { ExtensionRequest, RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { composeHost } from '@jimhoyd/urlcode/host';
import ui from '@jimhoyd/urlcode-ui/extension';
import store from '../src/extension.ts';
import { addMember } from '../src/index.ts';
import type { CollectionSpec } from '../src/index.ts';
import { cleanup } from './cleanup.ts';
import { FakeDocument } from './fake-dom.ts';
import { records } from './rows.ts';

const origin = 'https://requests.example.test';
const collections = {
  reviewers: { membership: true, key: 'userId', fields: { userId: { type: 'string', required: true, maxLength: 128 } } },
  requests: {
    mount: '/api/requests', ownership: 'owner', idempotency: { maxKeys: 100 }, filterable: ['status'],
    fields: {
      title: { type: 'string', required: true, maxLength: 120 },
      status: { type: 'string', enum: ['pending', 'approved', 'withdrawn'], default: 'pending', transitionOnly: true },
      reviewedBy: { type: 'string', maxLength: 128, transitionOnly: true },
    },
    transitions: {
      withdraw: { from: { status: 'pending' }, set: { status: 'withdrawn' } },
      approve: { from: { status: 'pending' }, set: { status: 'approved' }, stamp: { reviewedBy: 'actor' }, by: 'others', members: 'reviewers', mount: '/api/approvals' },
    },
    readers: { mount: '/api/review', members: 'reviewers' },
  },
};
const signedIn = { policies: { extensions: { badge: {} } } };

/** A synthetic principal provider: `Authorization: Badge <id>` signs a request in; nothing else does. */
async function badge(project: string): Promise<RuntimeExtension> {
  return {
    name: 'badge', version: '1', projectSha256: await inspectExtensionRevision(project), targets: ['node'], providesPrincipal: true,
    schema: { type: 'object', additionalProperties: false }, policySchema: { type: 'object', additionalProperties: false },
    activate() {
      return {
        handle() { return { status: 404, headers: [] }; },
        authorize(_policy: unknown, request: ExtensionRequest) {
          const match = /^Badge (\S+)$/.exec(request.headers.get('authorization') ?? '');
          if (!match) return { status: 401, headers: [['content-type', 'text/plain']], body: 'no badge' };
          request.setPrincipal!({ id: match[1]! });
          return undefined;
        },
      };
    },
  };
}

async function serve(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'store-transition-screens-')); cleanup(t, () => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app'), database = join(root, 'data', 'store.sqlite');
  await mkdir(project);
  const scaffolded = await ui.definition.scaffold!({ site: root, project, installed: ['store', 'ui'], acknowledgements: [] });
  for (const file of scaffolded.files ?? []) { await mkdir(join(root, file.path, '..'), { recursive: true }); await writeFile(join(root, file.path), file.content); }
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({
    version: '1',
    extensions: {
      badge: { version: '1', config: {} },
      ui: { version: '1', config: scaffolded.config },
      store: { version: '1', config: { collections, screens: { '/requests': { collection: 'requests' }, '/review': { collection: 'requests', readers: true, title: 'Review' } } } },
    },
    routes: {
      ...scaffolded.routes,
      '/requests/*': { extension: 'ui', methods: ['GET', 'HEAD'] },
      '/review/*': { extension: 'ui', methods: ['GET', 'HEAD'] },
      '/api/requests/*': { extension: 'store', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], ...signedIn },
      '/api/approvals/*': { extension: 'store', methods: ['POST'], ...signedIn },
      '/api/review/*': { extension: 'store', methods: ['GET', 'HEAD'], ...signedIn },
    },
  }));
  const sha = await inspectExtensionRevision(project);
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = sha;
  cleanup(t, () => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
  const host = await composeHost(pathToFileURL(join(root, 'host.mjs')), [ui(), store({ database })]);
  cleanup(t, () => host.close?.());
  const app = await startServer({ project, origin, port: 0, log: () => {}, extensions: [await badge(project), ...host.extensions!] });
  cleanup(t, () => app.close());
  const base = `http://127.0.0.1:${app.address.port}`;
  await addMember(database, { collections: collections as unknown as Record<string, CollectionSpec>, collection: 'reviewers', principal: 'rita' });
  return { base, database };
}

interface Sent { method: string; url: string; headers: Record<string, string>; status: number }
/**
 * Opens a served screen as `who`: reads the page's data attributes and its crud script from the server, and runs the
 * script with a fetch that sends the page's Origin and the badge. Every response is read in full before the script
 * sees it, so `idle()` can wait for the network. `strip` removes the list's ETags, as a list without them would read.
 */
async function open(site: { base: string }, path: string, who: string, options: { strip?: boolean } = {}) {
  const page = await fetch(`${site.base}${path}`, { headers: { authorization: `Badge ${who}` } });
  const html = await page.text();
  assert.equal(page.status, 200, html);
  assert.ok(!/<script(?![^>]* nonce=")/.test(html), 'no script without the page nonce');
  const csp = page.headers.get('content-security-policy') ?? '';
  assert.match(csp, /connect-src 'self'/); assert.ok(!/unsafe-inline|unsafe-eval/.test(csp), csp);
  const script = await (await fetch(`${site.base}${/src="(\/assets\/ui\/static\/crud\.[0-9a-f]{12}\.js)"/.exec(html)![1]!}`)).text();
  const document = new FakeDocument(), root = document.createElement('div');
  const shell = /<div class="ui-crud"[^>]*>/.exec(html)![0];
  for (const [, name, value] of shell.matchAll(/ (data-[a-z-]+)(?:="([^"]*)")?/g)) root.setAttribute(name!, (value ?? '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  document.roots.push(root);
  const sent: Sent[] = [], inflight = new Set<Promise<unknown>>();
  const browser = (async (url: string, init: RequestInit = {}) => {
    const headers = { ...(init.headers as Record<string, string>), origin, authorization: `Badge ${who}` };
    const work = (async () => {
      const response = await fetch(`${site.base}${url}`, { ...init, headers });
      let body: string | null = response.status === 204 ? null : await response.text();
      sent.push({ method: init.method ?? 'GET', url, headers, status: response.status });
      if (options.strip && body !== null && (init.method ?? 'GET') === 'GET') { const listed = JSON.parse(body) as { etags?: unknown }; delete listed.etags; body = JSON.stringify(listed); }
      return new Response(body, { status: response.status, headers: response.headers });
    })();
    inflight.add(work); void work.finally(() => inflight.delete(work)).catch(() => {});
    return work;
  }) as unknown as typeof fetch;
  new Function('document', 'fetch', script)(document, browser);
  const turns = async () => { for (let turn = 0; turn < 8; turn++) await new Promise<void>(resolve => setImmediate(resolve)); };
  const idle = async () => { for (;;) { await turns(); if (!inflight.size) return; await Promise.allSettled([...inflight]); } };
  await idle();
  const row = (title: string) => root.find(element => element.tagName === 'LI' && element.getAttribute('data-id') !== null && element.textContent.includes(title));
  const click = async (title: string, label: string) => { row(title).button(label).dispatch('click'); await idle(); };
  const create = async (title: string) => {
    root.find(element => element.tagName === 'INPUT' && element.getAttribute('name') === 'title').value = title;
    root.find(element => element.tagName === 'FORM').dispatch('submit');
    await idle();
  };
  const message = () => root.find(element => element.className === 'ui-crud-status').textContent;
  const offered = (title: string) => row(title).findAll(element => element.getAttribute('data-transition') !== null).map(element => element.getAttribute('data-transition'));
  return { root, sent, idle, row, click, create, message, offered, reload: async () => { root.button('Refresh').dispatch('click'); await idle(); } };
}

test('an owner withdraws and a reviewer approves through the served screens; a stale page is 412, a conflict 409, a refusal 403', async t => {
  const site = await serve(t);
  const stored = (title: string) => records(site.database, 'requests').find(record => record.title === title)!;

  // The owner's screen: the create form has no transitionOnly control, and the create body names none.
  const ann = await open(site, '/requests', 'ann');
  assert.deepEqual(ann.root.find(element => element.tagName === 'FORM').findAll(element => element.getAttribute('name') !== null).map(element => element.getAttribute('name')), ['title']);
  await ann.create('laptop');
  assert.equal(ann.sent.at(-1)!.status, 201);
  assert.match(ann.row('laptop').textContent, /pending/);
  assert.deepEqual(ann.offered('laptop'), ['withdraw'], 'the owner is offered only the transition the owner runs');

  // The reviewer's screen lists every owner's records through the readers mount and offers only approve.
  const rita = await open(site, '/review', 'rita');
  assert.equal(rita.root.findAll(element => element.tagName === 'FORM').length, 0, 'the readers screen is read-only');
  assert.deepEqual(rita.offered('laptop'), ['approve']);
  await rita.click('laptop', 'Approve');
  const approval = rita.sent.at(-1)!;
  assert.deepEqual([approval.method, approval.url, approval.status], ['POST', `/api/approvals/${stored('laptop').id as string}`, 200]);
  assert.match(approval.headers['if-match']!, /^"[0-9a-f]{32}"$/);
  assert.match(approval.headers['idempotency-key']!, /^[0-9a-f]{32}$/);
  assert.equal(approval.headers.origin, origin);
  assert.match(rita.row('laptop').textContent, /approved.*rita/);
  assert.deepEqual(rita.offered('laptop'), [], 'an approved request offers nothing');
  assert.deepEqual([stored('laptop').status, stored('laptop').reviewedBy], ['approved', 'rita']);

  // Ann's page still shows pending: her withdraw carries the ETag she listed, so the store refuses it with 412.
  assert.deepEqual(ann.offered('laptop'), ['withdraw']);
  await ann.click('laptop', 'Withdraw');
  assert.equal(ann.sent.at(-1)!.status, 412);
  assert.match(ann.message(), /changed since the list was loaded/);
  assert.equal(stored('laptop').status, 'approved', 'nothing was written');
  await ann.reload();
  assert.deepEqual(ann.offered('laptop'), [], 'after a refresh the page shows the approval');

  // The owner's transition succeeds on a current page.
  await ann.create('desk');
  await ann.click('desk', 'Withdraw');
  assert.equal(ann.sent.at(-1)!.status, 200);
  assert.equal(ann.sent.at(-1)!.url, `/api/requests/${stored('desk').id as string}/withdraw`);
  assert.match(ann.row('desk').textContent, /withdrawn/);
  assert.equal(ann.message(), '');
  assert.equal(stored('desk').status, 'withdrawn');

  // Without a listed ETag the script sends no If-Match, so a record that left the from state is the store's 409.
  await ann.create('chair');
  const unconditioned = await open(site, '/requests', 'ann', { strip: true });
  await rita.reload();
  await rita.click('chair', 'Approve');
  await unconditioned.click('chair', 'Withdraw');
  assert.equal(unconditioned.sent.at(-1)!.headers['if-match'], undefined);
  assert.equal(unconditioned.sent.at(-1)!.status, 409);
  assert.match(unconditioned.message(), /no longer applies/);
  assert.equal(stored('chair').status, 'approved');

  // A reviewer's own request is listed with approve (its state allows it), and the store refuses it: a 403 message.
  const own = await open(site, '/requests', 'rita');
  await own.create('monitor');
  await rita.reload();
  await rita.click('monitor', 'Approve');
  assert.equal(rita.sent.at(-1)!.status, 403);
  assert.match(rita.message(), /not allowed/);
  assert.equal(stored('monitor').status, 'pending');

  // A signed-in non-member gets the readers mount's 403: the list does not load, and nothing is offered.
  const bob = await open(site, '/review', 'bob');
  assert.equal(bob.sent[0]!.status, 403);
  assert.match(bob.message(), /could not be loaded/);
});

test('field values and a hostile title stay text on the served screen', async t => {
  const site = await serve(t);
  const ann = await open(site, '/requests', 'ann');
  const payload = '"><img src=x onerror=alert(1)><script>alert(1)</script>';
  await ann.create(payload);
  const rita = await open(site, '/review', 'rita');
  for (const screen of [ann, rita]) {
    assert.equal(screen.root.findAll(element => element.tagName === 'IMG' || element.tagName === 'SCRIPT').length, 0);
    assert.ok(screen.row(payload).textContent.includes(payload));
  }
  // The page itself never carries a record value: the shell is rendered before any record is read.
  const html = await (await fetch(`${site.base}/review`, { headers: { authorization: 'Badge rita' } })).text();
  assert.ok(!html.includes('onerror'), 'no record value in the served markup');
});

// #873 item 1: edits and deletes through the served screen carry If-Match too, so a stale page changes nothing.
test('a stale edit and a stale delete are 412 with a page message and nothing written; a current page edits then deletes', async t => {
  const site = await serve(t);
  const stored = () => records(site.database, 'requests').find(record => String(record.title).startsWith('lamp'));
  const current = await open(site, '/requests', 'ann');
  await current.create('lamp');
  const stale = await open(site, '/requests', 'ann');
  // One record per page, so its row is the only one; an edit row shows the title as an input value, not text.
  const only = (screen: Awaited<ReturnType<typeof open>>) => screen.root.find(element => element.tagName === 'LI' && element.getAttribute('data-id') !== null);
  const edit = async (screen: Awaited<ReturnType<typeof open>>, to: string) => {
    only(screen).button('Edit').dispatch('click');
    const input = only(screen).find(element => element.tagName === 'INPUT' && element.getAttribute('name') === 'title');
    input.value = to; input.dispatch('input');
    only(screen).button('Save').dispatch('click');
    await screen.idle();
  };

  await edit(current, 'lamp two');
  const saved = current.sent.at(-1)!;
  assert.deepEqual([saved.method, saved.status], ['PATCH', 200]);
  assert.match(saved.headers['if-match']!, /^"[0-9a-f]{32}"$/);
  assert.equal(stored()!.title, 'lamp two');

  // The other page still holds the ETag it listed: its edit and its delete are both refused.
  await edit(stale, 'lamp mine');
  assert.deepEqual([stale.sent.at(-1)!.method, stale.sent.at(-1)!.status], ['PATCH', 412]);
  assert.equal(stale.sent.at(-1)!.headers['if-match'], saved.headers['if-match'], 'the version both pages listed');
  assert.match(stale.message(), /changed since the list was loaded/);
  assert.equal(stored()!.title, 'lamp two', 'the stale edit wrote nothing');
  only(stale).button('Cancel').dispatch('click');
  await stale.click('lamp', 'Delete');
  assert.deepEqual([stale.sent.at(-1)!.method, stale.sent.at(-1)!.status], ['DELETE', 412]);
  assert.match(stale.message(), /changed since the list was loaded/);
  assert.ok(stored(), 'the stale delete removed nothing');
  assert.ok(stale.row('lamp'), 'the stale page keeps the row');

  // The current page moved to the ETag its edit returned, so its delete goes through.
  await current.click('lamp two', 'Delete');
  const removed = current.sent.at(-1)!;
  assert.deepEqual([removed.method, removed.status], ['DELETE', 204]);
  assert.match(removed.headers['if-match']!, /^"[0-9a-f]{32}"$/);
  assert.notEqual(removed.headers['if-match'], saved.headers['if-match'], 'the delete used the ETag the edit returned');
  assert.equal(stored(), undefined);
  assert.equal(current.message(), '');
});
