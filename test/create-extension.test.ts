// Exercises scripts/create-extension.ts (#614, #615): asserts specific
// generated files and their content, not just that the script exits 0.
// Runs against the real packages/ directory (like test/workspace-scaffold
// .integration.ts already does for other generators here) under
// collision-proof, randomly-suffixed names, always removed afterward.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const scriptPath = join(repoRoot, 'scripts', 'create-extension.ts');
const packagesDir = join(repoRoot, 'packages');

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [scriptPath, ...args], { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Asserts a TypeScript source file parses without syntax errors (not a full type-check, which
 * would need the generated package actually linked into node_modules; this catches a broken
 * template interpolation, an unbalanced brace, or invalid syntax in the generated source). */
function assertParses(source: string, path: string): void {
  const result = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const errors = (result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [], `${path} has syntax errors`);
}

async function cleanup(name: string): Promise<void> {
  await rm(join(packagesDir, name), { recursive: true, force: true });
}

test('a blank scaffold creates the minimal package shape with internally-consistent, parseable content', async t => {
  const name = `scaff-blank-${randomUUID().slice(0, 8)}`;
  t.after(() => cleanup(name));
  const result = run([name, '--description', 'A generated test extension.']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Created packages/${name} \\(\\d+ files\\)\\.`));

  const dir = join(packagesDir, name);
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
    name: string; private: boolean; description: string;
    devDependencies: Record<string, string>; peerDependencies: Record<string, string>;
    scripts: Record<string, string>; files: string[];
  };
  assert.equal(manifest.name, `@jimhoyd/urlcode-${name}`);
  assert.equal(manifest.private, true);
  assert.equal(manifest.description, 'A generated test extension.');
  assert.equal(manifest.devDependencies['@jimhoyd/urlcode'], 'file:../..');
  assert.match(manifest.peerDependencies['@jimhoyd/urlcode']!, /^>=\d+\.\d+\.0 <\d+\.\d+\.0$/);
  assert.equal(manifest.scripts.verify, 'npm run typecheck && npm run build && npm test');
  assert.deepEqual(manifest.files, ['dist', 'README.md', 'LICENSE', 'NOTICE', 'SECURITY.md']);
  // No workspace sibling peer was requested, so none should appear.
  assert.equal(Object.keys(manifest.peerDependencies).length, 1);

  // Every file the console summary counted should exist, plus the fixed core set.
  for (const relative of ['README.md', 'SECURITY.md', 'CHANGELOG.md', 'AGENTS.md', 'llms.txt', 'NOTICE', 'LICENSE', 'tsconfig.json', 'tsconfig.build.json']) {
    assert.ok((await stat(join(dir, relative))).isFile(), `${relative} was not created`);
  }
  // A blank scaffold must not pick up docs that only some existing packages carry.
  for (const optional of ['ACCEPTANCE.md', 'CONTRACT.md', 'IMPLEMENTATION-STATUS.md', 'THREAT-MODEL.md', '.gitignore']) {
    await assert.rejects(stat(join(dir, optional)), `${optional} should not exist on a blank scaffold`);
  }

  const indexSource = await readFile(join(dir, 'src', 'index.ts'), 'utf8');
  const extensionSource = await readFile(join(dir, 'src', `${name}.ts`), 'utf8');
  const testSource = await readFile(join(dir, 'test', `${name}.test.ts`), 'utf8');
  assertParses(indexSource, 'src/index.ts');
  assertParses(extensionSource, `src/${name}.ts`);
  assertParses(testSource, `test/${name}.test.ts`);

  const Name = name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
  // index.ts re-exports exactly the symbols the source module defines under the derived PascalCase name.
  assert.match(indexSource, new RegExp(`create${Name}Extension`));
  assert.match(extensionSource, new RegExp(`export function create${Name}Extension`));
  assert.match(extensionSource, /requires an explicit operator revision pin/);
  // The generated test declares the mount as a wildcard route (required by the runtime for an
  // extension handler) while the extension's own `mount` config field stays the literal path.
  assert.match(testSource, new RegExp(`'/${name}/\\*': \\{ extension: '${name}'`));
  assert.match(extensionSource, /request\.path !== request\.mount/);

  const readme = await readFile(join(dir, 'README.md'), 'utf8');
  assert.match(readme, new RegExp(`# @jimhoyd/urlcode-${name}`));
  assert.match(readme, /TODO/);
});

test('--from forks an existing package\'s file shape (workspace peers, optional docs) without copying its source', async t => {
  const name = `scaff-fork-${randomUUID().slice(0, 8)}`;
  t.after(() => cleanup(name));
  const result = run([name, '--from', 'forms']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /forked from the file shape of packages\/forms/);

  const dir = join(packagesDir, name);
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
    devDependencies: Record<string, string>; peerDependencies: Record<string, string>;
  };
  // forms peers on ui; the fork must reproduce that workspace-sibling wiring for the new package.
  assert.equal(manifest.devDependencies['@jimhoyd/urlcode-ui'], 'file:../ui');
  assert.match(manifest.peerDependencies['@jimhoyd/urlcode-ui']!, /^>=\d+\.\d+\.0 <\d+\.\d+\.0$/);

  const extensionSource = await readFile(join(dir, 'src', `${name}.ts`), 'utf8');
  const formsSource = await readFile(join(packagesDir, 'forms', 'src', 'forms.ts'), 'utf8');
  // The fork must not be a copy of the source package's own business logic (CSRF token handling,
  // form field validation) -- only its file/package shape.
  assert.ok(!extensionSource.includes('csrfSecret'), 'forked source should not carry forms\' CSRF-specific logic');
  assert.ok(!extensionSource.includes('CSRF_PURPOSE'));
  assert.notEqual(extensionSource, formsSource);

  // forms carries none of the optional first-party docs (ACCEPTANCE/CONTRACT/...), so the fork
  // should not fabricate them either -- it reproduces presence, not invents it.
  for (const optional of ['ACCEPTANCE.md', 'CONTRACT.md', 'IMPLEMENTATION-STATUS.md', 'THREAT-MODEL.md']) {
    await assert.rejects(stat(join(dir, optional)));
  }
});

test('--from a package that does carry an optional doc (auth has ACCEPTANCE.md) reproduces it as a placeholder', async t => {
  const name = `scaff-fork-auth-${randomUUID().slice(0, 8)}`;
  t.after(() => cleanup(name));
  const result = run([name, '--from', 'auth']);
  assert.equal(result.status, 0, result.stderr);

  const dir = join(packagesDir, name);
  const placeholder = await readFile(join(dir, 'ACCEPTANCE.md'), 'utf8');
  assert.match(placeholder, /packages\/auth/);
  assert.match(placeholder, /TODO/);
  const authAcceptance = await readFile(join(packagesDir, 'auth', 'ACCEPTANCE.md'), 'utf8');
  assert.notEqual(placeholder, authAcceptance, 'the placeholder must not be a copy of the source package\'s actual acceptance criteria');
});

test('rejects an invalid package name, a reserved name, an existing package name, and an unknown --from source', async t => {
  const invalid = run(['Not_Valid']);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Invalid package name/);

  const reserved = run(['core']);
  assert.notEqual(reserved.status, 0);
  assert.match(reserved.stderr, /reserved name/);

  const existing = run(['forms']);
  assert.notEqual(existing.status, 0);
  assert.match(existing.stderr, /already exists/);

  const name = `scaff-badfrom-${randomUUID().slice(0, 8)}`;
  t.after(() => cleanup(name));
  const badFrom = run([name, '--from', 'does-not-exist']);
  assert.notEqual(badFrom.status, 0);
  assert.match(badFrom.stderr, /does not exist/);
  await assert.rejects(stat(join(packagesDir, name)), 'a failed --from lookup must not leave a partial package directory behind');
});

test('--help prints usage and does not create a package', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: node scripts\/create-extension\.ts/);
});
