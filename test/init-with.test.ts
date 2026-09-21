import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { loadDocument } from '../src/config.ts';
import { inspectExtensionRevision } from '../src/extensions.ts';
import { initProjectWith, parseWithNames } from '../src/init-with.ts';
import type { BundleTransport } from '../src/extension-bundles.ts';
import { project } from './helpers.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const run = (cwd: string, args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
const parse = (out: string): Record<string, unknown> => JSON.parse(out.trim().split('\n').pop()!) as Record<string, unknown>;
const missing = async (path: string): Promise<boolean> => { try { await lstat(path); return false; } catch { return true; } };
interface FakeOptions { routes?: Record<string, unknown>; scaffold?: boolean; version?: string; contract?: Record<string, string[]>; risk?: boolean }
/** A fake `@jimhoyd/urlcode-<name>` package in the temp directory's node_modules, exporting `scaffold` and a runtime extension factory. */
async function fakePackage(root: string, name: string, { routes, scaffold = true, version = '1.0.0', contract = {}, risk = false }: FakeOptions = {}): Promise<void> {
  const dir = join(root, 'node_modules', '@jimhoyd', `urlcode-${name}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: `@jimhoyd/urlcode-${name}`, version, type: 'module', exports: './index.mjs' }));
  const fragment = JSON.stringify(routes ?? { [`/${name}/*`]: { extension: name, methods: ['GET', 'HEAD', 'POST'] } });
  await writeFile(join(dir, 'index.mjs'), `const name=${JSON.stringify(name)};
export function fakeExtension(projectSha256){return {name,version:'1',projectSha256,targets:['node'],schema:{type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false},activate(){return {handle:()=>({status:200,headers:[],body:'hi'})};}};}
${scaffold ? `export async function scaffold(request){
  if(!request.names.includes(name))throw new Error('names must include '+name);
  const id=name+':risky';
  if(${risk}&&!request.acknowledgements.includes(id))throw Object.assign(new Error('this would do something risky'),{acknowledgement:id});
  return {name,...(${risk}?{acknowledged:[id]}:{}),extensions:{[name]:{version:'1',config:{label:'hello'}}},routes:${fragment},
    hostImports:[\`import {fakeExtension as \${name}Extension} from '@jimhoyd/urlcode-\${name}';\`],
    hostSetup:[\`const \${name}Sha = process.env.PROJECT_SHA256;\`],hostEntries:[\`\${name}Extension(\${name}Sha)\`],hostClose:[\`// release \${name}\`],
    files:[{path:\`operator-\${name}.mjs\`,content:'export default 1;\\n',mode:0o600},{path:\`data/\${name}.key\`,content:new Uint8Array([1,2,3]),mode:0o600},{path:\`notes/\${name}.txt\`,content:'public note'}],
    readme:\`Readme for \${name}.\`,...${JSON.stringify(contract)},nextSteps:[\`step one for \${name}\`,\`step two for \${name}\`],env:{PROJECT_SHA256:'Reviewed revision.'}};
}` : ''}
`);
}
function bundleArchive():{bytes:Buffer;entry:string;sha256:string}{
  const entry='node_modules/@jimhoyd/urlcode-demo/dist/index.js', manifest={format:1,coreVersion:'0.4.9',bundles:[{name:'demo',version:'1.0.0',entry}]};
  // The executable test module is deliberately a fixed literal, never a
  // template populated from an input. It models the reviewed `demo` bundle.
  const moduleSource=`export async function scaffold(){return {name:'demo',extensions:{demo:{version:'1',config:{label:'bundle'}}},routes:{'/demo/*':{extension:'demo',methods:['GET']}},hostImports:[],hostBundleExports:['demoExtension'],hostSetup:['const demoSha = process.env.PROJECT_SHA256;'],hostEntries:['demoExtension(demoSha)'],files:[],readme:'Bundle demo.',nextSteps:['serve bundle demo']};}
export const demoExtension=(projectSha256)=>({name:'demo',version:'1',projectSha256,targets:['node'],schema:{type:'object'},activate(){return {handle:()=>({status:200,headers:[],body:'ok'})}}});`;
  const files:{path:string;body:string}[]=[{path:'bundle.json',body:JSON.stringify(manifest)},{path:'node_modules/@jimhoyd/urlcode-demo/package.json',body:JSON.stringify({type:'module'})},{path:entry,body:moduleSource}];
  const parts:Buffer[]=[];for(const file of files){const body=Buffer.from(file.body),header=Buffer.alloc(512);header.write(file.path);header.write(body.length.toString(8).padStart(11,'0')+'\0',124);header[156]=48;header.fill(32,148,156);const checksum=[...header].reduce((sum,byte)=>sum+byte,0);header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148);parts.push(header,body,Buffer.alloc((512-body.length%512)%512));}parts.push(Buffer.alloc(1024));const bytes=gzipSync(Buffer.concat(parts));return {bytes,entry,sha256:createHash('sha256').update(bytes).digest('hex')};
}

test('init --with merges fake extension scaffolds in canonical order, keeps file modes and the result validates with the generated host', async t => {
  const root = await project(t, {});
  await fakePackage(root, 'demo'); await fakePackage(root, 'other');
  const created = run(root, ['init', 'site', '--with', 'other,demo']);
  assert.equal(created.status, 0, created.stderr);
  const report = parse(created.stdout);
  assert.equal(report.event, 'created'); assert.deepEqual(report.extensions, ['demo', 'other']);
  const site = join(root, 'site'), app = join(site, 'app');
  // The CLI resolves against its cwd, which macOS reports through /private and Windows may report as a short name; compare canonical paths.
  const canonical = (path: string) => realpathSync.native(path);
  assert.equal(canonical(String(report.project)), canonical(app)); assert.equal(canonical(String(report.hostFile)), canonical(join(site, 'host.mjs')));
  const sha = await inspectExtensionRevision(app);
  assert.equal(report.projectSha256, sha); assert.match(String(report.review), new RegExp(`PROJECT_SHA256=${sha}`));
  const loaded = await loadDocument(app);
  assert.deepEqual(Object.keys(loaded.routes), ['/hello/{name}', '/go', '/demo/*', '/other/*']);
  assert.deepEqual(Object.keys(loaded.document.extensions ?? {}), ['demo', 'other']);
  const host = await readFile(join(site, 'host.mjs'), 'utf8');
  const order = ['import {fakeExtension as demoExtension}', 'import {fakeExtension as otherExtension}', 'const demoSha', 'const otherSha', 'demoExtension(demoSha),', 'otherExtension(otherSha),', '// release other', '// release demo'].map(needle => host.indexOf(needle));
  assert.ok(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1]!)), host);
  // Windows has no POSIX modes; the files still exist there.
  for (const [file, mode] of [['operator-demo.mjs', 0o600], ['data/other.key', 0o600], ['notes/demo.txt', 0o644], ['host.mjs', 0o600]] as const) { const info = await stat(join(site, file)); if (process.platform !== 'win32') assert.equal(info.mode & 0o777, mode, file); }
  assert.deepEqual([...await readFile(join(site, 'data/demo.key'))], [1, 2, 3]);
  const readme = await readFile(join(site, 'README.md'), 'utf8');
  for (const needle of ['## Starter', '## Your URLCode project', '## Extension: demo', 'Readme for demo.', '## Extension: other', '1. Review ', '2. Run `npm install`', '3. step one for demo', '5. step one for other', '- `PROJECT_SHA256`: Reviewed revision.', sha]) assert.ok(readme.includes(needle), needle);
  assert.ok(readme.indexOf('## Extension: demo') < readme.indexOf('## Extension: other'));
  assert.ok(await missing(join(app, 'README.md')));
  // One .mcp.json at the site root, pointing the read-only server at app/; the app copy moves up with it.
  assert.ok(await missing(join(app, '.mcp.json')));
  assert.deepEqual(JSON.parse(await readFile(join(site, '.mcp.json'), 'utf8')), { mcpServers: { urlcode: { command: 'urlcode', args: ['mcp', '--project', 'app'] } } });
  assert.ok((await readFile(join(app, '.gitignore'), 'utf8')).includes('.env.*'));
  // The site records the versions it was generated against; installing them stays an explicit operator step.
  assert.deepEqual(JSON.parse(await readFile(join(site, 'package.json'), 'utf8')).dependencies['@jimhoyd/urlcode-demo'], '1.0.0');
  assert.ok(await missing(join(site, 'package-lock.json')));
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

test('init --with bundle release writes a locked npm-free extension host',async t=>{
  const root=await project(t,{}), archive=bundleArchive(), release='extension-bundles@v0.4.9', catalog=Buffer.from(JSON.stringify({format:1,tag:release,commit:'a'.repeat(40),coreVersion:'0.4.9',bundles:[{name:'demo',version:'1.0.0',asset:'demo-1.0.0.tgz',sha256:archive.sha256,entry:archive.entry}],revoked:[]}));
  const transport:BundleTransport={release:async()=>[{name:'extension-bundles-catalog.json',url:'catalog'},{name:'demo-1.0.0.tgz',url:'bundle'}],download:async url=>url==='catalog'?catalog:archive.bytes,attest:async()=>{}};
  const created=await initProjectWith(join(root,'site'),['demo'],{cwd:root,bundleRelease:release,bundleTransport:transport});
  const host=await readFile(created.hostFile,'utf8');
  assert.match(host,/loadExtensionBundle/);assert.match(host,/loadExtensionBundle\(extensionBundleDirectory, 'demo'\)/);assert.doesNotMatch(host,/@jimhoyd\/urlcode-demo/);
  assert.ok(!(await missing(join(root,'site','urlcode.extension-bundles.lock.json'))));assert.ok(!(await missing(join(root,'site','.urlcode','extension-bundles',archive.sha256,'.bundle.tgz'))));
  assert.deepEqual(JSON.parse(await readFile(join(root,'site','package.json'),'utf8')).dependencies,{'@jimhoyd/urlcode':'0.4.9'});
});

test('init --with carries generic --ack acknowledgements: refusal prints the exact command, unconsumed values are rejected, nothing is written on refusal', async t => {
  const root = await project(t, {});
  await fakePackage(root, 'risky', { risk: true }); await fakePackage(root, 'calm');
  const refused = run(root, ['init', 'site', '--with', 'calm,risky', '--no-manifest']);
  assert.equal(refused.status, 1); assert.match(refused.stderr, /this would do something risky\. If you accept that risk, re-run with the acknowledgement: urlcode init site --with calm,risky --no-manifest --ack risky:risky/);
  assert.ok(await missing(join(root, 'site')));
  // An acknowledgement for another extension does not satisfy it, and the refusal keeps what was already passed.
  const other = run(root, ['init', 'site', '--with', 'calm,risky', '--no-manifest', '--ack', 'calm:other']);
  assert.match(other.stderr, /--no-manifest --ack calm:other --ack risky:risky/);
  const ok = run(root, ['init', 'site', '--with', 'risky', '--no-manifest', '--ack', 'risky:risky', '--ack', 'risky:risky']);
  assert.equal(ok.status, 0, ok.stderr);
  const unused = ['calm:risky', 'risky:other', 'ghost:thing'];
  for (const [index, id] of unused.entries()) {
    const result = run(root, ['init', `u${index}`, '--with', 'calm,risky', '--no-manifest', '--ack', 'risky:risky', '--ack', id]);
    assert.equal(result.status, 1, id); assert.match(result.stderr, new RegExp(`--ack ${id} has no effect`)); assert.ok(await missing(join(root, `u${index}`)));
  }
  assert.match(run(root, ['init', 'bad', '--with', 'calm', '--ack', 'nocolon']).stderr, /Use --ack <extension>:<id>/);
  assert.match(run(root, ['init', 'bad', '--ack', 'calm:x']).stderr, /--ack is only supported by init with --with/);
  assert.match(run(root, ['validate', '--ack', 'calm:x']).stderr, /--ack is only supported by init with --with/);
});

const permutations = <T,>(items: T[]): T[][] => items.length <= 1 ? [items] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [item, ...rest]));
const siteFiles = async (root: string, name: string): Promise<{ yaml: string; routes: string; host: string; sha: string }> => {
  const site = join(root, name), app = join(site, 'app');
  return { yaml: await readFile(join(app, 'urlcode.yaml'), 'utf8'), routes: await readFile(join(app, 'routes/extensions.yaml'), 'utf8'), host: (await readFile(join(site, 'host.mjs'), 'utf8')).replace(/^\/\/ Generated by.*\n/, ''), sha: await inspectExtensionRevision(app) };
};
test('init --with treats the set as unordered: every permutation emits the same order, host and revision', async t => {
  const root = await project(t, {});
  await fakePackage(root, 'ui', { contract: { provides: ['ui.kit'] } });
  await fakePackage(root, 'auth', { contract: { requires: ['ui.kit'], provides: ['auth.service'] } });
  await fakePackage(root, 'admin', { contract: { requires: ['ui.kit', 'auth.service'] } });
  let index = 0, baseline: Record<string, string> | undefined;
  for (const order of permutations(['admin', 'auth', 'ui'])) {
    const name = `site${index++}`, created = await initProjectWith(join(root, name), order, { cwd: root, manifest: false });
    assert.deepEqual(created.extensions, ['ui', 'auth', 'admin']);
    const files = await siteFiles(root, name);
    assert.equal(files.sha, created.projectSha256);
    assert.deepEqual(Object.keys((await loadDocument(join(root, name, 'app'))).document.extensions ?? {}), ['ui', 'auth', 'admin']);
    const host = files.host, at = ['uiExtension(', 'authExtension(', 'adminExtension('].map(needle => host.indexOf(needle));
    assert.ok(at.every((i, n) => i >= 0 && (n === 0 || i > at[n - 1]!)), host);
    baseline ??= files as unknown as Record<string, string>; assert.deepEqual(files, baseline, order.join(','));
  }
  assert.equal(index, 6);
});
test('init --with refuses a missing requirement, a conflict or a cycle before writing, naming the extensions', async t => {
  const root = await project(t, {});
  await fakePackage(root, 'ui', { contract: { provides: ['ui.kit'] } });
  await fakePackage(root, 'needy', { contract: { requires: ['ui.kit', 'auth'] } });
  await fakePackage(root, 'clash', { contract: { conflicts: ['ui'] } });
  await fakePackage(root, 'loopa', { contract: { requires: ['loopb'] } }); await fakePackage(root, 'loopb', { contract: { after: ['loopa'] } });
  for (const [names, expected] of [[['needy'], /needy requires ui\.kit/], [['needy', 'ui'], /needy requires auth/], [['ui', 'clash'], /clash conflicts with ui/], [['loopb', 'loopa', 'ui'], /cycle among loopa \(needs loopb\); loopb \(needs loopa\)/]] as const) {
    const destination = join(root, 'refused');
    await assert.rejects(initProjectWith(destination, names, { cwd: root, manifest: false }), expected);
    assert.ok(await missing(destination), names.join(','));
  }
  assert.doesNotMatch(await initProjectWith(join(root, 'ok'), ['ui'], { cwd: root, manifest: false }).then(() => '', error => String(error)), /./);
});
