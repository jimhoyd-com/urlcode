import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDocument } from '../src/config.ts';
import { inspectExtensionRevision } from '../src/extensions.ts';
import { initProjectWith, parseWithNames } from '../src/init-with.ts';
import { project } from './helpers.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const run = (cwd: string, args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
const parse = (out: string): Record<string, unknown> => JSON.parse(out.trim().split('\n').pop()!) as Record<string, unknown>;
const missing = async (path: string): Promise<boolean> => { try { await lstat(path); return false; } catch { return true; } };
interface FakeOptions { routes?: Record<string, unknown>; scaffold?: boolean }
/** A fake `@jimhoyd/urlcode-<name>` package in the temp directory's node_modules, exporting `scaffold` and a runtime extension factory. */
async function fakePackage(root: string, name: string, { routes, scaffold = true }: FakeOptions = {}): Promise<void> {
  const dir = join(root, 'node_modules', '@jimhoyd', `urlcode-${name}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: `@jimhoyd/urlcode-${name}`, type: 'module', exports: './index.mjs' }));
  const fragment = JSON.stringify(routes ?? { [`/${name}/*`]: { extension: name, methods: ['GET', 'HEAD', 'POST'] } });
  await writeFile(join(dir, 'index.mjs'), `const name=${JSON.stringify(name)};
export function fakeExtension(projectSha256){return {name,version:'1',projectSha256,targets:['node'],schema:{type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false},activate(){return {handle:()=>({status:200,headers:[],body:'hi'})};}};}
${scaffold ? `export async function scaffold(request){
  if(!request.names.includes(name))throw new Error('names must include '+name);
  return {name,extensions:{[name]:{version:'1',config:{label:'hello'}}},routes:${fragment},
    hostImports:[\`import {fakeExtension as \${name}Extension} from '@jimhoyd/urlcode-\${name}';\`],
    hostSetup:[\`const \${name}Sha = process.env.PROJECT_SHA256;\`],hostEntries:[\`\${name}Extension(\${name}Sha)\`],hostClose:[\`// release \${name}\`],
    files:[{path:\`operator-\${name}.mjs\`,content:'export default 1;\\n',mode:0o600},{path:\`data/\${name}.key\`,content:new Uint8Array([1,2,3]),mode:0o600},{path:\`notes/\${name}.txt\`,content:'public note'}],
    readme:\`Readme for \${name}.\`,nextSteps:[\`step one for \${name}\`,\`step two for \${name}\`],env:{PROJECT_SHA256:'Reviewed revision.'}};
}` : ''}
`);
}

test('init --with merges fake extension scaffolds in order, keeps file modes and the result validates with the generated host', async t => {
  const root = await project(t, {});
  await fakePackage(root, 'demo'); await fakePackage(root, 'other');
  const created = run(root, ['init', 'site', '--with', 'other,demo']);
  assert.equal(created.status, 0, created.stderr);
  const report = parse(created.stdout);
  assert.equal(report.event, 'created'); assert.deepEqual(report.extensions, ['other', 'demo']);
  const site = join(root, 'site'), app = join(site, 'app');
  // The CLI resolves against its cwd, which macOS reports through /private and Windows may report as a short name; compare canonical paths.
  const canonical = (path: string) => realpathSync.native(path);
  assert.equal(canonical(String(report.project)), canonical(app)); assert.equal(canonical(String(report.hostFile)), canonical(join(site, 'host.mjs')));
  const sha = await inspectExtensionRevision(app);
  assert.equal(report.projectSha256, sha); assert.match(String(report.review), new RegExp(`PROJECT_SHA256=${sha}`));
  const loaded = await loadDocument(app);
  assert.deepEqual(Object.keys(loaded.routes), ['/hello/{name}', '/go', '/other/*', '/demo/*']);
  assert.deepEqual(Object.keys(loaded.document.extensions ?? {}), ['other', 'demo']);
  const host = await readFile(join(site, 'host.mjs'), 'utf8');
  const order = ['import {fakeExtension as otherExtension}', 'import {fakeExtension as demoExtension}', 'const otherSha', 'const demoSha', 'otherExtension(otherSha),', 'demoExtension(demoSha),', '// release demo', '// release other'].map(needle => host.indexOf(needle));
  assert.ok(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1]!)), host);
  // Windows has no POSIX modes; the files still exist there.
  for (const [file, mode] of [['operator-demo.mjs', 0o600], ['data/other.key', 0o600], ['notes/demo.txt', 0o644], ['host.mjs', 0o600]] as const) { const info = await stat(join(site, file)); if (process.platform !== 'win32') assert.equal(info.mode & 0o777, mode, file); }
  assert.deepEqual([...await readFile(join(site, 'data/demo.key'))], [1, 2, 3]);
  const readme = await readFile(join(site, 'README.md'), 'utf8');
  for (const needle of ['## Starter', '## Your URLCode project', '## Extension: other', 'Readme for other.', '## Extension: demo', '1. step one for other', '3. step one for demo', '- `PROJECT_SHA256`: Reviewed revision.', sha]) assert.ok(readme.includes(needle), needle);
  assert.ok(readme.indexOf('## Extension: other') < readme.indexOf('## Extension: demo'));
  assert.ok(await missing(join(app, 'README.md')));
  // One .mcp.json at the site root, pointing the read-only server at app/; the app copy moves up with it.
  assert.ok(await missing(join(app, '.mcp.json')));
  assert.deepEqual(JSON.parse(await readFile(join(site, '.mcp.json'), 'utf8')), { mcpServers: { urlcode: { command: 'urlcode', args: ['mcp', '--project', 'app'] } } });
  assert.ok((await readFile(join(app, '.gitignore'), 'utf8')).includes('.env.*'));
  const validated = run(root, ['validate', '--project', app, '--host-file', join(site, 'host.mjs'), '--origin', 'https://demo.example'], { PROJECT_SHA256: sha });
  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(parse(validated.stdout).routes, 4);
  // Nothing generated is ever overwritten: the destination is reserved once.
  const again = run(root, ['init', 'site', '--with', 'demo']);
  assert.equal(again.status, 1); assert.equal(await readFile(join(site, 'host.mjs'), 'utf8'), host);
});
test('init --with refuses duplicate routes, missing packages and packages without scaffold before writing anything', async t => {
  const root = await project(t, {});
  await fakePackage(root, 'demo'); await fakePackage(root, 'twin', { routes: { '/demo/*': { extension: 'twin' } } });
  await fakePackage(root, 'dup', { routes: { '/go': { redirect: { url: 'https://example.org' } } } }); await fakePackage(root, 'plain', { scaffold: false });
  const cases: [string, RegExp][] = [
    ['demo,twin', /Route \/demo\/\* is added by both demo and twin/],
    ['dup', /Route \/go from dup already exists in the starter/],
    ['missing', /@jimhoyd\/urlcode-missing is not installed .*run: npm install @jimhoyd\/urlcode-missing/],
    ['plain', /@jimhoyd\/urlcode-plain does not export scaffold/],
    ['demo,demo', /Duplicate --with names/], ['Demo', /--with name/], ['', /--with name/],
  ];
  for (const [names, message] of cases) {
    const result = run(root, ['init', 'site', '--with', names]);
    assert.equal(result.status, 1, names); assert.match(result.stderr, message);
    assert.ok(await missing(join(root, 'site')), `${names} left files behind`);
  }
  assert.match(run(root, ['validate', '--with', 'demo']).stderr, /--with is only supported by init/);
  await assert.rejects(initProjectWith(join(root, 'site'), ['demo', 'missing'], { cwd: root }), /not installed/);
  assert.ok(await missing(join(root, 'site')));
  assert.deepEqual(parseWithNames(' auth , admin'), ['auth', 'admin']);
});
// The real companion packages are private repositories; this runs only where their checkouts exist.
const companions = { 'urlcode-auth': '/home/user/wt/auth-main', 'urlcode-admin': '/home/user/wt/admin-main', 'urlcode-ui': '/home/user/urlcode-ui' };
const absent: string[] = [];
for (const [name, path] of Object.entries(companions)) if (await missing(join(path, 'package.json'))) absent.push(`${name} (${path})`);
test('init --with auth,admin composes the real companion scaffolds', { skip: absent.length ? `companion checkouts not present: ${absent.join(', ')}` : false }, async t => {
  const root = await project(t, {});
  await mkdir(join(root, 'node_modules', '@jimhoyd'), { recursive: true });
  for (const [name, path] of Object.entries(companions)) await symlink(path, join(root, 'node_modules', '@jimhoyd', name), 'dir');
  const created = run(root, ['init', 'site', '--with', 'auth,admin']);
  assert.equal(created.status, 0, created.stderr);
  const report = parse(created.stdout), site = join(root, 'site'), app = join(site, 'app');
  const loaded = await loadDocument(app);
  assert.deepEqual(Object.keys(loaded.routes), ['/hello/{name}', '/go', '/account/*', '/private', '/admin/*']);
  assert.deepEqual(Object.keys(loaded.document.extensions ?? {}), ['auth', 'admin']);
  assert.equal(report.projectSha256, await inspectExtensionRevision(app));
  const host = await readFile(join(site, 'host.mjs'), 'utf8');
  assert.ok(host.indexOf("from '@jimhoyd/urlcode-auth'") < host.indexOf("from '@jimhoyd/urlcode-admin'"));
  assert.ok(host.indexOf('authExtension({service, csrfKey, projectSha256}),') < host.indexOf("adminExtension({service, csrfKey, projectSha256, authMount: '/account'}),"));
  assert.ok(host.includes('await service.close();'));
  for (const file of ['operator-service.mjs', 'data/encryption.key', 'data/csrf.key']) assert.equal((await stat(join(site, file))).mode & 0o777, 0o600, file);
  assert.equal((await stat(join(site, 'data/encryption.key'))).size, 32);
  const readme = await readFile(join(site, 'README.md'), 'utf8');
  for (const needle of ['## Extension: auth', '## Extension: admin', '## Administration', 'urlcode-auth bootstrap', '- `AUTH_ORIGIN`', '- `PROJECT_SHA256`']) assert.ok(readme.includes(needle), needle);
  // Admin needs auth in the same host; the refusal comes from its scaffold and leaves nothing behind.
  const alone = run(root, ['init', 'other', '--with', 'admin']);
  assert.equal(alone.status, 1); assert.match(alone.stderr, /urlcode-admin scaffold refused: .*requires the auth extension/); assert.ok(await missing(join(root, 'other')));
  // ui may or may not export scaffold yet; either it composes or it is refused clearly without writing.
  const withUi = run(root, ['init', 'ui-site', '--with', 'auth,admin,ui']);
  if (withUi.status === 0) assert.deepEqual(parse(withUi.stdout).extensions, ['auth', 'admin', 'ui']);
  else { assert.match(withUi.stderr, /@jimhoyd\/urlcode-ui does not export scaffold/); assert.ok(await missing(join(root, 'ui-site'))); }
  t.diagnostic('Serving the composed host needs a patched SQLite for the auth store; this test checks composition only.');
});
