// #844 operation 1: an artifact's standard documents (OpenAPI, JSON Schema, Markdown, JSON, YAML) are inspected
// offline as untrusted data. These tests hold the reference resolution, the refusals (path escape, symlinks, remote
// references, limits), the pin gate for an independent package and the CLI/MCP agreement on one core function.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { initSite } from '../packages/core/src/authoring.ts';
import { addAddons, assertInertArtifact, describeInstalledArtifacts, listAddons, readArtifactMember, removeAddon } from '../packages/core/src/addon-install.ts';
import { parseAddonManifest, parseDescriptor } from '../packages/core/src/addon-manifest.ts';
import type { AddonManifest, ArtifactDocument } from '../packages/core/src/addon-manifest.ts';
import { artifactInspectionLimits, inspectArtifactDocuments, inspectInstalledArtifact } from '../packages/core/src/artifact-inspect.ts';
import type { InspectedFile } from '../packages/core/src/artifact-inspect.ts';
import { runAddonCommand } from '../packages/core/src/extensions-cli.ts';
import { recordPackage, writeFilesLock } from '../packages/core/src/package-files.ts';

const fixtures = fileURLToPath(new URL('./fixtures/addons/', import.meta.url));
const petstore = join(fixtures, 'petstore-docs');
process.env.URLCODE_NPM = join(fixtures, 'fake-npm.mjs');
const manifest: AddonManifest = parseAddonManifest({ format: 1, version: '9.9.9', addons: {
  notes: { kind: 'artifact', package: '@jimhoyd/urlcode-notes', description: 'notes', requires: [], url: `file:${join(fixtures, 'notes')}`, integrity: null },
} }, 'test manifest');
const sha256 = async (path: string): Promise<string> => createHash('sha256').update(await readFile(path)).digest('hex');
const codes = (file: InspectedFile | undefined): string[] => (file?.diagnostics ?? []).map(item => item.code);

