import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { githubSlug, headingText, markdownAnchors } from '../scripts/check-local-links.ts';
import { asProject, checkBlock, yamlBlocks } from '../scripts/check-doc-yaml.ts';

const script = (name: string): string => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const run = (name: string) => spawnSync(process.execPath, [script(name)], { encoding: 'utf8', timeout: 60000 });

test('githubSlug follows GitHub heading anchors: lowercase, punctuation but - and _ removed, spaces to - (#781)', () => {
  assert.equal(githubSlug(headingText('`site.notFound` is inlined')), 'sitenotfound-is-inlined');
  assert.equal(githubSlug(headingText('2b. Root-relative and suffix redirects')), '2b-root-relative-and-suffix-redirects');
  assert.equal(githubSlug(headingText('Add-ons: extensions and artifacts')), 'add-ons-extensions-and-artifacts');
  assert.equal(githubSlug(headingText('What `snake_case` keeps')), 'what-snake_case-keeps');
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
