// #857 item 4: third-party inert YAML (artifact documents) may use anchors, aliases and merge keys under a bounded
// profile that install-time inertness and inspection share; project YAML keeps refusing them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { inertYamlLimits, parseInertYaml } from '../packages/core/src/inert-yaml.ts';
import { parseYaml } from '../packages/core/src/config.ts';
import { assertInertArtifact } from '../packages/core/src/addon-install.ts';
import { inspectArtifactDocuments } from '../packages/core/src/artifact-inspect.ts';

const petstore = fileURLToPath(new URL('./fixtures/addons/petstore-docs/', import.meta.url));

/** The shape real OpenAPI documents take when they share fragments: anchors, aliases, `<<` merges and numeric status keys. */
const openapi = `openapi: 3.1.0
info: {title: Shared fragments, version: "1.0"}
x-common:
  error: &error
    description: Error
    content:
      application/json:
        schema: {$ref: '#/components/schemas/Error'}
  paged: &paged
    - {name: limit, in: query, schema: {type: integer}}
    - {name: cursor, in: query, schema: {type: string}}
paths:
  /pets:
    get:
      parameters: *paged
      responses:
        200:
          description: Pets
          content:
            application/json:
              schema: {$ref: '../schemas/pet.json'}
        default: *error
  /orders:
    get:
      parameters: *paged
      responses:
        200: &ok
          <<: *error
          description: Orders
        404: *error
components:
  schemas:
    Error: {type: object, properties: {message: {type: string}}}
`;

async function artifact(t: TestContext, yaml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'urlcode-inert-yaml-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(petstore, dir, { recursive: true });
  await writeFile(join(dir, 'openapi', 'petstore.yaml'), yaml);
  return dir;
}
const laughs = (levels: number, width: number): string => {
  const lines = [`l0: &l0 [${Array(width).fill('"lol"').join(', ')}]`];
  for (let level = 1; level < levels; level++) lines.push(`l${level}: &l${level} [${Array(width).fill(`*l${level - 1}`).join(', ')}]`);
  return lines.join('\n') + '\n';
};

test('a real-world-style OpenAPI document with anchors, aliases and merge keys is accepted and expanded', () => {
  const data = parseInertYaml(openapi) as { paths: Record<string, { get: { parameters: unknown[]; responses: Record<string, { description: string; content?: unknown }> } }> };
  assert.deepEqual(data.paths['/pets']!.get.parameters, data.paths['/orders']!.get.parameters);
  assert.equal(data.paths['/pets']!.get.responses.default!.description, 'Error');
  assert.equal(data.paths['/orders']!.get.responses['200']!.description, 'Orders', 'a merge key keeps the local override');
  assert.deepEqual(data.paths['/orders']!.get.responses['200']!.content, data.paths['/orders']!.get.responses['404']!.content);
  assert.deepEqual(Object.keys(data.paths['/pets']!.get.responses), ['200', 'default'], 'a numeric status key is a string, as JSON has it');
});

test('install-time inertness and inspection accept the same aliased document, and inspection resolves refs through the aliases', async t => {
  const dir = await artifact(t, openapi);
  await assertInertArtifact(dir, 'petstore-docs');
  const { documents } = await inspectArtifactDocuments(dir, [{ path: 'openapi/petstore.yaml', mediaType: 'application/vnd.oai.openapi' }]);
  assert.deepEqual(documents[0]!.diagnostics, []);
  // Every place an alias expands to is walked after expansion, so the shared Error reference is reported at each.
  assert.deepEqual(documents[0]!.refs.map(ref => ref.at).filter(at => at.endsWith('/schema')).sort(), [
    '/paths/~1orders/get/responses/200/content/application~1json/schema',
    '/paths/~1orders/get/responses/404/content/application~1json/schema',
    '/paths/~1pets/get/responses/200/content/application~1json/schema',
    '/paths/~1pets/get/responses/default/content/application~1json/schema',
    '/x-common/error/content/application~1json/schema',
  ]);
});

test('billion laughs, tags, recursive aliases and too many aliases are refused, at install and at inspection alike', async t => {
  assert.throws(() => parseInertYaml(laughs(10, 9)), /YAML document would expand to more than \d+ bytes \(10 times its size, at most 16777216\)/);
  assert.throws(() => parseInertYaml('a: !!binary aGk=\n'), /YAML explicit tags are not allowed/);
  assert.throws(() => parseInertYaml('a: !custom {b: 1}\n'), /Unresolved tag|explicit tags are not allowed/);
  assert.throws(() => parseInertYaml('%TAG !e! tag:example.com,2000:\n---\na: 1\n'), /directives are not allowed/);
  assert.throws(() => parseInertYaml('a: &a [1, *a]\n'), /recursive alias/);
  assert.throws(() => parseInertYaml('a: &a {b: *a}\n'), /recursive alias/);
  assert.throws(() => parseInertYaml(`a: &a 1\nb: [${Array(inertYamlLimits.maxAliasCount + 1).fill('*a').join(', ')}]\n`), /more than 1024 aliases/);
  // Nesting counts after expansion: 200 levels aliased twice deep is 400.
  const deep = `a: &a ${'['.repeat(200)}${']'.repeat(200)}\nb: ${'['.repeat(100)}*a${']'.repeat(100)}\n`;
  assert.throws(() => parseInertYaml(deep), /nests deeper than 256 levels once its aliases are expanded/);
  assert.throws(() => parseInertYaml('a: 1\na: 2\n'), /Duplicate YAML mapping key/);
  assert.throws(() => parseInertYaml('__proto__: {a: 1}\n'), /Reserved YAML mapping key/);
  // A small legitimate reuse stays well inside the relative cap.
  assert.deepEqual(parseInertYaml('a: &a {x: 1}\nb: *a\nc: *a\n'), { a: { x: 1 }, b: { x: 1 }, c: { x: 1 } });
  // Messages never echo document content.
  assert.throws(() => parseInertYaml('secret: !!binary aHVudGVyMg==\n'), error => !String((error as Error).message).includes('aHVudGVyMg'));

  const bomb = await artifact(t, `openapi: 3.1.0\n${laughs(10, 9)}`);
  await assert.rejects(assertInertArtifact(bomb, 'petstore-docs'), /Artifact petstore-docs has invalid YAML in openapi\/petstore\.yaml: YAML document would expand/);
  const inspected = await inspectArtifactDocuments(bomb, [{ path: 'openapi/petstore.yaml', mediaType: 'application/vnd.oai.openapi' }]);
  assert.deepEqual(inspected.documents[0]!.diagnostics.map(item => [item.code, /would expand/.test(item.message)]), [['invalid-document', true]]);
  const tagged = await artifact(t, 'openapi: !!str 3.1.0\n');
  await assert.rejects(assertInertArtifact(tagged, 'petstore-docs'), /explicit tags are not allowed/);
});

test('project YAML still refuses anchors, aliases and tags', () => {
  assert.throws(() => parseYaml('version: "1"\nshared: &s {a: 1}\nroutes: {}\n'), /YAML aliases, anchors and explicit tags are unsupported/);
  assert.throws(() => parseYaml('a: *s\n'), /Invalid YAML|unsupported/);
  assert.throws(() => parseYaml('version: !!str 1\n'), /YAML aliases, anchors and explicit tags are unsupported/);
});
