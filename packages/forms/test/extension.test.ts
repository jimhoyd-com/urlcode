import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import type { ScaffoldResult } from '@jimhoyd/urlcode/extensions';
import { composeHost } from '@jimhoyd/urlcode/host';
import ui from '@jimhoyd/urlcode-ui/extension';
import forms, { formsCsrfKeyFile } from '../src/extension.ts';
import { formsConfigSchema, formsMail } from '../src/index.ts';

const origin = 'https://forms.example.test';
const request = (site: string) => ({ site, project: join(site, 'app'), installed: ['forms', 'ui'], acknowledgements: [] });

function withSha(t: test.TestContext, sha: string): void {
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = sha;
  t.after(() => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
}
/** Writes scaffold results the way core does: files relative to the site (existing ones kept), config wrapped as {version, config}. */
async function site(t: test.TestContext): Promise<{ site: string; project: string; results: Record<string, ScaffoldResult> }> {
  const root = await mkdtemp(join(tmpdir(), 'forms-extension-')); t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app'); await mkdir(project);
  const capability = await forms.definition.scaffold!(request(root)), example = await forms.definition.example!(request(root));
  // What `extensions add forms --example` writes: the capability (key, empty flows) with the contact flow on top.
  const results = { ui: await ui.definition.scaffold!(request(root)), forms: { ...capability, config: example.config, routes: example.routes } };
  for (const result of Object.values(results)) for (const file of result.files ?? []) {
    await mkdir(join(root, file.path, '..'), { recursive: true });
    await writeFile(join(root, file.path), file.content, { flag: 'wx', ...(file.mode === undefined ? {} : { mode: file.mode }) });
  }
  const extensions = Object.fromEntries(Object.entries(results).map(([name, result]) => [name, { version: '1', config: result.config }]));
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions, routes: { ...results.ui.routes, ...results.forms.routes } }));
  return { site: root, project, results };
}

test('the definition requires ui, uses abuse and mail, contributes its mail template and carries the runtime schema', () => {
  assert.equal(forms.definition.name, 'forms');
  assert.deepEqual(forms.definition.requires, ['ui']);
  assert.deepEqual(forms.definition.uses, ['abuse', 'mail']);
  assert.equal(forms.definition.schema, formsConfigSchema);
  assert.deepEqual(forms.definition.contributes, { mail: formsMail });
  assert.deepEqual(Object.keys(formsMail.templates), ['submission']);
  assert.deepEqual(formsMail.templates.submission!.slots, { flow: 'text', summary: 'text' });
});

test('--example rate limits the contact flow with a honeypot only when abuse is installed', async () => {
  const plain = await forms.definition.example!(request('/srv/site'));
  assert.equal('abuse' in (plain.config as { flows: { contact: object } }).flows.contact, false);
  const guarded = await forms.definition.example!({ ...request('/srv/site'), installed: ['abuse', 'forms', 'ui'] });
  assert.deepEqual((guarded.config as { flows: { contact: { abuse?: unknown } } }).flows.contact.abuse, { client: { limit: 5, windowMs: 3600000 }, honeypot: 'website' });
  assert.ok(guarded.notes!.some(note => note.includes('abuse.honeypot')));
});

test('a blank install writes the CSRF key and no flow or route (#711)', async () => {
  const blank = await forms.definition.scaffold!(request('/srv/site'));
  assert.deepEqual(blank.config, { flows: {} });
  assert.deepEqual(blank.routes, {});
  assert.deepEqual(blank.files!.map(file => file.path), [formsCsrfKeyFile]);
  assert.ok(blank.notes!.every(note => !note.includes('/contact')));
});

test('scaffold writes a fresh 32-byte private CSRF key, and --example a public contact flow', async t => {
  const first = await forms.definition.scaffold!(request('/srv/site')), second = await forms.definition.scaffold!(request('/srv/site'));
  const example = await forms.definition.example!(request('/srv/site'));
  const [key] = first.files!;
  assert.equal(key!.path, formsCsrfKeyFile); assert.equal(key!.mode, 0o600);
  assert.ok(key!.content instanceof Uint8Array && key!.content.byteLength === 32);
  assert.notDeepEqual(key!.content, second.files![0]!.content, 'every site gets its own secret');
  assert.ok(!key!.path.startsWith('app/') && !key!.path.startsWith('node_modules/'));
  assert.equal('version' in first.config, false, 'config is the inner block; core wraps it');
  assert.deepEqual(Object.keys((example.config as { flows: { contact: { fields: object } } }).flows.contact.fields), ['name', 'email', 'message']);
  assert.deepEqual(example.routes, { '/contact/*': { extension: 'forms', methods: ['GET', 'HEAD', 'POST'] } });
  assert.ok([...first.notes!, ...example.notes!].every(note => !note.includes('\n')));
  const { site: root } = await site(t);
  // Windows has no POSIX modes; everywhere else the key must be private to its owner.
  if (process.platform !== 'win32') assert.equal((await stat(join(root, formsCsrfKeyFile))).mode & 0o777, 0o600);
});

test('host() reads the scaffolded key, receives ui through composeHost, and the scaffolded flow validates and serves', async t => {
  const { site: root, project } = await site(t);
  const sha = await inspectExtensionRevision(project); withSha(t, sha);
  const host = await composeHost(pathToFileURL(join(root, 'host.mjs')), [forms(), ui()]);
  t.after(() => host.close?.());
  assert.deepEqual(host.extensions!.map(extension => extension.name), ['ui', 'forms']);
  // Activation checks each block against its registered schema and every flow mount against the routes.
  const app = await startServer({ project, origin, port: 0, log: () => {}, extensions: host.extensions! });
  t.after(() => app.close());
  const page = await fetch(`http://127.0.0.1:${app.address.port}/contact`);
  const html = await page.text();
  assert.equal(page.status, 200); assert.match(html, /Contact us/); assert.match(html, /name="email"/); assert.match(html, /<textarea /);
  const cookie = page.headers.getSetCookie()[0]!.split(';')[0]!, csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const sent = await fetch(`http://127.0.0.1:${app.address.port}/contact`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin, cookie },
    body: new URLSearchParams({ csrf, name: 'Ada', email: 'ada@example.test', message: 'Hello from the scaffold' }) });
  assert.equal(sent.status, 303); assert.equal(sent.headers.get('location'), '/contact/confirmation');
});

test('host() refuses without ui, and explains a missing key; an explicit secret needs no file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'forms-extension-')); t.after(() => rm(root, { recursive: true, force: true }));
  withSha(t, 'a'.repeat(64));
  const hostUrl = pathToFileURL(join(root, 'host.mjs'));
  await assert.rejects(composeHost(hostUrl, [forms()]), /forms requires ui/);
  await assert.rejects(composeHost(hostUrl, [ui(), forms()]), /forms needs its CSRF secret at .*forms-csrf\.key/);
  const host = await composeHost(hostUrl, [ui(), forms({ csrfSecret: 'b'.repeat(32) })]);
  assert.deepEqual(host.extensions!.map(extension => extension.name), ['ui', 'forms']);
  await host.close?.();
  await assert.rejects(composeHost(hostUrl, [ui(), forms({ csrfSecret: 'short' })]), /at least 32 bytes/);
});
