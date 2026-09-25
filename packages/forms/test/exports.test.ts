import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import type { ExtensionRequest, RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { createUiExtension } from '@jimhoyd/urlcode-ui/host';
import { createForms, formFlowBodySchema, formsConfigSchema } from '../src/index.ts';
import type { FormFlowBody, FormsExports, FormsFlow } from '../src/index.ts';

// #529: forms' export contract (FormsExports, version 1), proven with a synthetic consumer ("survey") rather than
// form-records: it defines its own flow body, serves it on its own mount and decides what a valid submission does.
const origin = 'https://forms.example.test';
const body: FormFlowBody = {
  title: 'Survey <1>', submitLabel: 'Send',
  confirmation: { title: 'Thanks', message: 'Rated {rating}.', show: ['rating'] },
  fields: {
    rating: { label: 'Rating', control: 'select', options: [{ value: '1', label: 'Poor' }, { value: '5', label: 'Great' }] },
    comment: { label: 'Comment', control: 'textarea', required: false, maxLength: 50 },
    reason: { label: 'Reason', required: false, maxLength: 40 },
  },
};

function survey(projectSha256: string, forms: FormsExports, record: (flow: FormsFlow) => void): RuntimeExtension {
  return {
    name: 'survey', version: '1', projectSha256, targets: ['node'], schema: { type: 'object', additionalProperties: false },
    activate() {
      const flow = forms.define('survey', body), commentOnly = flow.only(['comment']);
      record(flow);
      return {
        handle(request: ExtensionRequest) {
          const scope = request.query.get('scope') ?? 'survey:one';
          if (request.path === '/survey/comment') {
            if (request.method === 'GET') return commentOnly.render(request, { action: '/survey/comment', scope, readOnly: { rating: '5' }, title: 'Edit comment' });
            const sent = commentOnly.submit(request, { action: '/survey/comment', scope });
            return sent.ok ? { status: 200, headers: [['content-type', 'application/json']], body: JSON.stringify(sent.values) } : sent.response;
          }
          if (request.path === '/survey/done') return flow.confirmationPage({ rating: '5' }, { links: [{ href: '/survey', label: 'Again' }] });
          if (request.method === 'GET') return flow.render(request, { action: `/survey?scope=${scope}`, scope });
          const sent = flow.submit(request, { action: '/survey', scope });
          return sent.ok ? { status: 200, headers: [['content-type', 'application/json']], body: JSON.stringify(sent.values) } : sent.response;
        },
      };
    },
  };
}

async function boot(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'forms-exports-')); t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app'); await mkdir(project);
  const own = { mount: '/contact', title: 'Contact', submitLabel: 'Send', confirmation: { title: 'Sent', message: 'Sent.' }, fields: { rating: { label: 'Rating', maxLength: 5 } } };
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { ui: { version: '1', config: {} }, forms: { version: '1', config: { flows: { survey: own } } }, survey: { version: '1', config: {} } },
    routes: { '/assets/ui/*': { extension: 'ui' }, '/contact/*': { extension: 'forms', methods: ['GET', 'HEAD', 'POST'] }, '/survey/*': { extension: 'survey', methods: ['GET', 'POST'] } } }));
  const projectSha256 = await inspectExtensionRevision(project), ui = createUiExtension({ projectRoot: project, projectSha256 });
  const forms = createForms({ ui, projectSha256, csrfSecret: 'c'.repeat(32) });
  assert.equal(forms.exports.version, 1);
  assert.equal(forms.exports.active, false);
  assert.throws(() => forms.exports.define('survey', body), /forms is not active yet/);
  let defined: FormsFlow | undefined;
  const app = await startServer({ project, origin, port: 0, log: () => {}, extensions: [ui.registration, forms.registration, survey(projectSha256, forms.exports, flow => { defined = flow; })] });
  t.after(() => app.close());
  const cookies = new Map<string, string>();
  const call = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const response = await fetch(`http://127.0.0.1:${app.address.port}${path}`, { ...init, redirect: 'manual', headers: { ...(cookies.size ? { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}), ...init.headers } });
    for (const header of response.headers.getSetCookie()) { const first = header.split(';')[0]!, index = first.indexOf('='); cookies.set(first.slice(0, index), first.slice(index + 1)); }
    return response;
  };
  const csrf = async (path: string) => /name="csrf" value="([^"]+)"/.exec(await (await call(path)).text())![1]!;
  const post = (path: string, values: Record<string, string>, headers: Record<string, string> = { origin }) => call(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(values).toString() });
  return { forms, call, csrf, post, flow: () => defined! };
}

test('the flow body schema is the flow schema without mount, abuse and notify (mounted flows only)', () => {
  const flow = formsConfigSchema.properties.flows.additionalProperties;
  const { mount: _mount, abuse: _abuse, notify: _notify, ...rest } = flow.properties;
  assert.deepEqual(formFlowBodySchema.properties, rest);
  assert.deepEqual(formFlowBodySchema.required, flow.required.filter(name => name !== 'mount'));
});

