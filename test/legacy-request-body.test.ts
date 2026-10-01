// #1132: the route-wide request.body shape that #870 keyed by method gets one targeted migration hint, the same in
// the loader (CLI validate), MCP validate and explain_error, instead of the generic unknown-key schema error.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { loadDocument, parseYaml, validateDocument } from '../packages/core/src/config.ts';
import { explainError } from '../packages/core/src/agent-context.ts';
import { serveMcp } from '../packages/core/src/mcp.ts';
import { docsUrl } from '../packages/core/src/release.ts';
import { legacyRequestBodyHintIn } from '../packages/core/src/legacy-request-body.ts';

async function site(t: TestContext, yaml: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-legacy-body-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'urlcode.yaml'), yaml);
  return root;
}
const failure = async (root: string): Promise<Error & { details: Record<string, unknown> }> => {
  try { await loadDocument(root); } catch (error) { return error as Error & { details: Record<string, unknown> }; }
  assert.fail('the legacy shape must not load');
};
const notes = docsUrl('HTTP.md#moving-from-the-route-wide-body-shape');
const rule = 'request.body now holds one policy per HTTP method, under a method key such as POST:, and the route-wide shape is refused.';

test('a route with methods [POST] is told to move its keys under POST, with file, line, column and pointer', async t => {
  const root = await site(t, 'version: "1"\nroutes:\n  /contact:\n    methods: [POST]\n    request:\n      body:\n        required: true\n        format: json\n        schema: {type: object}\n    respond: {status: 204}\n');
  const error = await failure(root);
  // The exact message: one snapshot, so a change to the wording is a reviewed change.
  assert.equal(error.message, `urlcode.yaml:7:9: Invalid configuration at route /contact, request.body (legacy-request-body): ${rule} route /contact: move required, format and schema under POST, so request.body: {required: ..., format: ..., schema: ...} becomes request.body: {POST: {required: ..., format: ..., schema: ...}}. See ${notes}`);
  assert.deepEqual(error.details, { code: 'legacy-request-body', pointer: '/routes/~1contact/request/body', key: 'required', route: '/contact', file: 'urlcode.yaml', line: 7, column: 9 });
  assert.doesNotMatch(error.message, /unknown key|additionalProperties|urlcode schema/, 'replaces the generic schema advice');
  assert.doesNotMatch(error.message, /json|object/, 'names keys, never values');
});

test('a route without methods gets a defined suggestion for the GET/HEAD default', () => {
  const sizeOnly = (() => { try { validateDocument(parseYaml('version: "1"\nroutes:\n  /a:\n    request: {body: {maxBytes: 10}}\n    respond: {text: hi}\n')); } catch (error) { return (error as Error).message; } return ''; })();
  assert.match(sizeOnly, /route \/a: it declares no methods, so it answers the default GET and HEAD: move maxBytes under GET and HEAD, so request\.body: \{maxBytes: \.\.\.\} becomes request\.body: \{GET: \{maxBytes: \.\.\.\}, HEAD: \{maxBytes: \.\.\.\}\}\./);
  const typed = (() => { try { validateDocument(parseYaml('version: "1"\nroutes:\n  /a:\n    request: {body: {format: json, maxBytes: 10}}\n    respond: {text: hi}\n')); } catch (error) { return (error as Error).message; } return ''; })();
  assert.match(typed, /route \/a: it declares no methods, so it answers the default GET and HEAD, whose body entries take only maxBytes; if it accepts a body, declare methods: \[POST\] and move maxBytes and format under POST, so request\.body: \{maxBytes: \.\.\., format: \.\.\.\} becomes methods: \[POST\] with request\.body: \{POST: \{maxBytes: \.\.\., format: \.\.\.\}\}\./);
  // A route answering GET and POST: the whole policy under POST, and the bound alone under GET.
  const mixed = (() => { try { validateDocument(parseYaml('version: "1"\nroutes:\n  /a:\n    methods: [GET, POST]\n    request: {body: {maxBytes: 10, format: json}}\n    respond: {text: hi}\n')); } catch (error) { return (error as Error).message; } return ''; })();
  assert.match(mixed, /move maxBytes and format under POST, and maxBytes alone under GET, so request\.body: \{maxBytes: \.\.\., format: \.\.\.\} becomes request\.body: \{POST: \{maxBytes: \.\.\., format: \.\.\.\}, GET: \{maxBytes: \.\.\.\}\}/);
});

