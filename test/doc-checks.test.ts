import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkLinks, pinnedRepositoryPath, shippedLinkProblem, type Failure } from '../scripts/check-local-links.ts';
import { asProject, checkBlock, yamlBlocks } from '../scripts/check-doc-yaml.ts';
import { proseFailures, withoutFences } from '../scripts/check-guidance-claims.ts';

const script = (name: string): string => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const run = (name: string) => spawnSync(process.execPath, [script(name)], { encoding: 'utf8', timeout: 60000 });

// A throwaway checkout: `files` maps repository paths to contents. Version 1.2.3; packages/store ships README.md.
async function fixture(files: Record<string, string>): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), 'local-links-'));
  const all = { 'package.json': '{"version":"1.2.3"}', 'packages/store/package.json': '{"files":["dist"]}', ...files };
  for (const [path, text] of Object.entries(all)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return (await checkLinks(root)).failures.map((failure: Failure) => `${failure.file}:${failure.line} ${failure.rule}`).sort();
}

test('fragments follow GitHub heading slugs: punctuation, code spans, links, non-ASCII (#781)', async () => {
  const headings = ['# `site.notFound` is inlined', '## 2b. Root-relative and suffix redirects', '## Add-ons: extensions and artifacts', '## What `snake_case` keeps', '## [Linked](B.md) & *emphasised* text', '## Café — über'];
  const slugs = ['sitenotfound-is-inlined', '2b-root-relative-and-suffix-redirects', 'add-ons-extensions-and-artifacts', 'what-snake_case-keeps', 'linked--emphasised-text', 'café--über', 'caf%C3%A9--%C3%BCber'];
  const links = slugs.map(slug => `[x](A.md#${slug})`).join('\n\n');
  assert.deepEqual(await fixture({ 'A.md': `${headings.join('\n\n')}\n`, 'B.md': `${links}\n\n[bad](A.md#site-notfound)\n` }), ['B.md:15 dead-fragment']);
});

test('repeated headings are suffixed, explicit anchors count, fenced code is no heading (#781)', async () => {
  const target = ['# Title', '## Options', '## Options', '### Options', '<a id="custom-anchor"></a>', '', "<a name='legacy'></a>", '', 'Setext heading', '--------------', '```sh', '# not a heading', '```', ''].join('\n');
  const good = ['title', 'options', 'options-1', 'options-2', 'custom-anchor', 'legacy', 'setext-heading'].map(anchor => `[x](A.md#${anchor})`).join('\n\n');
  assert.deepEqual(await fixture({ 'A.md': target, 'B.md': `${good}\n\n[x](A.md#not-a-heading)\n\n[x](#nowhere)\n` }), ['B.md:15 dead-fragment', 'B.md:17 dead-fragment']);
});

test('a relative link must exist; other sites, source-line and directory fragments are not checked (#200)', async () => {
  const text = ['[a](docs/GONE.md)', '', '![b](missing.png)', '', '[c](src/a.ts#L10)', '', '[d](docs/#anything)', '', '[e](https://example.com/GONE.md#x)', '', '[f]: docs/ALSO-GONE.md', ''].join('\n');
  assert.deepEqual(await fixture({ 'README.md': text, 'src/a.ts': '', 'docs/X.md': '# X\n' }), ['README.md:1 dead-relative-link', 'README.md:11 dead-relative-link', 'README.md:3 dead-relative-link']);
});

test('a link to this repository at the current version is checked against the checkout; other versions are not (#916, #938)', async () => {
  const repo = 'https://github.com/jimhoyd-com/urlcode/';
  const text = [`[a](${repo}blob/v1.2.3/docs/X.md#x)`, '', `[b](${repo}tree/v1.2.3/docs)`, '', `[c](${repo}blob/v1.2.3/docs/GONE.md)`, '', `[d](${repo}blob/v1.2.3/docs/X.md#nowhere)`, '', `[e](${repo}blob/v1.2.2/docs/GONE.md)`, ''].join('\n');
  assert.deepEqual(await fixture({ 'docs/README.md': text, 'docs/X.md': '# X\n' }), ['docs/README.md:5 dead-relative-link', 'docs/README.md:7 dead-fragment']);
});

