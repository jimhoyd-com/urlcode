import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../src/server.ts';
import { createRuntime } from '../src/runtime.ts';
import { buildCloudflare } from '../src/build-cloudflare.ts';
import { createFetchHandler } from '../src/cloudflare.ts';
import { validatePattern, bundledLists } from '../src/policies/agents.ts';
import { resolveLists, loadListFile } from '../src/agent-lists.ts';
import { lists } from '../data/agents/index.ts';
import { project, redirect, request } from './helpers.ts';
import type { TestContext } from 'node:test';
import type { Server, ServerOptions } from '../src/server.ts';
import type { Artifact, Validators } from '../src/cloudflare.ts';
import type { AgentList } from '../data/agents/index.ts';

type LogEvent = Record<string, unknown>;
// The bundled table is keyed by name; a test names only lists the package ships.
function list(name: string): AgentList { const found = lists[name]; assert.ok(found, `bundled list ${name} exists`); return found; }

const browser = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const gptbot = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)';
const googlebot = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const bingbot = 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)';

async function serve(t: TestContext, root: string, options: Partial<ServerOptions> = {}): Promise<Server> {
  const app = await startServer({ project: root, port: 0, log: () => {}, ...options }); t.after(() => app.close()); return app;
}
const agentEvents = (events: LogEvent[]) => events.filter(event => event['event'] === 'agents');

test('bundled lists carry pinned revisions and only patterns in the subset', () => {
  assert.deepEqual([...bundledLists].sort(), ['ai-crawlers','crawlers','monitoring','seo']);
  for (const [name, list] of Object.entries(lists)) {
    assert.match(list.revision, /^v[\d.]+@[0-9a-f]{12}$/, name);
    assert.ok(list.patterns.length >= 25, `${name} has ${list.patterns.length} patterns`);
    for (const [, pattern] of list.patterns) assert.equal(validatePattern(pattern), undefined, `${name}: ${pattern}`);
  }
  const names = new Set(list('ai-crawlers').patterns.map(([n]) => n));
  for (const known of ['GPTBot','ClaudeBot','CCBot','Bytespider','Amazonbot']) assert.ok(names.has(known), known);
});

