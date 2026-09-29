import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { project } from './helpers.ts';
import type { ProjectFiles, ProjectRoutes } from './helpers.ts';
import { startServer } from '../packages/core/src/server.ts';
import { auditProject } from '../packages/core/src/readiness.ts';
import { runProjectTests } from '../packages/core/src/project-tests.ts';
import { inspectExtensionRevision } from '../packages/core/src/extensions.ts';
import type { ExtensionRequest, RuntimeExtension } from '../packages/core/src/extensions.ts';
// #914: how `auth: true` routes reach audit readiness. A signed-in fixture is an ordinary request through the
// provider's real gate (here a synthetic "badge" provider, deliberately not auth, that accepts
// `Authorization: Badge <id>`); there is no test principal. A fully gated route can instead waive methods once its
// gate's asserted 401 is observed. HEAD is implied by GET, and `{{origin}}` names the site origin.
const origin = 'https://fixtures.example.test';
async function badge(root: string): Promise<RuntimeExtension> {
  return {
    name: 'badge', version: '1', projectSha256: await inspectExtensionRevision(root), targets: ['node'], providesPrincipal: true,
    schema: { type: 'object', additionalProperties: false }, policySchema: { type: 'object', additionalProperties: false },
    activate() { return {
      handle() { return { status: 404, headers: [], body: '' }; },
      authorize(_policy: unknown, request: ExtensionRequest) {
        const match = /^Badge (\S+)$/.exec(request.headers.get('authorization') ?? '');
        if (!match) return { status: 401, headers: [['content-type', 'application/json']], body: '{"error":"authentication_required"}' };
        request.setPrincipal!({ id: match[1]! });
        return undefined;
      },
    }; },
  } as RuntimeExtension;
}
async function vault(root: string): Promise<RuntimeExtension> {
  return {
    name: 'vault', version: '1', projectSha256: await inspectExtensionRevision(root), targets: ['node'],
    schema: { type: 'object', additionalProperties: false },
    // PATCH is refused (a validation-style 422), so a fixture can assert only its refusal.
    activate() { return { handle(request: ExtensionRequest) { return { status: request.method === 'PATCH' ? 422 : 200, headers: [['content-type', 'application/json']], body: JSON.stringify({ id: request.principal?.id ?? null }) }; } }; },
  } as RuntimeExtension;
}
const declarations = { extensions: { badge: { version: '1', config: {} }, vault: { version: '1', config: {} } } };
async function gatedApp(t: TestContext, routes: ProjectRoutes, fixtures: unknown[]) {
  const root = await project(t, routes, { 'tests/requests.json': JSON.stringify(fixtures) }, declarations);
  const app = await startServer({ project: root, port: 0, log: () => {}, origin, extensions: [await badge(root), await vault(root)] });
  t.after(() => app.close());
  return app;
}
const anonymous = { path: '/v/x', status: 401, expectBody: '{"error":"authentication_required"}' };

test('a signed-in fixture covers a gated route through its real gate, and HEAD is implied by GET', async t => {
  const app = await gatedApp(t, { '/v/*': { extension: 'vault', policies: { extensions: { badge: {} } } } },
    [anonymous, { path: '/v/x', headers: { authorization: 'Badge alice' }, status: 200, expectBody: '{"id":"alice"}' }]);
  const report = await auditProject(app);
  assert.deepEqual([report.ready, report.uncovered], [true, []], JSON.stringify(report));
  assert.deepEqual(report.impliedRouteMethods, [{ route: '/v/*', method: 'HEAD', from: 'GET' }]);
  assert.deepEqual(app.testPlan().inventory.find(route => route.path === '/v/*')?.gatedBy, ['badge']);
});

test('a fully gated route honours coveredElsewhere once its gate refusal is asserted, and only then', async t => {
  const routes = { '/v/*': { extension: 'vault', methods: ['GET', 'POST'], policies: { extensions: { badge: {} } },
    coveredElsewhere: { GET: 'signed-in reads run against the staging IdP', POST: 'signed-in writes run against the staging IdP' } } };
  const proven = await auditProject(await gatedApp(t, routes, [anonymous]));
  assert.equal(proven.ready, true, JSON.stringify(proven));
  assert.deepEqual(proven.waivedRouteMethods.map(entry => [entry.method, entry.basis]), [['GET', 'gate-refusal'], ['POST', 'gate-refusal']]);
  // A bare status does not prove the refusal came from the gate rather than anything else answering 401.
  const unproven = await auditProject(await gatedApp(t, routes, [{ path: '/v/x', status: 401 }]));
  assert.equal(unproven.ready, false);
  assert.equal(unproven.ignoredWaivers.length, 2);
  assert.deepEqual(unproven.coverageNotes.map(note => [note.code, note.routes]), [['gated-route-uncovered', ['/v/*']], ['waiver-without-proof', ['/v/*']]]);
});