test('every route and shared block in the legacy shape gets its own hint, each located, in one error', async t => {
  const root = await site(t, [
    'version: "1"',
    'shared:',
    '  forms:',
    '    request:',
    '      body:',
    '        contentTypes: [application/json]',
    'routes:',
    '  /one:',
    '    methods: [PUT]',
    '    request:',
    '      body:',
    '        required: true',
    '    respond: {status: 204}',
    '  /fine:',
    '    methods: [POST]',
    '    request: {body: {POST: {required: true}}}',
    '    respond: {status: 204}',
    '  /two:',
    '    methods: [POST]',
    '    use: forms',
    '    respond: {status: 204}',
    '  /three:',
    '    methods: [PATCH]',
    '    request:',
    '      body:',
    '        maxBytes: 5',
    '    respond: {status: 204}',
    '',
  ].join('\n'));
  const error = await failure(root);
  assert.match(error.message, /^urlcode\.yaml:6:9: Invalid configuration at \/shared\/forms\/request\/body \(legacy-request-body\): /);
  assert.equal(error.details.pointer, '/shared/forms/request/body');
  const hint = legacyRequestBodyHintIn(error.message)!;
  assert.match(hint, /shared block "forms": every route that uses it answers POST: move contentTypes under POST, so request\.body: \{contentTypes: \.\.\.\} becomes request\.body: \{POST: \{contentTypes: \.\.\.\}\}; /);
  assert.match(hint, /; route \/one \(line 12, column 9\): move required under PUT, so /);
  assert.match(hint, /; route \/three \(line 26, column 9\): move maxBytes under PATCH, so /);
  assert.doesNotMatch(hint, /\/fine|\/two/, 'only the places that still write the old shape');
  assert.equal(hint.match(/: move /g)?.length, 3, 'one instruction each');
});

test('the per-method shape validates cleanly', async t => {
  const root = await site(t, 'version: "1"\nshared:\n  forms:\n    request: {body: {POST: {contentTypes: [application/json]}}}\nroutes:\n  /contact:\n    methods: [GET, POST]\n    request:\n      body:\n        GET: {maxBytes: 0}\n        POST: {required: true, format: json, schema: {type: object}}\n    respond: {status: 204}\n  /form:\n    methods: [POST]\n    use: forms\n    respond: {status: 204}\n');
  const loaded = await loadDocument(root);
  assert.deepEqual(Object.keys(loaded.routes).sort(), ['/contact', '/form']);
});

test('MCP validate and explain_error return the same hint as the CLI loader', async t => {
  const root = await site(t, 'version: "1"\nroutes:\n  /contact:\n    methods: [POST]\n    request:\n      body:\n        format: json\n    respond: {status: 204}\n');
  const cli = (await failure(root)).message;
  const hint = legacyRequestBodyHintIn(cli)!;
  assert.ok(hint.startsWith(rule) && hint.endsWith(notes), hint);
  let text = '';
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'validate', arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'explain_error', arguments: { error: cli } } },
  ];
  await serveMcp({ project: root, input: Readable.from([messages.map(value => JSON.stringify(value) + '\n').join('')]), output: new Writable({ write(chunk, _encoding, done) { text += String(chunk); done(); } }) });
  const replies = text.trim().split('\n').map(line => JSON.parse(line) as { id: number; result: { isError?: boolean; content: { text: string }[] } });
  const validated = replies.find(reply => reply.id === 2)!, explained = replies.find(reply => reply.id === 3)!;
  assert.equal(validated.result.isError, true);
  assert.equal(validated.result.content[0]!.text, cli, 'MCP validate prints what the CLI prints');
  const guidance = JSON.parse(explained.result.content[0]!.text) as { matched: string; guidance: string };
  assert.equal(guidance.matched, 'legacy-request-body');
  assert.equal(guidance.guidance, hint);
  // The SDK function agrees, and a fragment without the hint still gets the family's own guidance.
  assert.deepEqual(explainError(cli).guidance, hint);
  assert.match(explainError('legacy-request-body').guidance, /under a method key such as POST:/);
});