test('a bundled deny list refuses matching agents and logs the list name, never the header', async t => {
  const events: LogEvent[] = [];
  const root = await project(t, { '/go': redirect() }, {}, { policies: { agents: { deny: ['ai-crawlers'] } } });
  const app = await serve(t, root, { log: event => { events.push(event); } });
  const denied = await request(app, '/go', { headers: { 'user-agent': gptbot } });
  assert.equal(denied.status, 403);
  assert.equal(denied.body, 'Forbidden\n');
  assert.equal(denied.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(denied.headers['cache-control'], 'no-store');
  assert.equal(denied.headers['x-content-type-options'], 'nosniff');
  // Case-insensitive: product tokens are compared without regard to case.
  assert.equal((await request(app, '/go', { headers: { 'user-agent': gptbot.toUpperCase() } })).status, 403);
  assert.equal((await request(app, '/go', { headers: { 'user-agent': browser } })).status, 302);
  assert.equal((await request(app, '/go', { headers: { 'user-agent': googlebot } })).status, 302);
  const logged = agentEvents(events);
  assert.equal(logged.length, 2);
  assert.deepEqual(logged[0], { event: 'agents', route: '/go', list: 'ai-crawlers', outcome: 'denied' });
  assert.ok(!JSON.stringify(events).includes('GPTBot'), 'the raw User-Agent must never be logged');
});

test('allow lists and allow patterns win over deny', async t => {
  const root = await project(t, { '/go': redirect() }, {}, { policies: { agents: {
    deny: ['crawlers'], allow: ['monitoring'], allowPatterns: ['^Mozilla/5\\.0 \\(compatible; Googlebot'], status: 451 } } });
  const app = await serve(t, root);
  assert.equal((await request(app, '/go', { headers: { 'user-agent': bingbot } })).status, 451);
  assert.equal((await request(app, '/go', { headers: { 'user-agent': googlebot } })).status, 302);
  assert.equal((await request(app, '/go', { headers: { 'user-agent': 'Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)' } })).status, 302);
  assert.equal((await request(app, '/go', { headers: { 'user-agent': browser } })).status, 302);
});

test('a project-relative list file is loaded, validated and named in the log', async t => {
  const events: LogEvent[] = [];
  const files = { 'agents/deny.json': JSON.stringify({ entries: [{ name: 'curl', pattern: '^curl/' }, { pattern: 'internal-scanner' }] }) };
  const root = await project(t, { '/go': { ...redirect(), policies: { agents: { deny: ['agents/deny.json'], denyPatterns: ['^wget/'] } } } }, files);
  const app = await serve(t, root, { log: event => { events.push(event); } });
  assert.equal((await request(app, '/go', { headers: { 'user-agent': 'curl/8.4.0' } })).status, 403);
  assert.equal((await request(app, '/go', { headers: { 'user-agent': 'Wget/1.21' } })).status, 403);
  assert.equal((await request(app, '/go', { headers: { 'user-agent': 'not-curl/1' } })).status, 302);
  assert.deepEqual(agentEvents(events).map(event => event['list']), ['agents/deny.json', 'pattern']);
  assert.deepEqual(await loadListFile(root, 'agents/deny.json'), [{ name: 'curl', pattern: '^curl/' }, { name: 'internal-scanner', pattern: 'internal-scanner' }]);
  // The Worker build attaches the same entries so its synchronous compile finds them.
  const resolved = await resolveLists({ deny: ['agents/deny.json', 'ai-crawlers'] }, root);
  assert.ok(resolved?.resolved, 'project list files are attached');
  assert.deepEqual(Object.keys(resolved.resolved), ['agents/deny.json']);

  const escaping = await project(t, { '/go': { ...redirect(), policies: { agents: { deny: ['../outside.json'] } } } });
  await assert.rejects(createRuntime(escaping, { log: () => {} }), /\/go.*must stay inside the project/);
  const missing = await project(t, { '/go': { ...redirect(), policies: { agents: { deny: ['agents/none.json'] } } } });
  await assert.rejects(createRuntime(missing, { log: () => {} }), /\/go.*cannot be read/);
  const unknown = await project(t, { '/go': { ...redirect(), policies: { agents: { deny: ['no-such-list'] } } } });
  await assert.rejects(createRuntime(unknown, { log: () => {} }), /\/go.*unknown list "no-such-list"/);
  const badFile = await project(t, { '/go': { ...redirect(), policies: { agents: { deny: ['agents/bad.json'] } } } }, { 'agents/bad.json': JSON.stringify([{ pattern: '(a+)+' }]) });
  await assert.rejects(createRuntime(badFile, { log: () => {} }), /\/go.*agents\/bad\.json.*rejected/);
});

test('denyEmpty refuses a missing or blank User-Agent', async t => {
  const events: LogEvent[] = [];
  const root = await project(t, { '/go': redirect() }, {}, { policies: { agents: { denyEmpty: true } } });
  const app = await serve(t, root, { log: event => { events.push(event); } });
  assert.equal((await request(app, '/go')).status, 403);
  assert.equal((await request(app, '/go', { headers: { 'user-agent': '  ' } })).status, 403);
  assert.equal((await request(app, '/go', { headers: { 'user-agent': browser } })).status, 302);
  assert.deepEqual(agentEvents(events).map(event => event['list']), ['empty', 'empty']);
  const lenient = await serve(t, await project(t, { '/go': redirect() }, {}, { policies: { agents: { deny: ['ai-crawlers'] } } }));
  assert.equal((await request(lenient, '/go')).status, 302);
});

test('report mode logs a would-be denial and never blocks', async t => {
  const events: LogEvent[] = [];
  const root = await project(t, { '/go': redirect() }, {}, { policies: { agents: { deny: ['ai-crawlers'], denyEmpty: true, mode: 'report' } } });
  const app = await serve(t, root, { log: event => { events.push(event); } });
  assert.equal((await request(app, '/go', { headers: { 'user-agent': gptbot } })).status, 302);
  assert.equal((await request(app, '/go')).status, 302);
  assert.deepEqual(agentEvents(events), [
    { event: 'agents', route: '/go', list: 'ai-crawlers', outcome: 'reported' },
    { event: 'agents', route: '/go', list: 'empty', outcome: 'reported' }]);
});

test('patterns outside the linear-time subset are rejected at activation with the route named', async t => {
  const rejected: Array<[string, RegExp]> = [['(unclosed', /unterminated group/], [['(a', '+)', '+$'].join(''), /nested quantifiers/], ['(?=bot)', /lookaround/],
    ['(bot)\\1', /backreferences/], ['a{1,999}', /bound above 64/], ['a{2,}', /counted repetition/], ['a+?', /lazy/], ['(?<=x)y', /lookaround/],
    ['x'.repeat(257), /256 bytes/], ['(ab)*', /only \? may quantify a group/], ['^*', /anchor/], ['[[:alpha:]]', /nested character classes/]];
  for (const [pattern, reason] of rejected) {
    assert.match(validatePattern(pattern) ?? '', reason, pattern);
  }
  for (const pattern of ['^curl/', 'Mozilla/5\\.0 \\(compatible; (?:Googlebot|bingbot)/2\\.[01]', 'AdsBot-Google([^-]|$)', '[a-z]{1,64}bot', '(?:bot)?', 'a\\d+b\\s*c', 'bot\\b', '\\x41\\u0042']) {
    assert.equal(validatePattern(pattern), undefined, pattern);
  }
  const bad = await project(t, { '/ok': redirect(), '/evil': { ...redirect(), policies: { agents: { denyPatterns: ['(a+)+$'] } } } });
  await assert.rejects(createRuntime(bad, { log: () => {} }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /\/evil policies\.agents\.denyPatterns/);
    assert.match(error.message, /nested quantifiers/);
    return true;
  });
});

