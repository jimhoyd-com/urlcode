// Exercises scripts/create-extension.ts (#614, #615): asserts specific
// generated files and their content, and runs the generated package's own
// typecheck and test, not just that the script exits 0. Packages are
// generated under a randomly named directory directly below the repository
// root (--packages-dir), never packages/, so a half-built package never
// appears in the add-on list other scripts and tests read; it is always
// removed afterward. Running the generated test needs the root build
// (dist/), which `npm run verify` produces before `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const scriptPath = join(repoRoot, 'scripts', 'create-extension.ts');
const packagesDir = join(repoRoot, 'packages');
const coreVersion = (JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version;

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [scriptPath, ...args], { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A fresh output directory directly under the repository root, removed after the test. */
async function outputDir(t: test.TestContext): Promise<string> {
  const dir = join(repoRoot, `.create-extension-test-${randomUUID().slice(0, 8)}`);
  await mkdir(dir);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Asserts a TypeScript source file parses without syntax errors. */
function assertParses(source: string, path: string): void {
  const result = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const errors = (result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [], `${path} has syntax errors`);
}

interface Manifest {
  name: string; version: string; private: boolean; description: string; files: string[];
  exports: Record<string, { types: string; default: string }>;
  devDependencies: Record<string, string>; peerDependencies: Record<string, string>; scripts: Record<string, string>;
}

test('a blank scaffold creates the new extension shape, and the generated package typechecks and passes its own test', async t => {
  const out = await outputDir(t);
  const name = `scaff-blank-${randomUUID().slice(0, 8)}`;
  const result = run([name, '--description', 'A generated test extension.', '--packages-dir', out]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Created ${out.slice(repoRoot.length).replace(/^\//, '')}/${name} \\(\\d+ files\\)\\.`));
  await assert.rejects(stat(join(packagesDir, name)), 'nothing is written under packages/ when --packages-dir is given');

  const dir = join(out, name);
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Manifest;
  assert.equal(manifest.name, `@jimhoyd/urlcode-${name}`);
  assert.equal(manifest.version, coreVersion, 'released with core at core\'s version');
  assert.equal(manifest.private, true);
  assert.equal(manifest.description, 'A generated test extension.');
  assert.deepEqual(manifest.exports['./extension'], { types: './dist/extension.d.ts', default: './dist/extension.js' });
  assert.ok(manifest.exports['.']);
  assert.deepEqual(manifest.files, ['dist', 'urlcode.json', 'README.md', 'LICENSE', 'NOTICE', 'SECURITY.md']);
  assert.equal(manifest.devDependencies['@jimhoyd/urlcode'], 'file:../..');
  assert.deepEqual(manifest.peerDependencies, { '@jimhoyd/urlcode': coreVersion }, 'an exact core peer and no sibling peers');
  assert.match(manifest.scripts.build!, /rmSync\('dist'.*&& tsc -p tsconfig\.build\.json$/);
  assert.equal(manifest.scripts.verify, 'npm run typecheck && npm run build && npm test');

  assert.deepEqual(JSON.parse(await readFile(join(dir, 'urlcode.json'), 'utf8')), { kind: 'extension', name, description: 'A generated test extension.', requires: [] });
  for (const relative of ['README.md', 'SECURITY.md', 'CHANGELOG.md', 'AGENTS.md', 'llms.txt', 'NOTICE', 'LICENSE', 'tsconfig.json', 'tsconfig.build.json']) {
    assert.ok((await stat(join(dir, relative))).isFile(), `${relative} was not created`);
  }
  for (const optional of ['ACCEPTANCE.md', 'CONTRACT.md', 'IMPLEMENTATION-STATUS.md', 'THREAT-MODEL.md', '.gitignore']) {
    await assert.rejects(stat(join(dir, optional)), `${optional} should not exist on a blank scaffold`);
  }

  const sources = { index: 'src/index.ts', runtime: `src/${name}.ts`, definition: 'src/extension.ts', test: `test/${name}.test.ts` };
  const text: Record<string, string> = {};
  for (const [key, path] of Object.entries(sources)) { text[key] = await readFile(join(dir, path), 'utf8'); assertParses(text[key]!, path); }
  const Name = name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
  assert.match(text.runtime!, new RegExp(`export function create${Name}Extension`));
  assert.match(text.definition!, /export default defineExtension/);
  assert.match(text.definition!, /scaffold,/);
  assert.match(text.definition!, /host\(context\)/);
  assert.match(text.test!, /composeHost/);

  // No prose about the retired signed bundle release.
  for (const doc of ['README.md', 'CHANGELOG.md', 'AGENTS.md', 'llms.txt']) {
    const content = await readFile(join(dir, doc), 'utf8');
    assert.doesNotMatch(content, /extension-bundles|signed bundle|init --with/i, `${doc} still describes bundles`);
    if (doc !== 'AGENTS.md') assert.match(content, new RegExp(`urlcode extensions add ${name}`), `${doc} names the install command`);
  }

  // The generated package is real: it typechecks against core and its own test passes (scaffold -> composeHost -> HTTP).
  const tsc = spawnSync(process.execPath, [join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', dir], { cwd: dir, encoding: 'utf8', timeout: 120000 });
  assert.equal(tsc.status, 0, tsc.stdout + tsc.stderr);
  // A clean environment: an inherited NODE_TEST_CONTEXT would make the inner runner report to this one (and a
  // --test-name-pattern would skip every generated test), so the exit status alone would prove nothing.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST')));
  const own = spawnSync(process.execPath, ['--conditions=development', '--test', '--test-reporter=spec', join('test', `${name}.test.ts`)], { cwd: dir, encoding: 'utf8', timeout: 120000, env });
  assert.equal(own.status, 0, own.stdout + own.stderr);
  assert.match(own.stdout, /ℹ pass 6\n/, own.stdout);
  assert.match(own.stdout, /ℹ fail 0\n/, own.stdout);
});

test('--from forks an existing package\'s file shape (exact sibling peers become requires, optional docs) without copying its source', async t => {
  const out = await outputDir(t);
  const name = `scaff-fork-${randomUUID().slice(0, 8)}`;
  const result = run([name, '--from', 'forms', '--packages-dir', out]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /forked from the file shape of packages\/forms/);

  const forms = JSON.parse(await readFile(join(packagesDir, 'forms', 'package.json'), 'utf8')) as Manifest;
  const siblings = Object.keys(forms.peerDependencies).filter(peer => peer.startsWith('@jimhoyd/urlcode-')).map(peer => peer.slice('@jimhoyd/urlcode-'.length));
  assert.ok(siblings.length > 0, 'forms peers on at least one sibling extension');

  const dir = join(out, name);
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Manifest;
  for (const sibling of siblings) {
    const version = (JSON.parse(await readFile(join(packagesDir, sibling, 'package.json'), 'utf8')) as Manifest).version;
    assert.equal(manifest.devDependencies[`@jimhoyd/urlcode-${sibling}`], `file:../${sibling}`);
    assert.equal(manifest.peerDependencies[`@jimhoyd/urlcode-${sibling}`], version, 'sibling peers are exact');
  }
  assert.deepEqual((JSON.parse(await readFile(join(dir, 'urlcode.json'), 'utf8')) as { requires: string[] }).requires, siblings);
  assert.ok((await readFile(join(dir, 'src', 'extension.ts'), 'utf8')).includes(`requires: ${JSON.stringify(siblings)},`), 'the definition requires the sibling extensions');

  const extensionSource = await readFile(join(dir, 'src', `${name}.ts`), 'utf8');
  assert.ok(!extensionSource.includes('csrfSecret'), 'forked source should not carry forms\' CSRF-specific logic');
  assert.ok(!extensionSource.includes('CSRF_PURPOSE'));
  for (const optional of ['ACCEPTANCE.md', 'CONTRACT.md', 'IMPLEMENTATION-STATUS.md', 'THREAT-MODEL.md']) {
    await assert.rejects(stat(join(dir, optional)));
  }
});

test('--from a package that does carry an optional doc (auth has ACCEPTANCE.md) reproduces it as a placeholder', async t => {
  const out = await outputDir(t);
  const name = `scaff-fork-auth-${randomUUID().slice(0, 8)}`;
  const result = run([name, '--from', 'auth', '--packages-dir', out]);
  assert.equal(result.status, 0, result.stderr);

  const placeholder = await readFile(join(out, name, 'ACCEPTANCE.md'), 'utf8');
  assert.match(placeholder, /packages\/auth/);
  assert.match(placeholder, /TODO/);
  const authAcceptance = await readFile(join(packagesDir, 'auth', 'ACCEPTANCE.md'), 'utf8');
  assert.notEqual(placeholder, authAcceptance, 'the placeholder must not be a copy of the source package\'s actual acceptance criteria');
});

test('rejects an invalid name, a reserved name, an existing package, an unknown --from source, a bad --packages-dir and a multi-line description', async t => {
  const invalid = run(['Not_Valid']);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Invalid package name/);

  const reserved = run(['core']);
  assert.notEqual(reserved.status, 0);
  assert.match(reserved.stderr, /reserved name/);

  const existing = run(['forms']);
  assert.notEqual(existing.status, 0);
  assert.match(existing.stderr, /already exists/);

  const out = await outputDir(t);
  const name = `scaff-badfrom-${randomUUID().slice(0, 8)}`;
  const badFrom = run([name, '--from', 'does-not-exist', '--packages-dir', out]);
  assert.notEqual(badFrom.status, 0);
  assert.match(badFrom.stderr, /does not exist/);
  await assert.rejects(stat(join(out, name)), 'a failed --from lookup must not leave a partial package directory behind');

  const nested = run([name, '--packages-dir', join(out, 'deeper')]);
  assert.notEqual(nested.status, 0);
  assert.match(nested.stderr, /directly under the repository root/);

  const multiline = run([name, '--description', 'one\ntwo', '--packages-dir', out]);
  assert.notEqual(multiline.status, 0);
  assert.match(multiline.stderr, /one line/);
  await assert.rejects(stat(join(out, name)));
});

test('--help prints usage and does not create a package', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: node scripts\/create-extension\.ts/);
});