test('a consumer renders and admits its own flow with forms\' escaping, CSRF and 422 handling', async t => {
  const { call, csrf, post, flow, forms } = await boot(t);
  assert.equal(forms.exports.active, true);
  const page = await (await call('/survey')).text();
  assert.match(page, /Survey &lt;1&gt;/); assert.match(page, /action="\/survey\?scope=survey:one"/);
  const token = await csrf('/survey');
  const ok = await post('/survey', { csrf: token, rating: '5', comment: 'fine' });
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { rating: '5', comment: 'fine', reason: '' });
  const bad = await post('/survey', { csrf: token, rating: '3', extra: 'x' });
  const html = await bad.text();
  assert.equal(bad.status, 422); assert.match(html, /is not an allowed option/); assert.match(html, /name="csrf" value="[^"]+"/);
  assert.equal((await post('/survey', { csrf: token, rating: '5' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/survey', { rating: '5' })).status, 403);
  assert.equal((await call('/survey', { method: 'POST', headers: { 'content-type': 'text/plain', origin }, body: 'x' })).status, 415);
  assert.deepEqual(Object.keys(flow().fields), ['rating', 'comment', 'reason']);
  assert.throws(() => { (flow().fields as Record<string, unknown>).rating = {}; }, TypeError, 'the handle is frozen');
});

test('scoped tokens: another scope, and forms\' own flow of the same name, refuse each other\'s token', async t => {
  const { csrf, post } = await boot(t);
  const scoped = await csrf('/survey?scope=survey:one');
  assert.equal((await post('/survey?scope=survey:two', { csrf: scoped, rating: '5' })).status, 403);
  assert.equal((await post('/survey?scope=survey:one', { csrf: scoped, rating: '5' })).status, 200);
  const own = await csrf('/contact');
  assert.equal((await post('/survey', { csrf: own, rating: '5' })).status, 403, 'a forms-served flow token never admits an exported flow');
  assert.equal((await post('/contact', { csrf: scoped, rating: '5' })).status, 403, 'and the reverse');
});

test('only() narrows the admitted fields and shows the others read-only; confirmationPage shows record values', async t => {
  const { call, csrf, post, flow } = await boot(t);
  const page = await (await call('/survey/comment')).text();
  assert.match(page, /Edit comment/); assert.match(page, /<dt>Rating<\/dt><dd>Great<\/dd>/); assert.ok(!/name="rating"/.test(page));
  const token = await csrf('/survey/comment');
  assert.equal((await post('/survey/comment', { csrf: token, comment: 'ok' })).status, 200);
  const outside = await post('/survey/comment', { csrf: token, comment: 'ok', rating: '1' }), outsideHtml = await outside.text();
  assert.equal(outside.status, 422, 'a field outside only() is refused');
  // #739: the refused field has no input on this page, so the alert names it by its label rather than only "Correct the highlighted fields".
  assert.match(outsideHtml, /role="alert">Rating cannot be changed on this form\.<\/p>/);
  const undeclared = await post('/survey/comment', { csrf: token, comment: 'ok', 'x<y>': '<b>v</b>' }), undeclaredHtml = await undeclared.text();
  assert.equal(undeclared.status, 422);
  assert.match(undeclaredHtml, /role="alert">This form received a field it does not accept\.<\/p>/);
  assert.ok(!undeclaredHtml.includes('x&lt;y&gt;') && !undeclaredHtml.includes('<b>v</b>') && !undeclaredHtml.includes('&lt;b&gt;v'), 'the undeclared name and value are not echoed');
  const done = await (await call('/survey/done')).text();
  assert.match(done, /Rated Great\./); assert.match(done, /<a href="\/survey">Again<\/a>/);
  assert.throws(() => flow().only(['missing']), /missing is not a declared field/);
  assert.throws(() => flow().only([]), /distinct field names/);
  assert.throws(() => flow().confirmationPage({ rating: '5' }, { links: [{ href: 'https://evil.example', label: 'x' }] }), /same-site path/);
  assert.throws(() => flow().confirmationPage({}), /needs a value for rating/);
});

test('define() applies forms\' own cross-field rules and only() keeps requiredWhen siblings together', async t => {
  const { forms } = await boot(t);
  assert.throws(() => forms.exports.define('bad', { ...body, confirmation: { title: 'x', message: '{comment}', show: ['rating'] } }), /placeholder \{comment\} is not listed in show/);
  assert.throws(() => forms.exports.define('Bad Name', body), /Invalid form flow/);
  assert.throws(() => forms.exports.define('bad', { ...body, timeZone: 'Mars/Base' }), /not a known IANA time zone/);
  const conditional = forms.exports.define('conditional', { ...body, fields: { ...body.fields, reason: { label: 'Reason', maxLength: 40, requiredWhen: { field: 'rating', in: ['1'] } } } });
  assert.throws(() => conditional.only(['reason']), /rating must be included with it/);
  assert.deepEqual(Object.keys(conditional.only(['reason', 'rating']).fields), ['rating', 'reason']);
  const handle = forms.exports.define('page', body);
  const request = { headers: new Headers() } as unknown as ExtensionRequest;
  assert.throws(() => handle.render(request, { action: '//evil.example', scope: 's' }), /same-site path/);
  assert.throws(() => handle.render(request, { action: '/ok', scope: 'bad scope' }), /scope must be/);
  assert.throws(() => handle.only(['comment']).render(request, { action: '/ok', scope: 's', readOnly: { comment: 'x' } }), /read-only comment/);
});
