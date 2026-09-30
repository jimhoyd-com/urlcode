import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { githubSlug, headingText, markdownAnchors, pinnedRepositoryPath, shippedLinkProblem } from '../scripts/check-local-links.ts';
import { asProject, checkBlock, yamlBlocks } from '../scripts/check-doc-yaml.ts';
import { proseFailures, withoutFences } from '../scripts/check-guidance-claims.ts';

const script = (name: string): string => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const run = (name: string) => spawnSync(process.execPath, [script(name)], { encoding: 'utf8', timeout: 60000 });

test('githubSlug follows GitHub heading anchors: lowercase, punctuation but - and _ removed, spaces to - (#781)', () => {
  assert.equal(githubSlug(headingText('`site.notFound` is inlined')), 'sitenotfound-is-inlined');
  assert.equal(githubSlug(headingText('2b. Root-relative and suffix redirects')), '2b-root-relative-and-suffix-redirects');
  assert.equal(githubSlug(headingText('Add-ons: extensions and artifacts')), 'add-ons-extensions-and-artifacts');
  assert.equal(githubSlug(headingText('What `snake_case` keeps')), 'what-snake_case-keeps');
  // Tag stripping repeats until stable, so a nested tag cannot survive one pass.
  assert.equal(headingText('Safe <scr<b>ipt>heading'), 'Safe heading');
  assert.equal(githubSlug(headingText('[Linked](OTHER.md) & *emphasised* text')), 'linked--emphasised-text');
  assert.equal(githubSlug(headingText('Café — über')), 'café--über');
});

test('markdownAnchors suffixes repeated headings, reads explicit anchors and ignores fenced code (#781)', () => {
  const anchors = markdownAnchors([
    '# Title',
    '## Options',
    '## Options',
    '### Options',
    '<a id="custom-anchor"></a>',
    "<a name='legacy'></a>",
    'Setext heading',
    '--------------',
    '```sh',
    '# not a heading',
    '```',
  ].join('\n'));
  assert.deepEqual([...anchors].sort(), ['custom-anchor', 'legacy', 'options', 'options-1', 'options-2', 'setext-heading', 'title']);
  assert.equal(anchors.has('not-a-heading'), false);
});

test('the local-link check passes on this checkout, fragments included (#781)', () => {
  const result = run('check-local-links.ts');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\d+ fragment\(s\)/);
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

test('the conflict-marker check finds <<<<<<< and >>>>>>> lines, never a setext =======', async () => {
  const { conflictMarkers } = await import('../scripts/check-conflict-markers.ts');
  const text = ['# Title', '', 'Heading', '=======', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> origin/main', 'a <<<<<<< b', ''].join('\n');
  assert.deepEqual(conflictMarkers([{ path: 'CHANGELOG.md', text }]), ['CHANGELOG.md:5', 'CHANGELOG.md:9']);
  assert.deepEqual(conflictMarkers([{ path: 'README.md', text: 'Heading\n=======\nbody\n' }]), []);
});