async function temp(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
/** A package directory holding `files` (path -> JSON value or text) and nothing else. */
async function pkg(t: TestContext, files: Record<string, unknown>): Promise<string> {
  const dir = await temp(t, 'urlcode-inspect-');
  for (const [path, value] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return dir;
}
const schemaDoc = (path: string): ArtifactDocument => ({ path, mediaType: 'application/schema+json' });

test('the OpenAPI document resolves its same-document and relative-file refs; every document records media type, kind, version and digest', async () => {
  const descriptor = await assertInertArtifact(petstore, 'petstore-docs');
  const { documents, referencedFiles } = await inspectArtifactDocuments(petstore, descriptor.documents!);
  const [openapi, order, readme] = documents;
  assert.deepEqual([openapi!.path, openapi!.mediaType, openapi!.kind, openapi!.version], ['openapi/petstore.yaml', 'application/vnd.oai.openapi', 'openapi', '3.1.0']);
  assert.equal(openapi!.sha256, await sha256(join(petstore, 'openapi', 'petstore.yaml')));
  assert.equal(openapi!.bytes, (await readFile(join(petstore, 'openapi', 'petstore.yaml'))).length);
  assert.deepEqual(openapi!.refs.map(ref => [ref.ref, ref.target]), [
    ['#/components/schemas/Pets', 'openapi/petstore.yaml#/components/schemas/Pets'],
    ['../schemas/pet.json', 'schemas/pet.json#'],
    ['../schemas/pet.json', 'schemas/pet.json#'],
  ]);
  assert.equal(openapi!.refs[1]!.at, '/paths/~1pets~1{id}/get/responses/200/content/application~1json/schema', 'the JSON pointer of the object carrying $ref');
  assert.deepEqual(codes(openapi), []);
  assert.deepEqual([order!.kind, order!.version, order!.sha256], ['json-schema', 'https://json-schema.org/draft/2020-12/schema', await sha256(join(petstore, 'schemas', 'order.json'))]);
  assert.deepEqual([readme!.kind, readme!.refs, readme!.sha256], ['markdown', [], await sha256(join(petstore, 'README.md'))]);
  // The JSON Schema reached only through a reference is read, digested and resolved too.
  assert.deepEqual(referencedFiles.map(file => [file.path, file.mediaType, file.kind, file.sha256]), [['schemas/pet.json', null, 'json-schema', await sha256(join(petstore, 'schemas', 'pet.json'))]]);
  assert.deepEqual(referencedFiles[0]!.refs, [{ at: '/properties/tags/items', ref: '#/$defs/tag', target: 'schemas/pet.json#/$defs/tag' }]);
});

test('the descriptor lists documents only by a relative package path and a closed set of media types', () => {
  const descriptor = (documents: unknown): unknown => ({ kind: 'artifact', name: 'docs', description: 'd', requires: [], documents });
  assert.deepEqual(parseDescriptor(descriptor([{ path: 'api/openapi.json', mediaType: 'application/vnd.oai.openapi+json' }]), 'd').documents, [{ path: 'api/openapi.json', mediaType: 'application/vnd.oai.openapi+json' }]);
  for (const [documents, pattern] of [
    [[{ path: '../outside.json', mediaType: 'application/json' }], /relative package path/],
    [[{ path: '/etc/passwd.json', mediaType: 'application/json' }], /relative package path/],
    [[{ path: 'a/./b.json', mediaType: 'application/json' }], /relative package path/],
    [[{ path: '.hidden.json', mediaType: 'application/json' }], /relative package path/],
    [[{ path: 'api.yaml', mediaType: 'text/html' }], /mediaType text\/html; use one of/],
    [[{ path: 'api.json', mediaType: 'application/vnd.oai.openapi' }], /must end in \.yaml or \.yml/],
    [[{ path: 'a.json', mediaType: 'application/json' }, { path: 'a.json', mediaType: 'application/schema+json' }], /listed twice/],
    [[{ path: 'a.json', mediaType: 'application/json', title: 'x' }], /relative package path/],
    [Array.from({ length: 33 }, (_, index) => ({ path: `d${index}.json`, mediaType: 'application/json' })), /at most 32/],
  ] as const) assert.throws(() => parseDescriptor(descriptor(documents), 'd'), pattern);
  assert.throws(() => parseDescriptor({ kind: 'extension', name: 'x', description: 'd', requires: [], schema: {}, documents: [] }, 'x'), /lists no documents/);
});

test('reference cycles are reported once and not expanded, within a file and across files', async t => {
  const dir = await pkg(t, {
    'loop.json': { $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } } },
    'tree.json': { $defs: { node: { type: 'object', properties: { children: { type: 'array', items: { $ref: '#/$defs/node' } } } } } },
    'one.json': { $ref: 'two.json' },
    'two.json': { properties: { back: { $ref: 'one.json' } } },
  });
  const { documents, referencedFiles } = await inspectArtifactDocuments(dir, [schemaDoc('loop.json'), schemaDoc('tree.json'), schemaDoc('one.json')]);
  const [loop, tree, one] = documents;
  assert.deepEqual(codes(loop), ['ref-cycle']);
  assert.match(loop!.diagnostics[0]!.message, /loop\.json#\/\$defs\/a -> loop\.json#\/\$defs\/b -> loop\.json#\/\$defs\/a|loop\.json#\/\$defs\/b -> loop\.json#\/\$defs\/a -> loop\.json#\/\$defs\/b/);
  assert.equal(loop!.diagnostics[0]!.severity, 'warning');
  assert.deepEqual(codes(tree), ['ref-cycle'], 'a recursive schema is legal and reported as a warning');
  assert.equal(loop!.refs.length, 2, 'both references still resolve');
  assert.deepEqual([...codes(one), ...codes(referencedFiles[0])], ['ref-cycle'], 'a cross-file cycle is reported once');
  assert.deepEqual(referencedFiles.map(file => file.path), ['two.json']);
});

test('a remote reference is listed with a warning and never fetched; unresolvable ones are errors', async t => {
  const fetched: unknown[] = [], original = globalThis.fetch;
  globalThis.fetch = (async (...args: unknown[]) => { fetched.push(args); throw new Error('no network'); }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  const dir = await pkg(t, {
    'api.yaml': [
      'openapi: 3.0.3',
      'paths: {}',
      'components:',
      '  schemas:',
      '    Remote: {$ref: "https://schemas.example/pet.json#/Pet"}',
      '    Scheme: {$ref: "file:///etc/passwd"}',
      '    Network: {$ref: "//schemas.example/pet.json"}',
      '    Urn: {$ref: "urn:example:pet"}',
      '    Missing: {$ref: "#/components/schemas/Nope"}',
      '    MissingFile: {$ref: "absent.json"}',
      '    Anchor: {$ref: "#pet"}',
      '    Markdown: {$ref: "README.md"}',
      '    Escaped: {$ref: "#/components/schemas/a~1b"}',
      '    a/b: {type: string}',
      '    Broken: {$ref: "%E0%A4%A.json"}',
      '',
    ].join('\n'),
    'README.md': '# docs\n',
  });
  const [api] = (await inspectArtifactDocuments(dir, [{ path: 'api.yaml', mediaType: 'application/vnd.oai.openapi' }])).documents;
  assert.deepEqual(api!.diagnostics.map(item => [item.code, item.severity, item.ref]), [
    ['remote-ref', 'warning', 'https://schemas.example/pet.json#/Pet'],
    ['remote-ref', 'warning', 'file:///etc/passwd'],
    ['remote-ref', 'warning', '//schemas.example/pet.json'],
    ['remote-ref', 'warning', 'urn:example:pet'],
    ['unresolved-ref', 'error', '#/components/schemas/Nope'],
    ['unresolved-ref', 'error', 'absent.json'],
    ['unsupported-ref', 'warning', '#pet'],
    ['unresolved-ref', 'error', 'README.md'],
    ['unresolved-ref', 'error', '%E0%A4%A.json'],
  ]);
  assert.equal(api!.diagnostics[0]!.at, '/components/schemas/Remote');
  assert.match(api!.diagnostics[0]!.message, /listed, never fetched/);
  assert.deepEqual(api!.refs.map(ref => ref.target), ['api.yaml#/components/schemas/a~1b']);
  assert.deepEqual(fetched, [], 'nothing was fetched');
});

test('references and listed documents never leave the package: `..`, absolute paths and symlinks are refused', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, async t => {
  const outside = await pkg(t, { 'secret.json': { secret: true } });
  const dir = await pkg(t, {
    'schemas/api.json': { properties: {
      up: { $ref: '../../secret.json' },
      far: { $ref: `../${'../'.repeat(12)}etc/passwd.json` },
      absolute: { $ref: '/etc/passwd.json' },
      backslash: { $ref: '..\\secret.json' },
      linked: { $ref: 'link.json' },
      through: { $ref: 'linkdir/secret.json' },
    } },
  });
  await symlink(join(outside, 'secret.json'), join(dir, 'schemas', 'link.json'));
  await symlink(outside, join(dir, 'schemas', 'linkdir'));
  await symlink(join(outside, 'secret.json'), join(dir, 'listed.json'));
  const { documents, referencedFiles } = await inspectArtifactDocuments(dir, [schemaDoc('schemas/api.json'), schemaDoc('listed.json')]);
  assert.deepEqual(documents[0]!.diagnostics.map(item => [item.code, item.ref]), [
    ['path-escape', '../../secret.json'], ['path-escape', `../${'../'.repeat(12)}etc/passwd.json`], ['path-escape', '/etc/passwd.json'], ['path-escape', '..\\secret.json'],
    ['symlink', 'link.json'], ['symlink', 'linkdir/secret.json'],
  ]);
  assert.deepEqual([codes(documents[1]), documents[1]!.sha256], [['symlink'], null], 'a listed symlink is not read');
  assert.deepEqual(referencedFiles, []);
  // And a package holding a symlink is not an inert artifact at all, so it is never installed or inspected.
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@example/x', version: '1.0.0' }));
  await writeFile(join(dir, 'urlcode.json'), JSON.stringify({ kind: 'artifact', name: 'x', description: 'x', requires: [] }));
  await assert.rejects(assertInertArtifact(dir, 'x'), /contains listed\.json, which is not declarative data/);
});

test('inspection limits: document size, files read, reference count, chain depth and nesting', async t => {
  const limits = artifactInspectionLimits;
  assert.deepEqual(limits, { maxDocumentBytes: 1048576, maxFiles: 64, maxTotalBytes: 8388608, maxRefs: 1024, maxRefDepth: 32, maxNesting: 256 });
  const chain = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`a${index}`, index === 39 ? { type: 'string' } : { $ref: `#/$defs/a${index + 1}` }]));
  const nested = JSON.parse(`${'{"x":'.repeat(300)}{"$ref":"#"}${'}'.repeat(300)}`) as unknown;
  const dir = await pkg(t, {
    'big.json': JSON.stringify({ pad: 'x'.repeat(limits.maxDocumentBytes) }),
    'many-refs.json': { $defs: Object.fromEntries(Array.from({ length: limits.maxRefs + 5 }, (_, index) => [`r${index}`, { $ref: '#' }])) },
    'chain.json': { $defs: chain },
    'nested.json': nested,
    'fanout.json': { $defs: Object.fromEntries(Array.from({ length: limits.maxFiles + 2 }, (_, index) => [`f${index}`, { $ref: `parts/p${index}.json` }])) },
    ...Object.fromEntries(Array.from({ length: limits.maxFiles + 2 }, (_, index) => [`parts/p${index}.json`, { type: 'string' }])),
  });
  const read = async (path: string): Promise<InspectedFile> => (await inspectArtifactDocuments(dir, [schemaDoc(path)])).documents[0]!;
  const big = await read('big.json');
  assert.deepEqual([codes(big), big.sha256, big.bytes], [['limit'], null, limits.maxDocumentBytes + 10]);
  const many = await read('many-refs.json');
  assert.deepEqual([codes(many).filter(code => code === 'limit').length, many.refs.length], [1, limits.maxRefs]);
  const deep = await read('chain.json');
  assert.deepEqual([codes(deep), deep.refs.length], [['limit'], 39]);
  assert.match(deep.diagnostics[0]!.message, /longer than 32/);
  assert.deepEqual(codes(await read('nested.json')), ['limit'], 'a reference deeper than the nesting limit is not examined');
  const fanout = await inspectArtifactDocuments(dir, [schemaDoc('fanout.json')]);
  assert.equal(fanout.referencedFiles.length, limits.maxFiles - 1, 'the listed document counts toward the file limit');
  assert.deepEqual([...new Set(codes(fanout.documents[0]))], ['limit']);
});