test('retired repositories, local issue trackers and shipped links fail; historical markers exempt (#200, #916)', async () => {
  const repo = 'https://github.com/jimhoyd-com/urlcode/';
  assert.deepEqual(await fixture({
    'docs/A.md': ['See jimhoyd-com/urlcode-store for it.', '', 'Old: jimhoyd-com/urlcode-store <!-- local-links: historical -->', '', '<!-- local-links: historical -->', '', 'Released from', 'jimhoyd-com/urlcode-store and [x](GONE.md).', '', '[y](GONE.md)', ''].join('\n'),
    'docs/B.md': '<!-- local-links: historical-file -->\n\njimhoyd-com/urlcode-store [x](GONE.md)\n',
    'docs/issues/one.md': '# One\n',
    'BACKLOG.md': '# Later\n',
    'packages/store/README.md': [`[a](${repo}blob/main/docs/X.md)`, '', '[b](../../docs/A.md)', '', '[c](SECURITY.md)', '', `[d](${repo}blob/v1.2.3/docs/A.md)`, ''].join('\n'),
    'packages/store/SECURITY.md': '# Security\n',
  }), ['BACKLOG.md:1 local-issue-tracker', 'docs/A.md:1 retired-repository', 'docs/A.md:10 dead-relative-link', 'docs/issues/one.md:1 local-issue-tracker', 'packages/store/README.md:1 shipped-link', 'packages/store/README.md:3 shipped-link']);
});

test('the local-link check passes on this checkout, fragments included (#781)', () => {
  const result = run('check-local-links.ts');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /[1-9]\d* fragment\(s\)/);
});

test('a shipped package README links pinned, never outside the package or at main (#916)', () => {
  const repo = 'https://github.com/jimhoyd-com/urlcode/';
  assert.match(shippedLinkProblem('packages/store/README.md', '../../docs/STORE.md#openapi') ?? '', /outside packages\/store\/.*installed copy/);
  assert.match(shippedLinkProblem('packages/store/README.md', `${repo}blob/main/docs/STORE.md`) ?? '', /main branch/);
  assert.equal(shippedLinkProblem('packages/store/README.md', `${repo}blob/v1.2.3/docs/STORE.md#openapi`), undefined);
  assert.equal(shippedLinkProblem('packages/store/README.md', 'SECURITY.md'), undefined);
  assert.equal(shippedLinkProblem('packages/store/README.md', '#field-reference'), undefined);
  assert.equal(pinnedRepositoryPath(`${repo}blob/v1.2.3/docs/STORE.md#openapi`, '1.2.3'), 'docs/STORE.md#openapi');
  assert.equal(pinnedRepositoryPath(`${repo}tree/v1.2.3/proofs/private-requests/client`, '1.2.3'), 'proofs/private-requests/client');
  assert.equal(pinnedRepositoryPath(`${repo}blob/v1.2.2/docs/STORE.md`, '1.2.3'), undefined, 'another version is not checked against this checkout');
});

test('yamlBlocks returns only yaml/yml fences with their first content line (#780)', () => {
  const blocks = yamlBlocks(['text', '```yaml', 'a: 1', '```', '```json', '{}', '```', '~~~yml', 'b: 2', '~~~'].join('\n'));
  assert.deepEqual(blocks, [{ line: 3, text: 'a: 1' }, { line: 9, text: 'b: 2' }]);
});

test('the three guide examples from #780 fail as they shipped and pass as corrected', () => {
  const redirect = (url: string) => [
    '  /people/{id}:',
    '    parameters:',
    '      - {name: id, in: path, required: true, schema: {type: string, minLength: 1}}',
    `    redirect: {url: ${url}}`,
  ].join('\n');
  assert.equal(checkBlock(redirect('/profiles/{id}')).kind, 'failed');
  assert.deepEqual(checkBlock(redirect("'/profiles/{id}'")), { kind: 'validated' });

  const page = (key: string) => `version: "1"\nroutes:\n  /:\n    page: {${key}: pages/index.html}\n`;
  assert.equal(checkBlock(page('source')).kind, 'failed');
  assert.deepEqual(checkBlock(page('file')), { kind: 'validated' });

  const secrets = (name: string, secret: string) => `version: "1"\nroutes:\n  /api/report:\n    function: { source: functions/report.mjs }\n    secrets: { ${name}: { secret: ${secret} } }\n`;
  assert.equal(checkBlock(secrets('KEY', 'api-key')).kind, 'failed');
  assert.deepEqual(checkBlock(secrets('API_KEY', 'REPORT_API_KEY')), { kind: 'validated' });
});

test('project keys are completed, other YAML is parsed only, and # snippet: partial skips (#780)', () => {
  assert.deepEqual(asProject({ policies: { profile: 'hardened' } }), { version: '1', routes: {}, policies: { profile: 'hardened' } });
  assert.deepEqual(checkBlock('policies:\n  profile: hardened\n'), { kind: 'validated' });
  assert.equal(checkBlock('policies:\n  profile: nonexistent-builtin\n  unknown: 1\n').kind, 'failed');
  assert.deepEqual(checkBlock('name: ci\non: push\njobs: {}\n'), { kind: 'parsed' });
  assert.equal(checkBlock('a: [unclosed\n').kind, 'failed');
  assert.deepEqual(checkBlock('# snippet: partial\n  /x:\n    redirect: {url: /a/{b}}\n'), { kind: 'skipped' });
});

