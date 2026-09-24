import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateDocument, parseYaml, loadDocument } from '../packages/core/src/config.ts';
import { createRuntime } from '../packages/core/src/runtime.ts';
import { ConfigError } from '../packages/core/src/errors.ts';
import { analyzeProjectCapabilities, assertTargetCompatibility } from '../packages/core/src/capabilities.ts';
import { readFixtures } from '../packages/core/src/readiness.ts';
import { runProjectTests } from '../packages/core/src/project-tests.ts';
import { project } from './helpers.ts';

const cli = fileURLToPath(new URL('../packages/core/src/cli.ts', import.meta.url));
const failure = (doc: unknown): ConfigError => {
  try { validateDocument(doc); } catch (error) { assert.ok(error instanceof ConfigError); return error; }
  assert.fail('expected a validation failure');
};
const doc = (routes: object) => ({ version: '1', routes });
/** A project whose urlcode.yaml is exactly `yaml`, for line-number assertions. */
async function yamlProject(t: import('node:test').TestContext, yaml: string, files: Record<string, string> = {}): Promise<string> {
  const root = await project(t, {}, files);
  await writeFile(join(root, 'urlcode.yaml'), yaml);
  return root;
}
const rejection = async (promise: Promise<unknown>): Promise<ConfigError> => {
  try { await promise; } catch (error) { assert.ok(error instanceof ConfigError, String(error)); return error; }
  assert.fail('expected a rejection');
};
const run = (args: string[]) => {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20000 });
  const lines = (result.stdout + result.stderr).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  return { status: result.status, lines, error: lines.find(line => line.event === 'error') };
};

test('route shape errors name the handler problem instead of a missing redirect', () => {
  const two = failure(doc({ '/a': { redirect: { url: 'https://example.com' }, respond: { text: 'x' } } }));
  assert.match(two.message, /^Invalid configuration at route \/a: declares 2 handlers \(redirect, respond\); a route has exactly one/);
  assert.equal(two.details.code, 'multiple-handlers');
  const typo = failure(doc({ '/a/b': { redirct: { url: 'https://example.com' } } }));
  assert.match(typo.message, /^Invalid configuration at route \/a\/b \(additionalProperties\): unknown key "redirct"; did you mean "redirect"\?/);
  assert.deepEqual([typo.details.code, typo.details.route, typo.details.pointer, typo.details.key], ['unknown-key', '/a/b', '/routes/~1a~1b', 'redirct']);
  assert.match(failure(doc({ '/a': { respnd: { text: 'x' } } })).message, /did you mean "respond"\?/);
  const none = failure(doc({ '/a': { methods: ['GET'] } }));
  assert.match(none.message, /declares no handler; add exactly one of: redirect, function, page, download, static, respond/);
  assert.equal(none.details.code, 'no-handler');
});

test('nested schema errors print route paths unescaped, name the stray key and list enum values', () => {
  const to = failure(doc({ '/a/b': { redirect: { to: 'https://example.com' } } }));
  assert.match(to.message, /^Invalid configuration at route \/a\/b, redirect \(required\): missing required key "url"; found unknown key "to" instead \(allowed keys: url, status, query\)/);
  assert.ok(!to.message.includes('~1'));
  assert.equal(to.details.pointer, '/routes/~1a~1b/redirect');
  const status = failure(doc({ '/a': { redirect: { url: 'https://example.com', status: 299 } } }));
  assert.match(status.message, /route \/a, redirect\.status \(enum\): must be one of 301, 302, 303, 307, 308$/);
  assert.match(failure({ version: 1, routes: {} }).message, /at \/version \(const\): must be "1"/);
  assert.match(failure({ version: '1', rotes: {} }).message, /missing required key "routes"; found unknown key "rotes", did you mean "routes"\?/);
  // Values are never echoed, only schema-declared allowed values.
  assert.ok(!failure(doc({ '/a': { redirect: { url: 'https://example.com', status: 'sk_live_secret' } } })).message.includes('sk_live_secret'));
});

test('Express-style :name segments are refused with the {name} and parameters fix', async t => {
  const express = failure(doc({ '/users/:id': { respond: { text: 'x' } } }));
  assert.match(express.message, /segment :id is Express-style; write \{id\} and declare it under parameters: \[\{name: id, in: path, required: true, schema: \{type: string\}\}\]/);
  assert.equal(express.details.code, 'express-parameter');
  // Literal colons inside a segment stay literal.
  validateDocument(doc({ '/a:b': { respond: { text: 'x' } } }));
  const root = await project(t, { '/users/:id': { respond: { text: 'x' } } });
  const error = await rejection(createRuntime(root, { local: true }));
  assert.equal(error.details.route, '/users/:id');
});

