// jimhoyd-com/urlcode#811: a `steps` fixture keeps a cookie jar of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { project } from './helpers.ts';
import { startServer } from '../packages/core/src/server.ts';
import { runProjectTests, startRestartable } from '../packages/core/src/project-tests.ts';
import { auditProject } from '../packages/core/src/readiness.ts';
import { verifyDeployment } from '../packages/core/src/verify-deployment.ts';
import { CookieJar, jarScope } from '../packages/core/src/cookie-jar.ts';

// /set answers one Set-Cookie per `c` query value, as written; /echo and /app/echo answer the Cookie header they got.
// /login sets a value no fixture contains, so any trace of it in output is a leak.
const secret = 'sid-VALUE-7f3a9c';
const functions = `export function login(){return new Response('in',{headers:[['set-cookie','sid=${secret}; Path=/'],['set-cookie','single=${secret}-single; Path=/']]});}
export function set(request){const headers=new Headers({'content-type':'text/plain'});for(const line of new URL(request.url).searchParams.getAll('c'))headers.append('set-cookie',line);return new Response('set',{headers});}
export function echo(request){return new Response(request.headers.get('cookie') ?? '',{headers:{'content-type':'text/plain'}});}`;
const route = (name: string) => ({ sandboxReason: 'test', function: { source: 'cookies.mjs', export: name } });
const routes = { '/login': route('login'), '/set': route('set'), '/app/set': route('set'), '/echo': route('echo'), '/app/echo': route('echo') };
const set = (...lines: string[]) => `/set?${lines.map(line => `c=${encodeURIComponent(line)}`).join('&')}`;

async function run(t: TestContext, fixtures: unknown, origin?: string) {
  const root = await project(t, routes, { 'cookies.mjs': functions, 'tests/requests.json': JSON.stringify(fixtures) });
  const events: { event: string; case?: number; pass?: boolean; failures?: unknown; error?: string }[] = [];
  const result = await runProjectTests(root, { origin, log: event => events.push(event as never) });
  return { root, result, events, failed: events.filter(event => event.event === 'test' && event.pass === false).map(event => event.case) };
}

test('a cookie set by one step is sent on the next step of the same fixture, never to another fixture', async t => {
  const { result, failed } = await run(t, [
    { steps: [{ path: set('sid=abc; Path=/; HttpOnly; SameSite=Strict'), status: 200 }, { path: '/echo', status: 200, expectBody: 'sid=abc' }] },
    { steps: [{ path: '/echo', status: 200, expectBody: '' }] },
    { path: '/echo', status: 200, expectBody: '' },
  ]);
  assert.deepEqual(failed, []); assert.deepEqual(result, { total: 4, failed: 0 });
});

test('Path scopes a cookie; without one it defaults to the directory of the request that set it', async t => {
  const { failed } = await run(t, [{ steps: [
    { path: `/app${set('a=1', 'b=2; Path=/app', 'c=3; Path=/', 'd=4; Path=/ap')}`, status: 200 },
    // Longest path first, then oldest. Path=/ap matches /ap and /ap/..., never /app/...; the query is not part of the path.
    { path: '/app/echo', status: 200, expectBody: 'a=1; b=2; c=3' },
    { path: '/echo', status: 200, expectBody: 'c=3' },
    { path: '/app/echo?x=/y', status: 200, expectBody: 'a=1; b=2; c=3' },
  ] }]);
  assert.deepEqual(failed, []);
});

test('Max-Age=0, a negative Max-Age and a past Expires delete a stored cookie; Max-Age wins over Expires', async t => {
  const { failed } = await run(t, [{ steps: [
    { path: set('a=1; Path=/', 'b=2; Path=/', 'c=3; Path=/', 'd=4; Path=/; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT'), status: 200 },
    { path: '/echo', status: 200, expectBody: 'a=1; b=2; c=3; d=4' },
    { path: set('a=; Path=/; Max-Age=0', 'b=x; Path=/; Max-Age=-1', 'c=x; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'), status: 200 },
    { path: '/echo', status: 200, expectBody: 'd=4' },
    // Deleting a cookie whose path does not match leaves the stored one alone.
    { path: set('d=; Path=/app; Max-Age=0'), status: 200 },
    { path: '/echo', status: 200, expectBody: 'd=4' },
  ] }]);
  assert.deepEqual(failed, []);
});

