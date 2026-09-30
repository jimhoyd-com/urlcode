// #808: a missing page/download/static reference names the route, the YAML field and its location, the reference as
// written and the project-relative resolution rule, without absolute host paths; escaping references stay redacted
// (#610) and give the same answer whether or not the outside target exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { createRuntime } from '../packages/core/src/runtime.ts';
import { ConfigError } from '../packages/core/src/errors.ts';
import { serveMcp } from '../packages/core/src/mcp.ts';
import { project, spawnAsync } from './helpers.ts';

const cli = fileURLToPath(new URL('../packages/core/src/cli.ts', import.meta.url));
const rejection = async (promise: Promise<unknown>): Promise<ConfigError> => {
  try { await promise; } catch (error) { assert.ok(error instanceof ConfigError, String(error)); return error; }
  assert.fail('expected a rejection');
};
/** A site directory holding app/urlcode.yaml exactly as `yaml`, plus `files` relative to the site. */
async function site(t: import('node:test').TestContext, yaml: string, files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-site-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'app'));
  await writeFile(join(root, 'app', 'urlcode.yaml'), yaml);
  for (const [file, content] of Object.entries(files)) { await mkdir(join(root, file, '..'), { recursive: true }); await writeFile(join(root, file), content); }
  return root;
}
/** `urlcode validate --local --project app` run from the site directory, as the issue reproduces it. */
async function validate(cwd: string, ...args: string[]): Promise<{ status: number | null; error: Record<string, unknown> | undefined; output: string }> {
  const result = await spawnAsync(process.execPath, [cli, 'validate', '--local', '--project', 'app', ...args], { cwd, encoding: 'utf8', timeout: 20000 });
  const output = result.stdout + result.stderr;
  const lines = output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  return { status: result.status, error: lines.find(line => line.event === 'error'), output };
}
const staticYaml = (directory: string, extra = '') => `version: "1"\n${extra}routes:\n  /assets/*:\n    static:\n      directory: ${directory}\n`;
async function mcpText(root: string, name: string): Promise<{ isError: boolean | undefined; text: string }> {
  let out = '';
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: {} } },
  ];
  await serveMcp({ project: root, input: Readable.from([messages.map(value => JSON.stringify(value) + '\n').join('')]), output: new Writable({ write(chunk, _encoding, done) { out += String(chunk); done(); } }) });
  const reply = out.trim().split('\n').map(line => JSON.parse(line) as { id?: number; result: { isError?: boolean; content: { text: string }[] } }).find(line => line.id === 2)!;
  return { isError: reply.result.isError, text: reply.result.content[0]!.text };
}

test('an ordinary missing static directory names the route, field, location, reference and resolution rule', async t => {
  const root = await site(t, staticYaml('public'));
  const { status, error, output } = await validate(root);
  assert.equal(status, 1);
  assert.equal(error?.message, 'urlcode.yaml:5:7: Route /assets/*: static.directory "public" does not exist; asset references resolve relative to the selected project directory (the one holding urlcode.yaml), not the site or working directory');
  assert.deepEqual([error?.code, error?.route, error?.pointer, error?.file, error?.line, error?.column], ['missing-file', '/assets/*', '/routes/~1assets~1*/static/directory', 'urlcode.yaml', 5, 7]);
  assert.ok(!output.includes(root), 'no absolute host path');
  // The same message reaches the in-process loader and the MCP validate and get_context tools.
  const direct = await rejection(createRuntime(join(root, 'app'), { local: true }));
  assert.equal(direct.message, error?.message);
  for (const tool of ['validate', 'get_context']) assert.deepEqual(await mcpText(join(root, 'app'), tool), { isError: true, text: error?.message });
});