test('a malformed or mislabelled document is a diagnostic that never echoes its content', async t => {
  const dir = await pkg(t, {
    'broken.json': '{"secret": "hunter2" oops}',
    'not-openapi.yaml': 'title: nope\n',
    'aliased.yaml': 'a: !!binary aHVudGVyMg==\n',
  });
  await writeFile(join(dir, 'binary.md'), Buffer.from([0xff, 0xfe, 0x00]));
  const { documents } = await inspectArtifactDocuments(dir, [schemaDoc('broken.json'), { path: 'not-openapi.yaml', mediaType: 'application/vnd.oai.openapi' }, { path: 'aliased.yaml', mediaType: 'application/yaml' }, { path: 'binary.md', mediaType: 'text/markdown' }]);
  assert.deepEqual(documents.map(codes), [['invalid-document'], ['invalid-document'], ['invalid-document'], ['invalid-document']]);
  assert.doesNotMatch(JSON.stringify(documents), /hunter2/);
  assert.ok(documents.every(item => typeof item.sha256 === 'string'), 'the digest is recorded even when parsing fails');
  // A referenced file that does not parse is an unresolved reference, and is listed with its own diagnostic.
  await writeFile(join(dir, 'unlisted.json'), '{"secret": "hunter2" oops}');
  await writeFile(join(dir, 'refers.json'), JSON.stringify({ $ref: 'unlisted.json' }));
  const referring = await inspectArtifactDocuments(dir, [schemaDoc('refers.json')]);
  assert.deepEqual([codes(referring.documents[0]), referring.referencedFiles.map(file => [file.path, codes(file)])], [['unresolved-ref'], [['unlisted.json', ['invalid-document']]]]);
});