test('an explicit cookie header wins for the names it sends; the jar adds the others', async t => {
  const { failed } = await run(t, [{ steps: [
    { path: set('sid=jar; Path=/', 'theme=dark; Path=/'), status: 200, capture: { sid: { cookie: 'sid' } } },
    { path: '/echo', headers: { Cookie: 'sid=mine; extra=1' }, status: 200, expectBody: 'sid=mine; extra=1; theme=dark' },
    // The jar is unchanged by an explicit header, and a captured cookie value replays as written.
    { path: '/echo', status: 200, expectBody: 'sid=jar; theme=dark' },
    { path: set('sid=; Path=/; Max-Age=0'), status: 200 },
    { path: '/echo', headers: { cookie: 'sid={{sid}}' }, status: 200, expectBody: 'sid=jar; theme=dark' },
  ] }]);
  assert.deepEqual(failed, []);
});

test('Secure cookies are kept for an https or loopback origin and dropped for a plain http one; Domain must match the origin', async t => {
  const fixture = [{ steps: [
    { path: set('s=1; Path=/; Secure', '__Host-h=2; Path=/; Secure', 'p=3; Path=/'), status: 200 },
    { path: '/echo', status: 200, expectBody: 's=1; __Host-h=2; p=3' },
  ] }];
  assert.deepEqual((await run(t, fixture)).failed, [], 'the local loopback address is a secure context');
  assert.deepEqual((await run(t, fixture, 'https://api.example.test')).failed, []);
  const plain = await run(t, [{ steps: [fixture[0]!.steps[0]!, { path: '/echo', status: 200, expectBody: 'p=3' }] }], 'http://api.example.test');
  assert.deepEqual(plain.failed, [], 'a plain http origin keeps no Secure cookie');
  const domains = await run(t, [{ steps: [
    { path: set('a=1; Path=/; Domain=example.test', 'b=2; Path=/; Domain=.API.example.test', 'c=3; Path=/; Domain=other.test', 'd=4; Path=/; Domain=www.api.example.test', '__Host-e=5; Path=/; Secure; Domain=api.example.test', '__Secure-f=6; Path=/'), status: 200 },
    { path: '/echo', status: 200, expectBody: 'a=1; b=2' },
  ] }], 'https://api.example.test');
  assert.deepEqual(domains.failed, []);
});