// #959: a signed-in route whose other methods are covered is reached; the note names the method with no success case.
test('a method covered only by an asserted refusal is named as the gap, not the sign-in', async t => {
  const signedIn = { authorization: 'Badge alice' };
  const app = await gatedApp(t, { '/v/*': { extension: 'vault', methods: ['GET', 'HEAD', 'PATCH'], policies: { extensions: { badge: {} } } } },
    [anonymous, { path: '/v/x', headers: signedIn, status: 200, expectBody: '{"id":"alice"}' }, { path: '/v/x', method: 'PATCH', headers: signedIn, status: 422, expectBody: '{"id":"alice"}' }]);
  const report = await auditProject(app);
  assert.deepEqual([report.ready, report.uncovered], [false, [{ route: '/v/*', method: 'PATCH' }]]);
  assert.deepEqual(report.coverageNotes.map(note => [note.code, note.methods, note.cases?.length]), [['method-without-success', [{ route: '/v/*', method: 'PATCH' }], 1]], JSON.stringify(report.coverageNotes));
  assert.match(report.coverageNotes[0]!.message, /A refusal \(400 or more\) proves only the refusal/);
  // With nothing of the route covered, the gap is still the sign-in.
  const anonymousOnly = await auditProject(await gatedApp(t, { '/v/*': { extension: 'vault', methods: ['GET', 'PATCH'], policies: { extensions: { badge: {} } } } }, [anonymous]));
  assert.deepEqual(anonymousOnly.coverageNotes.map(note => [note.code, note.routes]), [['gated-route-uncovered', ['/v/*']]]);
});

test('an ungated route answering 401 cannot use the gate-refusal basis', async t => {
  const root = await project(t, { '/f': { methods: ['GET'], coveredElsewhere: { GET: 'nope' }, function: { source: 'f.mjs' } } }, {
    'f.mjs': 'export default () => new Response("no", {status: 401})', 'tests/requests.json': JSON.stringify([{ path: '/f', status: 401, expectBody: 'no' }]),
  } satisfies ProjectFiles);
  const app = await startServer({ project: root, port: 0, log: () => {} }); t.after(() => app.close());
  const report = await auditProject(app);
  assert.deepEqual([report.ready, report.ignoredWaivers.length, report.coverageNotes.map(note => note.code)], [false, 1, ['waiver-without-proof']]);
});

test('{{origin}} is the site origin in single and steps fixtures, and a status mismatch shows the refusal body', async t => {
  const echo = 'export default request => new Response(request.headers.get("origin") ?? "none")';
  const fixtures = [
    { path: '/f', headers: { origin: '{{origin}}' }, status: 200, expectBody: '{{origin}}' },
    { steps: [{ path: '/f', headers: { origin: '{{origin}}' }, status: 200, expectBody: origin }] },
    { path: '/v/x', method: 'POST', status: 200 },
  ];
  const root = await project(t, { '/f': { methods: ['GET'], function: { source: 'f.mjs' } }, '/v/*': { extension: 'vault', methods: ['POST'], policies: { extensions: { badge: {} } } } },
    { 'f.mjs': echo, 'tests/requests.json': JSON.stringify(fixtures) }, declarations);
  const events: Record<string, unknown>[] = [];
  const result = await runProjectTests(root, { origin, log: event => events.push(event as Record<string, unknown>), extensions: [await badge(root), await vault(root)] });
  assert.deepEqual(result, { total: 3, failed: 1 });
  assert.deepEqual(events.filter(event => event.event === 'test' && event.pass === false).map(event => event.failures),
    [[{ check: 'status', expected: 200, actual: 401, body: '{"error":"authentication_required"}' }]]);
});

test('{{origin}} is reserved: it cannot be captured, and other references need steps', async t => {
  for (const [fixtures, message] of [
    [[{ path: '/f', headers: { 'x-id': '{{id}}' }, status: 200 }], /\{\{id\}\} needs a steps fixture/],
    [[{ steps: [{ path: '/f', status: 200, capture: { origin: { header: 'x-a' } } }] }], /cannot be captured/],
  ] as const) {
    const root = await project(t, { '/f': { methods: ['GET'], respond: { status: 200, body: 'ok' } } }, { 'tests/requests.json': JSON.stringify(fixtures) });
    await assert.rejects(runProjectTests(root, { log: () => {} }), message);
  }
});