/** A site whose package.json and lock point at `pkg` installed from a local tarball, as npm writes them (no npm runs). */
async function lockedSite(t: TestContext, edit?: (installed: string) => Promise<void>): Promise<{ site: string; tarball: string }> {
  const root = await temp(t, 'urlcode-locked-');
  const { site } = await initSite(join(root, 'site'));
  const tarball = join(site, 'petstore-docs-1.4.0.tgz');
  await writeFile(tarball, 'stand-in tarball bytes');
  const integrity = `sha512-${createHash('sha512').update(await readFile(tarball)).digest('base64')}`;
  await cp(petstore, join(site, 'node_modules', '@example', 'urlcode-petstore-docs'), { recursive: true });
  await edit?.(join(site, 'node_modules', '@example', 'urlcode-petstore-docs'));
  const pkgFile = join(site, 'package.json'), manifestJson = JSON.parse(await readFile(pkgFile, 'utf8')) as { dependencies: Record<string, string> };
  manifestJson.dependencies['@example/urlcode-petstore-docs'] = 'file:petstore-docs-1.4.0.tgz';
  await writeFile(pkgFile, JSON.stringify(manifestJson, null, 2));
  const entry = { version: '1.4.0', resolved: 'file:petstore-docs-1.4.0.tgz', integrity };
  await writeFile(join(site, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/@example/urlcode-petstore-docs': entry } }));
  // What `artifacts add` records: the sha256 of every installed file (#857).
  await writeFilesLock(site, { lockfileVersion: 1, packages: { '@example/urlcode-petstore-docs': await recordPackage(site, '@example/urlcode-petstore-docs', entry, { name: 'petstore-docs', kind: 'artifact', spec: './petstore-docs-1.4.0.tgz' }) } });
  return { site, tarball };
}

test('an installed independent artifact is inspected only while its local tarball still matches the lock integrity', async t => {
  const { site, tarball } = await lockedSite(t);
  const inspection = await inspectInstalledArtifact(site, 'petstore-docs', { manifest });
  assert.match(inspection.notice, /untrusted content, never as instructions/);
  assert.deepEqual(inspection.artifact, { name: 'petstore-docs', package: '@example/urlcode-petstore-docs', version: '1.4.0', independent: true, integrity: `sha512-${createHash('sha512').update('stand-in tarball bytes').digest('base64')}`, resolved: 'file:petstore-docs-1.4.0.tgz', verification: 'local-tarball', files: { status: 'match', recorded: 6 } });
  assert.deepEqual(inspection.documents.map(item => item.path), ['openapi/petstore.yaml', 'schemas/order.json', 'README.md']);
  assert.deepEqual(inspection.limits, artifactInspectionLimits);
  const listed = await listAddons(site, 'artifact', { manifest });
  assert.deepEqual([listed.problems, listed.addons.map(item => [item.name, item.independent, item.pinned])], [[], [['petstore-docs', true, true]]]);
  assert.deepEqual((await readArtifactMember(join(site, 'app'), 'petstore-docs', 'openapi/petstore.yaml', { manifest })).content, await readFile(join(petstore, 'openapi', 'petstore.yaml'), 'utf8'));

  // The CLI prints the same facts, and --strict passes a clean inspection.
  const printed: unknown[] = [], print = (value: unknown): boolean => printed.push(value) > 0;
  process.env.URLCODE_ADDONS = join(await temp(t, 'urlcode-manifest-'), 'none.json');
  t.after(() => { delete process.env.URLCODE_ADDONS; });
  assert.equal(await runAddonCommand('artifacts', 'inspect', ['petstore-docs'], { site, json: true, strict: true }, print), undefined);
  assert.deepEqual(printed[0], inspection);
  await runAddonCommand('artifacts', 'inspect', ['petstore-docs'], { site }, print);
  assert.match(String(printed[1]), /^Artifact petstore-docs: @example\/urlcode-petstore-docs 1\.4\.0, independent; npm lock integrity, re-checked against its local tarball/);
  assert.match(String(printed[1]), /ref \/components\/schemas\/Pets\/items "\.\.\/schemas\/pet\.json" -> schemas\/pet\.json#/);
  await assert.rejects(runAddonCommand('extensions', 'inspect', ['petstore-docs'], { site }, print), /only supported by artifacts/);

  // A replaced tarball: the lock is stale, so inspection refuses and list --strict fails.
  await writeFile(tarball, 'tampered tarball bytes');
  await assert.rejects(inspectInstalledArtifact(site, 'petstore-docs', { manifest }), /petstore-docs is unpinned: .*no longer matches the sha512 integrity package-lock\.json recorded/);
  assert.match((await listAddons(site, 'artifact', { manifest })).problems.join('\n'), /petstore-docs: .*no longer matches/);
  await rm(tarball);
  await assert.rejects(inspectInstalledArtifact(site, 'petstore-docs', { manifest }), /which is missing, so npm ci cannot reinstall it/);
});

test('inspect --strict exits 1 when a document has an error diagnostic', async t => {
  // The package as published carries the broken reference, so its files still match their record.
  const { site } = await lockedSite(t, installed => writeFile(join(installed, 'schemas', 'order.json'), JSON.stringify({ $ref: 'missing.json' })));
  const printed: unknown[] = [];
  process.env.URLCODE_ADDONS = join(await temp(t, 'urlcode-manifest-'), 'none.json');
  t.after(() => { delete process.env.URLCODE_ADDONS; });
  assert.equal(await runAddonCommand('artifacts', 'inspect', ['petstore-docs'], { site, strict: true }, value => printed.push(value) > 0), 1);
  assert.match(String(printed[0]), /error unresolved-ref at \/ "missing\.json": schemas\/missing\.json does not exist in the package/);
});

test('an independent artifact installs by spec, lists, refuses inspection while only linked, and removes; it never runs scripts', async t => {
  const root = await temp(t, 'urlcode-artifact-site-');
  const { site } = await initSite(join(root, 'site'));
  const log = join(root, 'npm.log'); process.env.FAKE_NPM_LOG = log;
  t.after(() => { delete process.env.FAKE_NPM_LOG; });
  const variant = async (change: (files: { pkg: Record<string, unknown>; descriptor: Record<string, unknown> }) => void): Promise<string> => {
    const dir = await temp(t, 'urlcode-variant-');
    await cp(petstore, dir, { recursive: true });
    const files = { pkg: JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>, descriptor: JSON.parse(await readFile(join(dir, 'urlcode.json'), 'utf8')) as Record<string, unknown> };
    change(files);
    await writeFile(join(dir, 'package.json'), JSON.stringify(files.pkg));
    await writeFile(join(dir, 'urlcode.json'), JSON.stringify(files.descriptor));
    return dir;
  };
  const before = await readFile(join(site, 'package.json'), 'utf8');
  await assert.rejects(addAddons(site, 'artifact', [await variant(({ pkg }) => { pkg.scripts = { preinstall: 'node -e "process.exit(1)"' }; })], { manifest }), /Refusing @example\/urlcode-petstore-docs: Artifact petstore-docs package\.json declares scripts/);
  await assert.rejects(addAddons(site, 'artifact', [join(fixtures, 'greeting')], { manifest }), /its descriptor declares an extension; add it with `urlcode extensions add`/);
  await assert.rejects(addAddons(site, 'extension', [petstore], { manifest }), /its descriptor declares an artifact; add it with `urlcode artifacts add`/);
  await assert.rejects(addAddons(site, 'artifact', [await variant(({ descriptor }) => { descriptor.name = 'notes'; })], { manifest }), /names itself notes, which is a first-party artifact/);
  await assert.rejects(addAddons(site, 'artifact', [await variant(({ descriptor }) => { descriptor.documents = [{ path: 'openapi/gone.yaml', mediaType: 'application/vnd.oai.openapi' }]; })], { manifest }), /lists document openapi\/gone\.yaml, which the package does not contain/);
  assert.equal(await readFile(join(site, 'package.json'), 'utf8'), before, 'every refusal rolls package.json back');

  const added = await addAddons(site, 'artifact', [petstore], { manifest });
  assert.deepEqual([added.added, added.projectSha256], [['petstore-docs'], undefined]);
  assert.doesNotMatch(await readFile(join(site, 'host.mjs'), 'utf8'), /petstore/);
  const listed = await listAddons(site, 'artifact', { manifest });
  assert.deepEqual([listed.problems, listed.addons.map(item => [item.name, item.package, item.independent, item.pinned, item.mode])], [[], [['petstore-docs', '@example/urlcode-petstore-docs', true, false, 'artifact']]]);
  const described = await describeInstalledArtifacts(join(site, 'app'), { manifest });
  assert.deepEqual(described.artifacts.map(item => [item.name, item.status, item.independent, item.documents.length]), [['petstore-docs', 'unpinned', true, 3]]);
  await assert.rejects(inspectInstalledArtifact(site, 'petstore-docs', { manifest }), /is a linked directory, not locked by npm integrity/);
  await assert.rejects(inspectInstalledArtifact(site, 'absent', { manifest }), /absent is not an installed artifact/);

  assert.equal((await removeAddon(site, 'artifact', 'petstore-docs', { manifest })).removed, 'petstore-docs');
  assert.equal(JSON.parse(await readFile(join(site, 'package.json'), 'utf8')).dependencies['@example/urlcode-petstore-docs'], undefined);
  assert.ok((await readFile(log, 'utf8')).split('\n').filter(Boolean).every(line => (JSON.parse(line) as string[]).includes('--ignore-scripts')), 'npm never runs lifecycle scripts');
});

test('store-schema lists its JSON Schema, example and README as standard documents', async () => {
  const directory = fileURLToPath(new URL('../artifacts/store-schema/', import.meta.url));
  const descriptor = await assertInertArtifact(directory, 'store-schema');
  const { documents } = await inspectArtifactDocuments(directory, descriptor.documents!);
  assert.deepEqual(documents.map(item => [item.path, item.kind, item.diagnostics.length]), [['schemas/config.json', 'json-schema', 0], ['config/example.json', 'json', 0], ['README.md', 'markdown', 0]]);
});

test('a duplicate provider is reported once, in the list of its own kind (#857)', async t => {
  const root = await temp(t, 'urlcode-duplicates-');
  const { site } = await initSite(join(root, 'site'));
  const provide = async (packageName: string, descriptor: Record<string, unknown>): Promise<void> => {
    const directory = join(site, 'node_modules', ...packageName.split('/'));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: packageName, version: '1.0.0' }));
    await writeFile(join(directory, 'urlcode.json'), JSON.stringify({ description: 'd', requires: [], ...descriptor }));
  };
  await provide('@example/docs-a', { kind: 'artifact', name: 'docs' });
  await provide('@example/docs-b', { kind: 'artifact', name: 'docs' });
  await provide('@example/widget-art', { kind: 'artifact', name: 'widget' });
  await provide('@example/widget-ext', { kind: 'extension', name: 'widget', targets: ['node'], schema: {} });
  await provide('@example/broken', { kind: 'artifact', name: 'Not A Name' });
  const pkgFile = join(site, 'package.json'), manifestJson = JSON.parse(await readFile(pkgFile, 'utf8')) as { dependencies: Record<string, string> };
  for (const name of ['@example/docs-a', '@example/docs-b', '@example/widget-art', '@example/widget-ext', '@example/broken']) manifestJson.dependencies[name] = '1.0.0';
  await writeFile(pkgFile, JSON.stringify(manifestJson, null, 2));
  const duplicates = async (kind: 'extension' | 'artifact'): Promise<string[]> => (await listAddons(site, kind, { manifest })).problems.filter(problem => /both provide|is not an add-on descriptor/.test(problem));
  assert.deepEqual(await duplicates('artifact'), [
    `${join(site, 'node_modules', '@example', 'broken', 'urlcode.json')} is not an add-on descriptor`,
    '@example/docs-b and @example/docs-a both provide the artifact docs; keep one',
  ], 'an unreadable descriptor is reported under the kind it claims');
  assert.deepEqual(await duplicates('extension'), ['@example/widget-ext and @example/widget-art both provide an artifact and an extension named widget; keep one'], 'the set-aside package\'s kind owns the report');
});