test('load errors carry the file, line and column of the offending key', async t => {
  const multiple = await rejection(loadDocument(await yamlProject(t, 'version: "1"\nroutes:\n  /a:\n    redirect: {url: https://example.com}\n    respond: {text: x}\n')));
  assert.match(multiple.message, /^urlcode\.yaml:5:5: Invalid configuration at route \/a: declares 2 handlers/);
  assert.deepEqual([multiple.details.file, multiple.details.line, multiple.details.column], ['urlcode.yaml', 5, 5]);
  const status = await rejection(loadDocument(await yamlProject(t, 'version: "1"\nroutes:\n  /a:\n    redirect:\n      url: https://example.com\n      status: 299\n')));
  assert.match(status.message, /^urlcode\.yaml:6:7: .*must be one of 301/);
  const syntax = await rejection(loadDocument(await yamlProject(t, 'version: "1"\nroutes:\n  /a:\n   redirect: {url: https://example.com}\n  bad: [\n')));
  assert.match(syntax.message, /^urlcode\.yaml:\d+:\d+: Invalid YAML: .*\(BAD_INDENT\)/);
  assert.equal(syntax.details.code, 'invalid-yaml');
  assert.throws(() => parseYaml('a: [\n'), /Invalid YAML at line \d+, column \d+/);
  const included = await rejection(loadDocument(await yamlProject(t, 'version: "1"\nincludes: [more.yaml]\nroutes: {}\n', { 'more.yaml': 'version: "1"\nroutes:\n  /b:\n    respnd: {text: x}\n' })));
  assert.match(included.message, /^more\.yaml:4:5: .*unknown key "respnd"; did you mean "respond"\?/);
});

test('missing paths, placeholders, static wildcards and denied secrets name the route and the fix', async t => {
  const missing = await rejection(createRuntime(await project(t, { '/a': { function: 'functions/missing.mjs' } }), { local: true }));
  assert.match(missing.message, /Referenced project file is missing: "functions\/missing\.mjs"/);
  assert.equal(missing.details.route, '/a');
  const placeholder = await rejection(createRuntime(await project(t, { '/u/{id}': { respond: { text: 'x' } } }), { local: true }));
  assert.match(placeholder.message, /^Route \/u\/\{id\}: Every path placeholder requires an input declaration; \{id\} has none\. Add parameters:/);
  const statics = await rejection(createRuntime(await project(t, { '/s': { static: { directory: 'public' } } }, { 'public/a.txt': 'a' }), { local: true }));
  assert.match(statics.message, /^Route \/s: Static routes require a terminal \/\* wildcard; write \/s\/\*/);
  const secret = await rejection(createRuntime(await project(t, { '/a': { function: 'f.mjs', secrets: { KEY: { secret: 'API_KEY' } } } }, { 'f.mjs': 'export default () => new Response("x")' }), { local: true }));
  assert.match(secret.message, /Secret binding denied by operator policy: KEY reads API_KEY.*urlcode permissions.*--policy <file>/);
  assert.deepEqual([secret.details.code, secret.details.route], ['binding-denied', '/a']);
  const imports = await rejection(createRuntime(await project(t, { '/a': { function: 'f.mjs', sandbox: true } }, { 'f.mjs': 'import "node:crypto";\nexport default () => new Response("x")' }), { local: true }));
  assert.match(imports.message, /\/f\.mjs imports "node:crypto"\. A sandbox: true function has no Node built-ins or packages/);
});

test('a target refusal names the targets that would accept the project', async t => {
  const loaded = await loadDocument(await project(t, { '/a': { function: 'f.mjs' } }, { 'f.mjs': 'export default () => new Response("x")' }));
  const report = analyzeProjectCapabilities(loaded, 'static');
  assert.equal(report.compatible, false);
  assert.ok(report.alternatives?.includes('self-hosted'));
  assert.ok(!report.alternatives?.includes('static'));
  assert.throws(() => assertTargetCompatibility(report), (error: unknown) => error instanceof ConfigError && /Targets that support every capability this project uses: .*self-hosted/.test(error.message) && error.details.route === '/a');
  assert.equal(analyzeProjectCapabilities(loaded, 'self-hosted').alternatives, undefined);
});

test('the CLI names unknown options, missing values and absent projects, with structured fields', async t => {
  const root = await project(t, {});
  const unknown = run(['dev', '--prot', '3000', '--project', root]);
  assert.equal(unknown.status, 1);
  assert.equal(unknown.error?.message, 'Unknown option --prot; did you mean --port? (use --help for the options)');
  assert.equal(unknown.error?.code, 'unknown-option');
  const value = run(['validate', '--project']);
  assert.match(String(value.error?.message), /^Option --project needs a value/);
  const absent = run(['validate', '--project', join(root, 'nope')]);
  assert.match(String(absent.error?.message), /^Project directory not found: /);
  const bare = join(root, 'bare'); await mkdir(bare);
  const noYaml = run(['validate', '--project', bare]);
  assert.match(String(noYaml.error?.message), /^No urlcode\.yaml in .*; run urlcode init there/);
  assert.equal(noYaml.error?.code, 'no-project');
  const located = run(['validate', '--project', await yamlProject(t, 'version: "1"\nroutes:\n  /a/b:\n    redirct: {url: https://example.com}\n')]);
  assert.deepEqual([located.error?.code, located.error?.route, located.error?.file, located.error?.line, located.error?.pointer], ['unknown-key', '/a/b', 'urlcode.yaml', 4, '/routes/~1a~1b']);
});