test('describe reports lists, counts, mode and status for the audit inventory', async t => {
  const root = await project(t, { '/go': { ...redirect(), policies: { agents: { deny: ['ai-crawlers', 'seo'], allowPatterns: ['^Mozilla/5\\.0 \\(compatible; Googlebot'], mode: 'report', status: 429 } } } });
  const runtime = await createRuntime(root, { log: () => {} });
  t.after(() => runtime.close());
  const summary = runtime.testPlan().policies['/go']?.agents;
  assert.ok(summary?.deny && summary.patterns, 'the agents inventory is complete');
  assert.equal(summary.target, 'native');
  assert.equal(summary.mode, 'report'); assert.equal(summary.status, 429); assert.equal(summary.denyEmpty, false);
  assert.deepEqual(summary.deny.map(list => list.name), ['ai-crawlers', 'seo']);
  assert.equal(summary.deny[0]?.revision, list('ai-crawlers').revision);
  assert.equal(summary.patterns.deny, list('ai-crawlers').patterns.length + list('seo').patterns.length);
  assert.deepEqual(summary.patterns.allow, 1); assert.equal(summary.allowPatterns, 1);
});

test('the Cloudflare artifact enforces the same agents policy as the self-hosted server', async t => {
  const root = await project(t, { '/go': redirect('https://example.com/target'), '/open': { ...redirect(), policies: { agents: false } } }, {},
    { policies: { agents: { deny: ['ai-crawlers'], denyPatterns: ['^curl/'], allowPatterns: ['ClaudeBot'], denyEmpty: true } } });
  const hosted = await serve(t, root);
  const out = await mkdtemp(join(tmpdir(), 'urlcode-cf-agents-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  await buildCloudflare(root, { out });
  const artifact: Artifact = (await import(pathToFileURL(join(out, 'artifact.js')).href)).default;
  const compiledAgents = artifact.routes.find(route => route.pattern === '/go')?.policies?.['agents'];
  assert.ok(typeof compiledAgents === 'object' && compiledAgents !== null && 'deny' in compiledAgents, 'the artifact carries the agents policy');
  assert.deepEqual(compiledAgents.deny, ['ai-crawlers']);
  const validators: Validators = await import(pathToFileURL(join(out, 'validators.js')).href);
  const worker = createFetchHandler(artifact, validators);
  const probes: Array<[string, string | undefined]> = [['/go', gptbot], ['/go', browser], ['/go', 'curl/8.0'], ['/go', 'Mozilla/5.0 (compatible; ClaudeBot/1.0)'], ['/go', undefined], ['/open', gptbot], ['/go', 'GPTBOT/1.0']];
  for (const [path, agent] of probes) {
    const headers = agent === undefined ? {} : { 'user-agent': agent };
    const a = await request(hosted, path, { headers });
    const response = await worker(new Request(`https://links.example${path}`, { headers }));
    const b = { status: response.status, headers: Object.fromEntries([...response.headers]), body: await response.text() };
    const where = `${path} with ${agent ?? 'no User-Agent'}`;
    assert.equal(b.status, a.status, `status differs for ${where}`);
    assert.equal(b.body, a.body, `body differs for ${where}`);
    for (const header of ['location', 'content-type', 'cache-control', 'content-length', 'x-content-type-options']) assert.equal(b.headers[header], a.headers[header], `${header} differs for ${where}`);
  }
  assert.equal((await worker(new Request('https://links.example/go', { headers: { 'user-agent': gptbot } }))).status, 403);
  assert.equal((await worker(new Request('https://links.example/go', { headers: { 'user-agent': browser } }))).status, 302);
});