test('a relative $id sets a package-local base: relative refs resolve under it, embedded resources resolve in the file, and an escaping $id is refused', async t => {
  const dir = await pkg(t, {
    'api/root.json': {
      $schema: 'https://json-schema.org/draft/2020-12/schema', $id: '../shared/root.json',
      properties: {
        pet: { $ref: 'pet.json' },
        self: { $ref: 'root.json#/$defs/n' },
        inner: { $ref: 'item.json#/type' },
        fragment: { $ref: '#/$defs/n' },
      },
      $defs: {
        n: { type: 'number' },
        item: { $id: 'item.json', type: 'string', properties: { up: { $ref: '#/type' } } },
        out: { $id: '../../../outside/', properties: { escape: { $ref: 'secret.json' } } },
        anchor: { $id: '#legacy-anchor', properties: { kept: { $ref: 'pet.json' } } },
      },
    },
    'shared/pet.json': { type: 'object' },
    'api/pet.json': { description: 'the file-relative target, which the $id base replaces' },
  });
  const { documents, referencedFiles } = await inspectArtifactDocuments(dir, [schemaDoc('api/root.json')]);
  const [root] = documents;
  assert.deepEqual(root!.refs.map(ref => [ref.at, ref.ref, ref.target]), [
    ['/properties/pet', 'pet.json', 'shared/pet.json#'],
    ['/properties/self', 'root.json#/$defs/n', 'api/root.json#/$defs/n'],
    ['/properties/inner', 'item.json#/type', 'api/root.json#/$defs/item/type'],
    ['/properties/fragment', '#/$defs/n', 'api/root.json#/$defs/n'],
    ['/$defs/item/properties/up', '#/type', 'api/root.json#/$defs/item/type'],
    ['/$defs/anchor/properties/kept', 'pet.json', 'shared/pet.json#'],
  ], 'a plain-name $id is an anchor and keeps the enclosing base');
  assert.deepEqual(root!.diagnostics.map(item => [item.code, item.severity, item.at, item.ref]), [['path-escape', 'error', '/$defs/out/properties/escape', 'secret.json']]);
  assert.match(root!.diagnostics[0]!.message, /enclosing \$id \.\.\/\.\.\/\.\.\/outside\/ leaves the package directory/);
  assert.deepEqual(referencedFiles.map(file => file.path), ['shared/pet.json'], 'api/pet.json is not read');
});