test('the doubled app/ prefix suggests the project-relative reference only when it exists in the project', async t => {
  const root = await site(t, staticYaml('app/assets'), { 'app/assets/a.txt': 'a' });
  const absent = await site(t, staticYaml('app/public'));
  const wrongKind = await site(t, staticYaml('app/assets'), { 'app/assets': 'a file, not a directory' });
  const page = await site(t, 'version: "1"\nroutes:\n  /about:\n    page:\n      file: app/about.html\n  /guide:\n    download:\n      file: guide.pdf\n', { 'app/about.html': '<p>x</p>', 'app/guide.pdf': 'pdf' });
  const fn = await site(t, 'version: "1"\nroutes:\n  /f:\n    function: app/functions/f.mjs\n', { 'app/functions/f.mjs': 'export default () => new Response("x")' });
  // The five validations are independent processes: started together, checked in order.
  const [{ error }, absentRun, wrongKindRun, pageRun, fnRun] = await Promise.all([validate(root), validate(absent), validate(wrongKind), validate(page), validate(fn)]);
  assert.equal(error?.message, 'urlcode.yaml:5:7: Route /assets/*: static.directory "app/assets" does not exist; asset references resolve relative to the selected project directory (the one holding urlcode.yaml), not the site or working directory; did you mean "assets"? That directory exists in this project');
  assert.equal(error?.code, 'missing-file');
  // No suggestion for a shorter reference that is missing too, or that is the wrong kind.
  assert.doesNotMatch(String(absentRun.error?.message), /did you mean/);
  assert.doesNotMatch(String(wrongKindRun.error?.message), /did you mean/);
  // page, download and function sources get the same hint.
  assert.match(String(pageRun.error?.message), /^urlcode\.yaml:5:7: Route \/about: page\.file "app\/about\.html" does not exist; .*; did you mean "about\.html"\? That file exists in this project$/);
  assert.match(String(fnRun.error?.message), /Referenced project file is missing: "app\/functions\/f\.mjs" \(paths are relative to the directory holding urlcode\.yaml\); did you mean "functions\/f\.mjs"\? That file exists in this project/);
});

test('a reference in an include names that file, and a site file convention names its site key', async t => {
  const included = await project(t, {}, { 'more.yaml': 'version: "1"\nroutes:\n  /guide:\n    download:\n      file: docs/guide.pdf\n' }, { includes: ['more.yaml'] });
  const error = await rejection(createRuntime(included, { local: true }));
  assert.match(error.message, /^more\.yaml:5:7: Route \/guide: download\.file "docs\/guide\.pdf" does not exist/);
  assert.deepEqual([error.details.file, error.details.line, error.details.route], ['more.yaml', 5, '/guide']);
  const favicon = await rejection(createRuntime(await project(t, {}, {}, { site: { favicon: 'favicon.ico' } }), { local: true }));
  assert.match(favicon.message, /^urlcode\.yaml:\d+:\d+: site\.favicon "favicon\.ico" does not exist/);
  assert.deepEqual([favicon.details.pointer, favicon.details.route], ['/site/favicon', undefined]);
});

test('escaping references stay redacted and answer the same whether or not the outside target exists', async t => {
  const answers = async (directory: string, extra: string, outside: 'present' | 'absent', link = false) => {
    const root = await site(t, staticYaml(directory, extra), outside === 'present' ? { 'outside/secret-name.txt': 'x' } : {});
    if (link) await symlink(join(root, 'outside'), join(root, 'app', 'linked'));
    // The CLI child and the in-process MCP tool are independent; they run at the same time.
    const [cli, mcp] = await Promise.all([validate(root, '--origin', 'https://example.com'), mcpText(join(root, 'app'), 'validate')]);
    assert.ok(!cli.output.includes(root) && !cli.output.includes('secret-name') && !cli.output.includes('outside'), cli.output);
    assert.ok(!mcp.text.includes('outside') && !mcp.text.includes(root), mcp.text);
    return { cli: cli.error, mcp };
  };
  // With site.sitemap the tree used to be walked before the reference was checked, which made the two answers differ.
  for (const [directory, extra] of [['../outside', ''], ['../outside', 'site:\n  sitemap: true\n'], ['/etc', '']] as const) {
    const [present, absent] = await Promise.all([answers(directory, extra, 'present'), answers(directory, extra, 'absent')]);
    assert.deepEqual(present, absent, directory);
    assert.equal(present.cli?.code, 'invalid-file-reference');
    assert.equal(present.cli?.route, '/assets/*');
    assert.match(String(present.cli?.message), /Route \/assets\/\*: static\.directory must name a directory inside the project: no absolute path, "\.\.", hidden or sensitive segment/);
    assert.equal(present.mcp.isError, true);
  }
  const [present, dangling] = await Promise.all([answers('linked', '', 'present', true), answers('linked', '', 'absent', true)]);
  assert.deepEqual(present, dangling);
  assert.match(String(present.cli?.message), /static\.directory passes through a symlink; asset symlinks are forbidden/);
  assert.ok(!String(present.cli?.message).includes('"linked"'));
});