test('request fixtures are checked against schemas/requests.schema.json', async t => {
  const routes = { '/api/status': { respond: { json: { ok: true } } } };
  const bad = async (fixtures: unknown, pattern: RegExp) => assert.rejects(readFixtures(await project(t, routes, { 'tests/requests.json': JSON.stringify(fixtures) })), pattern);
  await bad([{ path: '/api/status', status: 200, json: { ok: false } }], /^Error: tests\/requests\.json fixture 1: unknown key "json"; send a JSON request body as body/);
  await bad([{ path: '/api/status', status: 200, expectJson: { ok: false } }], /unknown key "expectJson"; assert a JSON response with expectBody/);
  await bad([{ path: '/api/status', status: 200, expectBdy: 'x' }], /unknown key "expectBdy"; did you mean "expectBody"\?/);
  await bad([{ path: '/api/status', status: 200 }, { steps: [{ path: '/api/status', status: 200, bogus: 1 }] }], /fixture 2, step 1: unknown key "bogus"/);
  await bad([{ path: '/api/status' }], /fixture 1: Test must declare an HTTP status/);
  const root = await project(t, routes, { 'tests/requests.json': '[{"path":"/api/status",\n "status":200,}]' });
  await assert.rejects(readFixtures(root), /tests\/requests\.json is not valid JSON at line 2, column 15/);
});

test('a failing case prints expected and actual per assertion, and zero cases fail once routes exist', async t => {
  const routes = { '/api/status': { respond: { json: { ok: true } } } };
  const long = 'x'.repeat(300);
  const root = await project(t, { ...routes, '/long': { respond: { text: `${long}a` } } }, { 'tests/requests.json': JSON.stringify([
    { path: '/api/status', status: 200, expectHeaders: { 'x-frame-options': 'DENY' }, expectBody: '{"ok":false}' },
    { path: '/api/status', status: 201 },
    { path: '/long', status: 200, expectBody: `${long}b` },
  ]) });
  const events: Record<string, unknown>[] = [];
  assert.deepEqual(await runProjectTests(root, { log: event => events.push(event as Record<string, unknown>) }), { total: 3, failed: 3 });
  const tests = events.filter(event => event.event === 'test');
  assert.deepEqual(tests[0]?.failures, [
    { check: 'header', name: 'x-frame-options', expected: 'DENY', actual: null },
    { check: 'body', expected: '{"ok":false}', actual: '{"ok":true}', firstDifference: 6 },
  ]);
  assert.deepEqual([tests[0]?.method, tests[0]?.path], ['GET', '/api/status']);
  assert.deepEqual(tests[1]?.failures, [{ check: 'status', expected: 201, actual: 200 }]);
  const [body] = tests[2]?.failures as { expected: string; actual: string; firstDifference: number }[];
  assert.equal(body?.firstDifference, 300);
  assert.ok(body?.expected.startsWith('...') && body.expected.endsWith('xb') && body.actual.endsWith('xa'));

  const untested = await project(t, routes);
  await assert.rejects(runProjectTests(untested), /No request fixtures: tests\/requests\.json is missing or empty, but the project has 1 active route/);
  const emptied = await project(t, routes, { 'tests/requests.json': '[]' });
  await assert.rejects(runProjectTests(emptied), (error: unknown) => error instanceof ConfigError && error.details.code === 'no-test-cases');
  const warnings: Record<string, unknown>[] = [];
  assert.deepEqual(await runProjectTests(await project(t, {}), { log: event => warnings.push(event as Record<string, unknown>) }), { total: 0, failed: 0 });
  assert.ok(warnings.some(event => event.event === 'warning' && event.code === 'no-test-cases'));
});

test('a steps failure never prints a captured value', async t => {
  const root = await project(t, {
    '/token': { respond: { json: { token: 'tok_SECRET_123' } } },
    '/echo': { respond: { text: 'saw tok_SECRET_123 here' } },
  }, { 'tests/requests.json': JSON.stringify([{ steps: [
    { path: '/token', status: 200, capture: { token: { json: 'token' } } },
    { path: '/echo', status: 200, expectBody: 'saw {{token}} there' },
  ] }]) });
  const events: Record<string, unknown>[] = [];
  await runProjectTests(root, { log: event => events.push(event as Record<string, unknown>) });
  const printed = JSON.stringify(events.filter(event => event.event === 'test'));
  assert.ok(!printed.includes('tok_SECRET_123'), printed);
  assert.match(printed, /saw \{\{token\}\} here/);
});