test('an absolute remote $id makes relative refs under it remote (reported, never fetched) while its own resources still resolve in the file', async t => {
  const fetched: unknown[] = [], original = globalThis.fetch;
  globalThis.fetch = (async (...args: unknown[]) => { fetched.push(args); throw new Error('no network'); }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  const dir = await pkg(t, {
    'remote.json': {
      $id: 'https://schemas.example/pets/root.json',
      properties: {
        relative: { $ref: 'pet.json' },
        climbing: { $ref: '../../../../pet.json' },
        fragment: { $ref: '#/$defs/local' },
        absolute: { $ref: 'https://schemas.example/pets/root.json#/$defs/local' },
        embedded: { $ref: 'tag.json' },
      },
      $defs: { local: { type: 'string' }, tag: { $id: 'tag.json', type: 'string' } },
    },
    'pet.json': { type: 'object' },
    'legacy.yaml': 'openapi: 3.0.3\npaths: {}\ncomponents:\n  schemas:\n    Pet:\n      $id: "https://schemas.example/"\n      properties:\n        local: {$ref: "pet.json"}\n',
  });
  const { documents, referencedFiles } = await inspectArtifactDocuments(dir, [schemaDoc('remote.json'), { path: 'legacy.yaml', mediaType: 'application/vnd.oai.openapi' }]);
  const [remote, legacy] = documents;
  assert.deepEqual(remote!.diagnostics.map(item => [item.code, item.severity, item.ref]), [['remote-ref', 'warning', 'pet.json'], ['remote-ref', 'warning', '../../../../pet.json']]);
  assert.match(remote!.diagnostics[0]!.message, /remote \$id base to https:\/\/schemas\.example\/pets\/pet\.json: listed, never fetched/);
  assert.match(remote!.diagnostics[1]!.message, /https:\/\/schemas\.example\/pet\.json/);
  assert.deepEqual(remote!.refs.map(ref => ref.target), ['remote.json#/$defs/local', 'remote.json#/$defs/local', 'remote.json#/$defs/tag']);
  // OpenAPI 3.0 schemas have no $id: the reference resolves against the file, as the document's own dialect says.
  assert.deepEqual([legacy!.diagnostics, legacy!.refs.map(ref => ref.target)], [[], ['pet.json#']]);
  assert.deepEqual(referencedFiles.map(file => file.path), ['pet.json'], 'only the OpenAPI 3.0 reference reads pet.json');
  assert.deepEqual(fetched, []);
});

test('$ref keys inside example, examples, const, enum and default data are data, not references', async t => {
  const dir = await pkg(t, {
    'data.json': {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: {
        default: { $ref: '#/$defs/x' },
        value: {
          default: { $ref: 'missing.json' }, const: { $ref: '../escape.json' }, enum: [{ $ref: 'https://schemas.example/x' }],
          examples: [{ $ref: '#/nowhere' }], example: { $ref: 'missing.yaml' }, items: { default: { $id: '../../escape/' }, $ref: '#/$defs/x' },
        },
      },
      $defs: { x: { type: 'string' }, enum: { $ref: '#/$defs/x' } },
    },
    'api.yaml': [
      'openapi: 3.1.0',
      'paths:',
      '  /pets:',
      '    post:',
      '      requestBody:',
      '        content:',
      '          application/json:',
      '            schema: {$ref: "#/components/schemas/example"}',
      '            example: {$ref: "missing.json"}',
      '            examples:',
      '              inline: {value: {$ref: "../escape.json"}}',
      '              shared: {$ref: "#/components/examples/Shared"}',
      '      responses:',
      '        default: {$ref: "#/components/responses/Ok"}',
      'components:',
      '  schemas:',
      '    example: {type: object, default: {$ref: missing.json}, examples: [{$ref: missing.json}], enum: [{$ref: missing.json}]}',
      '  responses:',
      '    Ok: {description: ok}',
      '  examples:',
      '    Shared: {value: {$ref: "#/nowhere"}}',
      '',
    ].join('\n'),
    'swagger.yaml': [
      'swagger: "2.0"',
      'paths:',
      '  /pets:',
      '    get:',
      '      responses:',
      '        "200":',
      '          description: ok',
      '          schema: {$ref: "#/definitions/Pet"}',
      '          examples:',
      '            application/json: {$ref: missing.json}',
      'definitions:',
      '  Pet: {type: object, example: {$ref: missing.json}}',
      '',
    ].join('\n'),
  });
  const { documents, referencedFiles } = await inspectArtifactDocuments(dir, [schemaDoc('data.json'), { path: 'api.yaml', mediaType: 'application/vnd.oai.openapi' }, { path: 'swagger.yaml', mediaType: 'application/vnd.oai.openapi' }]);
  const [data, api, swagger] = documents;
  assert.deepEqual(data!.refs.map(ref => [ref.at, ref.target]), [['/properties/default', 'data.json#/$defs/x'], ['/properties/value/items', 'data.json#/$defs/x'], ['/$defs/enum', 'data.json#/$defs/x']], 'a property or definition named like a data keyword is still a schema, and a $id inside data sets no base');
  assert.deepEqual(api!.refs.map(ref => [ref.at, ref.target]), [
    ['/paths/~1pets/post/requestBody/content/application~1json/schema', 'api.yaml#/components/schemas/example'],
    ['/paths/~1pets/post/requestBody/content/application~1json/examples/shared', 'api.yaml#/components/examples/Shared'],
    ['/paths/~1pets/post/responses/default', 'api.yaml#/components/responses/Ok'],
  ], 'an Example Object reference and the default response are references; example values are not');
  assert.deepEqual(swagger!.refs.map(ref => ref.target), ['swagger.yaml#/definitions/Pet']);
  assert.deepEqual(documents.flatMap(codes), []);
  assert.deepEqual(referencedFiles, []);
});