test('every fenced yaml block in authored Markdown parses, and project YAML validates (#780)', () => {
  const result = run('check-doc-yaml.ts');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /[1-9]\d* block\(s\) validated/);
});

// Names each failure reports, in order, for one paragraph of guidance prose.
const denied = (text: string): string[] => proseFailures(text, 'x.md:1').map(failure => /`([^`]+)`/.exec(failure)?.[1] ?? '');

test('a negative claim denying a schema key fails: the #1008 sentence and its variants', () => {
  // The exact sentence docs/AI-AUTHORING.md shipped while the fixture schema had `expectJson`.
  assert.deepEqual(denied('There is no `json` or `expectJson` key: send JSON as `body` with a `content-type` header, and assert a JSON answer with its exact text in `expectBody`.'), ['json', 'expectJson']);
  assert.deepEqual(denied('A request case has no `expectJson`.'), ['expectJson']);
  assert.deepEqual(denied('The fixture format has no `expectJson` key.'), ['expectJson']);
  assert.deepEqual(denied('`expectJson` is not a key.'), ['expectJson']);
  assert.deepEqual(denied('`expectJson` is not a valid request key; compare the body text.'), ['expectJson']);
  assert.deepEqual(denied('Cases take no `expectJson` field.'), ['expectJson']);
  assert.deepEqual(denied('There are no `expectJson`, `expectSignals` or `steps` keys.'), ['expectJson', 'expectSignals', 'steps']);
  assert.match(proseFailures('There is no `expectJson` key.', 'docs/AI-AUTHORING.md:267')[0] ?? '', /^docs\/AI-AUTHORING\.md:267 {2}no-denied-field: `expectJson` is defined in schemas\/requests\.schema\.json/);
});

test('a negative claim about a key that really does not exist passes (#1008)', () => {
  // PR #1007's replacement: scoped to request keys, where `json` is not one
  // (it is a `respond` key and a `capture` pointer, neither a request key).
  assert.deepEqual(denied('There is no `json` request key: send JSON as `body` with a `content-type` header.'), []);
  assert.deepEqual(denied('There is no `expectText` key; assert text with `expectBody`.'), []);
  // Scoped to a closed key set: the auth policy takes `role`, not `roles`.
  assert.deepEqual(denied('`roles` is not a key of `auth`; write `role`.'), []);
  assert.deepEqual(denied('`auth` has no `roles` key.'), []);
  assert.deepEqual(denied('`auth` has no `required` key.'), ['required']);
});

test('instances, quotations and wrong-YAML examples are not negative claims (#1008)', () => {
  assert.deepEqual(denied('A route with no `auth` field is public.'), []);
  assert.deepEqual(denied('A project with no `policies` key and no `profiles` key behaves exactly as before.'), []);
  assert.deepEqual(denied('If there is no `cache` key, responses are not cached.'), []);
  assert.deepEqual(denied('A case that has no `expectBody` covers nothing.'), []);
  assert.deepEqual(denied('The old guide said "there is no `expectJson` key", which was wrong.'), []);
  assert.deepEqual(denied('Do not write `json: {ok: true}` in a case; send `body` text instead.'), []);
  const dontWrite = ['Do not write this:', '', '```yaml', '# there is no `expectJson` key, so this is wrong', 'json: {ok: true}', '```', '', 'Write this instead.'].join('\n');
  const stripped = withoutFences(dontWrite);
  assert.equal(stripped.split('\n').length, dontWrite.split('\n').length, 'line numbers hold');
  assert.deepEqual(denied(stripped.split('\n').join(' ')), []);
  assert.deepEqual(denied(dontWrite.split('\n').join(' ')), ['expectJson'], 'the same text outside a fence is a claim');
});

test('guidance that tells the reader to use a key the schema lacks fails (#1008)', () => {
  assert.deepEqual(denied('Use the `expectText` key to assert a body.'), ['expectText']);
  assert.deepEqual(denied('Set the `json` request key to an object.'), ['json']);
  assert.deepEqual(denied('Use the `expectJson` key with JSON Pointers.'), []);
  assert.deepEqual(denied('Declare the `cache` block on the route.'), []);
});

test('the guidance-claims check passes on this checkout (#1008)', () => {
  const result = run('check-guidance-claims.ts');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no contradictions/);
});