test('cookie values never reach output: failure diffs, the audit report and deployment verification', async t => {
  const fixtures = [
    { steps: [
      { path: '/login', status: 200, expectHeaders: { 'set-cookie': 'sid=other; Path=/' } },
    ] },
    { steps: [
      { path: '/login', status: 200 },
      { path: '/echo', status: 200, expectBody: 'something else' },
    ] },
    { path: '/login', status: 200, expectHeaders: { 'set-cookie': 'nope' } },
    { steps: [{ path: set('sid=; Path=/; Max-Age=0'), status: 200, capture: { gone: { cookie: 'sid' } } }] },
  ];
  const { root, events, failed } = await run(t, fixtures);
  assert.deepEqual(failed, [1, 3, 4, 5]);
  const printed = JSON.stringify(events);
  assert.doesNotMatch(printed, /VALUE-7f3a9c/);
  assert.match(printed, /sid=<cookie sid>; Path=\/, single=<cookie single>; Path=\//, 'the Set-Cookie diff names the cookie, not its value');
  assert.match(printed, /"actual":"sid=<cookie sid>; single=<cookie single>"/, 'a body echoing the cookies is redacted');
  assert.ok(events.some(event => event.case === 5 && event.error === 'capture'), 'a cookie capture with no such cookie fails the step');
  const app = await startRestartable({ project: root, port: 0, local: true, log: () => {} });
  t.after(() => app.close());
  const logged: object[] = [];
  const report = await auditProject(app, { log: event => logged.push(event) });
  const target = await startServer({ project: root, port: 0, local: true, log: () => {} });
  t.after(() => target.close());
  const verified = await verifyDeployment(root, { target: `http://127.0.0.1:${target.address.port}`, log: event => logged.push(event) });
  assert.equal(report.failed, 4);
  assert.doesNotMatch(JSON.stringify([logged, report, verified]), /VALUE-7f3a9c/);
});

test('the jar stores what RFC 6265 lets a client store, and forgets it when it expires', () => {
  let now = Date.parse('2026-09-27T00:00:00Z');
  const jar = new CookieJar(jarScope('https://api.example.test'), () => now);
  const names = (target: string) => jar.send(target).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  jar.store(['short=1; Max-Age=60', 'dated=2; Expires=Sun, 27 Sep 2026 00:02:00 GMT', 'session=3', 'bad', '=4', 'sp ace=5', `big=${'x'.repeat(5000)}`, '__Host-x=6; Secure; Path=/app'], '/login');
  assert.equal(names('/'), 'short=1; dated=2; session=3');
  now += 61_000; assert.equal(names('/'), 'dated=2; session=3', 'Max-Age expiry');
  now += 60_000; assert.equal(names('/'), 'session=3', 'Expires expiry');
  // A replacement keeps the original creation order; the jar is bounded.
  jar.store(['a=1', 'b=1', 'a=2'], '/'); assert.equal(names('/'), 'session=3; a=2; b=1');
  jar.store(Array.from({ length: 60 }, (_, i) => `n${i}=1`), '/');
  assert.equal(jar.send('/').length, 50);
  assert.ok(jar.values().has(`${'x'.repeat(5000)}`), 'a refused cookie value is still redacted');
  const loopback = jarScope('http://127.0.0.1:8080'), local = jarScope('http://app.localhost'), v6 = jarScope('http://[::1]:1');
  assert.deepEqual([loopback.secure, local.secure, v6.secure, v6.host, jarScope('http://example.test').secure], [true, true, true, '::1', false]);
  const ip = new CookieJar(loopback);
  ip.store(['a=1; Domain=127.0.0.1', 'b=2; Domain=0.0.1'], '/');
  assert.deepEqual(ip.send('/').map(cookie => cookie.name), ['a'], 'an IP host matches only itself');
});

test('the jar outlives a restart step, and deployment verification carries it between steps too', async t => {
  const fixtures = [{ steps: [{ path: set('sid=abc; Path=/'), status: 200 }, { restart: true }, { path: '/echo', status: 200, expectBody: 'sid=abc' }] },
    { steps: [{ path: set('sid=def; Path=/; Secure'), status: 200 }, { path: '/echo', status: 200, expectBody: 'sid=def' }] }];
  const { root, result } = await run(t, fixtures);
  assert.deepEqual(result, { total: 4, failed: 0 });
  const target = await startServer({ project: root, port: 0, local: true, log: () => {} });
  t.after(() => target.close());
  const verified = await verifyDeployment(root, { target: `http://127.0.0.1:${target.address.port}`, log: () => {} });
  assert.deepEqual(verified.findings.filter(finding => finding.check === 'fixtures'), [], 'a loopback target keeps Secure cookies; the restart fixture is skipped');
  assert.ok(verified.notes.some(note => note.startsWith('fixture 1 ')));
});

test('a cookie capture names one cookie, and set-cookie is refused as a header capture when the file is read', async t => {
  for (const [capture, message] of [[{ c: { cookie: 'a b' } }, /A cookie capture names one cookie/], [{ c: { header: 'Set-Cookie' } }, /not set-cookie/]] as const) {
    const root = await project(t, routes, { 'cookies.mjs': functions, 'tests/requests.json': JSON.stringify([{ steps: [{ path: '/echo', status: 200, capture }] }]) });
    await assert.rejects(runProjectTests(root), message);
  }
});
